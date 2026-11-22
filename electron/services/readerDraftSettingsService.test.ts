import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { ReaderDraftSettingsService } from './readerDraftSettingsService'

let dir = ''

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'weport-reader-draft-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('ReaderDraftSettingsService', () => {
  it('saves per account + session and merges patches without wiping the note', () => {
    const service = new ReaderDraftSettingsService(dir)
    service.set({ accountId: 'wxid_me', sessionId: 'chat_a', cloneId: 'clone_1', range: 'today', note: '对方是老板' })
    service.set({ accountId: 'wxid_me', sessionId: 'chat_a', range: '7d' })

    const saved = service.get('wxid_me', 'chat_a')
    expect(saved?.cloneId).toBe('clone_1')
    expect(saved?.range).toBe('7d')
    expect(saved?.note).toBe('对方是老板')
    expect(service.get('wxid_me', 'chat_b')).toBeNull()
    expect(service.get('wxid_other', 'chat_a')).toBeNull()
  })

  it('persists across instances (the point of "do not fill it in again")', () => {
    const first = new ReaderDraftSettingsService(dir)
    first.set({ accountId: 'wxid_me', sessionId: 'chat_a', cloneId: 'clone_1', range: '30d', note: '我们在讨论下周的旅行' })

    const second = new ReaderDraftSettingsService(dir)
    const saved = second.get('wxid_me', 'chat_a')
    expect(saved?.cloneId).toBe('clone_1')
    expect(saved?.range).toBe('30d')
    expect(saved?.note).toBe('我们在讨论下周的旅行')
  })

  it('keeps an oversized note intact and normalises an unknown range', () => {
    const service = new ReaderDraftSettingsService(dir)
    const longNote = 'x'.repeat(8_000)
    const saved = service.set({
      accountId: 'wxid_me',
      sessionId: 'chat_a',
      range: 'forever',
      note: longNote,
    })
    expect(saved.range).toBe('today')
    expect(saved.note).toBe(longNote)
  })

  it('clears a clone reference but keeps the conversation note', () => {
    const service = new ReaderDraftSettingsService(dir)
    service.set({ accountId: 'wxid_me', sessionId: 'chat_a', cloneId: 'clone_1', range: 'all', note: '收着点' })
    service.forgetClone('clone_1')
    const saved = service.get('wxid_me', 'chat_a')
    expect(saved?.cloneId).toBe('')
    expect(saved?.note).toBe('收着点')
    expect(saved?.range).toBe('all')
  })

  it('deletes a session setting', () => {
    const service = new ReaderDraftSettingsService(dir)
    service.set({ accountId: 'wxid_me', sessionId: 'chat_a', cloneId: 'clone_1' })
    expect(service.clear('wxid_me', 'chat_a')).toBe(true)
    expect(service.get('wxid_me', 'chat_a')).toBeNull()
    expect(service.clear('wxid_me', 'chat_a')).toBe(false)
  })
})
