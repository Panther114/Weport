/**
 * Weport MCP Server（v0.9.11）
 *
 * 基于 @modelcontextprotocol/sdk 的本地 MCP 服务（Streamable HTTP，127.0.0.1）。
 * 只读：所有工具落到既有的只读服务方法（chatService / groupAnalyticsService /
 * snsService / analyticsService），不提供写入 / 发送 / 删除能力。
 *
 * 认证：`Authorization: Bearer <token>`，token 取自 config `mcpToken`
 * （缺失时自动生成并持久化），兼容回退到 `httpApiToken`。
 *
 * 端口：config `mcpPort`，默认 5032（与 httpService 的 5031 错开）。
 *
 * AI 宿主接入：
 * - 支持 Streamable HTTP 的宿主直接指向 http://127.0.0.1:5032/mcp
 * - Claude Desktop / 仅支持 stdio 的宿主：scripts/mcp-stdio-bridge.cjs
 *   （打包后 resources/mcp/mcp-stdio-bridge.cjs），见 RELEASE_NOTES.md
 */
import http from 'http'
import { randomBytes, randomUUID } from 'crypto'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { z } from 'zod'
import { ConfigService } from './config'
import { chatService } from './chatService'
import { snsService } from './snsService'
import { analyticsService } from './analyticsService'
import { groupAnalyticsService } from './groupAnalyticsService'

interface McpHttpSession {
  server: McpServer
  transport: StreamableHTTPServerTransport
}

class McpService {
  private server: http.Server | null = null
  private port = 5032
  private host = '127.0.0.1'
  private running = false
  private token = ''
  private sessions = new Map<string, McpHttpSession>()
  private configService: ConfigService

  constructor() {
    this.configService = ConfigService.getInstance()
  }

  private resolveToken(): string {
    const explicit = String(this.configService.get('mcpToken') || '').trim()
    if (explicit) return explicit
    const fallback = String(this.configService.get('httpApiToken') || '').trim()
    if (fallback) return fallback
    const generated = randomBytes(16).toString('hex')
    this.configService.set('mcpToken', generated)
    return generated
  }

  private checkAuth(req: http.IncomingMessage): boolean {
    if (!this.token) return true
    const header = String(req.headers.authorization || '')
    return header === `Bearer ${this.token}`
  }

