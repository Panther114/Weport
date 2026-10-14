import { describe, expect, it } from 'vitest'
import * as echarts from 'echarts'
import { activityCalendarRange } from './calendarRange'

describe('activity calendar date coverage', () => {
  it('renders October dates after the first through the actual ECharts calendar', () => {
    const days = ['2026-09-30', '2026-10-01', '2026-10-12']
    const range = activityCalendarRange(days, new Date(2026, 9, 12).getTime() / 1000)
    const chart = echarts.init(null, undefined, { renderer: 'svg', ssr: true, width: 900, height: 250 })
    try {
      chart.setOption({ calendar: { range }, series: [{ type: 'heatmap', coordinateSystem: 'calendar', data: days.map(day => [day, 1]) }], visualMap: { min: 0, max: 1 } })
      const series = (chart as any).getModel().getSeriesByIndex(0)
      const calendar = series.coordinateSystem as any
      expect(calendar.getRangeInfo().end.formatedDate).toBe('2026-10-12')
      expect(calendar.dataToPoint(['2026-10-12', 1]).every(Number.isFinite)).toBe(true)
    } finally { chart.dispose() }
  })
  it('keeps newer daily rows visible despite stale overview data', () => {
    expect(activityCalendarRange(['2026-10-01', '2026-10-12'], new Date(2026, 9, 1).getTime() / 1000)).toEqual(['2026-10-01', '2026-10-12'])
  })
  it('bounds long histories to twelve calendar months without month-end overflow', () => {
    expect(activityCalendarRange(['2020-01-01', '2026-03-31'], null)).toEqual(['2025-04-01', '2026-03-31'])
    expect(activityCalendarRange(['2020-01-01', '2024-02-29'], null)).toEqual(['2023-03-01', '2024-02-29'])
  })
  it('does not invent activity for empty histories', () => {
    expect(activityCalendarRange([], null)).toBeNull()
  })
})
