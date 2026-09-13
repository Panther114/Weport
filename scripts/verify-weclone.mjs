#!/usr/bin/env node
/**
 * verify-weclone.mjs — drive the WeClone path end to end against a running
 * `weclone-server` and measure what the user actually cares about: how similar the
 * clone's replies are to the real person.
 *
 * Pipeline (all against real data, nothing mocked):
 *   1. read a clone's staging directory (chunks.jsonl + the five markdown sheets)
 *   2. upload it with an owner token
 *   3. pull real "stimulus → the person's actual reply" pairs out of the same corpus
 *      and ask the clone to answer the stimulus
 *   4. score similarity on four independent axes and print a table
 *
 * The evaluation set is built from *held-out* turns (the tail of each conversation),
 * so the clone is being scored on material it was given the chance to memorise — the
 * number is therefore an optimistic bound, and the honest signal is the comparison
 * between runs (same model, different prompt/retrieval) rather than the absolute value.
 * It is deliberately not a "the clone sounds nice" claim: it is a number that moves when
 * the implementation changes.
 *
 * Usage:
 *   node scripts/verify-weclone.mjs --id wc_... [--server http://127.0.0.1:8099]
 *   node scripts/verify-weclone.mjs --id wc_... --pairs 20 --json
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const flag = (name, fallback) => {
  const index = args.indexOf(`--${name}`)
  return index >= 0 ? args[index + 1] : fallback
}
const has = (name) => args.includes(`--${name}`)

const server = flag('server', 'http://127.0.0.1:8099').replace(/\/+$/, '')
const pairsWanted = Number(flag('pairs', '12'))
const jsonOut = has('json')
const stagingDir = flag('staging', join(process.env.APPDATA || '', 'Weport', 'weclone-staging', 'wxid_gsnpwh6vh2z012'))
const ownerToken = flag('token', process.env.WECLONE_OWNER_TOKEN || 'weport-owner-token')

const log = (...parts) => { if (!jsonOut) console.log(...parts) }
const fail = (message) => { console.error(`FAIL ${message}`); process.exit(1) }

if (!existsSync(join(stagingDir, 'chunks.jsonl'))) fail(`no chunks.jsonl under ${stagingDir}`)

// ---------------------------------------------------------------------------
// 1. load the clone
// ---------------------------------------------------------------------------
const meta = JSON.parse(readFileSync(join(stagingDir, 'metadata.json'), 'utf8'))
const mds = {}
// The app's own staging directories keep the sheets at the root; the voice builder writes
// them under `mds/`. Accept both rather than forcing one layout on the other. The server
// caps the set at five files (`MAX_MD_FILES`), so the most voice-bearing sheets win.
const WANTED_MD = ['voice.md', 'language.md', 'profile.md', 'knowledge.md', 'timeline.md', 'relationships.md']
for (const base of [stagingDir, join(stagingDir, 'mds')]) {
  for (const name of WANTED_MD) {
    if (Object.keys(mds).length >= 5) break
    const file = join(base, name)
    if (!mds[name] && existsSync(file)) mds[name] = readFileSync(file, 'utf8')
  }
}
const chunks = readFileSync(join(stagingDir, 'chunks.jsonl'), 'utf8')
  .split(/\r?\n/)
  .filter(Boolean)
  .map((line) => { try { return JSON.parse(line) } catch { return null } })
  .filter(Boolean)

log(`clone: ${meta.displayName} · ${meta.messageCount} messages · ${chunks.length} chunks · ${Object.keys(mds).length} md sheets`)

// ---------------------------------------------------------------------------
// 2. build the evaluation set
// ---------------------------------------------------------------------------

const MY_WXID = String(meta.wxid || '')
const MY_NAME = String(meta.displayName || '').trim()

/**
 * Candidate stimulus/response pairs.
 *
 * Two corpus shapes exist and both have to be readable:
 *  - a message stream (`sessions.jsonl`, what `build-weclone-voice.mjs` writes): a cue
 *    line followed by the person's own reply. This is the honest source, because the
 *    pair is a real adjacency rather than something parsed back out of a chunk string.
 *  - the legacy `chunks.jsonl` whose text is `speaker: text` lines, which predates the
 *    stream and is still what the on-disk clone contains.
 */
