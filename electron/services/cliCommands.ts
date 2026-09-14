/**
 * The concrete CLI command set.
 *
 * Every entry delegates straight to a service the GUI already uses, so a command
 * added here is immediately available to the terminal, and nothing in this file
 * reaches around an existing service to touch the database or the network itself.
 * The exceptions are `cli.ping` (a liveness check for the TUI handshake) and
 * `cli.commands` (the manifest the TUI renders its help from).
 */

import { app } from 'electron'
import { registerCommands, type CommandResult, type CommandSpec } from './weportCommands'
import { chatService } from './chatService'
import { snsService } from './snsService'
import { analyticsService } from './analyticsService'
import { groupAnalyticsService } from './groupAnalyticsService'
import { connectorsService } from './connectors/connectorsService'
import { weportAiService } from './weportAiService'
import { ConfigService } from './config'

const APP_VERSION = (() => {
  try { return String(app.getVersion() || '1.0.0') } catch { return '1.0.0' }
})()

function fail(error: unknown): CommandResult {
  return { success: false, error: String((error as Error)?.message || error) }
}

function asInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = Math.floor(Number(value))
  if (!Number.isFinite(n)) return fallback
  return Math.max(min, Math.min(max, n))
}

/**
 * The last-resort text of a message.
 *
 * `parsedContent` is empty for media and for message kinds the parser does not
 * know, while `rawContent` still holds the XML/plain body. Falling back keeps the
 * terminal from showing blank rows where the GUI shows "[图片]".
 */
function rawTextOf(message: { rawContent?: string; localType?: number }): string {
  const raw = String(message.rawContent || '').trim()
  if (!raw) return ''
  if (raw.startsWith('<') && raw.length > 200) return `[${message.localType ?? '?'}]`
  return raw
}

