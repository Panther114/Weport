/**
 * WeBot 调度计算（纯函数）。
 *
 * 抽出来单独放的理由：定时任务的正确性几乎全在边界上 —— 月末没有 31 号、
 * 机器休眠错过了几天、夏令时切换、以及「刚跑完必须后移否则会死循环」。
 * 这些用 UI 手工复现极其费时，用纯函数 + 单测则是一分钟的事。
 */

export type WeBotSchedule =
  | { kind: 'daily'; hour: number; minute: number }
  | { kind: 'weekly'; weekday: number; hour: number; minute: number }
  | { kind: 'monthly'; day: number; hour: number; minute: number }
  | { kind: 'interval'; everyMinutes: number; anchorMs: number }

/** 错过执行时间时的补偿策略。 */
export type WeBotCatchUp = 'skip' | 'once' | 'all'

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, Math.floor(value)))

/** 某个月的天数（用于把「每月 31 号」夹到 28/29/30）。 */
export function daysInMonth(year: number, monthIndex: number): number {
  return new Date(year, monthIndex + 1, 0).getDate()
}

/**
 * 给定「不早于 afterMs」的下一次执行时间。
 *
 * 返回值严格大于 afterMs —— 否则跑完一次之后 nextRunAt 不动，调度器会
 * 每次 tick 都认为「现在就是执行时间」，形成忙循环。
 */
export function nextRunAfter(schedule: WeBotSchedule, afterMs: number): number | null {
  const after = Number(afterMs)
  if (!Number.isFinite(after)) return null

  if (schedule.kind === 'interval') {
    const period = Math.max(1, Math.floor(schedule.everyMinutes)) * 60_000
    const anchor = Number.isFinite(schedule.anchorMs) ? schedule.anchorMs : after
    if (after < anchor) return anchor
    const elapsed = after - anchor
    return anchor + (Math.floor(elapsed / period) + 1) * period
  }

  const hour = clamp(schedule.hour, 0, 23)
  const minute = clamp(schedule.minute, 0, 59)

  if (schedule.kind === 'daily') {
    const candidate = new Date(after)
    candidate.setHours(hour, minute, 0, 0)
    if (candidate.getTime() <= after) candidate.setDate(candidate.getDate() + 1)
    return candidate.getTime()
  }

  if (schedule.kind === 'weekly') {
    const weekday = clamp(schedule.weekday, 0, 6)
    const candidate = new Date(after)
    candidate.setHours(hour, minute, 0, 0)
    let delta = (weekday - candidate.getDay() + 7) % 7
    // 今天就是那一天但时间已过 → 顺延一周
    if (delta === 0 && candidate.getTime() <= after) delta = 7
    candidate.setDate(candidate.getDate() + delta)
    return candidate.getTime()
  }

  // monthly：把「每月 N 号」夹到当月实际天数内（2 月没有 31 号）。
  const day = clamp(schedule.day, 1, 31)
  const candidate = new Date(after)
  candidate.setHours(hour, minute, 0, 0)
  const thisMonthDay = Math.min(day, daysInMonth(candidate.getFullYear(), candidate.getMonth()))
  candidate.setDate(thisMonthDay)
  if (candidate.getTime() <= after) {
    candidate.setDate(1)
    candidate.setMonth(candidate.getMonth() + 1)
    const nextMonthDay = Math.min(day, daysInMonth(candidate.getFullYear(), candidate.getMonth()))
    candidate.setDate(nextMonthDay)
  }
  return candidate.getTime()
}

/**
 * 计算「现在应该执行哪些到期的计划时间点」。
 *
 * `nextDueMs` 是**下一次应当执行的时间点**（持久化在任务上的 `nextRunAt`），
 * 不是一个「已经跑过的时间」—— 这个区别很关键：把它当成已跑过的时间会让
 * 扫描从它的下一个周期开始，于是到期的这一次永远被跳过，任务表现为
 * 「创建后再也不执行」。没有它则视为新任务，不补跑一段并不存在的过去。
 *
 * `catchUp` 决定机器休眠/应用未运行期间错过的任务怎么补：
 * `skip` 忽略积压、`once` 只补最近一次（默认，避免开机瞬间并发打爆模型）、
 * `all` 全部补（受 maxRuns 限制，防止休眠一周后一次性发起上百个任务）。
 */