  private registerTools(server: McpServer): void {
    const text = (payload: unknown) => ({
      content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }],
    })

    server.registerTool(
      'list_sessions',
      {
        title: '列出会话',
        description: '列出所有聊天会话（私聊与群聊）及其消息量提示',
        inputSchema: { limit: z.number().int().min(1).max(500).optional().describe('最多返回数量，默认全部') },
      },
      async ({ limit }) => {
        const r = await chatService.getSessions()
        if (!r.success) return text(r)
        const sessions = (r.sessions || []).slice(0, limit || undefined).map((s) => ({
          username: s.username,
          displayName: s.displayName || s.username,
          lastTimestamp: s.lastTimestamp,
          messageCountHint: s.messageCountHint ?? null,
          isFolded: s.isFolded ?? false,
        }))
        return text({ success: true, count: sessions.length, sessions })
      },
    )

    server.registerTool(
      'get_messages',
      {
        title: '获取会话消息',
        description: '读取指定会话的消息列表（只读）',
        inputSchema: {
          sessionId: z.string().min(1).describe('会话ID（username，如 wxid_xxx 或 xxx@chatroom）'),
          limit: z.number().int().min(1).max(500).optional().describe('消息条数，默认 50'),
          offset: z.number().int().min(0).optional().describe('偏移量，默认 0'),
        },
      },
      async ({ sessionId, limit, offset }) => {
        const r = await chatService.getMessages(sessionId, offset || 0, limit || 50)
        return text(r.success ? { success: true, messages: r.messages, hasMore: r.hasMore } : r)
      },
    )

    server.registerTool(
      'search_messages',
      {
        title: '搜索消息',
        description: '按关键词搜索聊天记录（可限定会话）',
        inputSchema: {
          keyword: z.string().min(1).describe('搜索关键词'),
          sessionId: z.string().optional().describe('限定会话ID，不传则全库搜索'),
          limit: z.number().int().min(1).max(200).optional().describe('最多返回数量，默认 50'),
        },
      },
      async ({ keyword, sessionId, limit }) => {
        const r = await chatService.searchMessages(keyword, sessionId, limit || 50)
        return text(r.success ? { success: true, messages: r.messages } : r)
      },
    )

    server.registerTool(
      'get_contacts',
      {
        title: '获取联系人信息',
        description: '批量获取联系人的显示名与本地头像 URL',
        inputSchema: { usernames: z.array(z.string().min(1)).min(1).max(100).describe('联系人 username 列表') },
      },
      async ({ usernames }) => {
        const r = await chatService.enrichSessionsContactInfo(usernames)
        return text(r)
      },
    )

    server.registerTool(
      'list_groups',
      {
        title: '列出群聊',
        description: '列出全部群聊及其成员数 / 消息数',
        inputSchema: {},
      },
      async () => {
        const r = await groupAnalyticsService.getGroupChats()
        return text(r)
      },
    )

    server.registerTool(
      'get_group_members',
      {
        title: '获取群成员',
        description: '获取群聊成员列表（含消息量）',
        inputSchema: { chatroomId: z.string().min(1).describe('群聊ID（xxx@chatroom）') },
      },
      async ({ chatroomId }) => {
        const [members, panel] = await Promise.all([
          groupAnalyticsService.getGroupMembers(chatroomId),
          groupAnalyticsService.getGroupMembersPanelData(chatroomId, { includeMessageCounts: true }).catch(() => null),
        ])
        const counts = new Map<string, number>()
        if (panel?.success && panel.data) for (const m of panel.data) counts.set(m.username, m.messageCount)
        const membersOut = (members.success ? members.data || [] : []).map((m) => ({
          username: m.username,
          displayName: m.displayName,
          nickname: m.nickname || null,
          alias: m.alias || null,
          remark: m.remark || null,
          groupNickname: m.groupNickname || null,
          isOwner: m.isOwner ?? false,
          messageCount: counts.get(m.username) ?? null,
        }))
        return text({ success: true, members: membersOut })
      },
    )

    server.registerTool(
      'get_group_stats',
      {
        title: '获取群聊统计',
        description: '群聊活跃时段 / 媒体构成 / 24×7 活跃热力图',
        inputSchema: { chatroomId: z.string().min(1).describe('群聊ID（xxx@chatroom）') },
      },
      async ({ chatroomId }) => {
        const [hours, media, heatmap] = await Promise.all([
          groupAnalyticsService.getGroupActiveHours(chatroomId, 0, 0),
          groupAnalyticsService.getGroupMediaStats(chatroomId, 0, 0),
          groupAnalyticsService.getGroupActivityHeatmap(chatroomId, 0, 0),
        ])
        return text({ success: true, hours: hours.data || null, media: media.data || null, activityHeatmap: heatmap.data || null })
      },
    )

    server.registerTool(
      'get_sns_timeline',
      {
        title: '获取朋友圈时间线',
        description: '读取朋友圈动态（只读）',
        inputSchema: {
          limit: z.number().int().min(1).max(200).optional().describe('数量，默认 20'),
          offset: z.number().int().min(0).optional().describe('偏移，默认 0'),
        },
      },
      async ({ limit, offset }) => {
        const r = await snsService.getTimeline(limit || 20, offset || 0)
        return text(r)
      },
    )

    server.registerTool(
      'get_sns_stats',
      {
        title: '朋友圈统计',
        description: '朋友圈总量统计（动态数 / 好友数）',
        inputSchema: {},
      },
      async () => {
        const r = await snsService.getExportStats({ allowTimelineFallback: true })
        return text(r)
      },
    )

    server.registerTool(
      'get_statistics',
      {
        title: '获取全局统计',
        description: '全局聊天统计（总量 / 类型构成 / 时段分布）',
        inputSchema: {},
      },
      async () => {
        const [stats, time] = await Promise.all([
          analyticsService.getOverallStatistics(),
          analyticsService.getTimeDistribution(),
        ])
        return text({ success: true, statistics: stats.data || null, timeDistribution: time.data || null })
      },
    )

    server.registerTool(
      'get_contact_rankings',
      {
        title: '联系排行榜',
        description: '按消息量排名的联系人 Top 榜',
        inputSchema: { limit: z.number().int().min(1).max(100).optional().describe('数量，默认 20') },
      },
      async ({ limit }) => {
        const r = await analyticsService.getContactRankings(limit || 20)
        return text(r)
      },
    )

    server.registerTool(
      'get_daily_activity',
      {
        title: '每日活跃度',
        description: '每日消息量（全部 / 我发送），日历热力图数据源',
        inputSchema: {},
      },
      async () => {
        const r = await analyticsService.getDailyActivity()
        return text(r)
      },
    )

    server.registerTool(
      'get_word_frequency',
      {
        title: '高频词统计',
        description: '全局文本消息高频词（词云数据源）',
        inputSchema: { limit: z.number().int().min(1).max(200).optional().describe('词数，默认 60') },
      },
      async ({ limit }) => {
        const r = await analyticsService.getWordFrequency(limit || 60)
        return text(r)
      },
    )
  }

  private async createSession(): Promise<McpHttpSession> {
    const server = new McpServer({ name: 'weport-mcp', version: '0.9.11' })
    this.registerTools(server)
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sessionId: string) => {
        // sessionId 在首个 initialize 请求到达时才生成（handleRequest 内部），
        // 只能通过该回调把会话登记到 map 中（过早登记 key 为 undefined 会丢失会话）
        if (!this.sessions.has(sessionId)) {
          this.sessions.set(sessionId, { server, transport })
        }
      },
    })
    transport.onerror = (err: Error) => console.error('[McpService] transport error:', err)
    transport.onclose = () => {
      if (transport.sessionId) this.sessions.delete(transport.sessionId)
    }
    await server.connect(transport)
    return { server, transport }
  }

  async start(port?: number, host?: string): Promise<{ success: boolean; port?: number; error?: string }> {
    if (this.running && this.server) return { success: true, port: this.port }
    if (typeof port === 'number' && Number.isFinite(port) && port > 0) this.port = Math.floor(port)
    if (host) this.host = host
    this.token = this.resolveToken()

    const httpServer = http.createServer((req, res) => {
      void this.handleRequest(req, res)
    })
    httpServer.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        void this.stop()
      }
    })

    return new Promise((resolve) => {
      httpServer.once('error', (err: NodeJS.ErrnoException) => {
        this.server = null
        resolve({ success: false, error: err.code === 'EADDRINUSE' ? `端口 ${this.port} 已被占用` : err.message })
      })
      httpServer.listen(this.port, this.host, () => {
        this.server = httpServer
        this.running = true
        console.log(`[McpService] MCP 服务已启动: http://${this.host}:${this.port}/mcp (token ${this.token ? '已配置' : '无'})`)
        resolve({ success: true, port: this.port })
      })
    })
  }

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (!this.checkAuth(req)) {
      res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ success: false, error: '未授权：需要正确的 Bearer Token' }))
      return
    }

    const url = new URL(req.url || '/', `http://${this.host}:${this.port}`)
    if (url.pathname !== '/mcp') {
      res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ success: false, error: '未知路径' }))
      return
    }

    try {
      const sessionId = String(req.headers['mcp-session-id'] || '')
      let session = sessionId ? this.sessions.get(sessionId) : undefined

      if (req.method === 'DELETE') {
        if (session) {
          await session.transport.close()
          this.sessions.delete(sessionId)
        }
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
        res.end('{}')
        return
      }

      if (!session) {
        session = await this.createSession()
      }

      if (req.method === 'GET') {
        await session.transport.handleRequest(req, res)
        return
      }

      if (req.method === 'POST') {
        const raw = await readBody(req)
        let parsedBody: unknown
        if (raw) {
          try { parsedBody = JSON.parse(raw) } catch { parsedBody = raw }
        }
        await session.transport.handleRequest(req, res, parsedBody)
        return
      }

      res.writeHead(405, { 'Content-Type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ success: false, error: '方法不支持' }))
    } catch (e) {
      console.error('[McpService] request error:', e)
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ success: false, error: String((e as Error)?.message || e) }))
      }
    }
  }

  async stop(): Promise<void> {
    this.running = false
    for (const session of Array.from(this.sessions.values())) {
      try { await session.transport.close() } catch { /* noop */ }
    }
    this.sessions.clear()
    const server = this.server
    this.server = null
    if (server) {
      await new Promise<void>((resolve) => {
        server.close(() => resolve())
        try { server.closeAllConnections?.() } catch { /* noop */ }
        setTimeout(resolve, 1000)
      })
    }
  }

  getStatus(): { running: boolean; port: number; host: string; tokenConfigured: boolean } {
    return { running: this.running, port: this.port, host: this.host, tokenConfigured: !!this.token }
  }
}

function readBody(req: http.IncomingMessage): Promise<string | undefined> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
    req.on('end', () => resolve(chunks.length > 0 ? Buffer.concat(chunks).toString('utf-8') : undefined))
    req.on('error', reject)
  })
}

export const mcpService = new McpService()