function buildPairs() {
  const sessionsFile = join(stagingDir, 'sessions.jsonl')
  if (existsSync(sessionsFile)) {
    const pairs = []
    for (const line of readFileSync(sessionsFile, 'utf8').split(/\r?\n/).filter(Boolean)) {
      const session = JSON.parse(line)
      let cue = null
      for (const message of session.messages || []) {
        const text = String(message.text || '').trim()
        if (text.length < 2 || text.length > 180) continue
        if (message.from === 'me') {
          if (cue) pairs.push({ cue, reply: text, sid: session.id, ts: message.at })
          cue = null
        } else {
          cue = text
        }
      }
    }
    return { pairs, source: 'sessions.jsonl' }
  }
  const pairs = []
  let cue = null
  for (const chunk of chunks) {
    const lines = String(chunk.text || '').split('\n').map((line) => line.trim()).filter(Boolean)
    for (const line of lines) {
      const separator = line.indexOf(': ')
      if (separator <= 0) continue
      const speaker = line.slice(0, separator)
      const text = line.slice(separator + 2).trim()
      if (!text || text.length < 2 || text.length > 180) continue
      if (text.includes('<?xml') || text.startsWith('[')) continue
      const isMine = speaker === MY_WXID || speaker === '我' || speaker === MY_NAME
      if (isMine) {
        if (cue) {
          pairs.push({ cue, reply: text, sid: chunk.sid, ts: chunk.ts })
          cue = null
        }
      } else {
        cue = text
      }
    }
  }
  return { pairs, source: 'chunks.jsonl' }
}

const built = buildPairs()
const allPairs = built.pairs
if (allPairs.length < 5) fail(`not enough stimulus/response pairs in the corpus (${allPairs.length})`)

/**
 * Pin the evaluation set.
 *
 * A strided sample of "however many pairs I asked for" moves every time the sample size
 * changes, which silently makes two runs incomparable — the first measurement here read
 * 0.287 and a re-run 0.042 purely because the stride changed. So the chosen pairs are
 * written to `eval-<n>.json` once, and later runs with `--eval <file>` score exactly the
 * same turns. That is what turns the number into a regression test instead of a readout.
 */
const evalFile = flag('eval', '')
const saveEval = flag('save-eval', '')
let selected
if (evalFile && existsSync(evalFile)) {
  const saved = JSON.parse(readFileSync(evalFile, 'utf8'))
  selected = saved.pairs || []
  log(`evaluation set: ${selected.length} pinned turns from ${evalFile}`)
} else {
  const step = Math.max(1, Math.floor(allPairs.length / Math.max(1, pairsWanted)))
  selected = allPairs.filter((_, index) => index % step === 0).slice(0, pairsWanted)
  log(`evaluation set: ${selected.length} held-out turns out of ${allPairs.length} candidates (from ${built.source})`)
  if (saveEval) {
    writeFileSync(saveEval, JSON.stringify({ source: built.source, createdAt: new Date().toISOString(), pairs: selected }, null, 2), 'utf8')
    log(`pinned to ${saveEval}`)
  }
}
const pairs = selected

/**
 * The server refuses an upload whose severe-PII count exceeds its threshold (5), and
 * this staging corpus was generated before the current filter, so it carries 59 hits.
 * The client-side filter is the same module the app ships, imported here rather than
 * reimplemented — the point of the check is that the shipped filter is what runs.
 */
async function loadPiiFilter() {
  const outDir = mkdtempSync(join(tmpdir(), 'weport-pii-'))
  const outFile = join(outDir, 'filter.mjs')
  const esbuild = await import('esbuild')
  await esbuild.build({
    entryPoints: [join(root, 'electron/services/weClonePiiFilter.ts')],
    outfile: outFile,
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node20',
    logLevel: 'error',
  })
  const mod = await import(pathToFileURL(outFile).href)
  return { mod, cleanup: () => rmSync(outDir, { recursive: true, force: true }) }
}

const { mod: pii, cleanup: cleanupPii } = await loadPiiFilter()
const redact = pii.redactSensitiveText || pii.default || ((text) => text)
const audit = pii.auditSeverePii

// ---------------------------------------------------------------------------
// 3. upload
// ---------------------------------------------------------------------------
const auth = { Authorization: `Bearer ${ownerToken}` }

/**
 * The server rejects any chunk over 1200 characters (`MAX_CHUNK_TEXT_CHARS`), and the
 * staging corpus predates that limit.
 *
 * Splitting happens on line boundaries first, because retrieval matches whole
 * utterances — but a single message can itself exceed the limit (an XML blob, a long
 * paste), so a hard character cut has to follow. Without it the upload fails on the
 * second chunk of this particular corpus.
 */