export function collectDueRuns(
  schedule: WeBotSchedule,
  options: { nowMs: number; nextDueMs?: number; catchUp?: WeBotCatchUp; maxRuns?: number }
): number[] {
  const now = Number(options.nowMs)
  const catchUp: WeBotCatchUp = options.catchUp || 'once'
  const maxRuns = Math.max(1, Math.min(20, options.maxRuns ?? 5))

  const firstDue = Number.isFinite(options.nextDueMs) && (options.nextDueMs as number) > 0
    ? (options.nextDueMs as number)
    : null
  // 没有调度起点 → 不判断任何执行点（新任务不应该在创建瞬间补跑）。
  if (firstDue === null) return []

  // 扫描上限只用于防呆（约 270 年的日任务），不代表要执行这么多次 ——
  // `once` 必须先扫到「现在」才能取到最近一次，用 maxRuns 截断扫描会让它
  // 停在积压区间的开头。
  const SCAN_LIMIT = 100_000
  const due: number[] = []
  let candidate = firstDue
  while (due.length < SCAN_LIMIT && candidate <= now) {
    due.push(candidate)
    const next = nextRunAfter(schedule, candidate)
    if (next === null) break
    candidate = next
  }

  if (catchUp === 'skip') return []

  // `once`：补**最近**的一次，而不是最早的一次。
  //
  // 对一个「每天扫描某群、把作业整理成笔记」的任务来说，机器休眠三天后去跑
  // 三天前那次毫无意义（数据窗口早就错位了）；用户想要的是「现在补上今天
  // 这一次」。所以取最后一个。
  if (catchUp === 'once') return due.length > 0 ? [due[due.length - 1]] : []

  // `all`：从头补齐，但限制次数 —— 休眠一周后一次性发起上百个任务会把模型
  // 和 WCDB 宿主一起打爆。
  return due.slice(0, maxRuns)
}

/** 人类可读的下次执行描述（界面与通知共用同一套措辞）。 */
export function describeSchedule(schedule: WeBotSchedule): string {
  const pad = (value: number): string => String(value).padStart(2, '0')
  if (schedule.kind === 'daily') return `每天 ${pad(schedule.hour)}:${pad(schedule.minute)}`
  if (schedule.kind === 'weekly') {
    const names = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
    return `每${names[clamp(schedule.weekday, 0, 6)]} ${pad(schedule.hour)}:${pad(schedule.minute)}`
  }
  if (schedule.kind === 'monthly') return `每月 ${clamp(schedule.day, 1, 31)} 日 ${pad(schedule.hour)}:${pad(schedule.minute)}`
  const minutes = Math.max(1, Math.floor(schedule.everyMinutes))
  if (minutes % 60 === 0) return `每 ${minutes / 60} 小时`
  return `每 ${minutes} 分钟`
}

/** 供界面预览：「下次 明天 08:30」。 */
export function describeNextRun(nextRunMs: number | null, nowMs: number = Date.now()): string {
  if (nextRunMs === null || !Number.isFinite(nextRunMs)) return '未启用'
  const pad = (value: number): string => String(value).padStart(2, '0')
  const next = new Date(nextRunMs)
  const now = new Date(nowMs)
  const time = `${pad(next.getHours())}:${pad(next.getMinutes())}`
  const sameDay = next.toDateString() === now.toDateString()
  if (sameDay) return `今天 ${time}`
  const tomorrow = new Date(nowMs)
  tomorrow.setDate(tomorrow.getDate() + 1)
  if (next.toDateString() === tomorrow.toDateString()) return `明天 ${time}`
  return `${next.getMonth() + 1} 月 ${next.getDate()} 日 ${time}`
}
