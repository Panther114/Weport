import * as path from 'path'
import * as fs from 'fs'
import { normalizeTimestampSeconds } from './timestamp'
import { ExportOptions } from '../types'

const WINDOWS_RESERVED_NAMES = new Set([
  'con', 'prn', 'aux', 'nul',
  'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
  'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9',
])

export function sanitizeExportFileNamePart(value: string): string {
  let name = String(value || '')
    .replace(/[<>:"\/\\|?*]/g, '_')
    .replace(/\.+$/, '')
    // Windows 不允许文件名以空格或点结尾
    .replace(/[\s.]+$/, '')
    .trim()
  // Windows 保留设备名（CON/PRN/AUX/NUL/COM1-9/LPT1-9）即使带扩展名也无法创建，
  // 加前缀规避（同名会话名称为「CON」时导出会直接失败）
  const base = name.replace(/\.[^.]+$/, '').toLowerCase()
  if (WINDOWS_RESERVED_NAMES.has(base)) {
    name = `_${name}`
  }
  return name
}

export function resolveFileAttachmentExtensionDir(msg: any, fileName: string): string {
  const rawExt = String(msg?.fileExt || '').trim() || path.extname(String(fileName || ''))
  const normalizedExt = rawExt.replace(/^\.+/, '').trim().toLowerCase()
  const safeExt = sanitizeExportFileNamePart(normalizedExt).replace(/\s+/g, '_')
  return safeExt || 'no-extension'
}

/**
 * 微信把收到的附件落盘时，如果目标目录里已经有同名文件，会自动追加 `(1)` / `(2)` 这类后缀；
 * 同一份文件被反复接收时会累加成 `(1)(3)(1)(1)`。但聊天消息里记录的**始终是原始文件名**，
 * 于是「拿消息里的文件名去 `msg/file/<yyyy-MM>/` 精确匹配」会整批落空，
 * 导出的 `src` 就只剩一个指向不存在文件的裸文件名。
 *
 * 这里解析出条目名相对目标文件名的「纯数字括号后缀序列」；不是这种形态就返回 null。
 * 只认纯 `(数字)` 后缀，因此 `报告（从A到B）(1).docx` 能匹配，`报告(1) - 副本.docx` 不会误匹配。
 */
function parseWeChatRenameSuffixNumbers(entryName: string, expectedName: string): number[] | null {
  const base = path.basename(String(expectedName || ''))
  const entry = String(entryName || '')
  if (!base || !entry || entry === base) return null

  const ext = path.extname(base)
  const stem = ext ? base.slice(0, base.length - ext.length) : base
  if (!entry.startsWith(stem) || !entry.endsWith(ext)) return null

  const middle = entry.slice(stem.length, entry.length - ext.length)
  if (!/^(?:\(\d+\))+$/.test(middle)) return null

  return (middle.match(/\d+/g) || []).map(value => Number.parseInt(value, 10))
}

export function isWeChatSuffixRenamedEntry(entryName: string, expectedName: string): boolean {
  return parseWeChatRenameSuffixNumbers(entryName, expectedName) !== null
}

/** 从一批目录条目里挑出「微信加了 (N) 后缀」的候选，按后缀序号升序排列（`(1)` < `(2)` < `(10)`）。 */
export function pickWeChatSuffixRenamedEntries(entryNames: readonly string[], expectedName: string): string[] {
  const matched: Array<{ name: string; suffixNumbers: number[] }> = []
  for (const entryName of entryNames) {
    const suffixNumbers = parseWeChatRenameSuffixNumbers(entryName, expectedName)
    if (suffixNumbers) matched.push({ name: String(entryName), suffixNumbers })
  }

  matched.sort((left, right) => {
    const depth = Math.max(left.suffixNumbers.length, right.suffixNumbers.length)
    for (let index = 0; index < depth; index += 1) {
      const leftValue = left.suffixNumbers[index] ?? 0
      const rightValue = right.suffixNumbers[index] ?? 0
      if (leftValue !== rightValue) return leftValue - rightValue
    }
    return left.name.localeCompare(right.name)
  })

  return matched.map(item => item.name)
}

export function normalizeFileNamingMode(value: unknown): 'classic' | 'date-range' {
  return String(value || '').trim().toLowerCase() === 'date-range' ? 'date-range' : 'classic'
}

export function normalizeExportConflictStrategy(value: unknown): 'incremental' | 'overwrite' | 'rename' {
  const normalized = String(value || '').trim().toLowerCase()
  if (normalized === 'overwrite') return 'overwrite'
  if (normalized === 'rename') return 'rename'
  return 'incremental'
}

export function formatDateTokenBySeconds(seconds?: number): string | null {
  const normalizedSeconds = normalizeTimestampSeconds(seconds)
  if (normalizedSeconds <= 0) return null
  const date = new Date(normalizedSeconds * 1000)
  if (Number.isNaN(date.getTime())) return null
  const y = date.getFullYear()
  const m = `${date.getMonth() + 1}`.padStart(2, '0')
  const d = `${date.getDate()}`.padStart(2, '0')
  return `${y}${m}${d}`
}

export function buildDateRangeFileNamePart(dateRange?: { start: number; end: number } | null): string {
  const start = formatDateTokenBySeconds(dateRange?.start)
  const end = formatDateTokenBySeconds(dateRange?.end)
  if (start && end) {
    if (start === end) return start
    return start < end ? `${start}-${end}` : `${end}-${start}`
  }
  if (start) return `${start}-至今`
  if (end) return `截至-${end}`
  return '全部时间'
}

export function buildSessionExportBaseName(
  sessionId: string,
  displayName: string,
  options: ExportOptions
): string {
  const baseName = sanitizeExportFileNamePart(displayName || sessionId) || sanitizeExportFileNamePart(sessionId) || 'session'
  const suffix = sanitizeExportFileNamePart(options.fileNameSuffix || '')
  const namingMode = normalizeFileNamingMode(options.fileNamingMode)
  const parts = [baseName]
  if (suffix) parts.push(suffix)
  if (namingMode === 'date-range') {
    parts.push(buildDateRangeFileNamePart(options.dateRange))
  }
  return sanitizeExportFileNamePart(parts.join('_')) || 'session'
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.promises.access(p)
    return true
  } catch {
    return false
  }
}

export async function reserveUniqueOutputPath(preferredPath: string, reservedPaths: Set<string>): Promise<string> {
  const dir = path.dirname(preferredPath)
  const ext = path.extname(preferredPath)
  const base = path.basename(preferredPath, ext)

  for (let attempt = 0; attempt < 10000; attempt += 1) {
    const candidate = attempt === 0
      ? preferredPath
      : path.join(dir, `${base}_${attempt + 1}${ext}`)

    if (reservedPaths.has(candidate)) continue

    const exists = await pathExists(candidate)
    if (reservedPaths.has(candidate)) continue
    if (exists) continue

    reservedPaths.add(candidate)
    return candidate
  }

  const fallback = path.join(dir, `${base}_${Date.now()}${ext}`)
  reservedPaths.add(fallback)
  return fallback
}
