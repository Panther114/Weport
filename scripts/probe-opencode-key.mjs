#!/usr/bin/env node
/**
 * probe-opencode-key.mjs — answer one question: does the OpenCode credential that
 * lives on this machine actually work, and for which models?
 *
 * Why it exists: the Weport probes report `Invalid API key` for every OpenCode
 * profile, while `opencode.ai/zen/go/v1/models` answers anonymously. Gateways can
 * reject in several different ways (bad key, region, missing session header), and
 * the messages are not interchangeable — this prints the raw status and body for
 * a chosen model, with the `x-opencode-session` header the gateway requires
 * (without it the router answers `MissingSessionID` and never reaches the model).
 *
 * Usage:
 *   node scripts/probe-opencode-key.mjs                 # default deepseek-v4.1-flash
 *   node scripts/probe-opencode-key.mjs grok-4.6 kimi-k3
 *   OPENCODE_KEY=sk-... node scripts/probe-opencode-key.mjs
 *
 * The key is read from `~/.local/share/opencode/auth.json` (the OpenCode CLI's own
 * store) unless OPENCODE_KEY is set. It is never printed — only its length.
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

const AUTH_PATH = join(homedir(), '.local', 'share', 'opencode', 'auth.json')
const BASE = 'https://opencode.ai/zen/go/v1'

function readKey() {
  if (process.env.OPENCODE_KEY?.trim()) return { key: process.env.OPENCODE_KEY.trim(), source: 'env' }
  try {
    const auth = JSON.parse(readFileSync(AUTH_PATH, 'utf8'))
    const entry = auth['opencode-go'] || auth.opencode
    const key = String(entry?.key || '').trim()
    if (key) return { key, source: AUTH_PATH }
  } catch (error) {
    console.error(`could not read ${AUTH_PATH}: ${String(error.message || error)}`)
  }
  return { key: '', source: '' }
}

async function attempt(model, key, headers) {
  const startedAt = Date.now()
  const response = await fetch(`${BASE}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}`, ...headers },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: 'Reply with the single word: ok' }], max_tokens: 12 }),
    signal: AbortSignal.timeout(60000),
  })
  const text = await response.text().catch(() => '')
  return { status: response.status, body: text.slice(0, 400).replace(/\s+/g, ' '), ms: Date.now() - startedAt }
}

const { key, source } = readKey()
if (!key) {
  console.error('no OpenCode key found')
  process.exit(2)
}
const models = process.argv.slice(2)
if (models.length === 0) models.push('deepseek-v4.1-flash')

console.log(`key: ${key.length} chars from ${source}`)
const session = `weport-probe-${randomUUID()}`
for (const model of models) {
  const withSession = await attempt(model, key, { 'x-opencode-session': session })
  console.log(`${model}: HTTP ${withSession.status} in ${withSession.ms}ms :: ${withSession.body}`)
  if (withSession.status === 400 && withSession.body.includes('MissingSessionID')) {
    console.log(`  (retrying ${model} without the session header to confirm the header is the cause)`)
    const without = await attempt(model, key, {})
    console.log(`${model} (no session header): HTTP ${without.status} :: ${without.body}`)
  }
}
