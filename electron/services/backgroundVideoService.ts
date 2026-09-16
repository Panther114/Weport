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
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync } from 'node:fs'
import { delimiter, join } from 'node:path'

/**
 * 背景视频的画质档位。
 *
 * v1.0.4 之前只有一个写死的档位（1920 长边 / crf 26 / veryfast），用户反馈
 * "背景视频被降质了"。降的其实不只是分辨率 —— 4K / 25MB 的源压成 1080p / 2.3MB
 * 是 11 倍的码率削减，crf 26 + veryfast 在渐变和细节上肉眼可见地糊。
 *
 * 所以给三个档位，**分辨率与编码质量同时分档**，默认留在老行为（balanced），
 * 想要原始观感的用户选 native：
 *
 *   native   长边到显示器设备宽度（不封 1920，上限 3840），crf 18 + medium
 *   balanced 长边 1280..1920，crf 26 + veryfast     ← 旧行为，默认
 *   compact  长边约显示器宽度的 2/3（≤1280），crf 30 + veryfast
 *
 * 档位只影响**缓存里的那份转码副本**，不动用户的源文件。
 */
export type BackgroundVideoQuality = 'native' | 'balanced' | 'compact'

export const BACKGROUND_VIDEO_QUALITY_DEFAULT: BackgroundVideoQuality = 'balanced'

export const BACKGROUND_VIDEO_QUALITY_OPTIONS: ReadonlyArray<{
  id: BackgroundVideoQuality
  label: string
  hint: string
}> = [
  {
    id: 'native',
    label: '原生',
    hint: '按屏幕分辨率解码、低压缩（crf 18）。观感最接近原片，解码量与显存占用最高',
  },
  {
    id: 'balanced',
    label: '平衡',
    hint: '默认。长边不超过屏幕宽度，压缩率较高，画质与开销折中',
  },
  {
    id: 'compact',
    label: '精简',
    hint: '长边约为屏幕的 2/3。最省，配合较大的背景模糊几乎看不出差别',
  },
]

/**
 * 模糊达到这个半径后，高分辨率已经没有意义：模糊会把细节抹掉，多解码出来的
 * 像素在屏幕上根本不存在。用户明确要求这条规则（原话：
 * "at a higher pixel blur, there's no need for higher resolutions, that's just wasted"）。
 *
 * 注意这只**压制高于 balanced 的档位**：用户主动选 compact 时保留 compact
 * （它本来就更低），选 native 且模糊 ≥4px 时自动回落到 balanced。
 */
export const BLUR_FORCES_BALANCED_PX = 4

interface QualitySpec {
  /** 长边上限（像素） */
  maxEdge: number
  /** 长边下限：再低就会在模糊/遮罩下看出软化 */
  minEdge: number
  crf: number
  preset: string
}

const QUALITY_SPECS: Record<BackgroundVideoQuality, QualitySpec> = {
  // native 的上限是 3840：再高的源在显示器上也没有落点，而转码本身要花钱。
  native: { maxEdge: 3840, minEdge: 1280, crf: 18, preset: 'medium' },
  balanced: { maxEdge: 1920, minEdge: 1280, crf: 26, preset: 'veryfast' },
  compact: { maxEdge: 1280, minEdge: 854, crf: 30, preset: 'veryfast' },
}

/** 档位高低序，用于"模糊时只降不升"。 */
const QUALITY_RANK: Record<BackgroundVideoQuality, number> = { compact: 0, balanced: 1, native: 2 }

export function isBackgroundVideoQuality(value: unknown): value is BackgroundVideoQuality {
  return value === 'native' || value === 'balanced' || value === 'compact'
}

/**
 * 应用"模糊 ≥4px 不得高于平衡档"这条规则。
 *
 * 返回 `demoted: true` 说明用户的选项被自动降级了 —— 设置页必须把这个原因
 * **说出来**，否则用户只会看到"我选了原生但没生效"。
 */
export function resolveEffectiveQuality(
  selected: BackgroundVideoQuality,
  blurPx: number
): { quality: BackgroundVideoQuality; demoted: boolean } {
  const blur = Number.isFinite(blurPx) ? blurPx : 0
  if (blur >= BLUR_FORCES_BALANCED_PX && QUALITY_RANK[selected] > QUALITY_RANK.balanced) {
    return { quality: 'balanced', demoted: true }
  }
  return { quality: selected, demoted: false }
}
/**
 * 允许作为背景视频的源文件上限（用户明确要求的一个约束）。
 *
 * 为什么需要它：背景视频是**每一个可见帧**都要解码的东西，而它压在面板下面、
 * 通常还带遮罩或模糊。用户从素材站随手下的 4K 片子动辄几百 MB、码率几十 Mbps，
 * 解码这些像素的唯一效果就是让界面变卡。50MB 足够放下 1080p/30fps 的十几秒循环，
 * 本机素材库里 10 个视频有 9 个在这条线以下。
 *
 * 超限的文件不会被转码也不会被播放（转码器可以把它压小，但那是拿一次几十秒的
 * 满核 ffmpeg 去换一个本来就不该选的输入）。设置页会给出明确原因。
 */
