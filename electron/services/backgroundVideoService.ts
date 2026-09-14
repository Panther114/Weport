// 视频背景降采样缓存。
//
// 问题：用户选一张 4K 壁纸当背景，`.app-bg video` 一直在解码 3840×2160，
// 而它的显示尺寸只有 1280×650（约 1/9 的像素）。多出来的解码 + 每帧一次
// 缩放/滤镜全部是白烧的 CPU/GPU，表现出来就是"选了视频背景就有点卡"。
//
// 做法：用 ffmpeg 把背景视频转成「显示尺寸够用的那一版」，缓存到 userData，
// 之后每次启动直接用缓存。**这是有损的**，但来源本来就是壁纸 —— 它被压在
// 半透明面板下、还可能被模糊处理，1080p 与 4K 在这一层看不出区别，而解码量
// 差 4 倍。
//
// 三条不变量：
//  1. **不阻塞启动**：转码是后台任务，转换完成前继续用原文件。启动时等一次
//     几十秒的 ffmpeg 是不可接受的。
//  2. **失败必须无声退化**：没装 ffmpeg、格式不认识、磁盘满 —— 一律回退原
//     文件。背景视频不是功能，不能因为它让应用不可用。
//  3. **缓存键包含源文件的 mtime+size**：用户换了视频、或者编辑了同一路径的
//     文件，都要重新转，不能命中旧缓存。

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs'
import { delimiter, join } from 'node:path'

/** 长边目标像素。1080p 对"压在面板下、常被模糊"的背景层绰绰有余。 */
const TARGET_LONG_EDGE = 1920
/** 缓存上限：超过就删掉最旧的几份，避免用户换几十次壁纸后缓存失控。 */
const MAX_CACHE_ENTRIES = 8

export interface BackgroundVideoInfo {
  /** 应用实际应当使用的路径（可能是原文件，也可能是缓存里的优化版） */
  path: string
  /** 原始文件路径，用于设置页显示与"已优化"标注 */
  sourcePath: string
  optimized: boolean
  /** 转码仍在进行时为 true，此时 path 是原文件 */
  pending: boolean
  /** 无法转码的原因（仅用于日志/设置页提示，不影响功能） */
  reason?: string
}

interface CacheState {
  optimizedPath: string
  pending: boolean
  reason?: string
}

/**
 * 找 ffmpeg。刻意**不打包**它：一个完整构建 40-100 MB，而背景视频只是
 * 锦上添花。找不到就用原文件 —— 功能不降级，只是没那么省。
 */
function findFfmpeg(): string | null {
  const override = String(process.env.WEPORT_FFMPEG || '').trim()
  if (override && existsSync(override)) return override
  const exe = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'
  const fromPath = String(process.env.PATH || '')
    .split(delimiter)
    .filter(Boolean)
    .map((dir) => join(dir, exe))
    .find((candidate) => existsSync(candidate))
  if (fromPath) return fromPath
  // 常见安装位置：PATH 里没有但确实装了的情况（WinGet / scoop / brew）
  const fallbacks =
    process.platform === 'win32'
      ? [
          join(process.env.LOCALAPPDATA || '', 'Programs', 'FFmpeg', 'bin', 'ffmpeg.exe'),
          join(process.env.ProgramData || '', 'chocolatey', 'bin', 'ffmpeg.exe'),
          join(process.env.USERPROFILE || '', 'scoop', 'shims', 'ffmpeg.exe'),
        ]
      : ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/usr/bin/ffmpeg']
  return fallbacks.find((candidate) => candidate && existsSync(candidate)) || null
}

export class BackgroundVideoService {
  private cacheDir: string
  private states = new Map<string, CacheState>()
  private inflight = new Set<string>()

  constructor(cacheRoot: string) {
    this.cacheDir = join(cacheRoot, 'background-video')
  }

  private log(message: string): void {
    try {
      mkdirSync(this.cacheDir, { recursive: true })
      appendFileSync(join(this.cacheDir, 'optimize.log'), `[${new Date().toISOString()}] ${message}\n`, 'utf8')
    } catch {
      /* 日志失败不影响功能 */
    }
  }

  private cacheKey(source: string): string | null {
    try {
      const stat = statSync(source)
      return createHash('sha1')
        .update(`${source}|${stat.size}|${Math.round(stat.mtimeMs)}|${TARGET_LONG_EDGE}`)
        .digest('hex')
        .slice(0, 20)
    } catch {
      return null
    }
  }

