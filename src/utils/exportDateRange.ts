/** Local times are inclusive to the second; date-only bounds retain whole-day semantics. */
export function exportDateRange(start: string, end: string): { start: number; end: number } | null {
  const parse = (value: string, endBound = false): Date => {
    const match = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(value)
    if (!match) throw new Error('请选择有效日期和时间')
    const [, y, m, d, h = '0', min = '0', s = '0'] = match
    const [year, month, day, hour, minute, second] = [y, m, d, h, min, s].map(Number)
    const date = new Date(year, month - 1, day, hour, minute, second)
    // Reject normalized invalid dates, out-of-range times and nonexistent DST times.
    if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day || date.getHours() !== hour || date.getMinutes() !== minute || date.getSeconds() !== second) throw new Error('请选择有效日期和时间')
    if (endBound && !match[4]) { date.setDate(date.getDate() + 1); date.setSeconds(date.getSeconds() - 1) }
    return date
  }
  const from = start ? parse(start) : null
  const to = end ? parse(end, true) : null
  if (from && to && from > to) throw new Error('开始日期不能晚于结束日期')
  if (!from && !to) return null
  return { start: from ? Math.floor(from.getTime() / 1000) : 0, end: to ? Math.floor(to.getTime() / 1000) : 0 }
}
