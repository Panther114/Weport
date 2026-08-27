/**
 * 本地 HTTP API 服务（v0.9.4，WeFlow httpService 的精简只读版）。
 *
 * 提供只读接口供本机脚本/工具读取导出数据：
 * - GET /api/health                       服务状态
 * - GET /api/sessions                     会话列表
 * - GET /api/messages?session=&limit=&offset=  会话消息
 * - GET /api/contacts?usernames=a,b       联系人信息
 * - GET /api/group-members?chatroom=      群成员
 * - GET /api/sns/timeline?limit=&offset=  朋友圈时间线
 * - GET /api/sns/stats                    朋友圈统计
 *
 * 认证：config httpApiToken 非空时要求 `Authorization: Bearer <token>`。
 * 服务仅监听 127.0.0.1（config httpApiHost/httpApiPort 可配置）。
 */
import http from 'http'
import { ConfigService } from './config'
import { chatService } from './chatService'
import { snsService } from './snsService'
import { groupAnalyticsService } from './groupAnalyticsService'

class HttpService {
  private server: http.Server | null = null
  private port = 5031
  private host = '127.0.0.1'
  private running = false

  private parseNumber(value: unknown, fallback: number, min = 0, max = Number.MAX_SAFE_INTEGER): number {
    const n = Number(value)
    if (!Number.isFinite(n)) return fallback
    return Math.max(min, Math.min(max, Math.floor(n)))
  }

  private checkAuth(req: http.IncomingMessage): boolean {
    const token = String(this.configService.get('httpApiToken') || '').trim()
    if (!token) return true
    const header = String(req.headers.authorization || '')
    return header === `Bearer ${token}`
  }

  private sendJson(res: http.ServerResponse, status: number, payload: unknown): void {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(payload))
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url || '/', `http://${this.host}:${this.port}`)
    const path = url.pathname.replace(/^\/api/, '') || '/'

    if (!this.checkAuth(req)) {
      this.sendJson(res, 401, { success: false, error: '未授权：需要正确的 Bearer Token' })
      return
    }

    const send = (payload: unknown, status = 200) => this.sendJson(res, status, payload)

    try {
      switch (path) {
        case '/health':
          send({ success: true, version: '0.9.10', running: this.running })
          return

        case '/sessions': {
          const r = await chatService.getSessions()
          send(r)
          return
        }

        case '/messages': {
          const sessionId = String(url.searchParams.get('session') || '').trim()
          if (!sessionId) {
            send({ success: false, error: '缺少 session 参数' }, 400)
            return
          }
          const limit = this.parseNumber(url.searchParams.get('limit'), 100, 1, 5000)
          const offset = this.parseNumber(url.searchParams.get('offset'), 0)
          const r = await chatService.getMessages(sessionId, offset, limit)
          send(r)
          return
        }

        case '/contacts': {
          const usernames = String(url.searchParams.get('usernames') || '')
            .split(',')
            .map((u) => u.trim())
            .filter(Boolean)
          if (usernames.length === 0) {
            send({ success: false, error: '缺少 usernames 参数（逗号分隔）' }, 400)
            return
          }
          const r = await chatService.enrichSessionsContactInfo(usernames)
          send(r)
          return
        }

        case '/group-members': {
          const chatroom = String(url.searchParams.get('chatroom') || '').trim()
          if (!chatroom) {
            send({ success: false, error: '缺少 chatroom 参数' }, 400)
            return
          }
          const r = await groupAnalyticsService.getGroupMembers(chatroom)
          send(r)
          return
        }

        case '/sns/timeline': {
          const limit = this.parseNumber(url.searchParams.get('limit'), 20, 1, 200)
          const offset = this.parseNumber(url.searchParams.get('offset'), 0)
          const r = await snsService.getTimeline(limit, offset)
          send(r)
          return
        }

        case '/sns/stats': {
          const r = await snsService.getExportStats({ allowTimelineFallback: true })
          send(r)
          return
        }

        default:
          send({ success: false, error: `未知接口: ${path}` }, 404)
      }
    } catch (e) {
      send({ success: false, error: String((e as Error)?.message || e) }, 500)
    }
  }

  async start(port: number, host: string): Promise<{ success: boolean; port?: number; error?: string }> {
    if (this.running && this.server) return { success: true, port: this.port }
    this.port = port
    this.host = host
    return new Promise((resolve) => {
      const server = http.createServer((req, res) => {
        void this.handle(req, res)
      })
      server.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE') {
          resolve({ success: false, error: `端口 ${this.port} 已被占用` })
        } else {
          resolve({ success: false, error: err.message })
        }
      })
      server.listen(this.port, this.host, () => {
        this.server = server
        this.running = true
        console.log(`[HttpService] HTTP API 已启动: http://${this.host}:${this.port}`)
        resolve({ success: true, port: this.port })
      })
    })
  }

  async stop(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.server) {
        this.running = false
        resolve()
        return
      }
      const server = this.server
      this.server = null
      server.close(() => {
        this.running = false
        resolve()
      })
      try { server.closeAllConnections?.() } catch { /* noop */ }
    })
  }

  getStatus(): { running: boolean; port: number; host: string } {
    return { running: this.running, port: this.port, host: this.host }
  }

  private configService: ConfigService
  constructor() {
    this.configService = ConfigService.getInstance()
  }
}

export const httpService = new HttpService()
