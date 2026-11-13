import { appendFileSync, existsSync, readFileSync } from 'fs'

/** A failed read must never become an empty transcript that a later save overwrites. */
export function readTranscript<T, TRun = unknown>(file: string): { messages: T[]; compressed: string; lastRun?: TRun } {
  if (!existsSync(file)) return { messages: [], compressed: '' }
  const data = JSON.parse(readFileSync(file, 'utf8'))
  if (!Array.isArray(data.messages)) throw new Error(`Invalid AI transcript: ${file}`)
  return { ...data, compressed: typeof data.compressed === 'string' ? data.compressed : '' }
}

export function readArchive<T extends { id: string }>(file: string): T[] {
  if (!existsSync(file)) return []
  const messages = new Map<string, T>()
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean)) {
    const message = JSON.parse(line) as T
    if (!message.id) throw new Error(`Invalid AI archive: ${file}`)
    messages.set(message.id, message)
  }
  return [...messages.values()]
}

/** Archive before replacing the provider projection; retries cannot duplicate turns. */
export function appendArchive<T extends { id: string }>(file: string, messages: T[]): void {
  if (!messages.length) return
  const known = new Set(readArchive<T>(file).map(message => message.id))
  const fresh = messages.filter(message => {
    if (known.has(message.id)) return false
    known.add(message.id)
    return true
  })
  if (fresh.length) appendFileSync(file, fresh.map(message => JSON.stringify(message)).join('\n') + '\n', 'utf8')
}

export function mergeTranscript<T extends { id: string }>(archived: T[], current: T[]): T[] {
  return [...new Map([...archived, ...current].map(message => [message.id, message])).values()]
}
