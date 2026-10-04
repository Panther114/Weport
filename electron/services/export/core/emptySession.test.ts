import { describe, expect, it } from 'vitest'
import { hasConfirmedEmptyMessageInventory } from './emptySession'

describe('confirmed empty session inventory', () => {
  it('requires successful explicit zeros from both native count sources', () => {
    expect(hasConfirmedEmptyMessageInventory('room',
      { success: true, tables: [{ count: 0 }, { count: '0' }] },
      { success: true, counts: { room: 0 } },
    )).toBe(true)
    expect(hasConfirmedEmptyMessageInventory('room',
      { success: true, tables: [] },
      { success: true, counts: { room: '0' } },
    )).toBe(true)
  })

  it('fails closed on API failures, missing session counts, or malformed table counts', () => {
    const validTableStats = { success: true, tables: [{ count: 0 }] }
    expect(hasConfirmedEmptyMessageInventory('room', { success: false, tables: [] }, { success: true, counts: { room: 0 } })).toBe(false)
    expect(hasConfirmedEmptyMessageInventory('room', validTableStats, { success: false, counts: { room: 0 } })).toBe(false)
    expect(hasConfirmedEmptyMessageInventory('room', validTableStats, { success: true, counts: {} })).toBe(false)
    expect(hasConfirmedEmptyMessageInventory('room', { success: true, tables: [{ count: undefined }] }, { success: true, counts: { room: 0 } })).toBe(false)
    expect(hasConfirmedEmptyMessageInventory('room', { success: true, tables: [{ count: 1 }] }, { success: true, counts: { room: 0 } })).toBe(false)
    expect(hasConfirmedEmptyMessageInventory('room', validTableStats, { success: true, counts: { room: 1 } })).toBe(false)
  })

  it('accepts a raw explicit session-table zero only when the native count map lacks coverage', () => {
    const tables = { success: true, tables: [] }
    expect(hasConfirmedEmptyMessageInventory('room', tables, { success: false }, 0)).toBe(true)
    expect(hasConfirmedEmptyMessageInventory('room', tables, { success: true, counts: {} }, 0)).toBe(true)
    expect(hasConfirmedEmptyMessageInventory('room', tables, { success: true, counts: { room: 4 } }, 0)).toBe(false)
    expect(hasConfirmedEmptyMessageInventory('room', tables, { success: false }, undefined)).toBe(false)
  })
})