const MAX_SOURCE_BYTES = 50 * 1024 * 1024
/** 解码帧率上限：源是 60/120fps 时没必要每一帧都解，观感在背景层没有区别。 */
const MAX_FPS = 30
/** 判定背景类型用的扩展名（与渲染层 utils/appearance 的 backgroundKindOf 对应） */
const VIDEO_EXTENSIONS = new Set(['mp4', 'webm', 'mov', 'm4v', 'mkv', 'ogv'])
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
  /** 用户选择的档位 */
  selectedQuality: BackgroundVideoQuality
  /** 实际生效的档位（模糊 ≥4px 时可能被降到 balanced） */
  quality: BackgroundVideoQuality
  /** true = 因为背景模糊 ≥4px 自动从更高档位降了下来 */
  demoted: boolean
  /** 本次目标的缩放长边上限（设置页用来解释"实际解多大"） */
  longEdge: number
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

/**
 * 目标长边：跟着"这层背景实际会被显示多大"走。
 *
 * 背景层永远铺满主窗口，所以它需要的像素上限 = 主显示器在**设备像素**下的宽度
 * （窗口不会比屏幕宽）。超出这个宽度的像素会被 GPU 缩放掉，纯白烧的解码量：
 * 在 1920 物理宽 + 150% 缩放的机器上，1280 CSS 宽的窗口 = 1920 设备像素宽，
 * 所以 1920 恰好，2560 就是浪费，3840 是 4 倍浪费。
 *
 * 取不到屏幕信息（例如 app 还没 ready）时退回该档的上限，行为与旧版一致。
 */
export function longEdgeForQuality(quality: BackgroundVideoQuality): number {
  const spec = QUALITY_SPECS[quality]
  const deviceWidth = primaryDeviceWidth()
  if (!deviceWidth) return spec.maxEdge
  if (quality === 'compact') {
    // 精简档按显示宽度成比例缩小，但不越过自己的上限 —— 这样它在任何屏幕上
    // 都明显低于 balanced（否则 1080p 屏上两档会撞成同一个数）。
    return Math.min(spec.maxEdge, Math.max(spec.minEdge, Math.round(deviceWidth * 0.66)))
  }
  return Math.max(spec.minEdge, Math.min(spec.maxEdge, deviceWidth))
}

