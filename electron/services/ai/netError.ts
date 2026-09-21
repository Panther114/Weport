/**
 * `fetch failed` 的翻译层。
 *
 * 为什么必须有这一层：Node/Electron 的 `fetch`（undici）在网络层失败时只抛
 * `TypeError: fetch failed`，真正的 errno（`ENOTFOUND` / `ECONNREFUSED` /
 * `UND_ERR_CONNECT_TIMEOUT` …）藏在 `error.cause` 里，再往里还可能是
 * `AggregateError`（多地址尝试全失败）。只取 `.message` 的代码，就会把这个
 * 信息完整、却完全不可读的错误原样丢给用户 —— WeBot 笔记里那句
 * 「上次失败：fetch failed」正是这么来的：用户拿到的是 undici 的内部措辞，
 * 既不知道是 DNS 还是超时，也不知道该改什么。
 *
 * 两条规则：
 * 1. **展开 cause 链**，把最内层的 code / syscall / host 拿出来；
 * 2. **连接阶段的失败可以重试**，但只在"请求肯定没送达"的错误码上重试
 *    （DNS、连接建立失败）。`ECONNRESET` / `UND_ERR_SOCKET` 可能是请求已经
 *    收到、响应中途断开 —— 重试就等于把一次调用计费两次，所以不重试。
 */

/** 从任意层级的错误里挖出来的网络事实。 */
export interface NetworkFailureFacts {
  /** 最内层的 errno 风格 code（大写，如 `ENOTFOUND`）。找不到时为空串。 */
  code: string
  /** 目标主机（能从错误里解析出来时）。 */
  host: string
  /** 逐层消息，最内层在前。 */
  chain: string[]
}

const CODE_HINTS: Record<string, string> = {
  ENOTFOUND: '域名解析失败（域名不存在或当前网络无法解析）',
  EAI_AGAIN: '域名解析暂时失败（DNS 服务器无响应）',
  ECONNREFUSED: '连接被拒绝（对方端口没有在监听）',
  ECONNRESET: '连接被对方重置',
  ETIMEDOUT: '连接超时',
  UND_ERR_CONNECT_TIMEOUT: '连接超时',
  UND_ERR_HEADERS_TIMEOUT: '等待响应头超时',
  UND_ERR_BODY_TIMEOUT: '读取响应超时',
  UND_ERR_SOCKET: '连接中断（对端在响应完成前关闭）',
  UND_ERR_CLOSED: '连接已被关闭',
  CERT_HAS_EXPIRED: 'TLS 证书已过期',
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'TLS 证书链无法验证',
  SELF_SIGNED_CERT_IN_CHAIN: 'TLS 证书是自签名的',
  DEPTH_ZERO_SELF_SIGNED_CERT: 'TLS 证书是自签名的',
  ERR_TLS_CERT_ALTNAME_INVALID: 'TLS 证书与域名不匹配',
  EPROTO: 'TLS 握手失败',
  ERR_SSL_WRONG_VERSION_NUMBER: 'TLS 协议版本不匹配',
  EPERM: '系统拒绝了这个连接',
  EACCES: '系统拒绝了这个连接',
}

/**
 * 只有**确定请求没送达**的错误才允许重试。
 *
 * `ECONNRESET` / `UND_ERR_SOCKET` 恰恰是"可能已经送达"的那一类：把它们也重试，
 * 一次网络抖动就会让用户按两次 token 计费。
 */
const RETRYABLE_CODES = new Set([
  'ENOTFOUND',
  'EAI_AGAIN',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'UND_ERR_CONNECT_TIMEOUT',
])

function pushCauseChain(error: unknown, out: unknown[], depth = 0): void {
  if (!error || typeof error !== 'object' || depth > 6) return
  out.push(error)
  const nested = (error as { cause?: unknown }).cause
  if (nested !== error) pushCauseChain(nested, out, depth + 1)
  // AggregateError（多地址尝试）：每一支都要看一眼，否则会漏掉真正的 errno。
  const errors = (error as { errors?: unknown }).errors
  if (Array.isArray(errors)) for (const item of errors) pushCauseChain(item, out, depth + 1)
}

function readField(error: unknown, key: string): string {
  const value = (error as Record<string, unknown> | null)?.[key]
  if (typeof value === 'string' && value.trim()) return value.trim()
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return ''
}

