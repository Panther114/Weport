import { describe, expect, it, vi } from 'vitest'
import {
  describeNetworkFailure,
  enrichNetworkError,
  fetchWithRetry,
  readNetworkFailure,
  shouldRetryNetworkFailure,
} from './netError'

/**
 * `fetch failed` 的翻译层（v1.0.1）。
 *
 * 起因是一个真实投诉：WeBot 笔记里写着「上次失败：fetch failed」——用户既不知道
 * 是 DNS 还是超时，也不知道该改什么。undici 把真正的 errno 塞在 `cause` 里，
 * 而这些用例就是把那条 link 钉死，防止有人"简化"成只读 `.message`。
 */

/** undici 的真实形状：外层 TypeError，errno 在 cause 上。 */
function undiciFailure(code: string, message = 'request failed', host = 'api.example.com'): Error {
  const cause = Object.assign(new Error(message), { code, hostname: host, syscall: 'getaddrinfo' })
  return Object.assign(new TypeError('fetch failed'), { cause })
}

describe('readNetworkFailure：把 cause 链摊平', () => {
  it('读得到最内层的 code 与主机名', () => {
    const facts = readNetworkFailure(undiciFailure('ENOTFOUND'))
    expect(facts.code).toBe('ENOTFOUND')
    expect(facts.host).toBe('api.example.com')
    expect(facts.chain).toContain('fetch failed')
    expect(facts.chain).toContain('request failed')
  })

  it('AggregateError（多个地址全失败）里的 errno 也能挖出来', () => {
    const aggregated = Object.assign(new Error('all attempts failed'), {
      errors: [
        Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED', address: '127.0.0.1' }),
        Object.assign(new Error('connect EHOSTUNREACH'), { code: 'EHOSTUNREACH' }),
      ],
    })
    const outer = Object.assign(new TypeError('fetch failed'), { cause: aggregated })
    expect(readNetworkFailure(outer).code).toBe('ECONNREFUSED')
  })

  it('没有 cause 的普通错误不崩，只是没有 code', () => {
    const facts = readNetworkFailure(new Error('boom'))
    expect(facts.code).toBe('')
    expect(facts.chain).toEqual(['boom'])
  })

  it('null / 字符串 / undefined 都安全', () => {
    expect(readNetworkFailure(null).code).toBe('')
    expect(readNetworkFailure('nope').chain).toEqual([])
    expect(readNetworkFailure(undefined).code).toBe('')
  })

  it('循环 cause 不会无限递归', () => {
    const a = new Error('a')
    ;(a as Error & { cause?: unknown }).cause = a
    expect(readNetworkFailure(a).chain).toEqual(['a'])
  })
})

describe('describeNetworkFailure：给用户看的一句话', () => {
  it('DNS 失败说清是解析失败，并且带上原始 code', () => {
    const text = describeNetworkFailure(undiciFailure('ENOTFOUND'))
    expect(text).toContain('api.example.com')
    expect(text).toContain('域名解析失败')
    expect(text).toContain('ENOTFOUND')
    expect(text).not.toBe('fetch failed')
  })

  it('连接超时与连接被拒绝是两句不同的话', () => {
    expect(describeNetworkFailure(undiciFailure('UND_ERR_CONNECT_TIMEOUT'))).toContain('连接超时')
    expect(describeNetworkFailure(undiciFailure('ECONNREFUSED'))).toContain('连接被拒绝')
  })

  it('认不出的 code 也绝不退回 "fetch failed"', () => {
    const text = describeNetworkFailure(undiciFailure('EWEIRD', 'something odd happened'))
    expect(text).toContain('something odd happened')
    expect(text).not.toBe('fetch failed')
  })

  it('连 code 都没有时仍给出一句话', () => {
    expect(describeNetworkFailure(new TypeError('fetch failed'))).toContain('网络请求失败')
  })
})

