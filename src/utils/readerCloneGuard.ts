export interface ReaderCloneGuard {
  accountId: string
  sessionId: string
}

/** Strip only a documented directory suffix; never truncate arbitrary wxid components. */
export function cloneAccountIdentity(value: string): string {
  const account = String(value || '').trim()
  if (account.toLowerCase().startsWith('wxid_')) return account.replace(/^(wxid_[^_]+)_([a-zA-Z0-9]{4})$/i, '$1')
  return account.replace(/^(.+)_([a-zA-Z0-9]{4})$/, '$1')
}

/** The Reader wrapper's language must not override the selected incoming message. */
export function readerDraftLanguageText(message: string): string {
  const start = message.indexOf('<selected-chat-jsonl>\n')
  const end = message.lastIndexOf('\n</selected-chat-jsonl>')
  if (start < 0 || end <= start) return message
  try {
    const rows = message.slice(start + '<selected-chat-jsonl>\n'.length, end).split('\n').map((line) => JSON.parse(line))
    if (!rows.length || rows.length > 20 || rows.some((row) => !row || typeof row.text !== 'string' || !['self', 'other'].includes(row.direction))) return message
    return [...rows].reverse().find((row) => row.direction === 'other')?.text || rows[rows.length - 1].text
  } catch { return message }
}

/** Called before retrieval and again at every provider dispatch for Reader drafts. */
export function readerCloneGuardError(guard: ReaderCloneGuard, activeAccount: string, cloneId: string, clone?: { id: string; wxid: string }): string | undefined {
  if (!guard || typeof guard.accountId !== 'string' || typeof guard.sessionId !== 'string' || !guard.accountId.trim() || !guard.sessionId.trim() || !cloneId.trim()) {
    return '回复草稿必须明确选择账号、会话和分身，请重新选择。'
  }
  const expected = cloneAccountIdentity(guard.accountId)
  if (!expected || expected !== cloneAccountIdentity(activeAccount)) return '当前账号已改变，请返回阅读器重新选择消息。'
  if (!clone || clone.id !== cloneId || cloneAccountIdentity(clone.wxid) !== expected) return '所选分身不存在或不属于当前账号，请刷新并重新选择。'
  return undefined
}
