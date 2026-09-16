/**
 * llm/proxy —— OpenAI 兼容上游流式代理（v0.9.10）。
 *
 * 服务端不本地运行任何模型（RAM 预算 <100MB 的前提）：只做 HTTPS 流式转发。
 * - 上游：POST {WECLONE_LLM_BASE_URL}/chat/completions，stream:true，
 *   Authorization: Bearer {WECLONE_LLM_API_KEY}。
 * - 默认强制与 WeportAI 客户端同款配置：opencode-go 网关
 *   （https://opencode.ai/zen/go/v1）+ muse-spark-1.2-contributor。
 *   WECLONE_LLM_BASE_URL / WECLONE_LLM_MODEL 环境变量仍可覆盖（自建网关用），
 *   但缺省即锁定 opencode-go，不再回落 deepseek-chat。
 * - baseUrl 以 /v1 结尾时直接拼 /chat/completions；否则补 /v1 前缀
 *   （兼容 WECLONE_LLM_BASE_URL=https://api.deepseek.com 这类裸域名覆盖）。
 * - 未配置 API key 时进入 mock 模式：回显最后一条 user 消息，
 *   前缀 "[Mock WeClone] "（本地联调 SSE 用），只告警一次。
 * - 解析上游 SSE `data: {...choices[0].delta.content}` 逐 delta yield；
 *   `data: [DONE]` 结束。
 */

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface StreamChatOptions {
  messages: LlmMessage[]
  temperature?: number
  maxTokens?: number
  /** 客户端断开时中止上游请求 */
  signal?: AbortSignal
}

const UPSTREAM_TIMEOUT_MS = 90_000
const MOCK_ECHO_MAX_CHARS = 500
let warnedNoKey = false

/** 默认强制：OpenCode Go 订阅网关 + DeepSeek V4.1 Flash（与 WeportAI 一致） */
export const DEFAULT_LLM_BASE_URL = 'https://opencode.ai/zen/go/v1'
export const DEFAULT_LLM_MODEL = 'deepseek-v4.1-flash'

/**
 * 网关要求的会话标识头。
 *
 * OpenCode Go 会按它做路由和缓存亲和：不带这个头，`/chat/completions` 直接回
 * 400 MissingSessionID（"cannot be routed efficiently"），所以它不是可选装饰。
 * 每个服务进程固定一个值即可 —— 这里要的是"同一来源"，不是逐请求唯一。
 */
const GATEWAY_SESSION_ID = `weclone-${process.pid}-${Date.now().toString(36)}`

/** 只在 OpenCode 网关上抬头：别的服务对陌生 header 没有耐心。 */
function gatewayHeaders(): Record<string, string> {
  return /opencode\.ai/i.test(llmBaseUrl()) ? { 'x-opencode-session': GATEWAY_SESSION_ID } : {}
}

export function isLlmConfigured(): boolean {
  return Boolean(process.env.WECLONE_LLM_API_KEY)
}

function llmBaseUrl(): string {
  return (process.env.WECLONE_LLM_BASE_URL || DEFAULT_LLM_BASE_URL).replace(/\/+$/, '')
}

function llmModel(): string {
  return process.env.WECLONE_LLM_MODEL || DEFAULT_LLM_MODEL
}

/** baseUrl 已含版本段（…/v1）则直接拼路径，否则补 /v1 */
function chatCompletionsUrl(): string {
  const base = llmBaseUrl()
  return /\/v\d+$/.test(base) ? `${base}/chat/completions` : `${base}/v1/chat/completions`
}

/**
 * 流式对话：逐 delta 产出文本片段。抛错时由调用方决定降级文案。
 */
