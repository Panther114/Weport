import { describe, expect, it } from 'vitest'
import { exportDateRange } from './exportDateRange'

it('preserves inclusive sub-day boundaries to exact local seconds', () => {
  expect(exportDateRange('2026-10-19T10:12:13', '2026-10-19T10:12:14')).toEqual({ start: new Date(2026, 9, 19, 10, 12, 13).getTime() / 1000, end: new Date(2026, 9, 19, 10, 12, 14).getTime() / 1000 })
  expect(exportDateRange('2026-10-19T10:12', '2026-10-19')?.end).toBe(new Date(2026, 9, 20).getTime() / 1000 - 1)
  expect(exportDateRange('', '2026-10-19T10:12')?.start).toBe(0)
  expect(exportDateRange('2026-10-19T10:12', '')?.end).toBe(0)
})

it.each(['2026-10-19T24:00', '2026-10-19T10:60', '2026-10-19T10:12:60', '2026-02-30T10:00', '2026-10-19T10:00Z'])('rejects invalid or non-local timestamp %s', value => {
  expect(() => exportDateRange(value, '')).toThrow()
})

it('rejects reversed times on the same day', () => {
  expect(() => exportDateRange('2026-10-19T10:12:14', '2026-10-19T10:12:13')).toThrow()
})

describe('export calendar bounds', () => {
  it('includes both full local days and accepts open bounds', () => {
    expect(exportDateRange('', '')).toBeNull()
    expect(exportDateRange('2026-10-01', '2026-10-19')).toEqual({ start: new Date(2026, 9, 1).getTime() / 1000, end: new Date(2026, 9, 20).getTime() / 1000 - 1 })
    expect(exportDateRange('', '2026-10-19')?.start).toBe(0)
    expect(exportDateRange('2026-10-19', '')?.end).toBe(0)
  })
  it('rejects reversed and impossible dates before starting an export', () => {
    expect(() => exportDateRange('2026-10-20', '2026-10-19')).toThrow()
    expect(() => exportDateRange('2026-02-30', '')).toThrow()
  })
})
