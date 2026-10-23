import { afterEach, describe, expect, it, vi } from 'vitest'
import { exportReaderSession } from './readerExport'
import type { ReaderSession } from './readerTypes'

afterEach(() => vi.unstubAllGlobals())
describe('Reader uses the production export contract', () => {
  it.each([undefined, { success: true, stopped: true, successCount: 1 }, { success: true, paused: true, successCount: 1 }])('never claims completion for missing or unfinished results', async result => {
    vi.stubGlobal('window', { electronAPI: { config: { get: async (key: string) => key === 'exportPath' ? 'D:\\exports' : undefined }, export: { exportSessions: vi.fn().mockResolvedValue(result) } } })
    expect((await exportReaderSession({ id: 'room' } as ReaderSession)).ok).toBe(false)
  })
  it('forwards exact second bounds and an explicit original-only policy', async () => {
    const exportSessions = vi.fn().mockResolvedValue({ success: true, successCount: 1 })
    vi.stubGlobal('window', { electronAPI: { config: { get: async (key: string) => ({ exportPath: 'D:\\exports', exportMedia: { images: true }, exportMediaPolicy: 'best-available' }[key]) }, export: { exportSessions } } })
    const dateRange = { start: 1700000001, end: 1700018001 }
    expect((await exportReaderSession({ id: 'selected-only' } as ReaderSession, { mediaPolicy: 'original-only', dateRange })).ok).toBe(true)
    expect(exportSessions).toHaveBeenCalledWith('D:\\exports', expect.objectContaining({ sessionIds: ['selected-only'], mediaPolicy: 'original-only', dateRange, exportImages: true }))
  })
  it('inherits the saved quality policy but never silently inherits a different export range', async () => {
    const exportSessions = vi.fn().mockResolvedValue({ success: true, successCount: 1 })
    vi.stubGlobal('window', { electronAPI: { config: { get: async (key: string) => ({ exportPath: 'D:\\exports', exportMediaPolicy: 'original-only' }[key]) }, export: { exportSessions } } })
    await exportReaderSession({ id: 'room' } as ReaderSession)
    expect(exportSessions).toHaveBeenCalledWith('D:\\exports', expect.objectContaining({ sessionIds: ['room'], mediaPolicy: 'original-only', dateRange: null }))
  })
})
