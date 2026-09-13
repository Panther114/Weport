import { describe, expect, it } from 'vitest'
import {
  collectDueRuns,
  daysInMonth,
  describeNextRun,
  describeSchedule,
  nextRunAfter,
  type WeBotSchedule,
} from './weBotSchedule'

/**
 * 这些用例全部用「本地时间构造、本地时间断言」，因为调度本身就是本地时间
 * 语义（用户说 08:30 指的是他手表上的 08:30）。
 */
const at = (y: number, m: number, d: number, h = 0, min = 0, s = 0): number =>
  new Date(y, m - 1, d, h, min, s, 0).getTime()

const daily = (hour: number, minute: number): WeBotSchedule => ({ kind: 'daily', hour, minute })

describe('nextRunAfter — daily', () => {
  it('当天时间还没到就返回当天', () => {
    expect(nextRunAfter(daily(8, 30), at(2026, 3, 10, 7, 0))).toBe(at(2026, 3, 10, 8, 30))
  })

  it('当天时间已过就返回第二天', () => {
    expect(nextRunAfter(daily(8, 30), at(2026, 3, 10, 9, 0))).toBe(at(2026, 3, 11, 8, 30))
  })

  it('**严格大于**给定时刻：正好等于时也要顺延，否则会忙循环', () => {
    expect(nextRunAfter(daily(8, 30), at(2026, 3, 10, 8, 30))).toBe(at(2026, 3, 11, 8, 30))
  })

  it('跨月边界正确', () => {
    expect(nextRunAfter(daily(8, 30), at(2026, 3, 31, 9, 0))).toBe(at(2026, 4, 1, 8, 30))
  })

  it('跨年边界正确', () => {
    expect(nextRunAfter(daily(8, 30), at(2026, 12, 31, 9, 0))).toBe(at(2027, 1, 1, 8, 30))
  })

  it('非法时分被夹到合法范围而不是抛错', () => {
    expect(nextRunAfter(daily(99, -5), at(2026, 3, 10, 0, 0))).toBe(at(2026, 3, 10, 23, 0))
  })
})

describe('nextRunAfter — weekly', () => {
  it('本周内还没到就返回本周', () => {
    // 2026-03-10 是周二；目标周三
    expect(nextRunAfter({ kind: 'weekly', weekday: 3, hour: 9, minute: 0 }, at(2026, 3, 10, 8, 0))).toBe(
      at(2026, 3, 11, 9, 0)
    )
  })

  it('同一天但时间已过顺延一周', () => {
    expect(nextRunAfter({ kind: 'weekly', weekday: 2, hour: 9, minute: 0 }, at(2026, 3, 10, 10, 0))).toBe(
      at(2026, 3, 17, 9, 0)
    )
  })

  it('同一天时间未到则就是今天', () => {
    expect(nextRunAfter({ kind: 'weekly', weekday: 2, hour: 9, minute: 0 }, at(2026, 3, 10, 8, 0))).toBe(
      at(2026, 3, 10, 9, 0)
    )
  })
})

describe('nextRunAfter — monthly', () => {
  it('当月内还没到就返回当月', () => {
    expect(nextRunAfter({ kind: 'monthly', day: 20, hour: 9, minute: 0 }, at(2026, 3, 10, 8, 0))).toBe(
      at(2026, 3, 20, 9, 0)
    )
  })

  it('已过就返回下个月', () => {
    expect(nextRunAfter({ kind: 'monthly', day: 5, hour: 9, minute: 0 }, at(2026, 3, 10, 8, 0))).toBe(
      at(2026, 4, 5, 9, 0)
    )
  })

  it('**31 号在 2 月被夹到 28 号**，且不会溢出到 3 月', () => {
    const result = nextRunAfter({ kind: 'monthly', day: 31, hour: 9, minute: 0 }, at(2026, 2, 1, 0, 0))
    expect(result).toBe(at(2026, 2, 28, 9, 0))
    expect(new Date(result as number).getMonth()).toBe(1)
  })

  it('闰年 2 月夹到 29 号', () => {
    const result = nextRunAfter({ kind: 'monthly', day: 31, hour: 9, minute: 0 }, at(2028, 2, 1, 0, 0))
    expect(result).toBe(at(2028, 2, 29, 9, 0))
  })
})

