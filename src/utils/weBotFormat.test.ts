import { describe, expect, it } from 'vitest'
import {
  describeNextRun,
  describeRelativeTime,
  describeSchedule,
  formatClock,
  formatDuration,
  formatStamp,
  runStatusLabel,
  toTwelveHour,
  toTwentyFourHour,
} from './weBotFormat'

/**
 * WeBot 的时间显示（v1.0.1）。
 *
 * 用户报的原话是「执行时间要有 AM/PM，小时是 12 不是 24」。内部一律保持 0–23
 * （调度器、已落盘的任务、nextRunAfter 都用 24 小时制），只有显示与录入走 12
 * 小时制 —— 这些用例把两个边界钉死：`12 上午` = 0 点、`12 下午` = 12 点。
 */

describe('formatClock：12 小时制的一刻', () => {
  it('上午/下午 + 12 进制小时', () => {
    expect(formatClock(8, 30)).toBe('上午 8:30')
    expect(formatClock(13, 5)).toBe('下午 1:05')
    expect(formatClock(0, 0)).toBe('上午 12:00')
    expect(formatClock(12, 0)).toBe('下午 12:00')
    expect(formatClock(23, 59)).toBe('下午 11:59')
  })

  it('分钟补零，小时不补零（12 小时制里没有 08 点这种读法）', () => {
    expect(formatClock(9, 5)).toBe('上午 9:05')
  })

  it('脏输入不产生 25 点这种输出', () => {
    expect(formatClock(25, 70)).toBe('上午 1:59')
    expect(formatClock(-1, 0)).toBe('下午 11:00')
  })
})

describe('12 ↔ 24 小时制换算（录入用）', () => {
  it('12 上午 = 0 点，12 下午 = 12 点', () => {
    expect(toTwentyFourHour(12, 'am')).toBe(0)
    expect(toTwentyFourHour(12, 'pm')).toBe(12)
  })

  it('其它小时按 AM/PM 加减', () => {
    expect(toTwentyFourHour(1, 'am')).toBe(1)
    expect(toTwentyFourHour(1, 'pm')).toBe(13)
    expect(toTwentyFourHour(11, 'pm')).toBe(23)
  })

  it('24 → 12 是它的逆运算', () => {
    for (const hour of [0, 1, 8, 11, 12, 13, 23]) {
      const twelve = toTwelveHour(hour)
      expect(toTwentyFourHour(twelve.hour, twelve.meridiem)).toBe(hour)
    }
  })

  it('越界/缺失的小时按「12 点」处理，不产生负数或 99 点', () => {
    // 12 小时制里没有 0 点：0 / NaN 一律当作「12」
    expect(toTwentyFourHour(0, 'am')).toBe(0)
    expect(toTwentyFourHour(0, 'pm')).toBe(12)
    expect(toTwentyFourHour(Number.NaN, 'pm')).toBe(12)
    expect(toTwentyFourHour(99, 'pm')).toBe(12)
    expect(toTwentyFourHour(99, 'am')).toBe(0)
  })
})

describe('计划描述也说 12 小时制（否则卡片上又出现 23:00）', () => {
  it('每天 / 每周 / 每月', () => {
    expect(describeSchedule({ kind: 'daily', hour: 8, minute: 30 })).toBe('每天 上午 8:30')
    expect(describeSchedule({ kind: 'weekly', weekday: 1, hour: 20, minute: 0 })).toBe('每周一 下午 8:00')
    expect(describeSchedule({ kind: 'monthly', day: 3, hour: 0, minute: 0 })).toBe('每月 3 日 上午 12:00')
  })

  it('间隔任务不受影响', () => {
    expect(describeSchedule({ kind: 'interval', everyMinutes: 120, anchorMs: 0 })).toBe('每 2 小时')
  })

  it('下次执行时间同样用 12 小时制', () => {
    const now = new Date(2026, 8, 21, 9, 0, 0).getTime()
    expect(describeNextRun(new Date(2026, 8, 21, 20, 15).getTime(), now)).toBe('今天 下午 8:15')
    expect(describeNextRun(new Date(2026, 8, 22, 8, 0).getTime(), now)).toBe('明天 上午 8:00')
    expect(describeNextRun(null)).toBe('未启用')
  })

  it('相对时间里的时刻也是 12 小时制', () => {
    const now = new Date(2026, 8, 21, 23, 0, 0).getTime()
    expect(describeRelativeTime(new Date(2026, 8, 21, 14, 20).getTime(), now)).toBe('今天 下午 2:20')
  })
})

describe('运行记录的读数', () => {
  it('时间戳带 AM/PM', () => {
    expect(formatStamp(new Date(2026, 8, 21, 20, 15).getTime())).toBe('09-21 下午 8:15')
  })

  it('耗时分档：秒 / 分秒 / 小时分', () => {
    expect(formatDuration(3_400)).toBe('3.4 秒')
    expect(formatDuration(45_000)).toBe('45 秒')
    expect(formatDuration(72_000)).toBe('1 分 12 秒')
    expect(formatDuration(3_600_000 + 3 * 60_000)).toBe('1 小时 3 分')
  })

  it('耗时缺失（还在跑、旧记录）显示为破折号，不是 0 秒', () => {
    expect(formatDuration(undefined)).toBe('—')
    expect(formatDuration(Number.NaN)).toBe('—')
  })

  it('四种状态都有中文标签', () => {
    expect(runStatusLabel('running')).toBe('运行中')
    expect(runStatusLabel('ok')).toBe('成功')
    expect(runStatusLabel('error')).toBe('失败')
    expect(runStatusLabel('skipped')).toBe('已中止')
  })
})
