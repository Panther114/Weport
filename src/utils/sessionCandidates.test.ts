import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  emptyReferenceHint,
  invalidateReferenceCandidates,
  loadReferenceCandidates,
  parseSessionPayload,
  sessionListFromPayload,
  toReferenceCandidates,
} from './sessionCandidates'

/**
 * `@` 引用候选的解析（v1.0.1）。
 *
 * 这个文件存在的唯一理由是那个真实 bug：`chat:getSessions` 返回
 * `{ success, sessions }`，而两个调用点都按 `{ data }` 解包 —— 于是**已经连上
 * 微信**的账号在 WeportAI 与 WeNote 里都显示「还没有可引用的会话（先连接微信）」。
 * 所以这里第一组用例就是把真实返回形状钉死；第二组钉"空结果不进缓存"，
 * 否则用户在连接微信之前打开过页面，`@` 就永久是空的。
 */

describe('会话返回形状：chat:getSessions 的 { sessions } 必须被认出来', () => {
  it('解包 { success, sessions }（真实形状）', () => {
    const payload = { success: true, sessions: [{ username: 'wxid_a' }, { username: 'b@chatroom' }] }
    expect(sessionListFromPayload(payload)).toHaveLength(2)
  })

  it('旧形状 { data } 仍然认（两个入口历史上写过它）', () => {
    expect(sessionListFromPayload({ data: [{ username: 'x' }] })).toHaveLength(1)
  })

  it('裸数组也认', () => {
    expect(sessionListFromPayload([{ username: 'x' }])).toHaveLength(1)
  })

  it('坏输入返回空数组而不是抛异常', () => {
    expect(sessionListFromPayload(null)).toEqual([])
    expect(sessionListFromPayload(undefined)).toEqual([])
    expect(sessionListFromPayload('nope')).toEqual([])
    expect(sessionListFromPayload({})).toEqual([])
  })

  it('真实形状端到端映射出候选（不再是空列表）', () => {
    const result = parseSessionPayload({
      success: true,
      sessions: [
        { username: 'wxid_me', displayName: '我' },
        { username: '12345@chatroom', displayName: '项目群' },
        { username: 'gh_abc', displayName: '某公众号' },
      ],
    })
    expect(result.ok).toBe(true)
    expect(result.candidates).toHaveLength(3)
    // 群聊排前面（两个入口的典型用法都是引用群）
    expect(result.candidates[0]).toMatchObject({ id: '12345@chatroom', kind: 'group' })
  })

  it('success:false 是失败，不是"没有会话"', () => {
    const result = parseSessionPayload({ success: false, error: 'WCDB 未连接' })
    expect(result.ok).toBe(false)
    expect(result.error).toBe('WCDB 未连接')
    expect(result.candidates).toEqual([])
  })
})

describe('候选映射', () => {
  it('类型只按 username 判定，与导出/通知过滤同一套判据', () => {
    const mapped = toReferenceCandidates([
      { username: 'a@chatroom' },
      { username: 'gh_x' },
      { username: 'wxid_plain' },
    ])
    const byId = Object.fromEntries(mapped.map((c) => [c.id, c.kind]))
    expect(byId['a@chatroom']).toBe('group')
    expect(byId['gh_x']).toBe('official')
    expect(byId['wxid_plain']).toBe('private')
  })

  it('没有 username 的行被丢掉（否则会出现一个空名字的候选）', () => {
    expect(toReferenceCandidates([{ displayName: '没 id' }, { username: '  ' }])).toEqual([])
  })

  it('备注与显示名相同时不重复成副标题', () => {
    const [same] = toReferenceCandidates([{ username: 'a', displayName: '张三', remark: '张三' }])
    expect(same.subtitle).toBeUndefined()
    const [diff] = toReferenceCandidates([{ username: 'b', displayName: '张三', remark: '老王' }])
    expect(diff.subtitle).toBe('备注：老王')
  })

  it('没有显示名时回落到 id，绝不产生空标签', () => {
    const [only] = toReferenceCandidates([{ username: 'wxid_only' }])
    expect(only.label).toBe('wxid_only')
  })
})

