#!/usr/bin/env node
/**
 * verify-tui-engine.mjs — end-to-end check of the TUI's engine protocol.
 *
 * The TUI is only useful if `weport <command>` really reaches the main process, so
 * this spawns the packaged app in `--cli` mode exactly as the TUI does, performs the
 * token handshake, and runs a read-only command against the real database. It fails
 * loudly on a missing handshake, a wrong-shaped reply, or a command that errors.
 *
 * Usage: node scripts/verify-tui-engine.mjs [path-to-Weport.exe]
 */
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync } from 'node:fs'
import { WeportEngine } from '../packages/weport-tui/dist/engine.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const candidates = [
  process.argv[2],
  process.env.WEPORT_ENGINE,
  join(root, 'release', 'win-unpacked', process.platform === 'win32' ? 'Weport.exe' : 'Weport'),
  process.platform === 'win32' ? join(process.env.LOCALAPPDATA || '', 'Programs', 'Weport', 'Weport.exe') : null,
].filter(Boolean)

const exe = candidates.find((candidate) => existsSync(candidate))
if (!exe) {
  console.error(`no engine found; tried:\n${candidates.join('\n')}`)
  process.exit(2)
}
console.log(`engine: ${exe}`)

let failed = false
const step = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failed = true
}

const engine = new WeportEngine(exe, root)
engine.onLog = (line) => console.log(`   [engine] ${line}`)
engine.onExit = (code) => console.log(`   [engine exited ${code}]`)

try {
  const info = await engine.start(90000)
  step('handshake', Boolean(info?.version), `version=${info.version} pid=${info.pid}`)

  const ping = await engine.call('cli.ping')
  step('cli.ping', ping.success, ping.success ? `dbPath=${String(ping.data?.dbPath || '(none)')}` : ping.error)

  const commands = await engine.call('cli.commands')
  const list = Array.isArray(commands.data) ? commands.data : []
  step('cli.commands', commands.success && list.length > 0, `${list.length} commands`)

  const sessions = await engine.call('sessions.list', { limit: 5 }, 180000)
  const rows = Array.isArray(sessions.data) ? sessions.data : []
  step('sessions.list', sessions.success, sessions.success ? `${rows.length} rows${rows[0] ? ` · 第一个：${rows[0].name}` : ''}` : sessions.error)

  if (rows[0]?.id) {
    const messages = await engine.call('messages.list', { session: rows[0].id, limit: 3 }, 180000)
    const messages_ = Array.isArray(messages.data) ? messages.data : []
    step('messages.list', messages.success, messages.success ? `${messages_.length} 条 · ${String(messages_[0]?.text || '').slice(0, 40)}` : messages.error)
  }

  const connectors = await engine.call('connectors.list')
  step('connectors.list', connectors.success, connectors.success ? `${(connectors.data || []).length} connector(s)` : connectors.error)

  const bad = await engine.call('does.not.exist')
  step('unknown command is rejected', bad.success === false, String(bad.error || ''))
} catch (error) {
  step('engine session', false, String(error?.message || error))
} finally {
  engine.stop()
}

setTimeout(() => process.exit(failed ? 1 : 0), 600)