export function registerCliCommands(): void {
  const config = ConfigService.getInstance()

  const specs: CommandSpec[] = [
    {
      name: 'cli.ping',
      summary: 'Handshake: confirms a Weport engine is attached and returns its version.',
      mutating: false,
      run: () => ({
        success: true,
        data: {
          version: APP_VERSION,
          platform: process.platform,
          arch: process.arch,
          pid: process.pid,
          dbPath: String(config.get('dbPath') || ''),
          myWxid: String(config.get('myWxid') || ''),
          hasKey: Boolean(String(config.get('decryptKey') || '')),
        },
      }),
    },
    {
      name: 'cli.commands',
      summary: 'The full command manifest (used by the TUI to build its help view).',
      mutating: false,
      run: async () => ({
        success: true,
        data: (await import('./weportCommands')).listCommands(),
      }),
    },

    // ---------------------------------------------------------------- 会话 / 消息
    {
      name: 'sessions.list',
      summary: 'List WeChat chats (name, type, last activity, message hint).',
      mutating: false,
      args: [
        { name: 'type', type: 'string', description: 'all | group | private | official' },
        { name: 'keyword', type: 'string' },
        { name: 'limit', type: 'number' },
      ],
      run: async (args, ctx) => {
        const result = await chatService.getSessions()
        if (!result.success) return { success: false, error: result.error }
        const type = String(args.type || 'all')
        const keyword = String(args.keyword || '').trim().toLowerCase()
        const limit = asInt(args.limit, 50, 1, 2000)
        const matched = (result.sessions || []).filter((session) => {
          if (type === 'group' && !String(session.username).endsWith('@chatroom')) return false
          if (type === 'private' && String(session.username).endsWith('@chatroom')) return false
          if (type === 'official' && !String(session.username).startsWith('gh_')) return false
          if (keyword) {
            const haystack = `${session.displayName || ''} ${session.username}`.toLowerCase()
            if (!haystack.includes(keyword)) return false
          }
          return true
        })
        const page = matched.slice(0, limit)
        // Real counts, not the per-row hint: the hint is often absent, and a column of
        // zeros reads as "this chat is empty" rather than "we did not look".
        const counts = page.length > 0
          ? (await chatService.getSessionMessageCounts(page.map((session) => String(session.username)), { preferHintCache: true })).counts || {}
          : {}
        const rows = page.map((session) => {
          const id = String(session.username)
          return {
            id,
            name: session.displayName || (session as { sessionDisplayName?: string }).sessionDisplayName || id,
            type: id.endsWith('@chatroom') ? 'group' : id.startsWith('gh_') ? 'official' : 'private',
            lastAt: Number(session.lastTimestamp || 0),
            messageCount: Number(counts[id] ?? (session as { messageCountHint?: number }).messageCountHint ?? 0),
          }
        })
        return { success: true, data: rows, text: `${rows.length} 个会话（共 ${result.sessions?.length || 0} 个）` }
      },
    },
    {
      name: 'messages.list',
      summary: 'Read messages of one chat.',
      mutating: false,
      args: [
        { name: 'session', type: 'string', required: true },
        { name: 'limit', type: 'number' },
        { name: 'offset', type: 'number' },
      ],
      run: async (args) => {
        const sessionId = String(args.session || '').trim()
        if (!sessionId) return { success: false, error: '缺少 session 参数' }
        const limit = asInt(args.limit, 50, 1, 2000)
        const offset = asInt(args.offset, 0, 0, Number.MAX_SAFE_INTEGER)
        const result = await chatService.getMessages(sessionId, offset, limit)
        if (!result.success) return { success: false, error: result.error }
        return {
          success: true,
          data: (result.messages || []).map((message) => ({
            id: message.messageKey,
            at: Number(message.createTime || 0),
            from: message.isSend === 1 ? 'me' : 'them',
            sender: message.senderDisplayName || message.senderUsername || '',
            type: Number(message.localType || 1),
            text: String(message.parsedContent || message.content || rawTextOf(message)).slice(0, 4000),
          })),
        }
      },
    },
    {
      name: 'contacts.info',
      summary: 'Resolve display names and avatars for wxids.',
      mutating: false,
      args: [{ name: 'usernames', type: 'string', required: true, description: '逗号分隔' }],
      run: async (args) => {
        const usernames = String(args.usernames || '').split(',').map((value) => value.trim()).filter(Boolean)
        if (usernames.length === 0) return { success: false, error: '缺少 usernames 参数' }
        const result = await chatService.enrichSessionsContactInfo(usernames)
        if (!result.success) return { success: false, error: result.error }
        return { success: true, data: result.contacts }
      },
    },
    {
      name: 'groups.members',
      summary: 'List the members of a group chat.',
      mutating: false,
      args: [{ name: 'chatroom', type: 'string', required: true }],
      run: async (args) => {
        const chatroom = String(args.chatroom || '').trim()
        if (!chatroom) return { success: false, error: '缺少 chatroom 参数' }
        const result = await groupAnalyticsService.getGroupMembers(chatroom)
        if (!result.success) return { success: false, error: result.error }
        return { success: true, data: result.data }
      },
    },

    // ------------------------------------------------------------------ 朋友圈 / 分析
    {
      name: 'sns.timeline',
      summary: 'Moments timeline (朋友圈).',
      mutating: false,
      args: [
        { name: 'limit', type: 'number' },
        { name: 'offset', type: 'number' },
      ],
      run: async (args) => {
        const result = await snsService.getTimeline(asInt(args.limit, 20, 1, 200), asInt(args.offset, 0, 0, Number.MAX_SAFE_INTEGER))
        if (!result.success) return { success: false, error: result.error }
        return { success: true, data: result.timeline }
      },
    },
    {
      name: 'analytics.overview',
      summary: 'Global analytics summary.',
      mutating: false,
      run: async () => {
        const result = await analyticsService.getOverallStatistics()
        if (!result.success) return { success: false, error: result.error }
        return { success: true, data: result.data }
      },
    },
    {
      name: 'analytics.rankings',
      summary: 'Contact ranking by message volume.',
      mutating: false,
      args: [{ name: 'limit', type: 'number' }],
      run: async (args) => {
        const result = await analyticsService.getContactRankings(asInt(args.limit, 20, 1, 200))
        if (!result.success) return { success: false, error: result.error }
        return { success: true, data: result.data }
      },
    },
    {
      name: 'analytics.group',
      summary: 'Group analytics: message ranking and active hours for one chatroom.',
      mutating: false,
      args: [
        { name: 'chatroom', type: 'string', required: true },
        { name: 'limit', type: 'number' },
      ],
      run: async (args) => {
        const chatroom = String(args.chatroom || '').trim()
        if (!chatroom) return { success: false, error: '缺少 chatroom 参数' }
        const [ranking, hours, heatmap] = await Promise.all([
          groupAnalyticsService.getGroupMessageRanking(chatroom, asInt(args.limit, 20, 1, 200)),
          groupAnalyticsService.getGroupActiveHours(chatroom),
          groupAnalyticsService.getGroupActivityHeatmap(chatroom),
        ])
        if (!ranking.success) return { success: false, error: ranking.error }
        return {
          success: true,
          data: {
            ranking: ranking.data,
            activeHours: hours.success ? hours.data : undefined,
            heatmap: heatmap.success ? heatmap.data : undefined,
          },
        }
      },
    },

    // ------------------------------------------------------------------ 连接器
    {
      name: 'connectors.connect',
      summary: 'Store a credential for a connector and verify it immediately.',
      mutating: true,
      args: [
        { name: 'id', type: 'string', description: '连接器 id（默认 todoist）' },
        { name: 'token', type: 'string', required: true },
      ],
      run: async (args) => {
        const id = String(args.id || 'todoist')
        const token = String(args.token || '').trim()
        if (!token) return { success: false, error: '缺少 token 参数' }
        const result = await connectorsService.connect(id, token)
        // Never echo the credential back, not even on failure: the caller already has it.
        return result.success
          ? { success: true, data: { id, connected: true, credentialHint: result.data?.credentialHint } }
          : { success: false, error: result.error }
      },
    },
    {
      name: 'connectors.list',
      summary: 'Connector status (connected services and their credential masks).',
      mutating: false,
      run: () => ({ success: true, data: connectorsService.list() }),
    },
    {
      name: 'connectors.targets',
      summary: 'Targets (projects/labels) a connected service can file into.',
      mutating: false,
      args: [{ name: 'id', type: 'string' }],
      run: async (args) => {
        const id = String(args.id || connectorsService.listConnectedIds()[0] || 'todoist')
        const result = await connectorsService.listTargets(id)
        return result.success ? { success: true, data: result.data } : { success: false, error: result.error }
      },
    },
    {
      name: 'connectors.addTask',
      summary: 'Create a task in a connected service (Todoist).',
      mutating: true,
      args: [
        { name: 'id', type: 'string' },
        { name: 'content', type: 'string', required: true },
        { name: 'dueText', type: 'string', description: '自然语言，如 tomorrow 9am' },
        { name: 'priority', type: 'string', description: 'none | low | medium | high | urgent' },
        { name: 'targetId', type: 'string' },
        { name: 'description', type: 'string' },
      ],
      run: async (args) => {
        const id = String(args.id || connectorsService.listConnectedIds()[0] || 'todoist')
        const result = await connectorsService.createTask(id, {
          content: String(args.content || ''),
          description: args.description ? String(args.description) : undefined,
          dueText: args.dueText ? String(args.dueText) : undefined,
          priority: (args.priority ? String(args.priority) : undefined) as never,
          targetId: args.targetId ? String(args.targetId) : undefined,
        })
        return result.success
          ? { success: true, data: result.data, text: `已创建：${result.data?.content}` }
          : { success: false, error: result.error }
      },
    },

    // ------------------------------------------------------------------ AI / 克隆
    {
      name: 'ai.status',
      summary: 'WeportAI provider status: active profile, model, per-consumer assignment.',
      mutating: false,
      run: () => {
        const profiles = weportAiService.listProviderProfiles()
        const activeId = weportAiService.getActiveProfileId()
        const active = profiles.find((profile) => profile.id === activeId)
        return {
          success: true,
          data: {
            active: active ? { id: active.id, name: active.name, providerId: active.providerId, model: active.model } : null,
            profiles: profiles.map((profile) => ({ id: profile.id, name: profile.name, providerId: profile.providerId, model: profile.model })),
            assignments: weportAiService.getConsumerAssignments(),
          },
        }
      },
    },
    {
      name: 'ai.costs',
      summary: 'Per-model pricing (USD per million tokens) for the configured profiles.',
      mutating: false,
      args: [{ name: 'models', type: 'string', description: '逗号分隔；留空返回所有已配置模型' }],
      run: (args) => {
        const setup = weportAiService.getSetup()
        const costs = setup.modelCosts || {}
        const wanted = String(args.models || '')
          .split(',')
          .map((value) => value.trim())
          .filter(Boolean)
        const modelIds = wanted.length > 0 ? wanted : Object.keys(costs)
        const rows = modelIds.map((model) => {
          const cost = costs[model]
          return {
            model,
            // 未收录就是 null，不是 0 —— 未定价和免费是两件事
            input: cost?.input ?? null,
            output: cost?.output ?? null,
            cacheRead: cost?.cacheRead ?? null,
            cacheWrite: cost?.cacheWrite ?? null,
            reasoning: cost?.reasoning ?? null,
            source: cost?.source ?? null,
          }
        })
        const priced = rows.filter((row) => row.input !== null || row.output !== null).length
        return {
          success: true,
          data: { unit: 'USD per 1M tokens', priced, unpriced: rows.length - priced, rows },
          text: rows
            .map((row) =>
              row.input === null && row.output === null
                ? `${row.model}\t未定价`
                : `${row.model}\tin $${row.input ?? '—'} / out $${row.output ?? '—'}`
            )
            .join('\n'),
        }
      },
    },
    {
      name: 'ai.chats',
      summary: 'List WeportAI conversations.',
      mutating: false,
      run: () => ({ success: true, data: weportAiService.listChats() }),
    },
    {
      name: 'ai.ask',
      summary: 'Send one question to WeportAI and wait for the answer.',
      mutating: true,
      args: [
        { name: 'chatId', type: 'string' },
        { name: 'text', type: 'string', required: true },
        { name: 'consumer', type: 'string', description: 'chat | weclone | webot' },
      ],
      run: async (args) => {
        const text = String(args.text || '').trim()
        if (!text) return { success: false, error: '缺少 text 参数' }
        const chatId = String(args.chatId || '').trim() || weportAiService.createChat(text.slice(0, 24)).id
        const consumer = (String(args.consumer || 'chat') as 'chat' | 'weclone' | 'webot')
        const result = await weportAiService.runChat(chatId, text, { consumer })
        if (!result.success) return { success: false, error: result.error }
        // The run streams; the persisted conversation is the authoritative answer.
        const stored = weportAiService.getChat(chatId)
        const answer = [...((stored?.messages || []) as Array<{ role: string; content: string }>)]
          .reverse()
          .find((message) => message.role === 'assistant')
        return { success: true, data: { chatId, answer: answer?.content || '' }, text: answer?.content || '' }
      },
    },

    {
      name: 'ai.compact',
      summary: 'Compact one conversation: fold older turns into the digest and keep the recent window.',
      mutating: true,
      args: [
        { name: 'chatId', type: 'string' },
        { name: 'consumer', type: 'string', description: 'chat | weclone | webot' },
      ],
      run: (args) => {
        const chatId = String(args.chatId || '').trim()
        if (!chatId) return { success: false, error: '缺少 chatId 参数（用 ai.chats 查看）' }
        const consumer = (String(args.consumer || 'chat') as 'chat' | 'weclone' | 'webot')
        const result = weportAiService.compactChat(chatId, { consumer })
        if (!result.success) return { success: false, error: result.error || '压缩失败' }
        // 「没压」和「压了」必须分开报：把 below-threshold 说成成功会让用户以为
        // 上下文已经腾空，紧接着下一轮又看到同样的占用。
        return {
          success: true,
          data: result,
          text: result.changed
            ? `已压缩：归档 ${result.dropped} 条，保留 ${result.kept} 条，摘要 ${result.digestChars} 字`
            : '当前上下文尚未超过压缩阈值，未做改动',
        }
      },
    },

    {
      name: 'ai.setup',
      summary: 'Replace the provider configuration with one service and verify it end to end.',
      mutating: true,
      args: [
        { name: 'key', type: 'string', required: true },
        { name: 'model', type: 'string', description: '默认 deepseek-v4.1-flash' },
        { name: 'baseUrl', type: 'string' },
        { name: 'providerId', type: 'string' },
        { name: 'name', type: 'string' },
        { name: 'keepOthers', type: 'string', description: '传 1 则保留其它服务' },
      ],
      run: async (args) => {
        const key = String(args.key || '').trim()
        if (!key) return { success: false, error: '缺少 key 参数' }
        const model = String(args.model || 'deepseek-v4.1-flash').trim()
        const providerId = String(args.providerId || 'opencode-go').trim()
        const baseUrl = String(args.baseUrl || 'https://opencode.ai/zen/go/v1').trim()
        const name = String(args.name || `OpenCode Go · ${model}`).trim()
        const existing = weportAiService.listProviderProfiles()
        const saved = weportAiService.saveProviderProfile({ name, providerId, protocol: 'openai-compatible', baseUrl, model, apiKey: key })
        if (!saved.success || !saved.profile) return { success: false, error: saved.error || '保存失败' }
        if (String(args.keepOthers || '') !== '1') {
          for (const profile of existing) {
            if (profile.id !== saved.profile.id) weportAiService.deleteProviderProfile(profile.id)
          }
        }
        weportAiService.activateProviderProfile(saved.profile.id)
        for (const consumer of ['chat', 'weclone', 'webot'] as const) weportAiService.assignConsumerProfile(consumer, saved.profile.id)
        return { success: true, data: { profileId: saved.profile.id, providerId, baseUrl, model }, text: `已配置 ${providerId}/${model}` }
      },
    },
    {
      name: 'ai.probe',
      summary: 'Send N turns through the configured service and report cache hits and latency.',
      mutating: true,
      args: [
        { name: 'turns', type: 'number', description: '默认 4' },
        { name: 'consumer', type: 'string', description: 'chat | weclone | webot' },
      ],
      run: async (args) => {
        const turns = Math.max(1, Math.min(12, asInt(args.turns, 4, 1, 12)))
        const consumer = (String(args.consumer || 'chat') as 'chat' | 'weclone' | 'webot')
        const prompts = [
          '用一句话说明你能做什么，不要调用工具。',
          '把刚才那句改短，仍然不要调用工具。',
          '用两条要点总结上面的内容，不要调用工具。',
          '再补一句：这些要点里哪条最重要，为什么。不要调用工具。',
          '最后：回答"收到"两个字即可，不要调用工具。',
        ]
        const chat = weportAiService.createChat('[cli-probe]')
        const rows: Array<Record<string, unknown>> = []
        for (let index = 0; index < turns; index += 1) {
          const startedAt = Date.now()
          const result = await weportAiService.runChat(chat.id, prompts[index % prompts.length], { consumer })
          if (!result.success) {
            weportAiService.deleteChat(chat.id)
            return { success: false, error: result.error }
          }
          const stored = weportAiService.getChat(chat.id)
          const usage = (stored as { usage?: { promptTokens?: number; promptCacheHitTokens?: number } }).usage || {}
          const promptTokens = Number(usage.promptTokens) || 0
          const hit = Number(usage.promptCacheHitTokens) || 0
          rows.push({
            turn: index + 1,
            elapsedMs: Date.now() - startedAt,
            promptTokens,
            cacheHitTokens: hit,
            cacheHitRate: promptTokens > 0 ? Math.round((hit / promptTokens) * 10000) / 100 : null,
          })
        }
        weportAiService.deleteChat(chat.id)
        const rates = rows.slice(1).map((row) => Number(row.cacheHitRate)).filter((value) => Number.isFinite(value))
        const steady = rates.length > 0 ? Math.round((rates.reduce((a, b) => a + b, 0) / rates.length) * 100) / 100 : null
        return { success: true, data: { turns: rows, steadyStateCacheHitRate: steady } }
      },
    },

    // ------------------------------------------------------------------ WeClone
    {
      name: 'weclone.clones',
      summary: 'List the personality clones the configured server knows about.',
      mutating: false,
      run: async () => {
        const server = String(config.get('weCloneServerUrl') || '').trim().replace(/\/+$/, '')
        const token = String(config.get('weCloneServerToken') || '').trim()
        if (!server) return { success: false, error: '未配置 weCloneServerUrl（设置 → 人格克隆）' }
        const response = await fetch(`${server}/api/weclone/list`, {
          headers: token ? { Authorization: `Bearer ${token}` } : {},
          signal: AbortSignal.timeout(30000),
        })
        const payload = (await response.json().catch(() => null)) as { clones?: unknown[]; error?: string } | null
        if (!response.ok) return { success: false, error: payload?.error || `HTTP ${response.status}` }
        const clones = Array.isArray(payload?.clones) ? payload.clones : []
        return { success: true, data: clones, text: `${clones.length} 个克隆` }
      },
    },
    {
      name: 'weclone.chat',
      summary: 'Talk to a clone (the server holds its knowledge base; Weport is just the client).',
      mutating: true,
      args: [
        { name: 'message', type: 'string', required: true },
        { name: 'id', type: 'string', description: '克隆 id；留空则用最近生成的那个' },
        { name: 'name', type: 'string', description: '按名字片段选克隆（如「语音」），避免误聊到旧的' },
        { name: 'history', type: 'string', description: 'JSON 数组，形如 [{"role":"user","content":"…"}]' },
      ],
      run: async (args) => {
        const server = String(config.get('weCloneServerUrl') || '').trim().replace(/\/+$/, '')
        const token = String(config.get('weCloneServerToken') || '').trim()
        if (!server) return { success: false, error: '未配置 weCloneServerUrl（设置 → 人格克隆）' }
        const message = String(args.message || '').trim()
        if (!message) return { success: false, error: '缺少 message 参数' }
        const auth = token ? { Authorization: `Bearer ${token}` } : {}

        let cloneId = String(args.id || '').trim()
        if (!cloneId) {
          const listResponse = await fetch(`${server}/api/weclone/list`, { headers: auth, signal: AbortSignal.timeout(30000) })
          const list = (await listResponse.json().catch(() => null)) as { clones?: Array<{ id?: string; displayName?: string; createdAt?: string }> } | null
          let clones = Array.isArray(list?.clones) ? list.clones : []
          // Selecting by name matters once a server holds more than one clone: the newest
          // rows here were test uploads of the same corpus, and "newest wins" silently
          // picked a legacy clone built from a different corpus entirely.
          const wanted = String(args.name || '').trim().toLowerCase()
          if (wanted) clones = clones.filter((clone) => String(clone.displayName || '').toLowerCase().includes(wanted))
          if (clones.length === 0) {
            return {
              success: false,
              error: wanted
                ? `没有名字包含「${args.name}」的克隆：先在「人格克隆」里生成并上传一个`
                : '服务器上没有这个 token 的克隆：先在「人格克隆」里生成并上传一个',
            }
          }
          clones.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))
          cloneId = String(clones[0]?.id || '')
        }

        let history: unknown[] = []
        if (args.history) {
          try {
            const parsed = JSON.parse(String(args.history))
            if (Array.isArray(parsed)) history = parsed
          } catch {
            return { success: false, error: 'history 必须是 JSON 数组' }
          }
        }

        const started = Date.now()
        const response = await fetch(`${server}/api/weclone/${encodeURIComponent(cloneId)}/chat`, {
          method: 'POST',
          headers: { ...auth, 'Content-Type': 'application/json' },
          // Streamed replies arrive as SSE with the whole text in deltas; the non-stream
          // form returns one JSON body, which is what a terminal caller wants.
          body: JSON.stringify({ message, history, stream: false }),
          signal: AbortSignal.timeout(180000),
        })
        const text = await response.text()
        let payload: { reply?: string; error?: string } | null = null
        try { payload = JSON.parse(text) as { reply?: string; error?: string } } catch { /* html error page */ }
        if (!response.ok || !payload) {
          return { success: false, error: payload?.error || text.slice(0, 200) || `HTTP ${response.status}` }
        }
        const reply = String(payload.reply || '').trim()
        return {
          success: true,
          data: { cloneId, reply, elapsedMs: Date.now() - started },
          text: reply,
        }
      },
    },

    // ------------------------------------------------------------------ 配置
    {
      name: 'config.get',
      summary: 'Read config values (secrets are returned as a boolean, never plaintext).',
      mutating: false,
      args: [{ name: 'keys', type: 'string', description: '逗号分隔，留空返回关键项' }],
      run: (args) => {
        const SECRET = new Set(['decryptKey', 'imageAesKey', 'mcpToken', 'httpApiToken', 'weportAiApiKey', 'weportAiProfilesBlob', 'weCloneServerToken', 'weportConnectorsBlob', 'authPassword'])
        const keys = String(args.keys || '').split(',').map((value) => value.trim()).filter(Boolean)
        const wanted = keys.length > 0 ? keys : ['dbPath', 'myWxid', 'colorMode', 'notificationDuration', 'launchAtStartup', 'connectorsAllowAgent']
        const data: Record<string, unknown> = {}
        for (const key of wanted) {
          if (SECRET.has(key)) {
            data[key] = Boolean(String(config.get(key as never) || ''))
            continue
          }
          data[key] = config.get(key as never)
        }
        return { success: true, data }
      },
    },
    {
      name: 'config.set',
      summary: 'Write one config value.',
      mutating: true,
      args: [
        { name: 'key', type: 'string', required: true },
        { name: 'value', type: 'string', required: true },
      ],
      run: (args) => {
        const key = String(args.key || '').trim()
        if (!key) return { success: false, error: '缺少 key 参数' }
        const raw = String(args.value ?? '')
        const existing = config.get(key as never) as unknown
        let value: unknown = raw
        if (typeof existing === 'boolean') value = raw === 'true' || raw === '1'
        else if (typeof existing === 'number') {
          const n = Number(raw)
          if (!Number.isFinite(n)) return { success: false, error: `${key} 需要数字` }
          value = n
        } else if (Array.isArray(existing)) {
          value = raw.split(',').map((item) => item.trim()).filter(Boolean)
        }
        config.set(key as never, value as never)
        return { success: true, data: { key, value }, text: `${key} = ${JSON.stringify(value)}` }
      },
    },
  ]

  registerCommands(specs)
}
