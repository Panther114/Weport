import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, lstatSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { randomUUID } from 'crypto'

export interface StoredChat {
  id: string
  memoryEnabled?: boolean
  invocation?: { kind: 'automation'; taskId: string; runId?: string }
}

function atomicJson(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true })
  const temporary = `${file}.${randomUUID()}.tmp`
  writeFileSync(temporary, JSON.stringify(value, null, 2))
  renameSync(temporary, file)
}

export function persistChatIndexes<T extends StoredChat>(dataDir: string, chats: T[]): void {
  // Commit the destination first. A crash before the second rename leaves a
  // recoverable duplicate, which loadChatIndexes deduplicates by stable ID.
  atomicJson(join(dataDir, 'automations', 'index.json'), { chats: chats.filter(chat => chat.invocation?.kind === 'automation') })
  atomicJson(join(dataDir, 'index.json'), { chats: chats.filter(chat => chat.invocation?.kind !== 'automation') })
}

function verifiedCopy(source: string, destination: string): void {
  if (!existsSync(source)) return
  const stat = lstatSync(source)
  if (existsSync(destination) && lstatSync(destination).isSymbolicLink()) throw new Error('Cannot migrate into a linked automation destination.')
  if (stat.isSymbolicLink()) throw new Error('Cannot migrate a linked automation file.')
  if (stat.isDirectory()) {
    mkdirSync(destination, { recursive: true })
    for (const name of readdirSync(source)) verifiedCopy(join(source, name), join(destination, name))
  } else {
    mkdirSync(dirname(destination), { recursive: true })
    if (!existsSync(destination)) cpSync(source, destination, { errorOnExist: true, force: false })
    if (!readFileSync(source).equals(readFileSync(destination))) throw new Error('Automation migration destination differs; original history was retained.')
  }
}

/** Account-local, restartable migration. Originals remain in a recovery folder. */
export function loadChatIndexes<T extends StoredChat>(dataDir: string, workspaceAccountDir: string): T[] {
  const read = (file: string): T[] => {
    if (!existsSync(file)) return []
    const data = JSON.parse(readFileSync(file, 'utf8'))
    if (!Array.isArray(data.chats)) throw new Error('Invalid chat index.')
    for (const chat of data.chats) if (!/^[\w-]+$/.test(chat.id)) throw new Error('Invalid stored chat ID.')
    return data.chats
  }
  const originalIndex = join(dataDir, 'index.json')
  const interactive = read(originalIndex)
  const automations = read(join(dataDir, 'automations', 'index.json'))
  const byId = new Map(interactive.map(chat => [chat.id, chat]))
  for (const chat of automations) byId.set(chat.id, chat)
  const moved: Array<{ source: string; destination: string }> = []
  let changed = false
  for (const chat of byId.values()) {
    if (!chat.invocation) {
      const file = join(dataDir, 'sessions', `${chat.id}.json`)
      const archive = join(dataDir, 'sessions', `${chat.id}.archive.jsonl`)
      try {
        const saved = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {}
        const archived = existsSync(archive) ? readFileSync(archive, 'utf8').split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line)) : []
        const first = [...archived, ...(saved.messages || [])].find((message: { role: string }) => message.role === 'user')?.content || ''
        // Old dispatchers supplied both exact markers; a title is never proof.
        if (first.includes('这是 WeBot 定时任务的自动执行（') && first.includes('请只输出简洁结论，正文控制在 300 字以内')) {
          chat.invocation = { kind: 'automation', taskId: 'legacy' }
          changed = true
        }
      } catch (error) {
        // One damaged transcript must not hide every other conversation. The
        // original remains untouched and opening it reports the read failure.
        console.warn('[WeportAI] 无法识别旧版自动任务:', chat.id, error)
      }
    }
    if (chat.invocation?.kind !== 'automation') continue
    for (const suffix of ['.json', '.archive.jsonl']) {
      const source = join(dataDir, 'sessions', `${chat.id}${suffix}`)
      const destination = join(dataDir, 'automations', 'sessions', `${chat.id}${suffix}`)
      if (existsSync(source)) {
        verifiedCopy(source, destination)
        moved.push({ source, destination: join(dataDir, 'automation-migration-backup', 'sessions', `${chat.id}${suffix}`) })
        changed = true
      }
    }
    const source = join(workspaceAccountDir, 'chats', chat.id)
    if (existsSync(source)) {
      verifiedCopy(source, join(workspaceAccountDir, 'automations', chat.id))
      moved.push({ source, destination: join(workspaceAccountDir, 'automation-migration-backup', chat.id) })
      changed = true
    }
    if (interactive.some(row => row.id === chat.id)) changed = true
  }
  if (changed) {
    const backup = join(dataDir, 'automation-migration-backup', 'index.json')
    if (existsSync(originalIndex) && !existsSync(backup)) {
      mkdirSync(dirname(backup), { recursive: true })
      cpSync(originalIndex, backup, { errorOnExist: true, force: false })
    }
    persistChatIndexes(dataDir, [...byId.values()])
    for (const item of moved) {
      mkdirSync(dirname(item.destination), { recursive: true })
      if (!existsSync(item.destination)) renameSync(item.source, item.destination)
    }
  }
  return [...byId.values()]
}
