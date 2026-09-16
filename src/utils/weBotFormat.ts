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

/** 「每天 08:30」这类人类可读的规则描述。 */
export function describeSchedule(schedule: WeBotSchedule): string {
  if (schedule.kind === 'daily') return `每天 ${pad(schedule.hour)}:${pad(schedule.minute)}`
  if (schedule.kind === 'weekly') {
    const names = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
    return `每${names[clamp(schedule.weekday, 0, 6)]} ${pad(schedule.hour)}:${pad(schedule.minute)}`
  }
  if (schedule.kind === 'monthly') {
    return `每月 ${clamp(schedule.day, 1, 31)} 日 ${pad(schedule.hour)}:${pad(schedule.minute)}`
  }
  const minutes = Math.max(1, Math.floor(schedule.everyMinutes))
  if (minutes % 60 === 0) return `每 ${minutes / 60} 小时`
  return `每 ${minutes} 分钟`
}

/** 「下次 明天 08:30」。 */
export function describeNextRun(nextRunMs: number | null, nowMs: number = Date.now()): string {
  if (nextRunMs === null || !Number.isFinite(nextRunMs)) return '未启用'
  const next = new Date(nextRunMs)
  const now = new Date(nowMs)
  const time = `${pad(next.getHours())}:${pad(next.getMinutes())}`
  if (next.toDateString() === now.toDateString()) return `今天 ${time}`
  const tomorrow = new Date(nowMs)
  tomorrow.setDate(tomorrow.getDate() + 1)
  if (next.toDateString() === tomorrow.toDateString()) return `明天 ${time}`
  return `${next.getMonth() + 1} 月 ${next.getDate()} 日 ${time}`
}

/** 相对时间（笔记列表用）：刚刚 / 5 分钟前 / 昨天 14:20 / 8 月 3 日。 */
export function describeRelativeTime(ms: number, nowMs: number = Date.now()): string {
  const delta = nowMs - ms
  if (delta < 60_000) return '刚刚'
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)} 分钟前`

  const then = new Date(ms)
  const now = new Date(nowMs)
  const time = `${pad(then.getHours())}:${pad(then.getMinutes())}`
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