describe('enrichNetworkError：保留 cause，HTTP 类错误原样放行', () => {
  it('替换掉 undici 的措辞，但 cause 还在', () => {
    const enriched = enrichNetworkError(undiciFailure('ENOTFOUND'), 'https://api.example.com/v1/chat/completions')
    expect(enriched.message).not.toBe('fetch failed')
    expect(enriched.message).toContain('域名解析失败')
    expect(enriched.message).toContain('https://api.example.com/v1/chat/completions')
    expect((enriched as Error & { cause?: unknown }).cause).toBeInstanceOf(TypeError)
  })

  it('已带 status 的 HTTP 错误不翻译（否则 401 会变成"网络请求失败"）', () => {
    const httpError = Object.assign(new Error('无效的 API key'), { status: 401 })
    expect(enrichNetworkError(httpError)).toBe(httpError)
  })

  it('中止（用户点停止）原样抛出', () => {
    const abort = Object.assign(new Error('This operation was aborted'), { name: 'AbortError' })
    expect(enrichNetworkError(abort)).toBe(abort)
  })
})

describe('shouldRetryNetworkFailure：只重试"肯定没送达"的那一类', () => {
  it('DNS / 连接建立失败可重试', () => {
    expect(shouldRetryNetworkFailure(undiciFailure('ENOTFOUND'))).toBe(true)
    expect(shouldRetryNetworkFailure(undiciFailure('ECONNREFUSED'))).toBe(true)
    expect(shouldRetryNetworkFailure(undiciFailure('UND_ERR_CONNECT_TIMEOUT'))).toBe(true)
  })

  it('连接被重置/中途断开**不**重试（请求可能已经送达并计费）', () => {
    expect(shouldRetryNetworkFailure(undiciFailure('ECONNRESET'))).toBe(false)
    expect(shouldRetryNetworkFailure(undiciFailure('UND_ERR_SOCKET'))).toBe(false)
  })

  it('用户中止不重试', () => {
    const abort = Object.assign(new TypeError('fetch failed'), { cause: { name: 'AbortError' } })
    expect(shouldRetryNetworkFailure(abort)).toBe(false)
  })
})

describe('fetchWithRetry', () => {
  const ok = () => new Response('{}', { status: 200 })

  it('第一次就成功时不重试', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ok())
    const sleep = vi.fn().mockResolvedValue(undefined)
    await fetchWithRetry('https://x/y', {}, { fetchImpl, sleep })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(sleep).not.toHaveBeenCalled()
  })

  it('DNS 抖动后第二次成功', async () => {
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(undiciFailure('ENOTFOUND'))
      .mockResolvedValueOnce(ok())
    const sleep = vi.fn().mockResolvedValue(undefined)
    const response = await fetchWithRetry('https://x/y', {}, { fetchImpl, sleep })
    expect(response.status).toBe(200)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(sleep).toHaveBeenCalledWith(400)
  })

  it('一直失败时抛出的错误是可读的（不是 fetch failed）', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(undiciFailure('ENOTFOUND'))
    const sleep = vi.fn().mockResolvedValue(undefined)
    await expect(fetchWithRetry('https://x/y', {}, { fetchImpl, sleep })).rejects.toThrow(/域名解析失败/)
    expect(fetchImpl).toHaveBeenCalledTimes(3)
  })

  it('不可重试的错误立刻抛出，不浪费重试预算', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(undiciFailure('ECONNRESET'))
    const sleep = vi.fn().mockResolvedValue(undefined)
    await expect(fetchWithRetry('https://x/y', {}, { fetchImpl, sleep })).rejects.toThrow(/连接被对方重置/)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('已中止的信号不重试', async () => {
    const controller = new AbortController()
    controller.abort()
    const fetchImpl = vi.fn().mockRejectedValue(undiciFailure('ENOTFOUND'))
    const sleep = vi.fn().mockResolvedValue(undefined)
    await expect(
      fetchWithRetry('https://x/y', { signal: controller.signal }, { fetchImpl, sleep })
    ).rejects.toThrow()
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })
})
