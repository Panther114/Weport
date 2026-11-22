import { describe, expect, it } from 'vitest'
import {
  autoDraftRetrievalText,
  buildAutoDraftPrompt,
  buildReaderDraftSelection,
  type ReaderDraftSourceMessage,
} from './readerAutoDraft'
import {
  buildReaderDraftNoteSection,
  normalizeReaderDraftNote,
  normalizeReaderDraftRange,
  readerDraftRangeLabel,
  readerDraftRangeStart,
} from './readerDraftSettings'

function row(
  id: number,
  text: string,
  options?: Partial<ReaderDraftSourceMessage>,
): ReaderDraftSourceMessage {
  return {
    key: `k${id}`,
    ts: 1_700_000_000_000 + id * 1000,
    isSend: false,
    senderName: 'Alex',
    kind: 'text',
    text,
    ...options,
  }
}

describe('reader draft range settings', () => {
  it('normalises unknown ranges to today', () => {
    expect(normalizeReaderDraftRange('7d')).toBe('7d')
    expect(normalizeReaderDraftRange('all')).toBe('all')
    expect(normalizeReaderDraftRange('forever')).toBe('today')
    expect(readerDraftRangeLabel('30d')).toBe('近 30 天')
  })

  it('computes local midnight for today and rolling windows otherwise', () => {
    const now = new Date(2026, 10, 22, 15, 30, 0).getTime()
    const midnight = new Date(2026, 10, 22, 0, 0, 0).getTime()
    expect(readerDraftRangeStart('today', now)).toBe(midnight)
    expect(readerDraftRangeStart('7d', now)).toBe(now - 7 * 24 * 60 * 60 * 1000)
    expect(readerDraftRangeStart('all', now)).toBe(0)
  })

  it('normalises the per-conversation note without truncating it', () => {
    const long = `a\r\nb${'x'.repeat(8_000)}`
    const note = normalizeReaderDraftNote(long)
    expect(note.startsWith('a\nb')).toBe(true)
    expect(note.length).toBe(long.length - 1)
    expect(buildReaderDraftNoteSection('')).toBe('')
    expect(buildReaderDraftNoteSection('对方是我老板')).toContain('本会话补充提示词')
  })
})

describe('reader auto draft selection', () => {
  it('targets the last incoming message and ignores messages after it', () => {
    const selection = buildReaderDraftSelection([
      row(1, '早'),
      row(2, '在吗'),
      row(3, '在的', { isSend: true }),
      row(4, '晚上有空吗'),
      row(5, '我先忙', { isSend: true }),
    ])
    expect(selection.target?.key).toBe('k4')
    expect(selection.rows.map((item) => item.key)).toEqual(['k1', 'k2', 'k3', 'k4'])
  })

  it('respects an explicit target and keeps it last', () => {
    const selection = buildReaderDraftSelection(
      [row(1, 'a'), row(2, 'b'), row(3, 'c')],
      { targetKey: 'k2' },
    )
    expect(selection.rows.map((item) => item.key)).toEqual(['k1', 'k2'])
    expect(selection.target?.key).toBe('k2')
  })

  it('samples older messages when over the message budget', () => {
    const messages = Array.from({ length: 80 }, (_, index) => row(index + 1, `m${index + 1}`))
    const selection = buildReaderDraftSelection(messages, { maxMessages: 20 })
    expect(selection.includedCount).toBeLessThanOrEqual(20)
    expect(selection.target?.key).toBe('k80')
    expect(selection.rows[selection.rows.length - 1]?.key).toBe('k80')
    expect(selection.truncated).toBe(true)
    // 取样应覆盖早期消息，而不是只留最后 20 条。
    expect(selection.rows.some((item) => Number(item.key.slice(1)) < 40)).toBe(true)
  })

  it('drops the oldest rows under a character budget but never the target', () => {
    const messages = Array.from({ length: 30 }, (_, index) => row(index + 1, 'x'.repeat(200)))
    const selection = buildReaderDraftSelection(messages, { maxChars: 1200 })
    expect(selection.charCount).toBeLessThanOrEqual(1200)
    expect(selection.target?.key).toBe('k30')
    expect(selection.rows[selection.rows.length - 1]?.key).toBe('k30')
    expect(selection.truncated).toBe(true)
  })

  it('builds a prompt with context, target and per-session note', () => {
    const selection = buildReaderDraftSelection([row(1, '在吗'), row(2, '晚上有空吗')])
    const prompt = buildAutoDraftPrompt(selection, { range: 'today', note: '对方是我老板，收着点说' })
    expect(prompt).toContain('<chat-context-jsonl>')
    expect(prompt).toContain('"text":"晚上有空吗"')
    expect(prompt).toContain('<reply-target>')
    expect(prompt).toContain('本会话补充提示词')
    expect(prompt).toContain('对方是我老板')
    expect(prompt).toContain('不要发送任何消息')
  })

  it('falls back to the last other text when the target is media', () => {
    const selection = buildReaderDraftSelection([
      row(1, '你看这个', { kind: 'text' }),
      row(2, '[图片]', { kind: 'image' }),
    ])
    expect(selection.target?.kind).toBe('image')
    expect(autoDraftRetrievalText(selection)).toBe('你看这个')
  })
})
