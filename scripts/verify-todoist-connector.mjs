#!/usr/bin/env node
/**
 * verify-todoist-connector.mjs — exercise the Todoist connector against the live
 * API using the real source module (bundled on the fly by Vite, so there is no
 * hand-copied duplicate of the connector logic to drift).
 *
 * Why this exists next to the unit tests: those pin the *request body* against a
 * stubbed fetch, which cannot tell you whether Todoist accepts it. The parts most
 * likely to be wrong in reality are the ones only the service can answer —
 * `due_string` natural-language parsing in a given language, and the priority
 * numbering (the API stores 4 = urgent while its own syntax says `p1`). Both are
 * read back from a freshly created task here.
 *
 * The token is read from `WEPORT_TODOIST_TOKEN` or `{repo}/.todoist-token`
 * (git-ignored); it is never printed.
 *
 * Usage:
 *   node scripts/verify-todoist-connector.mjs              # verify + list targets (no writes)
 *   node scripts/verify-todoist-connector.mjs --create     # also create one probe task
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'vite'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

async function loadConnector() {
  const outDir = mkdtempSync(join(tmpdir(), 'weport-todoist-'))
  await build({
    root,
    configFile: false,
    logLevel: 'error',
    build: {
      lib: { entry: join(root, 'electron/services/connectors/todoistConnector.ts'), formats: ['es'], fileName: () => 'connector.mjs' },
      outDir,
      emptyOutDir: false,
      target: 'node20',
      minify: false,
      ssr: true,
    },
  })
  const mod = await import(pathToFileURL(join(outDir, 'connector.mjs')).href)
  return { mod, cleanup: () => rmSync(outDir, { recursive: true, force: true }) }
}

function readToken() {
  if (process.env.WEPORT_TODOIST_TOKEN?.trim()) return { token: process.env.WEPORT_TODOIST_TOKEN.trim(), source: 'env' }
  const file = join(root, '.todoist-token')
  if (existsSync(file)) return { token: readFileSync(file, 'utf8').trim(), source: '.todoist-token' }
  return { token: '', source: '' }
}

const { token, source } = readToken()
if (!token) {
  console.error('No Todoist token. Set WEPORT_TODOIST_TOKEN or write a token to .todoist-token (never commit it).')
  process.exit(2)
}

const { mod, cleanup } = await loadConnector()
const todoistConnector = mod.todoistConnector
console.log(`token: ${token.length} chars from ${source}`)

let failed = false
const step = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failed = true
}

const verify = await todoistConnector.verify(token)
step('verify token', verify.success, verify.success ? verify.data?.accountName : verify.error)

const targets = await todoistConnector.listTargets(token)
step('list targets', targets.success && (targets.data?.length || 0) > 0, targets.success ? `${targets.data?.length} targets` : targets.error)
if (targets.success) {
  for (const target of (targets.data || []).slice(0, 10)) {
    console.log(`   · [${target.kind}] ${target.name}${target.id ? ` (${target.id})` : ''}`)
  }
}

if (process.argv.includes('--create')) {
  const stamp = new Date().toISOString().slice(0, 19)
  const created = await todoistConnector.createTask(token, {
    content: `Weport connector check ${stamp}`,
    description: 'Created by scripts/verify-todoist-connector.mjs — safe to delete.',
    dueText: 'tomorrow 9am',
    priority: 'urgent',
    labels: ['weport-verify'],
  })
  step('create task (natural-language due + urgent priority)', created.success, created.success ? created.data?.url : created.error)
  if (created.success && created.data?.id) {
    const listed = await todoistConnector.listTasks(token, { limit: 50 })
    const found = listed.success ? (listed.data || []).find((task) => task.id === created.data.id) : undefined
    step('read the task back', Boolean(found), found ? `due="${found.dueText}" priority=${found.priority}` : 'not found in the first 50 tasks')
    if (found) step('priority round-trips as urgent', found.priority === 'urgent', `got ${found.priority}`)
    if (found?.dueText) step('due date parsed by Todoist', /\d/.test(found.dueText), found.dueText)
  }
} else {
  console.log('(no --create flag: skipping writes)')
}

cleanup()
process.exit(failed ? 1 : 0)