  private pruneCache(): void {
    try {
      const files = readdirSync(this.cacheDir)
        .filter((name) => name.endsWith('.mp4'))
        .map((name) => {
          const full = join(this.cacheDir, name)
          return { full, mtime: statSync(full).mtimeMs }
        })
        .sort((a, b) => b.mtime - a.mtime)
      for (const stale of files.slice(MAX_CACHE_ENTRIES)) {
        try {
          unlinkSync(stale.full)
        } catch {
          /* 被占用就下次再说 */
        }
      }
    } catch {
      /* 目录还不存在 */
    }
  }

  /**
   * 取得应当播放的路径。第一次调用会同步返回原文件 + 启动后台转码；
   * 转码完成后再次调用（或下次启动）返回缓存文件。
   */
  resolve(sourcePath: string): BackgroundVideoInfo {
    const source = String(sourcePath || '').trim()
    if (!source || !existsSync(source)) {
      return { path: source, sourcePath: source, optimized: false, pending: false, reason: 'not-found' }
    }

    const key = this.cacheKey(source)
    if (!key) return { path: source, sourcePath: source, optimized: false, pending: false, reason: 'stat-failed' }

    const cached = this.states.get(key)
    if (cached?.optimizedPath && existsSync(cached.optimizedPath)) {
      return { path: cached.optimizedPath, sourcePath: source, optimized: true, pending: false }
    }

    const target = join(this.cacheDir, `${key}.mp4`)
    if (existsSync(target)) {
      this.states.set(key, { optimizedPath: target, pending: false })
      return { path: target, sourcePath: source, optimized: true, pending: false }
    }

    const ffmpeg = findFfmpeg()
    if (!ffmpeg) {
      // 记下来，避免每帧都重新找一遍 PATH
      this.states.set(key, { optimizedPath: '', pending: false, reason: 'ffmpeg-missing' })
      return { path: source, sourcePath: source, optimized: false, pending: false, reason: 'ffmpeg-missing' }
    }

    this.startOptimize(ffmpeg, source, target, key)
    return { path: source, sourcePath: source, optimized: false, pending: true }
  }

  private startOptimize(ffmpeg: string, source: string, target: string, key: string): void {
    if (this.inflight.has(key)) return
    this.inflight.add(key)
    try {
      mkdirSync(this.cacheDir, { recursive: true })
    } catch {
      this.inflight.delete(key)
      return
    }
    // 缩放用 `-2` 让另一条边保持偶数（H.264 要求偶数尺寸），aspect 不变。
    const scale = `scale='if(gt(iw,ih),${TARGET_LONG_EDGE},-2)':'if(gt(iw,ih),-2,${TARGET_LONG_EDGE})'`
    const args = [
      '-hide_banner',
      '-loglevel', 'error',
      '-y',
      '-i', source,
      '-an', // 背景本来就 muted，音轨纯浪费
      '-vf', scale,
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-crf', '26',
      '-pix_fmt', 'yuv420p',
      // faststart：moov 放到文件头，播放器可以立刻开始解码
      '-movflags', '+faststart',
      target
    ]
    this.log(`optimize start key=${key} source=${source}`)
    const child = spawn(ffmpeg, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] })
    let stderrTail = ''
    child.stderr?.on('data', (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString()).slice(-400)
    })
    const finish = (ok: boolean) => {
      this.inflight.delete(key)
      if (ok && existsSync(target)) {
        this.states.set(key, { optimizedPath: target, pending: false })
        this.pruneCache()
        this.log(`optimize done key=${key}`)
      } else {
        this.states.set(key, { optimizedPath: '', pending: false, reason: stderrTail || 'ffmpeg-failed' })
        this.log(`optimize failed key=${key} err=${stderrTail}`)
      }
    }
    child.on('error', (error) => {
      stderrTail = String((error as Error)?.message || error)
      finish(false)
    })
    child.on('close', (code) => finish(code === 0))
  }

  /** 设置页/CLI 用来解释"为什么没优化" */
  status(): { ffmpeg: string | null; cacheDir: string } {
    return { ffmpeg: findFfmpeg(), cacheDir: this.cacheDir }
  }
}
