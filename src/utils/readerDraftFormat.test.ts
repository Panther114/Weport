import { describe, expect, it } from 'vitest'
import { draftPreview, normalizeDraftText } from './readerDraftFormat'

describe('normalizeDraftText', () => {
  it('removes blank lines and line breaks, adding sentence punctuation', () => {
    const text = normalizeDraftText('你好\n\n在吗\n今天有空吗')
    expect(text).not.toContain('\n')
    expect(text).toBe('你好。在吗。今天有空吗。')
  })

  it('keeps existing sentence-ending punctuation instead of doubling it', () => {
    expect(normalizeDraftText('第一点。\n第二点！')).toBe('第一点。第二点！')
    expect(normalizeDraftText('好。\n\n')).toBe('好。')
  })

  it('strips list markers and headings', () => {
    expect(normalizeDraftText('- 第一点\n- 第二点')).toBe('第一点。第二点。')
    expect(normalizeDraftText('1. 先这样\n2) 再那样')).toBe('先这样。再那样。')
    expect(normalizeDraftText('## 结论\n可以')).toBe('结论。可以。')
  })

  it('uses full-width punctuation for Chinese and ASCII for English', () => {
    expect(normalizeDraftText('可以, 明天见!')).toBe('可以，明天见！')
    expect(normalizeDraftText('hey\n\nwhat is up')).toBe('hey. what is up.')
  })

  it('collapses repeated punctuation and removes spaces before it', () => {
    expect(normalizeDraftText('笑死。。。\n\n好 ！！')).toBe('笑死。好！')
    expect(normalizeDraftText('好 。')).toBe('好。')
  })

  it('returns an empty string for empty input', () => {
    expect(normalizeDraftText('')).toBe('')
    expect(normalizeDraftText('\n\n')).toBe('')
    expect(draftPreview('\n\n')).toBe('')
  })

  it('keeps emoji, English abbreviations and names', () => {
    const text = normalizeDraftText('lol 这个太离谱了 😂\n下次再聊')
    expect(text).toContain('lol')
    expect(text).toContain('😂')
    expect(text).not.toContain('\n')
  })

  it('truncates the compact preview', () => {
    expect(draftPreview('x'.repeat(100), 20)).toHaveLength(21)
  })
})
