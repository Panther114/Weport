/** Calendar array endpoints are days: ECharts treats `YYYY-MM` as day 1. */
export function activityCalendarRange(days: string[], lastMessageTime: number | null): [string, string] | null {
  const sorted = days.filter(day => /^\d{4}-\d{2}-\d{2}$/.test(day)).sort()
  if (!sorted.length) return null
  const format = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
  const statsEnd = lastMessageTime ? format(new Date(lastMessageTime * 1000)) : ''
  // Daily detail may be newer than separately cached overview statistics.
  const end = [sorted[sorted.length - 1], statsEnd].sort().pop()!
  const [year, month] = end.split('-').map(Number)
  // Construct on day 1 to avoid setMonth overflow on the 29th–31st.
  const rollingStart = format(new Date(year, month - 12, 1))
  return [sorted[0] > rollingStart ? sorted[0] : rollingStart, end]
}