function primaryDeviceWidth(): number {
  try {
    const { screen } = require('electron') as typeof import('electron')
    const primary = screen.getPrimaryDisplay()
    return Math.round((primary?.size?.width || 0) * (primary?.scaleFactor || 1))
  } catch {
    return 0
  }
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

  /**
   * 缓存键必须覆盖**整条编码签名**，不只是分辨率。
   *
   * native 与 balanced 在 1080p 屏上算出来的长边是同一个数（1920），但 crf/preset
   * 不同 —— 只哈希 edge 的话两档会命中同一个文件，用户切档位时"没反应"，
   * 而且是先转码的那一档悄悄获胜。所以 quality / crf / preset 全部进键。
   */
  private cacheKey(source: string, quality: BackgroundVideoQuality, edge: number): string | null {
    try {
      const stat = statSync(source)
      const spec = QUALITY_SPECS[quality]
      return createHash('sha1')
        .update(`${source}|${stat.size}|${Math.round(stat.mtimeMs)}|${quality}|${edge}|${spec.crf}|${spec.preset}`)
        .digest('hex')
        .slice(0, 20)
    } catch {
      return null
    }
  }

  private pruneCache(): void {
    try {
      const files = readdirSync(this.cacheDir)
      // 半成品（.part）先删：正常情况下 finish() 会自己清掉，这里收的是"进程被强杀"
      // 留下的孤儿。它们不计入 MAX_CACHE_ENTRIES（那份配额是给可用缓存算的）。
      for (const name of readdirSync(this.cacheDir)) {
        if (name.endsWith('.part')) {
          try {
            unlinkSync(join(this.cacheDir, name))
          } catch {
            /* 被占用就下次再说 */
          }
        }
      }
      const mp4s = files
        .filter((name) => name.endsWith('.mp4'))
        .map((name) => {
          const full = join(this.cacheDir, name)
          return { full, mtime: statSync(full).mtimeMs }
        })
        .sort((a, b) => b.mtime - a.mtime)
      for (const stale of mp4s.slice(MAX_CACHE_ENTRIES)) {
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
   * 一个缓存文件是否**可以信任**。
   *
   * 只检查存在是不够的：转码是被强杀过的进程留下的残片可能非空但不是可播放的 mp4
   * （没有 moov atom）。因此编码一律先写 `{key}.mp4.part`、成功后才 rename 到正式名
   * （见 startOptimize），正式名下的文件在逻辑上只会是完整的。这里再把 0 字节挡掉 ——
   * 历史遗留或外部工具碰过的文件仍然可能命中。
   */
  private isUsableCacheFile(path: string): boolean {
    try {
      return statSync(path).size > 0
    } catch {
      return false
    }
  }

  /**
   * 取得应当播放的路径。第一次调用会同步返回原文件 + 启动后台转码；
   * 转码完成后再次调用（或下次启动）返回缓存文件。
   *
   * `options.quality` 是用户选的档位，`options.blurPx` 是背景模糊半径 ——
   * 后者用来执行"模糊 ≥4px 就不该用高分辨率"这条规则（见 resolveEffectiveQuality）。
   */
  resolve(
    sourcePath: string,
    options?: { quality?: unknown; blurPx?: unknown }
  ): BackgroundVideoInfo {
    const selectedQuality = isBackgroundVideoQuality(options?.quality)
      ? options.quality
      : BACKGROUND_VIDEO_QUALITY_DEFAULT
    const blurPx = Number(options?.blurPx)
    const { quality, demoted } = resolveEffectiveQuality(
      selectedQuality,
      Number.isFinite(blurPx) ? blurPx : 0
    )
    const longEdge = longEdgeForQuality(quality)
    const base = { sourcePath, selectedQuality, quality, demoted, longEdge }

    const source = String(sourcePath || '').trim()
    if (!source || !existsSync(source)) {
      return { ...base, path: source, optimized: false, pending: false, reason: 'not-found' }
    }

    // 只有视频才进这个转码器。
    //
    // 旧版对任何存在的文件都跑一遍 ffmpeg：把一张 PNG 背景"转码"成了
    // 1920×1080 / 0.04 秒 / 1 帧的 mp4（实测 20KB，见 optimize.log 里的
    // 349021.png 那条）。图片背景是 <img> 一次光栅化、根本不重绘，比一个
    // 单帧视频便宜得多。这里直接放行原文件，不启动 ffmpeg、不写缓存。
    const ext = (source.split('.').pop() || '').toLowerCase()
    if (!VIDEO_EXTENSIONS.has(ext)) {
      return { ...base, path: source, optimized: false, pending: false, reason: 'not-a-video' }
    }

    // 体积上限：超限不转码、不播放，交给设置页解释原因。
    try {
      const stat = statSync(source)
      if (stat.size > MAX_SOURCE_BYTES) {
        this.log(`reject too-large bytes=${stat.size} source=${source}`)
        return { ...base, path: '', optimized: false, pending: false, reason: 'too-large' }
      }
    } catch {
      return { ...base, path: source, optimized: false, pending: false, reason: 'stat-failed' }
    }

    const key = this.cacheKey(source, quality, longEdge)
    if (!key) return { ...base, path: source, optimized: false, pending: false, reason: 'stat-failed' }

    const cached = this.states.get(key)
    if (cached?.optimizedPath && this.isUsableCacheFile(cached.optimizedPath)) {
      return { ...base, path: cached.optimizedPath, optimized: true, pending: false }
    }

    const target = join(this.cacheDir, `${key}.mp4`)
    if (this.isUsableCacheFile(target)) {
      this.states.set(key, { optimizedPath: target, pending: false })
      return { ...base, path: target, optimized: true, pending: false }
    }

    // 转码失败过（例如 ffmpeg 编不了这个像素格式）就别每次重试：记住失败，
    // 直接播原文件。原因写进 state 供设置页显示。
    const failed = this.states.get(key)
    if (failed?.reason && !failed.optimizedPath) {
      return { ...base, path: source, optimized: false, pending: false, reason: failed.reason }
    }

    const ffmpeg = findFfmpeg()
    if (!ffmpeg) {
      // 记下来，避免每帧都重新找一遍 PATH
      this.states.set(key, { optimizedPath: '', pending: false, reason: 'ffmpeg-missing' })
      return { ...base, path: source, optimized: false, pending: false, reason: 'ffmpeg-missing' }
    }

    this.startOptimize(ffmpeg, source, target, key, quality, longEdge)
    return { ...base, path: source, optimized: false, pending: true }
  }

  private startOptimize(
    ffmpeg: string,
    source: string,
    target: string,
    key: string,
    quality: BackgroundVideoQuality,
    edge: number
  ): void {
    if (this.inflight.has(key)) return
    this.inflight.add(key)
    try {
      mkdirSync(this.cacheDir, { recursive: true })
    } catch {
      this.inflight.delete(key)
      return
    }
    const spec = QUALITY_SPECS[quality]
    /** 编码目标：写这个临时名，成功后原子 rename 到 target（见 finish 里的说明）。 */
    const staging = `${target}.part`
    // 缩放用 `-2` 让另一条边保持偶数（H.264 要求偶数尺寸），aspect 不变。
    //
    // `min(iw,edge)` 这一层是必须的，**绝不能只写 edge**：旧写法
    // `if(gt(iw,ih),edge,-2)` 会把一个 1280 宽的源"放大"到 1920 —— 解码量涨 1.25 倍，
    // 而多出来的像素全是插值算的，画面上一点好处都没有。`trunc(x/2)*2` 再保证
    // 取源尺寸时宽度是偶数（奇数宽度 x264 会直接报错）。
    const cap = (name: 'iw' | 'ih') => `trunc(min(${name},${edge})/2)*2`
    const scale = `scale='if(gt(iw,ih),${cap('iw')},-2)':'if(gt(iw,ih),-2,${cap('ih')})'`
    const args = [
      '-hide_banner',
      '-loglevel', 'error',
      '-y',
      '-i', source,
      '-an', // 背景本来就 muted，音轨纯浪费
      // 帧率封顶：源是 60/120fps 时解码量翻倍/翻四倍，而背景层看不出差别。
      // fps 滤镜不会改变时长（丢帧而非变速）。
      '-vf', `${scale},fps=fps='min(${MAX_FPS},source_fps)'`,
      '-c:v', 'libx264',
      '-preset', spec.preset,
      '-crf', String(spec.crf),
      '-pix_fmt', 'yuv420p',
      // 关键帧间隔：loop 回到开头时要立刻出画，默认的 250 帧间隔会让每轮
      // 循环的前几帧回退到"等下一个关键帧"。
      '-g', String(MAX_FPS * 2),
      // faststart：moov 放到文件头，播放器可以立刻开始解码
      '-movflags', '+faststart',
      // **必须显式指定容器**：输出名是 `{key}.mp4.part`，ffmpeg 从 `.part` 推断不出格式，
      // 会直接报 "Unable to find a suitable output format for '…mp4.part'" 并让整个转码
      // 失败 —— 而失败是**静默回退到原文件**，于是 4K 源被逐帧解码，GPU 进程从 ~170MB
      // 涨到 400MB+（实测本机整机 863MB = 5.36%）。这条不是可选的保险，是 .part 方案
      // 成立的前提。
      '-f', 'mp4',
      // **先写 .part，成功后再 rename**（见 finish）。
      //
      // 直接写正式名有个静默且永久的坏结局：转码中途被强杀（关机、崩溃、任务管理器
      // 结束进程树 —— native 档的 4K 转码要几十秒，这个窗口很宽）会在正式名下留下一个
      // 非空但**没有 moov atom、根本无法播放**的 mp4。而 resolve() 只认"文件存在"，
      // 于是它会一直把这个残片当作有效缓存返回，永远不会重转 —— 用户的视频背景
      // 从此变成一块黑，且没有任何提示。实测：杀掉 ffmpeg 后留下 1,572,912 字节的
      // 输出，ffprobe 报 "moov atom not found"。
      //
      // rename 在同一目录内是原子的，所以正式名下要么不存在、要么是一个完整文件 ——
      // "存在即可信"这条假设因此才真正成立。
      staging
    ]
    this.log(`optimize start key=${key} quality=${quality} edge=${edge} crf=${spec.crf} source=${source}`)
    const child = spawn(ffmpeg, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] })
    let stderrTail = ''
    child.stderr?.on('data', (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString()).slice(-400)
    })
    const finish = (ok: boolean) => {
      this.inflight.delete(key)
      const usable = ok && this.isUsableCacheFile(staging)
      if (usable) {
        try {
          renameSync(staging, target)
        } catch (error) {
          stderrTail = `rename failed: ${(error as Error)?.message || error}`
        }
      }
      if (this.isUsableCacheFile(target)) {
        this.states.set(key, { optimizedPath: target, pending: false })
        this.pruneCache()
        this.log(`optimize done key=${key}`)
      } else {
        // 失败/中断：把半成品删掉，别让它以 .part 的形式永远占着磁盘
        try {
          unlinkSync(staging)
        } catch {
          /* 没留下东西就不用删 */
        }
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

  /**
   * 背景的平均相对亮度（0=黑，1=白），用于自动决定明暗主题。
   *
   * **必须在主进程算**：渲染层拿到的是 `weport-media://`（自定义协议），把它画到
   * canvas 上会把 canvas 标记为 tainted，`getImageData` 直接抛 SecurityError ——
   * 在渲染层这条路根本走不通（实测报的就是这个错）。
   *
   * 图片用 nativeImage 解码；视频用已有的降采样缓存抽一帧（ffmpeg 缺失时返回
   * null，明暗自适应就不生效，不影响其它功能）。
   */
  async meanLuminance(sourcePath: string): Promise<number | null> {
    const source = String(sourcePath || '').trim()
    if (!source || !existsSync(source)) return null

    const ext = (source.split('.').pop() || '').toLowerCase()
    const png = VIDEO_EXTENSIONS.has(ext)
      ? await this.extractVideoFramePng(source)
      : this.readImagePng(source)
    if (!png) return null

    try {
      const { nativeImage } = require('electron') as typeof import('electron')
      const image = nativeImage.createFromBuffer(png)
      if (image.isEmpty()) return null
      // 缩到很小的位图：只要平均亮度，32×18 足够且几乎零成本
      const small = image.resize({ width: 32, height: 18, quality: 'good' })
      const { width, height } = small.getSize()
      if (width === 0 || height === 0) return null
      const bitmap = small.toBitmap() // BGRA
      const lin = (v: number) => {
        const s = v / 255
        return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
      }
      let sum = 0
      let n = 0
      for (let i = 0; i + 3 < bitmap.length; i += 4) {
        const b = bitmap[i]
        const g = bitmap[i + 1]
        const r = bitmap[i + 2]
        sum += 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
        n += 1
      }
      return n > 0 ? sum / n : null
    } catch {
      return null
    }
  }

  /** 图片 → PNG buffer（nativeImage 直接支持 png/jpg/webp/bmp） */
  private readImagePng(source: string): Buffer | null {
    try {
      const { nativeImage } = require('electron') as typeof import('electron')
      const image = nativeImage.createFromPath(source)
      return image.isEmpty() ? null : image.toPNG()
    } catch {
      return null
    }
  }

  /**
   * 视频 → 某一帧的 PNG。
   *
   * 取 **1 秒处**而不是第 0 帧：很多壁纸开头是淡入或黑场，用第 0 帧判明暗会把
   * 所有视频都判成深色。输入优先用已经转好的降采样缓存（更小、抽帧更快）。
   */
  private async extractVideoFramePng(source: string): Promise<Buffer | null> {
    const ffmpeg = findFfmpeg()
    if (!ffmpeg) return null
    // 明暗自适应只需要"随便一帧"，用 balanced 档的缓存即可 —— 挑档位在这里
    // 没有任何意义（它只影响抽帧速度，不影响平均亮度）。
    const key = this.cacheKey(source, 'balanced', longEdgeForQuality('balanced'))
    if (!key) return null
    const cached = join(this.cacheDir, `${key}.mp4`)
    const input = existsSync(cached) ? cached : source
    const outPath = join(this.cacheDir, `.lum-${key}.png`)
    try {
      mkdirSync(this.cacheDir, { recursive: true })
    } catch {
      return null
    }
    const ok = await new Promise<boolean>((resolve) => {
      const child = spawn(
        ffmpeg,
        ['-hide_banner', '-loglevel', 'error', '-y', '-ss', '1', '-i', input, '-frames:v', '1', '-vf', 'scale=64:-2', outPath],
        { windowsHide: true, stdio: 'ignore' }
      )
      child.on('error', () => resolve(false))
      child.on('close', (code) => resolve(code === 0))
    })
    if (!ok || !existsSync(outPath)) return null
    try {
      return readFileSync(outPath)
    } catch {
      return null
    } finally {
      try {
        unlinkSync(outPath)
      } catch {
        /* 清不掉就留着，下次覆盖 */
      }
    }
  }
}
