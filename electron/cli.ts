import { getExtractor, type ExportOptions } from './api'

type ArgMap = Record<string, string | boolean>

function print(data: unknown) {
  if (typeof data === 'string') {
    process.stdout.write(data + (data.endsWith('\n') ? '' : '\n'))
    return
  }
  process.stdout.write(JSON.stringify(data, null, 2) + '\n')
}

function fail(message: string, code = 1): never {
  process.stderr.write(String(message) + '\n')
  process.exit(code)
}

function parseArgs(argv: string[]): { command: string; flags: ArgMap; positionals: string[] } {
  const [command = 'help', ...rest] = argv
  const flags: ArgMap = {}
  const positionals: string[] = []

  for (let i = 0; i < rest.length; i++) {
    const token = rest[i]
    if (!token.startsWith('--')) {
      positionals.push(token)
      continue
    }
    const body = token.slice(2)
    if (body.includes('=')) {
      const [k, ...v] = body.split('=')
      flags[k] = v.join('=')
      continue
    }
    const next = rest[i + 1]
    if (next && !next.startsWith('--')) {
      flags[body] = next
      i++
    } else {
      flags[body] = true
    }
  }

  return { command, flags, positionals }
}

function flagString(flags: ArgMap, ...keys: string[]): string {
  for (const key of keys) {
    const value = flags[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return ''
}

function flagBool(flags: ArgMap, key: string, defaultValue = false): boolean {
  if (!(key in flags)) return defaultValue
  const value = flags[key]
  if (value === true) return true
  if (value === false) return false
  const text = String(value).trim().toLowerCase()
  if (['0', 'false', 'no', 'off'].includes(text)) return false
  return true
}

function usage(): string {
  return `Weport Engine CLI — WeChat chat history extraction

Usage:
  weport-engine <command> [options]
  weport <command> [options]

Commands:
  help                         Show this help
  detect                       Auto-detect WeChat data directory
  accounts --db <path>         List wxid accounts under a data directory
  key                          Auto-extract database key (WeChat must be logged in)
  image-key [--wxid <id>]      Auto-extract image XOR/AES keys
  config                       Show current stored config
  config-set --db --key --wxid [--xor] [--aes] [--cache] [--export]
  connect                      Test + connect using stored/flag config
  sessions [--json]            List sessions (requires configured connection)
  export --out <dir> [opts]    Export selected/all sessions

Export options:
  --out <dir>                  Output directory (required)
  --format <fmt>               txt|json (also accepts engine formats)
  --sessions <id,id>           Comma-separated session usernames
  --all                        Export all sessions (every contact + group)
  --flat                       Write files directly into --out (default)
  --per-session                One subfolder per session
  --no-media                   Disable media export (default for Weport)
  --media                      Enable media export
  --no-images --no-voices --no-videos --no-emojis --no-files
  --avatars / --no-avatars

File names:
  群聊_[name].txt|json
  私聊_[name].txt|json

Examples:
  weport detect
  weport accounts --db "C:\\\\Users\\\\me\\\\Documents\\\\xwechat_files"
  weport key
  weport export --out ./out --format txt --all --flat
  weport export --out ./out --format json --all
`
}

async function ensureConfiguredFromFlags(flags: ArgMap) {
  const extractor = getExtractor()
  const input = {
    dbPath: flagString(flags, 'db', 'dbPath') || undefined,
    decryptKey: flagString(flags, 'key', 'decryptKey') || undefined,
    wxid: flagString(flags, 'wxid', 'myWxid') || undefined,
    imageXorKey: flagString(flags, 'xor', 'imageXorKey') || undefined,
    imageAesKey: flagString(flags, 'aes', 'imageAesKey') || undefined,
    cachePath: flagString(flags, 'cache', 'cachePath') || undefined,
    exportPath: flagString(flags, 'export', 'exportPath') || undefined,
    logEnabled: 'log' in flags ? flagBool(flags, 'log') : undefined
  }
  await extractor.configure(input)
  return extractor
}

async function runCli(argv: string[]): Promise<number> {
  const { command, flags } = parseArgs(argv)
  const extractor = getExtractor()
  extractor.init()

  switch (command) {
    case 'help':
    case '-h':
    case '--help':
      print(usage())
      return 0

    case 'detect': {
      const result = await extractor.detectDbPath()
      print(result)
      return result.success ? 0 : 1
    }

    case 'accounts': {
      const db = flagString(flags, 'db', 'dbPath') || String(extractor.getConfig('dbPath') || '')
      if (!db) fail('Missing --db <path>')
      const list = await extractor.scanAccounts(db)
      print(list)
      return 0
    }

    case 'key': {
      const result = await extractor.getDbKey((message) => {
        process.stderr.write(`[key] ${message}\n`)
      })
      if (result.success && result.key) {
        await extractor.configure({ decryptKey: result.key })
      }
      print(result)
      return result.success ? 0 : 1
    }

    case 'image-key': {
      const wxid = flagString(flags, 'wxid') || undefined
      const result = await extractor.getImageKey({
        wxid,
        onStatus: (message) => process.stderr.write(`[image-key] ${message}\n`)
      })
      if (result.success) {
        await extractor.configure({
          imageXorKey: result.xorKey,
          imageAesKey: result.aesKey
        })
      }
      print(result)
      return result.success ? 0 : 1
    }

    case 'config': {
      print({
        dbPath: extractor.getConfig('dbPath') || '',
        decryptKey: extractor.getConfig('decryptKey') ? '[set]' : '',
        myWxid: extractor.getConfig('myWxid') || '',
        imageXorKey: extractor.getConfig('imageXorKey') ?? '',
        imageAesKey: extractor.getConfig('imageAesKey') ? '[set]' : '',
        cachePath: extractor.getConfig('cachePath') || '',
        exportPath: extractor.getConfig('exportPath') || '',
        logEnabled: extractor.getConfig('logEnabled') === true
      })
      return 0
    }

    case 'config-set': {
      await ensureConfiguredFromFlags(flags)
      print({ success: true, message: 'config updated' })
      return 0
    }

    case 'connect': {
      await ensureConfiguredFromFlags(flags)
      const test = await extractor.testConnection()
      if (!test.success) {
        print(test)
        return 1
      }
      const result = await extractor.connect()
      print(result)
      return result.success ? 0 : 1
    }

    case 'sessions': {
      await ensureConfiguredFromFlags(flags)
      const connected = await extractor.connect()
      if (!connected.success) {
        print(connected)
        return 1
      }
      const result = await extractor.listSessions()
      if (!result.success) {
        print(result)
        return 1
      }
      if (flagBool(flags, 'json', true) || flags.json === true || !('table' in flags)) {
        print(
          (result.sessions || []).map((s) => ({
            username: s.username,
            displayName: s.displayName || s.username,
            type: s.type,
            lastTimestamp: s.lastTimestamp,
            messageCountHint: s.messageCountHint,
            summary: s.summary
          }))
        )
      }
      return 0
    }

    case 'export': {
      await ensureConfiguredFromFlags(flags)
      const out = flagString(flags, 'out', 'output', 'export')
      if (!out) fail('Missing --out <dir>')

      const formatRaw = (flagString(flags, 'format') || 'txt').toLowerCase()
      const format = (formatRaw === 'json' ? 'json' : formatRaw === 'txt' ? 'txt' : formatRaw) as ExportOptions['format']
      // Weport defaults: no media, flat layout (群聊_/私聊_ files in output folder)
      const exportMedia = flagBool(flags, 'media', false) && !flagBool(flags, 'no-media', false)
      const flat = !flagBool(flags, 'per-session', false)
      const options: ExportOptions = {
        format,
        exportMedia,
        exportAvatars: flagBool(flags, 'avatars', false),
        exportImages: exportMedia && !flagBool(flags, 'no-images', false),
        exportVoices: exportMedia && !flagBool(flags, 'no-voices', false),
        exportVideos: exportMedia && !flagBool(flags, 'no-videos', false),
        exportEmojis: exportMedia && !flagBool(flags, 'no-emojis', false),
        exportFiles: exportMedia && !flagBool(flags, 'no-files', false),
        maxFileSizeMb: 200,
        sessionLayout: flat ? 'shared' : 'per-session',
        sessionNameWithTypePrefix: true,
        exportWriteLayout: 'A',
        displayNamePreference: 'group-nickname',
        exportConflictStrategy: 'rename'
      }

      const connected = await extractor.connect()
      if (!connected.success) {
        print(connected)
        return 1
      }

      let sessionIds = flagString(flags, 'sessions', 'session')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)

      // Default to --all when no sessions specified (Weport lightweight export)
      if (flagBool(flags, 'all', false) || sessionIds.length === 0) {
        const listed = await extractor.listSessions({ enrichNames: true })
        if (!listed.success || !listed.sessions) {
          print(listed)
          return 1
        }
        sessionIds = listed.sessions.map((s) => s.username).filter(Boolean)
      }

      if (sessionIds.length === 0) fail('No sessions to export')

      await extractor.configure({ exportPath: out })
      process.stderr.write(`[export] ${sessionIds.length} session(s) → ${out} (${format})\n`)

      const result = await extractor.exportSessions(sessionIds, out, options, {
        taskId: `cli_${Date.now()}`,
        onProgress: (p) => {
          const label = p.phaseLabel || p.phase || 'exporting'
          const ratio =
            p.total > 0
              ? `${p.current.toFixed(1)}/${p.total}`
              : p.phaseTotal
                ? `${p.phaseProgress || 0}/${p.phaseTotal}`
                : ''
          const session = p.currentSession || p.currentSessionId || ''
          process.stderr.write(`[export] ${label}${ratio ? ' ' + ratio : ''}${session ? ' ' + session : ''}\n`)
        }
      })

      print(result)
      return result?.success ? 0 : 1
    }

    default:
      fail(`Unknown command: ${command}\n\n${usage()}`)
  }
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  try {
    const code = await runCli(argv)
    await getExtractor().close()
    process.exit(code)
  } catch (error) {
    const message = error instanceof Error ? error.stack || error.message : String(error)
    process.stderr.write(message + '\n')
    try {
      await getExtractor().close()
    } catch {
      // ignore
    }
    process.exit(1)
  }
}
