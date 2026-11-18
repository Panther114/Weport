import { randomUUID } from 'node:crypto'
import { closeSync, fstatSync, lstatSync, openSync, readSync, readdirSync, realpathSync, renameSync, unlinkSync, writeFileSync, mkdirSync, type Stats } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative } from 'node:path'
import { TextDecoder } from 'node:util'

const MAX_FILE_BYTES = 512 * 1024
const MAX_OUTPUT = 12_000
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
const ignoredFolders = new Set(['.git', 'node_modules', '.venv', 'dist', 'build', 'vendor'])

function sameEntry(a: Stats, b: Stats): boolean {
  return a.dev === b.dev && a.ino === b.ino
}

export class CodingWorkspace {
  readonly directory: string
  private readonly identity: Stats

  constructor(directory: string) {
    if (!isAbsolute(directory)) throw new Error('请选择工作目录。')
    this.directory = realpathSync.native(directory)
    this.identity = lstatSync(this.directory)
    if (!this.identity.isDirectory()) throw new Error('工作目录无效。')
  }

  private path(value: unknown, allowRoot = false, allowMissing = false): string {
    const current = lstatSync(this.directory)
    if (!current.isDirectory() || !sameEntry(current, this.identity) ||
      realpathSync.native(this.directory) !== this.directory) throw new Error('工作目录已变更，请重新选择。')
    if (allowRoot && (value === undefined || value === '.')) return this.directory
    if (typeof value !== 'string' || !value || value.length > 4096) throw new Error('Provide a relative workspace path.')
    const parts = value.split(/[\\/]/)
    let target = this.directory
    for (const [index, part] of parts.entries()) {
      if (!part || /[. ]$|[<>:"|?*\x00-\x1f]/.test(part) ||
        /^(?:con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³]) *(?:\.|$)/i.test(part)) throw new Error('Invalid workspace path.')
      target = join(target, part)
      let entry
      try { entry = lstatSync(target) }
      catch (error) {
        if (allowMissing && index === parts.length - 1 && (error as NodeJS.ErrnoException).code === 'ENOENT') return target
        throw error
      }
      if (entry.isSymbolicLink() || (!entry.isDirectory() && (!entry.isFile() || entry.nlink !== 1))) {
        throw new Error('Workspace tools require ordinary files and folders.')
      }
      if (relative(target, realpathSync.native(target))) {
        throw new Error('Workspace paths cannot redirect through links.')
      }
    }
    return target
  }

  private read(path: string): { text: string; entry: Stats } {
    const entry = lstatSync(path)
    if (!entry.isFile() || entry.nlink !== 1 || entry.size > MAX_FILE_BYTES) throw new Error('Expected a text file up to 512 KiB.')
    const fd = openSync(path, 'r')
    try {
      if (!sameEntry(entry, fstatSync(fd))) throw new Error('File changed during read. Try again.')
      const bytes = Buffer.alloc(entry.size + 1)
      const length = readSync(fd, bytes)
      if (length !== entry.size || bytes.subarray(0, length).includes(0)) throw new Error('Expected a stable UTF-8 text file.')
      return { text: decoder.decode(bytes.subarray(0, length)), entry }
    } finally { closeSync(fd) }
  }

  list(path: unknown, offset: number): string {
    const entries = readdirSync(this.path(path, true), { withFileTypes: true })
      .filter(entry => entry.isDirectory() || entry.isFile())
      .sort((a, b) => a.name.localeCompare(b.name))
    const rows = entries.slice(offset, offset + 100).map(entry => entry.name + (entry.isDirectory() ? '/' : ''))
    return JSON.stringify({ directory: this.directory, entries: rows, nextOffset: offset + rows.length < entries.length ? offset + rows.length : null })
  }

  readLines(path: unknown, start: number, count: number): string {
    const lines = this.read(this.path(path)).text.split('\n')
    if (start > lines.length) return `No lines at ${start}; file contains ${lines.length} lines.`
    const rows: string[] = []
    let length = 0
    for (let i = start - 1; i < Math.min(lines.length, start - 1 + count); i++) {
      const row = `${i + 1}: ${lines[i]}`
      if (length + row.length > MAX_OUTPUT && rows.length) break
      rows.push(row.slice(0, MAX_OUTPUT))
      length += row.length + 1
    }
    const nextLine = start + rows.length
    return [`Lines ${start}–${nextLine - 1} of ${lines.length}${nextLine <= lines.length ? `; nextLine=${nextLine}` : ''} (long lines may be clipped)`, ...rows].join('\n')
  }

  search(path: unknown, query: unknown): string {
    if (typeof query !== 'string' || !query.trim() || query.length > 500 || /[\r\n]/.test(query)) throw new Error('Provide a single-line literal search string.')
    const root = this.path(path, true)
    const pending = [root]
    const hits: string[] = []
    let inspected = 0
    let skipped = 0
    const deadline = Date.now() + 250
    while (pending.length && inspected < 1000 && hits.length < 40 && Date.now() < deadline) {
      const target = pending.pop()!
      inspected++
      try {
        const entry = lstatSync(target)
        if (entry.isDirectory()) {
          if (relative(target, realpathSync.native(target))) continue
          for (const child of readdirSync(target, { withFileTypes: true })) {
            if (child.isFile() || (child.isDirectory() && !ignoredFolders.has(child.name))) pending.push(join(target, child.name))
          }
        } else {
          const lines = this.read(target).text.split('\n')
          for (const [index, line] of lines.entries()) {
            const at = line.indexOf(query)
            if (at < 0) continue
            hits.push(`${relative(this.directory, target)}:${index + 1}: ${line.slice(Math.max(0, at - 40), at + 150)}`)
            if (hits.length === 40) break
          }
        }
      } catch { skipped++ }
    }
    return [...hits, `Matches shown: ${hits.length}; skipped unreadable/non-text entries: ${skipped}. ${pending.length || hits.length === 40 ? 'Search limit reached; narrow the folder or query.' : ''}`].join('\n')
  }

  write(path: unknown, content: unknown, oldText?: string): string {
    if (typeof content !== 'string' || content.includes('\0')) throw new Error('Expected UTF-8 text content.')
    const target = this.path(path, false, oldText === undefined)
    if (oldText === undefined) {
      if (Buffer.byteLength(content) > MAX_FILE_BYTES) throw new Error('File exceeds 512 KiB.')
      writeFileSync(target, content, { flag: 'wx' })
    } else {
      const { text: original, entry } = this.read(target)
      const at = original.indexOf(oldText)
      if (!oldText || at < 0 || original.indexOf(oldText, at + 1) >= 0) throw new Error('The old text must match exactly once.')
      const updated = original.slice(0, at) + content + original.slice(at + oldText.length)
      if (Buffer.byteLength(updated) > MAX_FILE_BYTES) throw new Error('File exceeds 512 KiB.')
      const temporary = join(dirname(target), `.weport-${randomUUID()}.tmp`)
      try {
        writeFileSync(temporary, updated, { flag: 'wx', mode: entry.mode & 0o777 })
        const current = lstatSync(this.path(path))
        if (!sameEntry(entry, current) || current.mtimeMs !== entry.mtimeMs || current.size !== entry.size) {
          throw new Error('File changed during edit. Read it again before retrying.')
        }
        renameSync(temporary, target)
      } finally { try { unlinkSync(temporary) } catch { /* renamed or never created */ } }
    }
    return `${oldText === undefined ? 'Created' : 'Edited'} ${basename(target)}.`
  }

  createDirectory(path: unknown): string {
    const target = this.path(path, false, true)
    mkdirSync(target)
    return `Created directory ${basename(target)}.`
  }
}