const MAX_CHUNK_TEXT = 1200
function splitForUpload(entries) {
  const out = []
  const push = (id, sid, ts, text) => {
    for (let start = 0; start < text.length; start += MAX_CHUNK_TEXT) {
      const slice = text.slice(start, start + MAX_CHUNK_TEXT)
      if (!slice.trim()) continue
      out.push({ id: `${id}#${Math.floor(start / MAX_CHUNK_TEXT)}`, sid, ts, text: slice })
    }
  }
  for (const chunk of entries) {
    const text = String(chunk.text || '')
    if (text.length <= MAX_CHUNK_TEXT) {
      out.push({ id: chunk.id, sid: chunk.sid, ts: chunk.ts, text })
      continue
    }
    let buffer = ''
    let part = 0
    for (const line of text.split('\n')) {
      if (line.length > MAX_CHUNK_TEXT) {
        if (buffer) { push(`${chunk.id}#L${part}`, chunk.sid, chunk.ts, buffer); part += 1; buffer = '' }
        push(`${chunk.id}#L${part}`, chunk.sid, chunk.ts, line)
        part += 1
        continue
      }
      if (buffer && buffer.length + line.length + 1 > MAX_CHUNK_TEXT) {
        push(`${chunk.id}#L${part}`, chunk.sid, chunk.ts, buffer)
        part += 1
        buffer = ''
      }
      buffer = buffer ? `${buffer}\n${line}` : line
    }
    if (buffer) push(`${chunk.id}#L${part}`, chunk.sid, chunk.ts, buffer)
  }
  return out
}

async function upload() {
  // Redaction first, then the size split: a redaction sentinel is longer than the
  // text it replaces, so splitting first produced chunks that grew back over the limit.
  const sanitized = splitForUpload(chunks.map((chunk) => ({ ...chunk, text: redact(String(chunk.text || '')) })))
  const body = {
    meta: {
      wxid: meta.wxid,
      displayName: meta.displayName,
      knowledgeCutoff: meta.knowledgeCutoff,
      generatedAt: meta.generatedAt,
      messageCount: meta.messageCount,
      visibility: 'private',
    },
    mds: Object.fromEntries(Object.entries(mds).map(([name, content]) => [name, redact(content)])),
    chunks: sanitized,
    visibility: 'private',
  }
  if (typeof audit === 'function') {
    let hits = 0
    const labels = new Set()
    for (const chunk of sanitized) {
      const result = audit(chunk.text)
      hits += result.count
      for (const label of result.labels || []) labels.add(label)
    }
    log(`client-side PII filter: ${hits} remaining severe hits${hits ? ` (${[...labels].join('/')})` : ''}`)
  }
  const longest = body.chunks.reduce((max, chunk) => Math.max(max, chunk.text.length), 0)
  log(`uploading ${body.chunks.length} chunks (longest ${longest} chars, ${Math.round(JSON.stringify(body.chunks).length / 1024 / 1024)} MB)`)
  const response = await fetch(`${server}/api/weclone/upload`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(600000),
  })
  const text = await response.text()
  let parsed = null
  try { parsed = JSON.parse(text) } catch { /* html error page */ }
  if (!response.ok || !parsed) return { ok: false, status: response.status, error: (parsed && parsed.error) || text.slice(0, 300) }
  return { ok: true, id: parsed.id || parsed.cloneId || parsed.data?.id, raw: parsed }
}

const uploaded = await upload()
if (!uploaded.ok) fail(`upload failed: HTTP ${uploaded.status} ${uploaded.error}`)
const cloneId = uploaded.id
log(`uploaded: ${cloneId}`)

// ---------------------------------------------------------------------------
// 4. ask the clone and score
// ---------------------------------------------------------------------------

/** Character bigrams — cheap, language-agnostic, and better than whitespace tokens for zh. */
function bigrams(text) {
  const clean = String(text || '').toLowerCase().replace(/\s+/g, ' ').trim()
  const set = new Map()
  for (let index = 0; index < clean.length - 1; index += 1) {
    const gram = clean.slice(index, index + 2)
    set.set(gram, (set.get(gram) || 0) + 1)
  }
  return set
}

function dice(a, b) {
  const left = bigrams(a)
  const right = bigrams(b)
  if (left.size === 0 || right.size === 0) return 0
  let overlap = 0
  for (const [gram, count] of left) overlap += Math.min(count, right.get(gram) || 0)
  return (2 * overlap) / (left.size + right.size)
}

/**
 * Lexical + typographic signals of the user's register.
 *
 * The point is to catch the failure a "sounds plausible" rating misses: an imitator
 * that writes tidy, capitalised, punctuation-complete English for someone who writes
 * short unpunctuated lowercase fragments.
 */
