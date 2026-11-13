import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { appendArchive, mergeTranscript, readArchive, readTranscript } from './transcriptStorage'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function file() { const root = mkdtempSync(join(tmpdir(), 'weport-transcript-')); roots.push(root); return join(root, 'history') }

describe('durable AI transcripts', () => {
  it('keeps archived turns visible without duplicating a retried compaction', () => {
    const path = file(), old = { id: 'old', content: 'Original message' }, recent = { id: 'recent', content: 'Latest answer' }
    appendArchive(path, [old]); appendArchive(path, [old])
    expect(readArchive(path)).toEqual([old])
    expect(mergeTranscript(readArchive(path), [old, recent])).toEqual([old, recent])
  })
  it('distinguishes absent history from damaged history and leaves damaged bytes untouched', () => {
    const path = file()
    expect(readTranscript(path)).toEqual({ messages: [], compressed: '' })
    for (const original of ['{truncated', '{"messages":null}']) {
      writeFileSync(path, original)
      expect(() => readTranscript(path)).toThrow()
      expect(readFileSync(path, 'utf8')).toBe(original)
    }
  })
  it('refuses compaction after archive read or write failures', () => {
    const path = file()
    writeFileSync(path, '{truncated')
    expect(() => appendArchive(path, [{ id: 'kept' }])).toThrow()
    expect(readFileSync(path, 'utf8')).toBe('{truncated')
    const directory = file(); mkdirSync(directory)
    expect(() => appendArchive(directory, [{ id: 'kept' }])).toThrow()
  })
})