describe('nextRunAfter — interval', () => {
  it('从锚点按周期推进', () => {
    const schedule: WeBotSchedule = { kind: 'interval', everyMinutes: 30, anchorMs: at(2026, 3, 10, 8, 0) }
    expect(nextRunAfter(schedule, at(2026, 3, 10, 8, 10))).toBe(at(2026, 3, 10, 8, 30))
  })

  it('锚点在未来时先等锚点', () => {
    const schedule: WeBotSchedule = { kind: 'interval', everyMinutes: 30, anchorMs: at(2026, 3, 10, 12, 0) }
    expect(nextRunAfter(schedule, at(2026, 3, 10, 8, 0))).toBe(at(2026, 3, 10, 12, 0))
  })

  it('间隔小于 1 分钟被夹到 1 分钟（防止忙循环）', () => {
    const schedule: WeBotSchedule = { kind: 'interval', everyMinutes: 0, anchorMs: at(2026, 3, 10, 8, 0) }
    expect(nextRunAfter(schedule, at(2026, 3, 10, 8, 0))).toBe(at(2026, 3, 10, 8, 1))
  })
})

describe('collectDueRuns — 休眠/错过后的补偿', () => {
  it('从未运行过的任务不会在创建瞬间补跑一段虚构的过去', () => {
    expect(collectDueRuns(daily(8, 30), { nowMs: at(2026, 3, 10, 12, 0) })).toEqual([])
  })

  it('skip：完全忽略积压，不补跑', () => {
    const runs = collectDueRuns(daily(8, 30), {
      nowMs: at(2026, 3, 10, 12, 0),
      lastScheduledMs: at(2026, 3, 1, 8, 30),
      catchUp: 'skip',
    })
    expect(runs).toEqual([])
  })

  it('once（默认）：补**最近**一次，而不是最早一次', () => {
    // 机器休眠了 9 天。补跑 3 月 2 日那次对「每天扫描群聊」类任务毫无意义，
    // 用户要的是「现在把今天这次补上」。
    const runs = collectDueRuns(daily(8, 30), {
      nowMs: at(2026, 3, 10, 12, 0),
      lastScheduledMs: at(2026, 3, 1, 8, 30),
    })
    expect(runs).toEqual([at(2026, 3, 10, 8, 30)])
  })

  it('all：补齐所有错过的时间点，但有上限', () => {
    const runs = collectDueRuns(daily(8, 30), {
      nowMs: at(2026, 3, 10, 12, 0),
      lastScheduledMs: at(2026, 3, 1, 8, 30),
      catchUp: 'all',
      maxRuns: 5,
    })
    expect(runs.length).toBe(5)
    expect(runs[0]).toBe(at(2026, 3, 2, 8, 30))
  })

  it('还没到时间就不返回任何执行点', () => {
    expect(
      collectDueRuns(daily(8, 30), { nowMs: at(2026, 3, 10, 7, 0), lastScheduledMs: at(2026, 3, 9, 8, 30) })
    ).toEqual([])
  })

  it('执行点严格递增 —— 保证调度器一定会推进 nextRunAt', () => {
    const runs = collectDueRuns(daily(8, 30), {
      nowMs: at(2026, 3, 10, 12, 0),
      lastScheduledMs: at(2026, 3, 5, 8, 30),
      catchUp: 'all',
      maxRuns: 10,
    })
    for (let i = 1; i < runs.length; i += 1) {
      expect(runs[i]).toBeGreaterThan(runs[i - 1])
    }
  })
})

describe('describeSchedule / describeNextRun', () => {
  it('每种调度都有中文描述', () => {
    expect(describeSchedule(daily(8, 5))).toBe('每天 08:05')
    expect(describeSchedule({ kind: 'weekly', weekday: 1, hour: 9, minute: 0 })).toBe('每周一 09:00')
    expect(describeSchedule({ kind: 'monthly', day: 1, hour: 9, minute: 0 })).toBe('每月 1 日 09:00')
    expect(describeSchedule({ kind: 'interval', everyMinutes: 120, anchorMs: 0 })).toBe('每 2 小时')
    expect(describeSchedule({ kind: 'interval', everyMinutes: 30, anchorMs: 0 })).toBe('每 30 分钟')
  })

  it('下次执行描述区分今天/明天/更远', () => {
    const now = at(2026, 3, 10, 7, 0)
    expect(describeNextRun(at(2026, 3, 10, 8, 30), now)).toBe('今天 08:30')
    expect(describeNextRun(at(2026, 3, 11, 8, 30), now)).toBe('明天 08:30')
    expect(describeNextRun(at(2026, 3, 20, 8, 30), now)).toBe('3 月 20 日 08:30')
    expect(describeNextRun(null, now)).toBe('未启用')
  })
})

describe('daysInMonth', () => {
  it('正确处理 2 月与闰年', () => {
    expect(daysInMonth(2026, 1)).toBe(28)
    expect(daysInMonth(2028, 1)).toBe(29)
    expect(daysInMonth(2026, 3)).toBe(30)
    expect(daysInMonth(2026, 0)).toBe(31)
  })
})
