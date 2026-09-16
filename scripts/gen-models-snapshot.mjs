/**
 * Regenerate the bundled models.dev snapshot used as the provider layer's
 * offline fallback (D1/C1.2).
 *
 * Why a curated snapshot instead of the full payload: `https://models.dev/api.json`
 * is ~4.6 MB (213 providers, ~7,758 models) and its data-usage terms are
 * undocumented, so Weport ships only the provider entries its catalog can
 * actually address and keeps the full payload a runtime cache
 * (`{userData}/models-cache.json`). `THIRD-PARTY-NOTICES.md` covers attribution.
 *
 * Usage (needs network):
 *   node scripts/gen-models-snapshot.mjs
 *
 * The output is committed. Re-run it when the gateways add models; the runtime
 * cache refreshes on its own every 24 h, so a stale snapshot only affects a
 * first launch that has no network.
 */
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

const SOURCE = 'https://models.dev/api.json'
const OUT = resolve('electron/assets/models/models-dev-snapshot.json')

/**
 * models.dev provider ids referenced by `providerCatalog.ts`. Keeping this list
 * explicit (rather than dumping every provider) is what keeps the artifact
 * small enough to commit.
 */
const PROVIDER_IDS = [
  'openai',
  'anthropic',
  'google',
  'deepseek',
  'minimax',
  'groq',
  'mistral',
  'xai',
  'openrouter',
  'siliconflow',
  'lmstudio',
  'cerebras',
  'opencode',
  'opencode-go',
  'alibaba',
  'moonshotai',
  'zhipuai',
  'togetherai',
  'volcengine',
]

function fail(message) {
  console.error(`[gen-models-snapshot] ${message}`)
  process.exit(1)
}

const response = await fetch(SOURCE, {
  headers: { Accept: 'application/json', 'Accept-Encoding': 'gzip', 'User-Agent': 'Weport-build/1' },
}).catch((error) => fail(`fetch failed: ${error.message}`))

if (!response.ok) fail(`HTTP ${response.status}`)
// There is no per-provider endpoint: `/api/{id}.json` answers 200 with the SPA's
// HTML, so a content-type check is the only thing standing between us and
// committing a snapshot full of `<html>`.
const contentType = response.headers.get('content-type') || ''
if (!/json/i.test(contentType)) fail(`unexpected content-type: ${contentType || '(none)'}`)

const payload = await response.json()
if (!payload || typeof payload !== 'object' || !payload.deepseek) fail('unexpected payload shape (missing `deepseek`)')

const out = {}
let modelCount = 0
const missing = []
for (const providerId of PROVIDER_IDS) {
  const provider = payload[providerId]
  if (!provider || typeof provider !== 'object') {
    missing.push(providerId)
    continue
  }
  const models = {}
  for (const [modelId, model] of Object.entries(provider.models || {})) {
    if (!model || typeof model !== 'object') continue
    // Keep `id`. It looks redundant next to the map key, but Weport's
    // `normalizeModelRecord` reads the model id from `record.id` (falling back to
    // `record.name`, which is a DISPLAY name upstream) — dropping it makes every
    // model id come back as "Qwen3.7 Max" and silently breaks protocol/cost lookup.
    models[modelId] = model
    modelCount += 1
  }
  const { models: _models, ...providerMeta } = provider
  out[providerId] = { ...providerMeta, models }
}

if (missing.length > 0) console.warn(`[gen-models-snapshot] providers absent upstream: ${missing.join(', ')}`)
if (modelCount === 0) fail('no models extracted')

mkdirSync(dirname(OUT), { recursive: true })
const serialized = `${JSON.stringify(out)}\n`
const temp = `${OUT}.tmp`
writeFileSync(temp, serialized, 'utf8')
// renameSync fails on Windows when the destination exists.
rmSync(OUT, { force: true })
renameSync(temp, OUT)
console.log(`[gen-models-snapshot] wrote ${OUT} (${Object.keys(out).length} providers, ${modelCount} models, ${(serialized.length / 1024).toFixed(0)} KiB)`)
