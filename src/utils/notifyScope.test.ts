import { describe, expect, it } from 'vitest'
import { summarizeNotifyScope } from './notifyScope'

/**
 * 「接收范围」那行文案（v1.0.1）。
 *
 * 用户报的 bug：「跟随微信消息免打扰」打开后，微信里标了免打扰的会话确实不弹窗，
 * 但头上仍写着「屏蔽 3 个会话的通知」—— 免打扰的那些一个都没算进去。这里的用例
 * 就是把"算进去"这件事钉死，顺带钉住"还不知道免打扰数量时不要假装是 0"。
 */

describe('blacklist：屏蔽数 = 已选 ∪ 跟随免打扰', () => {
  it('免打扰会话计入屏蔽数', () => {
    const summary = summarizeNotifyScope({ mode: 'blacklist', selectedCount: 3, mutedExtraCount: 41, followMute: true })
    expect(summary.primary).toBe('屏蔽 44 个会话的通知')
    expect(summary.detail).toBe('已选 3 + 跟随微信免打扰 41')
    expect(summary.blockedCount).toBe(44)
  })

  it('关掉跟随时不把免打扰算进去', () => {
    const summary = summarizeNotifyScope({ mode: 'blacklist', selectedCount: 3, mutedExtraCount: 41, followMute: false })
    expect(summary.primary).toBe('屏蔽 3 个会话的通知')
    expect(summary.detail).toBeUndefined()
    expect(summary.blockedCount).toBe(3)
  })

  it('免打扰数量未知时不假装是 0：只报已选，blockedCount 为 null', () => {
    const summary = summarizeNotifyScope({ mode: 'blacklist', selectedCount: 3, mutedExtraCount: null, followMute: true })
    expect(summary.primary).toBe('屏蔽 3 个会话的通知')
    expect(summary.blockedCount).toBeNull()
    expect(summary.detail).toBeUndefined()
  })

  it('没有免打扰会话时不加多余说明', () => {
    const summary = summarizeNotifyScope({ mode: 'blacklist', selectedCount: 5, mutedExtraCount: 0, followMute: true })
    expect(summary.primary).toBe('屏蔽 5 个会话的通知')
    expect(summary.detail).toBeUndefined()
    expect(summary.blockedCount).toBe(5)
  })

  it('已选为空但跟随免打扰打开时，屏蔽数就是免打扰的数量', () => {
    const summary = summarizeNotifyScope({ mode: 'blacklist', selectedCount: 0, mutedExtraCount: 12, followMute: true })
    expect(summary.primary).toBe('屏蔽 12 个会话的通知')
    expect(summary.detail).toBe('已选 0 + 跟随微信免打扰 12')
  })
})

describe('whitelist：说明白"已选里的免打扰同样不会响"', () => {
  it('列出实际不会弹窗的数量', () => {
    const summary = summarizeNotifyScope({ mode: 'whitelist', selectedCount: 10, mutedExtraCount: 2, followMute: true })
    expect(summary.primary).toBe('仅通知已选 10 个会话')
    expect(summary.detail).toBe('其中 2 个会话在微信里是「消息免打扰」，实际不会弹窗')
  })

  it('没有免打扰时不加说明', () => {
    const summary = summarizeNotifyScope({ mode: 'whitelist', selectedCount: 10, mutedExtraCount: 0, followMute: true })
    expect(summary.detail).toBeUndefined()
  })

  it('数量未知时也不编造说明', () => {
    const summary = summarizeNotifyScope({ mode: 'whitelist', selectedCount: 10, mutedExtraCount: null, followMute: true })
    expect(summary.primary).toBe('仅通知已选 10 个会话')
    expect(summary.detail).toBeUndefined()
  })
})

describe('all / mentions', () => {
  it('全部接收时把被免打扰压住的会话数说出来', () => {
    const summary = summarizeNotifyScope({ mode: 'all', selectedCount: 0, mutedExtraCount: 30, followMute: true })
    expect(summary.primary).toBe('接收所有会话的通知')
    expect(summary.detail).toContain('30 个会话')
  })

  it('全部接收且没有免打扰：只有主文案', () => {
    const summary = summarizeNotifyScope({ mode: 'all', selectedCount: 0, mutedExtraCount: 0, followMute: true })
    expect(summary).toEqual({ primary: '接收所有会话的通知', blockedCount: 0 })
  })

  it('仅 @我 模式不受免打扰数字影响（那条路径本来就不弹普通消息）', () => {
    const summary = summarizeNotifyScope({ mode: 'mentions', selectedCount: 3, mutedExtraCount: 30, followMute: true })
    expect(summary.primary).toContain('@你')
    expect(summary.detail).toBeUndefined()
  })
})

describe('脏输入不产生负数或 NaN', () => {
  it('负数与 NaN 被夹到 0', () => {
    const summary = summarizeNotifyScope({
      mode: 'blacklist',
      selectedCount: Number.NaN,
      mutedExtraCount: -5,
      followMute: true,
    })
    expect(summary.primary).toBe('屏蔽 0 个会话的通知')
    expect(summary.blockedCount).toBe(0)
  })
})
