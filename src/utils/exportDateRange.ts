/** Local calendar dates, including the entire end day (also across DST). */
export function exportDateRange(start: string, end: string): { start: number; end: number } | null {
  const parse = (value: string): Date => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error('请选择有效日期')
    const [year, month, day] = value.split('-').map(Number)
    const date = new Date(year, month - 1, day)
    if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) throw new Error('请选择有效日期')
    return date
  }
  const from = start ? parse(start) : null
  const to = end ? parse(end) : null
  if (from && to && from > to) throw new Error('开始日期不能晚于结束日期')
  if (!from && !to) return null
  if (to) to.setDate(to.getDate() + 1)
  return { start: from ? Math.floor(from.getTime() / 1000) : 0, end: to ? Math.floor(to.getTime() / 1000) - 1 : 0 }
}