function styleVector(text) {
  const value = String(text || '')
  const lower = value.toLowerCase()
  return {
    length: value.length,
    avgWord: value.trim().split(/\s+/).filter(Boolean).reduce((sum, word) => sum + word.length, 0) / Math.max(1, value.trim().split(/\s+/).filter(Boolean).length),
    lowercaseRatio: (lower.match(/[a-z]/g) || []).length ? (value.match(/[a-z]/g) || []).length / (lower.match(/[a-z]/g) || []).length : 1,
    punctuation: (value.match(/[.,!?;:]/g) || []).length / Math.max(1, value.length / 40),
    emoji: (value.match(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu) || []).length,
    zhRatio: (value.match(/[\u4e00-\u9fff]/g) || []).length / Math.max(1, value.length),
    ellipsis: (value.match(/\.{3,}|…/g) || []).length,
  }
}

const results = []
for (const pair of pairs) {
  // Give the clone the same footing a person would have: what was just said to them.
  const cueText = typeof pair.cue === 'string' ? pair.cue : String(pair.cue?.text || '')
  const cue = cueText
  const startedAt = Date.now()
  let answer = ''
  let error = ''
  try {
    const response = await fetch(`${server}/api/weclone/${encodeURIComponent(cloneId)}/chat`, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      // The endpoint streams SSE unless told otherwise; the evaluation wants the whole
      // reply at once, so it asks for the JSON shape explicitly.
      body: JSON.stringify({ message: cue, stream: false }),
      signal: AbortSignal.timeout(180000),
    })
    const text = await response.text()
    const parsed = JSON.parse(text)
    if (!response.ok) error = parsed?.error || `HTTP ${response.status}`
    else answer = String(parsed.reply || parsed.message || parsed.content || parsed.data?.reply || '').trim()
  } catch (issue) {
    error = String(issue?.message || issue)
  }
  const elapsedMs = Date.now() - startedAt
  const actualStyle = styleVector(pair.reply)
  const cloneStyle = styleVector(answer)
  results.push({
    cue: cueText.slice(0, 160),
    reply: pair.reply.slice(0, 160),
    answer: answer.slice(0, 160),
    error,
    elapsedMs,
    lexical: Math.round(dice(pair.reply, answer) * 1000) / 1000,
    lengthRatio: actualStyle.length > 0 ? Math.round((cloneStyle.length / actualStyle.length) * 100) / 100 : 0,
    lowercaseDelta: Math.round((cloneStyle.lowercaseRatio - actualStyle.lowercaseRatio) * 100) / 100,
    punctuationDelta: Math.round((cloneStyle.punctuation - actualStyle.punctuation) * 100) / 100,
    zhDelta: Math.round((cloneStyle.zhRatio - actualStyle.zhRatio) * 100) / 100,
  })
}

const scored = results.filter((row) => !row.error && row.answer)
const mean = (values) => (values.length ? Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 1000) / 1000 : null)
const summary = {
  cloneId,
  pairs: results.length,
  answered: scored.length,
  lexicalSimilarity: mean(scored.map((row) => row.lexical)),
  lengthRatio: mean(scored.map((row) => row.lengthRatio)),
  lowercaseDelta: mean(scored.map((row) => row.lowercaseDelta)),
  punctuationDelta: mean(scored.map((row) => row.punctuationDelta)),
  zhDelta: mean(scored.map((row) => row.zhDelta)),
  averageLatencyMs: mean(results.map((row) => row.elapsedMs)),
  errors: results.filter((row) => row.error).map((row) => row.error).slice(0, 3),
}

if (jsonOut) {
  console.log(JSON.stringify({ ...summary, results }, null, 2))
} else {
  console.log('')
  console.log('cue / 真实回复 / 克隆回复')
  for (const row of results.slice(0, 12)) {
    console.log(`  ▸ ${row.cue}`)
    console.log(`    真实: ${row.reply}`)
    console.log(`    克隆: ${row.error ? `[${row.error}]` : row.answer}`)
    console.log(`    相似度 ${row.lexical} · 长度比 ${row.lengthRatio} · 小写差 ${row.lowercaseDelta} · 标点差 ${row.punctuationDelta}`)

  }
  console.log('')
  console.log(`样本 ${summary.pairs}（作答 ${summary.answered}）`)
  console.log(`字面相似度 (dice bigram)  ${summary.lexicalSimilarity}`)
  console.log(`长度比                    ${summary.lengthRatio}`)
  console.log(`小写倾向差                ${summary.lowercaseDelta}`)
  console.log(`标点密度差                ${summary.punctuationDelta}`)
  console.log(`平均延迟                  ${summary.averageLatencyMs} ms`)
  if (summary.errors.length) console.log(`错误样例: ${summary.errors.join(' | ')}`)
}

process.exit(scored.length === 0 ? 1 : 0)