/** 把错误摊平成 `{ code, host, chain }`。纯函数，便于单测。 */
export function readNetworkFailure(error: unknown): NetworkFailureFacts {
  const chain: unknown[] = []
  pushCauseChain(error, chain)

  let code = ''
  let host = ''
  const messages: string[] = []
  for (const item of chain) {
    const itemCode = readField(item, 'code').toUpperCase()
    // `ERR_INVALID_URL` 这类不是网络路径错误，但也比 "fetch failed" 有用。
    if (!code && itemCode) code = itemCode
    if (!host) {
      const itemHost = readField(item, 'hostname') || readField(item, 'host')
      if (itemHost) host = itemHost
    }
    const address = readField(item, 'address')
    if (!host && address) host = address
    const message = readField(item, 'message')
    if (message && !messages.includes(message)) messages.push(message)
  }

  return { code, host, chain: messages }
}

/** 一行中文结论。认不出的错误也要把原始链路带出来，绝不退回 `fetch failed`。 */
export function describeNetworkFailure(error: unknown): string {
  const { code, host, chain } = readNetworkFailure(error)
  const target = host ? `${host} ` : ''
  const hint = CODE_HINTS[code]
  if (hint) return `网络请求失败：${target}${hint}（${code}）`
  // 认不出的 code：用**最内层**那句真正有意义的话。`chain` 是从外往内收的，
  // 第一项永远是 undici 的 `fetch failed` —— 拿它当结论等于什么都没说。
  const detail = chain.find((line) => line && !/^fetch failed$/i.test(line)) || chain[0] || '原因未知'
  if (code) return `网络请求失败：${target}${detail}（${code}）`
  return `网络请求失败：${target}${detail}`
}

export function shouldRetryNetworkFailure(error: unknown): boolean {
  if (isAbortError(error)) return false
  const { code } = readNetworkFailure(error)
  if (!code) return false
  return RETRYABLE_CODES.has(code)
}

export function isAbortError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const name = readField(error, 'name')
  return name === 'AbortError' || name === 'TimeoutError' || readField(error, 'code') === 'ABORT_ERR'
}

/**
 * 把原始网络错误换成一句能读的话，同时保留 cause（调试时仍能看到 undici 的原文）。
 *
 * 已经是可读错误的（HTTP 状态码那一类）原样放行：`readError()` 抛出的
 * `HTTP 401` 之类不该被翻译成"网络请求失败"。
 */
export function enrichNetworkError(error: unknown, url?: string): Error {
  if (isAbortError(error)) return error as Error
  if ((error as { status?: unknown })?.status !== undefined) return error as Error
  const base = error instanceof Error ? error : new Error(String(error))
  const detail = describeNetworkFailure(error)
  const withUrl = url && !detail.includes(url) ? `${detail}｜${url}` : detail
  const enriched = new Error(withUrl)
  ;(enriched as Error & { cause?: unknown }).cause = base
  return enriched
}

type FetchLike = (url: string, init: RequestInit) => Promise<Response>
type SleepLike = (ms: number) => Promise<void>

const defaultSleep: SleepLike = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * 带连接阶段重试的 `fetch`。
 *
 * 重试预算刻意很小（默认 2 次、总延迟 2 秒）：定时任务失败时用户要的是**读得懂
 * 的原因**，不是让一条已经明显断网的请求再拖十几秒。
 */
export async function fetchWithRetry(
  url: string,
  init: RequestInit,
  options: { retries?: number; delaysMs?: number[]; fetchImpl?: FetchLike; sleep?: SleepLike } = {}
): Promise<Response> {
  const fetchImpl = options.fetchImpl || (globalThis.fetch as unknown as FetchLike)
  const delays = options.delaysMs || [400, 1200]
  const retries = Math.max(0, Math.min(options.retries ?? delays.length, delays.length))
  const sleep = options.sleep || defaultSleep

  let attempt = 0
  for (;;) {
    try {
      return await fetchImpl(url, init)
    } catch (error) {
      const retryable = attempt < retries && shouldRetryNetworkFailure(error) && !init.signal?.aborted
      if (!retryable) throw enrichNetworkError(error, url)
      await sleep(delays[attempt])
      attempt += 1
    }
  }
}
