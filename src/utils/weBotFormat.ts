/**
 * WeBot 的界面文案格式化。
 *
 * 为什么与 electron/services/weBotSchedule.ts 里的同名函数重复：
 * 渲染层与主进程分属两个 tsconfig，渲染层无法 import electron/ 下的模块，
 * 仓库里也没有共享目录。这里刻意只保留**展示**逻辑（主进程不需要产生
 * 中文文案），并且两者都有单测锁住行为。
 */

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, Math.floor(value)))

const pad = (value: number): string => String(value).padStart(2, '0')

/** 上午（AM）/ 下午（PM）。 */
export type Meridiem = 'am' | 'pm'

/**
 * 12 小时制的一刻：`上午 8:30`、`下午 12:00`。
 *
 * 内部分钟点**始终是 0–23**（调度器、持久化、`nextRunAfter` 都用 24 小时制，
 * 改掉它们会牵动已落盘的任务），只有显示和录入走 12 小时制。用户看到的
 * 「12:00 下午」= 内部的 12:00，与 iOS/微信的表述一致。
 */
export function formatClock(hour24: number, minute: number): string {
  const hour = ((Math.floor(Number(hour24) || 0) % 24) + 24) % 24
  const mins = clamp(Number(minute) || 0, 0, 59)
  return `${hour < 12 ? '上午' : '下午'} ${hour % 12 === 0 ? 12 : hour % 12}:${pad(mins)}`
}

/** 24 小时制 → 12 小时制录入值（1–12 + 上午/下午）。 */
export function toTwelveHour(hour24: number): { hour: number; meridiem: Meridiem } {
  const hour = ((Math.floor(Number(hour24) || 0) % 24) + 24) % 24
  return { hour: hour % 12 === 0 ? 12 : hour % 12, meridiem: hour < 12 ? 'am' : 'pm' }
}

/** 12 小时制录入值 → 24 小时制。`12 上午` = 0 点，`12 下午` = 12 点。 */
export function toTwentyFourHour(hour12: number, meridiem: Meridiem): number {
  const raw = clamp(Number(hour12) || 12, 1, 12)
  const base = raw === 12 ? 0 : raw
  return meridiem === 'pm' ? base + 12 : base
}

/** 时间戳 → `09-21 下午 8:15`（运行记录里每一行的时刻）。 */
export function formatStamp(ms: number): string {
  const then = new Date(ms)
  return `${pad(then.getMonth() + 1)}-${pad(then.getDate())} ${formatClock(then.getHours(), then.getMinutes())}`
}

/** 耗时：`3.4 秒` / `1 分 12 秒` / `1 小时 3 分`。 */
export function formatDuration(ms: number | undefined): string {
  const value = Number(ms)
  if (!Number.isFinite(value) || value < 0) return '—'
  if (value < 10_000) return `${Math.round(value / 100) / 10} 秒`
  if (value < 60_000) return `${Math.round(value / 1000)} 秒`
  const minutes = Math.floor(value / 60_000)
  const seconds = Math.round((value % 60_000) / 1000)
  if (minutes < 60) return seconds > 0 ? `${minutes} 分 ${seconds} 秒` : `${minutes} 分`
  const hours = Math.floor(minutes / 60)
  return `${hours} 小时 ${minutes % 60} 分`
}

/** 运行状态的中文标签。 */
export function runStatusLabel(status: string): string {
  if (status === 'running') return '运行中'
  if (status === 'ok') return '成功'
  if (status === 'skipped') return '已中止'
  return '失败'
}

/** 「每天 上午 8:30」这类人类可读的规则描述。 */
export function describeSchedule(schedule: WeBotSchedule): string {
  if (schedule.kind === 'daily') return `每天 ${formatClock(schedule.hour, schedule.minute)}`
  if (schedule.kind === 'weekly') {
    const names = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
    return `每${names[clamp(schedule.weekday, 0, 6)]} ${formatClock(schedule.hour, schedule.minute)}`
  }
  if (schedule.kind === 'monthly') {
    return `每月 ${clamp(schedule.day, 1, 31)} 日 ${formatClock(schedule.hour, schedule.minute)}`
  }
  const minutes = Math.max(1, Math.floor(schedule.everyMinutes))
  if (minutes % 60 === 0) return `每 ${minutes / 60} 小时`
  return `每 ${minutes} 分钟`
}

/** 「下次 明天 上午 8:30」。 */
export function describeNextRun(nextRunMs: number | null, nowMs: number = Date.now()): string {
  if (nextRunMs === null || !Number.isFinite(nextRunMs)) return '未启用'
  const next = new Date(nextRunMs)
  const now = new Date(nowMs)
  const time = formatClock(next.getHours(), next.getMinutes())
  if (next.toDateString() === now.toDateString()) return `今天 ${time}`
  const tomorrow = new Date(nowMs)
  tomorrow.setDate(tomorrow.getDate() + 1)
  if (next.toDateString() === tomorrow.toDateString()) return `明天 ${time}`
  return `${next.getMonth() + 1} 月 ${next.getDate()} 日 ${time}`
}

/** 相对时间（笔记列表用）：刚刚 / 5 分钟前 / 昨天 下午 2:20 / 8 月 3 日。 */
export function describeRelativeTime(ms: number, nowMs: number = Date.now()): string {
  const delta = nowMs - ms
  if (delta < 60_000) return '刚刚'
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)} 分钟前`

  const then = new Date(ms)
  const now = new Date(nowMs)
  const time = formatClock(then.getHours(), then.getMinutes())
  if (then.toDateString() === now.toDateString()) return `今天 ${time}`
  const yesterday = new Date(nowMs)
  yesterday.setDate(yesterday.getDate() - 1)
  if (then.toDateString() === yesterday.toDateString()) return `昨天 ${time}`
  if (delta < 7 * 86_400_000) return `${Math.floor(delta / 86_400_000)} 天前`
  return `${then.getMonth() + 1} 月 ${then.getDate()} 日`
}

export const CATCH_UP_OPTIONS: Array<{ id: WeBotCatchUp; label: string; hint: string }> = [
  { id: 'once', label: '补最近一次', hint: '机器休眠后，补跑最近错过的那次（推荐）' },
  { id: 'skip', label: '不补跑', hint: '错过就跳过，等下一个周期' },
  { id: 'all', label: '全部补齐', hint: '把错过的每次都跑一遍（最多 5 次）' },
]

export const WEEKDAY_OPTIONS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
