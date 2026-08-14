/**
 * 头像本地磁盘缓存服务（v0.9.1 深度修复）
 *
 * 问题背景：微信 CDN 头像（wx.qlogo.cn / qpic.cn）每次启动都要网络往返，
 * URL 过期还会 403 → 渲染层显示字母占位；本地 head_image.db 里其实有完整
 * 头像数据，此前只被当作「没有 CDN URL」时的兜底。
 *
 * 本服务把所有头像统一落到 `{cacheBasePath}/avatars/{sha1(url)}.jpg`：
 * - data: URL（head_image.db 读出的本地头像）→ 直接落盘
 * - CDN URL → 带 MicroMessenger UA/Referer 后台下载（并发池 + 去重）
 * - 已缓存的 URL 通过 `weport-media://` 本地协议返回，渲染进程零网络、
 *   跨启动即时显示；CDN URL 过期也不影响（磁盘文件仍可用）。
 */
import { net } from 'electron'
import { join } from 'path'
import { existsSync, mkdirSync, renameSync } from 'fs'
import { writeFile } from 'fs/promises'
import { createHash } from 'crypto'
import { ConfigService } from './config'

const AVATAR_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/107.0.0.0 Safari/537.36 MicroMessenger/7.0.20.1781(0x6700143B) WindowsWechat(0x63090719) XWEB/8351'

const isCdnUrl = (url: string): boolean => /^https?:\/\/([a-z0-9-]+\.)?(qlogo|qpic)\.cn\//i.test(url)
const isDataUrl = (url: string): boolean => /^data:image\//i.test(url)
const isLocalUrl = (url: string): boolean => url.startsWith('weport-media://')

/**
 * 本地协议 URL 格式：weport-media://local/<encodeURIComponent(绝对路径)>
 * 注意：不能把盘符放进 host（weport-media://C:/...）—— Chromium 会把 `C:`
 * 规范化为 host `c`（冒号被当作端口分隔符），路径解析会丢盘符冒号。
 */
export const toProtocolUrl = (filePath: string): string =>
  `weport-media://local/${encodeURIComponent(filePath.replace(/\\/g, '/'))}`

export const protocolUrlToPath = (url: string): string | null => {
  try {
    const parsed = new URL(url)
    const raw = decodeURIComponent(parsed.pathname.replace(/^\/+/, ''))
    return raw || null
  } catch {
    return null
  }
}

class AvatarCacheService {
  private cacheDir = ''
  private inFlight = new Map<string, Promise<void>>()
  private activeDownloads = 0
  private maxConcurrent = 6
  private pending: Array<() => void> = []

  /** 由 appMain 在 ready 后调用（cacheBasePath 即 contacts.json 所在目录） */
  init(cacheBasePath?: string): void {
    if (this.cacheDir) return
    const base = cacheBasePath && cacheBasePath.trim().length > 0
      ? cacheBasePath
      : ConfigService.getInstance().getCacheBasePath()
    this.cacheDir = join(base, 'avatars')
    try {
      mkdirSync(this.cacheDir, { recursive: true })
    } catch { /* noop */ }
  }

  private resolveFilePath(url: string): string {
    const hash = createHash('sha1').update(url).digest('hex')
    return join(this.cacheDir, `${hash}.jpg`)
  }

  /**
   * 同步：本地已有缓存 → 返回 weport-media:// URL；否则返回原始 URL。
   * 不触发下载（配合 ensure 使用）。
   */
  localUrlOrOriginal(url: string | undefined): string | undefined {
    if (!url) return undefined
    const normalized = String(url).trim()
    if (!normalized || isLocalUrl(normalized)) return normalized
    if (!isCdnUrl(normalized) && !isDataUrl(normalized)) return normalized
    const filePath = this.resolveFilePath(normalized)
    return existsSync(filePath) ? toProtocolUrl(filePath) : normalized
  }

  /**
   * 判断 URL 是否可立即解析（weport-media:// 需验证文件仍存在；
   * data: / CDN 视为可解析，由渲染层或下载流程兜底）。
   */
  isResolvable(url: string | undefined): boolean {
    if (!url) return false
    const normalized = String(url).trim()
    if (!normalized) return false
    if (isLocalUrl(normalized)) {
      try {
        const p = protocolUrlToPath(normalized)
        return !!p && existsSync(p)
      } catch {
        return false
      }
    }
    return true
  }

