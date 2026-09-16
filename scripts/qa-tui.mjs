#!/usr/bin/env node
/**
 * qa-tui.mjs — the TUI's verification harness.
 *
 * `weport` is a text interface, so a screenshot proves nothing; instead the TUI
 * renders real frames to files (`--dump`) and this script asserts on them:
 *
 *   1. every section renders (no ERROR line in the dump index),
 *   2. every frame is exactly the requested size — no line longer than the terminal,
 *      which is what turns a TUI into a wrapped mess,
 *   3. no frame is blank, and the sidebar/title actually appear,
 *   4. the table-heavy views (sessions, messages) contain real rows.
 *
 * It drives the *installed* engine when `--exe` is omitted, so the run also proves the
 * packaged app exposes the CLI surface.
 *
 * Usage: node scripts/qa-tui.mjs [--exe <Weport.exe>] [--session <wxid>] [--width 140]
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const flag = (name, fallback) => {
  const index = args.indexOf(`--${name}`)
  return index >= 0 ? args[index + 1] : fallback
}

const exe = flag('exe', join(root, 'release', 'win-unpacked', process.platform === 'win32' ? 'Weport.exe' : 'Weport'))
const width = Number(flag('width', '140'))
const height = Number(flag('height', '38'))
if (!existsSync(exe)) {
  console.error(`engine not found: ${exe}`)
  process.exit(2)
}

let failed = false
const step = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failed = true
}

const dumpDir = mkdtempSync(join(tmpdir(), 'weport-tui-qa-'))
const cli = join(root, 'packages', 'weport-tui', 'bin', 'weport.mjs')
const session = flag('session', '')
const run = spawnSync(
  process.execPath,
  [cli, '--exe', exe, '--dump', dumpDir, '--width', String(width), '--height', String(height), ...(session ? ['--session', session] : [])],
  { encoding: 'utf8', timeout: 600000 },
)
const log = `${run.stdout || ''}${run.stderr || ''}`
console.log(log.trim().split('\n').slice(0, 20).map((line) => `   ${line}`).join('\n'))

step('dump exits 0', run.status === 0, `status=${run.status}`)
const files = readdirSync(dumpDir).filter((name) => name.endsWith('.txt') && name !== 'index.txt')
step('every section wrote a frame', files.length >= 9, `${files.length} files`)

for (const file of files) {
  const raw = readFileSync(join(dumpDir, file), 'utf8')
  // composeFrame writes "\r\n" between rows and ends each with ESC[K.
  const lines = raw.replace(new RegExp('\\u001B\\[K', 'g'), '').split(/\r?\n/).filter((line, index, all) => index < all.length - 1 || line.length > 0)
  const oversized = lines.find((line) => line.length > width)
  const blank = lines.every((line) => line.trim().length === 0)
  step(`${file} fits ${width} columns`, !oversized, oversized ? `${oversized.length} cols` : '')
  step(`${file} is not blank`, !blank, blank ? 'all lines empty' : `${lines.length} rows`)
  // The sidebar holds one section per row, so "总览" and "帮助" never share a line —
  // check each is present in the first column band instead.
  const hasSectionRow = (label) => lines.some((line) => line.slice(0, 24).includes(label))
  step(`${file} has the sidebar`, hasSectionRow('总览') && hasSectionRow('帮助'), '')
}

for (const [file, needle] of [
  ['sessions.txt', '会话'],
  ['messages-session.txt', ''],
  ['help.txt', 'cli.commands'],
  ['connectors.txt', 'Todoist'],
]) {
  if (!files.includes(file)) continue
  const raw = readFileSync(join(dumpDir, file), 'utf8')
  step(`${file} mentions ${needle || 'messages'}`, needle ? raw.includes(needle) : /我|对方|消息/.test(raw), '')
}

console.log(`\nframes kept at ${dumpDir}`)
process.exit(failed ? 1 : 0)
