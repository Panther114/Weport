import { readFileSync, readdirSync, statSync } from 'fs'
import { basename, isAbsolute, join, normalize } from 'path'

/** Bounded hints only; callers must validate the WeChat 4.x account layout. */
export function windowsDbRoots(home: string, documents: string, appData: string): string[] {
  const candidates: string[] = []
  const configDir = join(appData, 'Tencent', 'xwechat', 'config')
  try {
    const files = readdirSync(configDir).filter(name => /^[a-f0-9]{32}\.ini$/i.test(name)).sort()
    for (const name of files.slice(0, 64)) {
      try {
        const file = join(configDir, name)
        if (statSync(file).size > 4096) continue
        const bytes = readFileSync(file)
        const utf16 = bytes[0] === 0xff && bytes[1] === 0xfe
        const value = bytes.toString(utf16 ? 'utf16le' : 'utf8').replace(/^\uFEFF/, '').replace(/\0+$/, '').trim().replace(/^"(.*)"$/, '$1')
        const path = /^MyDocument:\s*$/i.test(value) ? documents : value
        if (!isAbsolute(path) || /[\r\n\0]/.test(path)) continue
        candidates.push(basename(normalize(path)).toLowerCase() === 'xwechat_files' ? path : join(path, 'xwechat_files'))
      } catch { /* An unreadable hint must not hide the other candidates. */ }
    }
  } catch { /* No relocation hints on a fresh installation. */ }
  candidates.push(join(documents, 'xwechat_files'), join(home, 'Documents', 'xwechat_files'), join(home, 'xwechat_files'))
  return [...new Set(candidates.map(path => normalize(path)))]
}
