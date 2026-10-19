import { describe, expect, it } from 'vitest'
import { exportDateRange } from './exportDateRange'

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