export async function* streamChatWithLLM(opts: StreamChatOptions): AsyncGenerator<string, void, undefined> {
  const apiKey = process.env.WECLONE_LLM_API_KEY
  if (!apiKey) {
    if (!warnedNoKey) {
      console.warn('[llm/proxy] WECLONE_LLM_API_KEY not configured — serving "[Mock WeClone]" echo replies (dev only)')
      warnedNoKey = true
    }
    yield* mockStream(opts.messages)
    return
  }

  const controller = new AbortController()
  const onClientAbort = () => controller.abort()
  if (opts.signal) {
    if (opts.signal.aborted) controller.abort()
    else opts.signal.addEventListener('abort', onClientAbort, { once: true })
  }
  const timeout = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS)

  try {
    const res = await fetch(chatCompletionsUrl(), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
        Accept: 'text/event-stream',
        ...gatewayHeaders(),
      },
      body: JSON.stringify({
        model: llmModel(),
        messages: opts.messages,
        stream: true,
        temperature: opts.temperature ?? 0.9,
        max_tokens: opts.maxTokens ?? (Number(process.env.WECLONE_LLM_MAX_TOKENS) || 1024),
      }),
      signal: controller.signal,
    })

    if (!res.ok || !res.body) {
      const detail = await res.text().catch(() => '')
      throw new Error(`LLM upstream ${res.status}${detail ? `: ${detail.slice(0, 200)}` : ''}`)
    }

    // Node 18 fetch body 是 web ReadableStream —— 按 SSE 帧解析
    const decoder = new TextDecoder()
    let buffer = ''
    for await (const value of res.body as unknown as AsyncIterable<Uint8Array>) {
      buffer += decoder.decode(value, { stream: true })
      let sep: number
      while ((sep = buffer.indexOf('\n\n')) >= 0) {
        const rawEvent = buffer.slice(0, sep)
        buffer = buffer.slice(sep + 2)
        for (const line of rawEvent.split('\n')) {
          const trimmed = line.trim()
          if (!trimmed.startsWith('data:')) continue
          const data = trimmed.slice(5).trim()
          if (!data) continue
          if (data === '[DONE]') return
          try {
            const json = JSON.parse(data) as {
              choices?: Array<{ delta?: { content?: unknown; reasoning_content?: unknown } }>
              usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_cache_hit_tokens?: number }
            }
            // The gateway reports usage on the final frame. Logging it is what makes the
            // cache measurable from the outside: without these numbers, "the clone is
            // fast" and "the prefix is cached" are indistinguishable claims.
            if (json.usage) {
              const promptTokens = Number(json.usage.prompt_tokens) || 0
              const hit = Number(json.usage.prompt_cache_hit_tokens) || 0
              const rate = promptTokens > 0 ? Math.round((hit / promptTokens) * 1000) / 10 : null
              console.log(
                `[llm/proxy] usage prompt=${promptTokens} cacheHit=${hit} rate=${rate === null ? 'n/a' : `${rate}%`} completion=${Number(json.usage.completion_tokens) || 0}`,
              )
            }
            const delta = json.choices?.[0]?.delta?.content
            if (typeof delta === 'string' && delta.length > 0) yield delta
          } catch {
            // 忽略无法解析的心跳/注释帧
          }
        }
      }
    }
  } finally {
    clearTimeout(timeout)
    opts.signal?.removeEventListener('abort', onClientAbort)
  }
}

/** 收集完整回复（非流式路径用） */
export async function collectStream(gen: AsyncGenerator<string, void, undefined>): Promise<string> {
  let out = ''
  for await (const delta of gen) out += delta
  return out
}

/**
 * 一次性拿到完整回复，空回复重试。
 *
 * 为什么需要重试：RAG 提示词偏长时，模型偶尔只产出 `reasoning_content` 而
 * `choices[0].delta.content` 始终为空（实测 4 轮对话里出现过 1 次）。对用户来说
 * 那是一条**空消息**——比慢一点、比花多几个 token 都糟，因为看起来像坏掉了。
 * 只重试一次，并把重试次数记进日志，避免悄悄变成无限重试。
 */
export async function collectStreamWithRetry(
  makeStream: () => AsyncGenerator<string, void, undefined>,
  attempts = 2,
): Promise<string> {
  let last = ''
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    last = await collectStream(makeStream())
    if (last.trim()) {
      if (attempt > 1) console.warn(`[llm/proxy] empty reply on attempt ${attempt - 1}, retry produced ${last.length} chars`)
      return last
    }
  }
  console.warn('[llm/proxy] all attempts returned an empty reply')
  return last
}

// ---------------------------------------------------------------------------
// Mock（未配置 key 时）：回显最后一条 user 消息，前缀 "[Mock WeClone] "
// ---------------------------------------------------------------------------

async function* mockStream(messages: LlmMessage[]): AsyncGenerator<string, void, undefined> {
  const lastUser = [...messages].reverse().find((m) => m.role === 'user')
  const reply = `[Mock WeClone] ${String(lastUser?.content ?? '').slice(0, MOCK_ECHO_MAX_CHARS)}`
  for (let i = 0; i < reply.length; i += 8) {
    yield reply.slice(i, i + 8)
    await sleep(10)
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