  /**
   * 异步确保本地缓存存在：
   * - 已缓存 → 立即返回本地协议 URL
   * - data: URL → 异步落盘，返回原始 data URL（渲染层本就即时）
   * - CDN URL → 后台下载（去重 + 并发池），返回原始 URL（首帧），
   *   下次查询即命中本地文件
   */
  async ensure(url: string | undefined): Promise<string | undefined> {
    if (!url) return undefined
    const localized = this.localUrlOrOriginal(url)
    if (localized !== url) return localized

    const normalized = String(url).trim()
    if (isDataUrl(normalized)) {
      void this.persistDataUrl(normalized)
      return normalized
    }
    if (isCdnUrl(normalized)) {
      void this.download(normalized)
      return normalized
    }
    return normalized
  }

  /** data:image → 磁盘文件（幂等：同 URL 只写一次） */
  async persistDataUrl(dataUrl: string): Promise<string | undefined> {
    if (!isDataUrl(dataUrl)) return undefined
    const filePath = this.resolveFilePath(dataUrl)
    if (existsSync(filePath)) return toProtocolUrl(filePath)

    const existing = this.inFlight.get(dataUrl)
    if (existing) {
      await existing
      return existsSync(filePath) ? toProtocolUrl(filePath) : undefined
    }

    const match = /^data:image\/[a-zA-Z0-9.+-]+;base64,(.+)$/i.exec(dataUrl)
    if (!match?.[1]) return undefined
    const task = (async () => {
      try {
        const buffer = Buffer.from(match[1], 'base64')
        if (!buffer.length) return
        const tmp = `${filePath}.tmp`
        await writeFile(tmp, buffer)
        if (existsSync(filePath)) {
          try { await import('fs/promises').then((f) => f.unlink(tmp)) } catch { /* noop */ }
          return
        }
        renameSync(tmp, filePath)
      } catch { /* noop: 落盘失败不影响显示 */ }
    })()
    this.inFlight.set(dataUrl, task)
    try {
      await task
    } finally {
      this.inFlight.delete(dataUrl)
    }
    return existsSync(filePath) ? toProtocolUrl(filePath) : undefined
  }

  /** CDN URL 后台下载（去重 + 并发池） */
  private download(url: string): Promise<void> {
    const existing = this.inFlight.get(url)
    if (existing) return existing

    const task = new Promise<void>((resolve) => {
      const run = () => {
        this.activeDownloads++
        let done = false
        const finish = () => {
          if (done) return
          done = true
          this.activeDownloads--
          this.inFlight.delete(url)
          this.next()
          resolve()
        }

        try {
          const filePath = this.resolveFilePath(url)
          const chunks: Buffer[] = []
          const req = net.request({
            url,
            headers: {
              'User-Agent': AVATAR_UA,
              Referer: 'https://servicewechat.com/',
              Accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
              'Accept-Encoding': 'gzip, deflate, br',
              'Accept-Language': 'zh-CN,zh;q=0.9',
              Connection: 'keep-alive',
            },
          })
          req.on('response', (res) => {
            if (res.statusCode !== 200 || !/^image\//i.test(String(res.headers['content-type'] || ''))) {
              req.abort()
              finish()
              return
            }
            res.on('data', (chunk: Buffer) => chunks.push(chunk))
            res.on('end', () => {
              if (chunks.length === 0) {
                finish()
                return
              }
              const buffer = Buffer.concat(chunks)
              const tmp = `${filePath}.tmp`
              try {
                writeFile(tmp, buffer)
                  .then(() => {
                    if (!existsSync(filePath)) renameSync(tmp, filePath)
                    else {
                      void import('fs/promises').then((f) => f.unlink(tmp)).catch(() => undefined)
                    }
                    finish()
                  })
                  .catch(() => finish())
              } catch {
                finish()
              }
            })
            res.on('error', () => finish())
          })
          req.on('error', () => finish())
          req.end()
        } catch {
          finish()
        }
      }

      if (this.activeDownloads >= this.maxConcurrent) {
        this.pending.push(run)
      } else {
        run()
      }
    })
    this.inFlight.set(url, task)
    return task
  }

  private next(): void {
    if (this.activeDownloads >= this.maxConcurrent) return
    const next = this.pending.shift()
    if (next) next()
  }

  /** 并发发起一批 URL 的本地化（预热用） */
  prefetch(urls: Array<string | undefined>): void {
    for (const url of urls) {
      if (!url) continue
      const normalized = String(url).trim()
      if (!normalized) continue
      if (isLocalUrl(normalized)) continue
      if (this.localUrlOrOriginal(normalized) !== normalized) continue
      if (isDataUrl(normalized)) void this.persistDataUrl(normalized)
      else if (isCdnUrl(normalized)) void this.download(normalized)
    }
  }
}

export const avatarCacheService = new AvatarCacheService()
