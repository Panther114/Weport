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
