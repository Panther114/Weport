import { describe, expect, it, vi } from 'vitest'
import { WcdbCore } from './wcdbCore'

function coreWithCounts(options: {
  singleCountStatus?: number
  singleCountValue?: number
  aggregateJson?: string
  aggregateStatus?: number
} = {}): WcdbCore {
  const core = Object.create(WcdbCore.prototype) as any
  core.initialized = true
  core.handle = 1
  core.wcdbGetMessageCount = vi.fn((_handle: number, _sessionId: string, outCount: number[]) => {
    if (options.singleCountValue !== undefined) outCount[0] = options.singleCountValue
    return options.singleCountStatus ?? 0
  })
  core.wcdbGetSessionMessageCounts = vi.fn((_handle: number, _sessionIds: string, outPointer: unknown[]) => {
    outPointer[0] = 1
    return options.aggregateStatus ?? 0
  })
  core.decodeJsonPtr = vi.fn(() => options.aggregateJson ?? '{"room":0}')
  return core as WcdbCore
}

describe('WCDB count APIs preserve unknown and error states', () => {
  it('does not coerce a nonzero native single-count status to an empty session', async () => {
    const core = coreWithCounts({ singleCountStatus: -3, singleCountValue: 0 })
    await expect(core.getMessageCounts(['room'])).resolves.toMatchObject({ success: false })
  })

  it('accepts an explicitly returned native zero count', async () => {
    const core = coreWithCounts({ singleCountStatus: 0, singleCountValue: 0 })
    await expect(core.getMessageCounts(['room'])).resolves.toEqual({ success: true, counts: { room: 0 } })
  })

  it('rejects an untouched single-count out parameter as unknown', async () => {
    const core = coreWithCounts({ singleCountStatus: 0 })
    await expect(core.getMessageCounts(['room'])).resolves.toMatchObject({ success: false })
  })

  it('rejects a missing aggregate count instead of filling in zero', async () => {
    const core = coreWithCounts({ aggregateJson: '{}' })
    await expect(core.getSessionMessageCounts(['room'])).resolves.toMatchObject({ success: false })
  })

  it('accepts an explicit aggregate zero and rejects malformed counts', async () => {
    const explicitZero = coreWithCounts({ aggregateJson: '{"room":0}' })
    await expect(explicitZero.getSessionMessageCounts(['room'])).resolves.toEqual({ success: true, counts: { room: 0 } })

    const malformed = coreWithCounts({ aggregateJson: '{"room":null}' })
    await expect(malformed.getSessionMessageCounts(['room'])).resolves.toMatchObject({ success: false })
  })

  it('keeps the strict semantics when aggregate support falls back to single counts', async () => {
    const core = coreWithCounts({ singleCountStatus: -7, singleCountValue: 0 })
    ;(core as any).wcdbGetSessionMessageCounts = null
    await expect(core.getSessionMessageCounts(['room'])).resolves.toMatchObject({ success: false })
  })
})
