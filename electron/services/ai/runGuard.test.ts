import { describe, expect, it } from 'vitest'
import { AiRunGuard, toolRoundLimit } from './runGuard'

describe('long productive AI runs', () => {
  it('continues beyond the former 48-step default with distinct evidence', () => {
    const guard = new AiRunGuard()
    for (let round = 1; round <= 150; round++) {
      guard.observeBatch([{ name: 'read_session_messages', args: { offset: round }, result: `page ${round}` }])
      expect(guard.shouldFinalize(round, toolRoundLimit(48), 1000, 128000)).toBe(false)
    }
    expect(toolRoundLimit(0)).toBe(Infinity)
    expect(toolRoundLimit(undefined)).toBe(Infinity)
  })
  it('finalizes repeated unchanged evidence but resets on new evidence', () => {
    const guard = new AiRunGuard()
    for (let round = 1; round <= 5; round++) guard.observeBatch([{ name: 'read', args: { a: 1, b: 2 }, result: 'unchanged' }])
    expect(guard.shouldFinalize(5, Infinity, 1000, 128000)).toBe(true)
    guard.observeBatch([{ name: 'read', args: { b: 2, a: 1 }, result: 'new evidence' }])
    expect(guard.shouldFinalize(6, Infinity, 1000, 128000)).toBe(false)
  })
  it('reserves a final answer for an explicit budget or nearly full context', () => {
    const guard = new AiRunGuard()
    expect(guard.shouldFinalize(1, toolRoundLimit(2), 1000, 128000)).toBe(false)
    expect(guard.shouldFinalize(2, toolRoundLimit(2), 1000, 128000)).toBe(true)
    expect(guard.shouldFinalize(1, Infinity, 102400, 128000)).toBe(true)
  })
})