describe('共享缓存：只有成功且非空的结果才缓存', () => {
  beforeEach(() => {
    invalidateReferenceCandidates()
  })

  it('第一次读到的空结果不被缓存，下一次仍会重新读', async () => {
    const getSessions = vi
      .fn()
      .mockResolvedValueOnce({ success: true, sessions: [] })
      .mockResolvedValueOnce({ success: true, sessions: [{ username: 'wxid_a', displayName: 'A' }] })

    const first = await loadReferenceCandidates(getSessions)
    expect(first.candidates).toEqual([])

    // 用户在这一刻才连上微信 —— 上面那次空结果不能把 `@` 永久锁死
    const second = await loadReferenceCandidates(getSessions)
    expect(second.candidates).toHaveLength(1)
    expect(getSessions).toHaveBeenCalledTimes(2)
  })

  /**
   * 「失败不缓存」与「失败不刷屏」是两件事，必须都成立：
   * - 失败**不会**把空列表写进缓存（否则 `@` 永久是空的）；
   * - 但紧接着的调用会走 3 秒冷却，不会每敲一个字就打一次 IPC。
   *
   * 所以这条断言的是"冷却过后真的会重试"，而不是"下一次立刻重试" ——
   * 后者正是按键刷屏的来源。
   */
  it('失败的结果不被缓存：冷却过后会重新读，连上之后就能列出会话', async () => {
    const getSessions = vi
      .fn()
      .mockResolvedValueOnce({ success: false, error: 'WCDB 未连接' })
      .mockResolvedValueOnce({ success: true, sessions: [{ username: 'wxid_a' }] })

    const failed = await loadReferenceCandidates(getSessions)
    expect(failed.ok).toBe(false)

    // 冷却期内：不重试，也如实说明"稍后会重试"
    const cooled = await loadReferenceCandidates(getSessions)
    expect(cooled.ok).toBe(false)
    expect(getSessions).toHaveBeenCalledTimes(1)

    // 冷却结束后（用户在这期间连上了微信）：
    invalidateReferenceCandidates()
    const ok = await loadReferenceCandidates(getSessions)
    expect(ok.ok).toBe(true)
    expect(ok.candidates).toHaveLength(1)
    expect(getSessions).toHaveBeenCalledTimes(2)
  })

  it('成功且非空的结果被缓存：第二次不再打 IPC', async () => {
    const getSessions = vi.fn().mockResolvedValue({ success: true, sessions: [{ username: 'wxid_a' }] })
    await loadReferenceCandidates(getSessions)
    await loadReferenceCandidates(getSessions)
    expect(getSessions).toHaveBeenCalledTimes(1)
  })

  it('并发调用合并成一次 IPC（两个入口同时挂载）', async () => {
    const getSessions = vi.fn().mockResolvedValue({ success: true, sessions: [{ username: 'wxid_a' }] })
    const [a, b] = await Promise.all([loadReferenceCandidates(getSessions), loadReferenceCandidates(getSessions)])
    expect(getSessions).toHaveBeenCalledTimes(1)
    expect(a.candidates).toHaveLength(1)
    expect(b.candidates).toHaveLength(1)
  })

  it('IPC 抛异常被转成失败结果，而不是让面板崩掉', async () => {
    const getSessions = vi.fn().mockRejectedValue(new Error('boom'))
    const result = await loadReferenceCandidates(getSessions)
    expect(result.ok).toBe(false)
    expect(result.error).toContain('boom')
  })

  /**
   * 失败冷却。
   *
   * `ensureReferenceCandidates` 挂在**每一次按键**上（输入 `@` 之后每打一个字
   * 都会问一次）。失败时缓存是空的，没有冷却的话，用户在输入框里打十个字就是
   * 十次失败的 IPC。
   */
  it('失败后 3 秒内不重复打 IPC', async () => {
    const getSessions = vi.fn().mockResolvedValue({ success: false, error: 'WCDB 未连接' })
    await loadReferenceCandidates(getSessions)
    await loadReferenceCandidates(getSessions)
    await loadReferenceCandidates(getSessions)
    expect(getSessions).toHaveBeenCalledTimes(1)
    const third = await loadReferenceCandidates(getSessions)
    expect(third.ok).toBe(false)
    expect(third.error).toContain('稍后会自动重试')
  })

  it('invalidate 会同时清掉冷却（重新连上微信后要能立刻重试）', async () => {
    const getSessions = vi
      .fn()
      .mockResolvedValueOnce({ success: false, error: 'WCDB 未连接' })
      .mockResolvedValueOnce({ success: true, sessions: [{ username: 'wxid_a' }] })
    await loadReferenceCandidates(getSessions)
    invalidateReferenceCandidates()
    const retry = await loadReferenceCandidates(getSessions)
    expect(retry.ok).toBe(true)
    expect(retry.candidates).toHaveLength(1)
    expect(getSessions).toHaveBeenCalledTimes(2)
  })
})

describe('空态文案：三种情况必须说三句不同的话', () => {
  it('还在读 → 正在读取会话…', () => {
    expect(emptyReferenceHint({ loading: true, ok: true, hasCandidates: false })).toBe('正在读取会话…')
  })

  it('读失败 → 说出原因（不是"先连接微信"）', () => {
    const text = emptyReferenceHint({ loading: false, ok: false, error: 'WCDB 未连接', hasCandidates: false })
    expect(text).toContain('WCDB 未连接')
    expect(text).not.toContain('先连接微信')
  })

  it('读成功但账号没有会话 → 才是"先连接微信"', () => {
    expect(emptyReferenceHint({ loading: false, ok: true, hasCandidates: false })).toContain('先连接微信')
  })

  it('有候选但筛选无命中 → 没有匹配的会话', () => {
    expect(emptyReferenceHint({ loading: false, ok: true, hasCandidates: true })).toBe('没有匹配的会话')
  })
})
