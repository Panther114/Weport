import { describe, expect, it, vi } from 'vitest'
import {
  MODELS_DEV_URL,
  ModelRegistry,
  NPM_TO_PROTOCOL,
  buildSnapshot,
  estimateModelCost,
  extractModelIds,
  isChatCapable,
  mergeCatalogMetadata,
  normalizeModelRecord,
  resolveModelMetadata,
} from './modelRegistry'
import type { ModelRecord, ModelRegistryOptions, ModelRegistryPayload, ModelRegistryStorage, ModelSource, ReasoningOption, RegistryFetch } from './modelRegistry'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * Trimmed to the shapes that actually matter: one multi-protocol gateway (the
 * OpenCode Zen / Go case), one single-protocol provider, and the awkward
 * records — `limit.context === 0`, no `cost`, a non-chat model, a `" "`
 * reasoning_options entry.
 */
const PAYLOAD = {
  deepseek: {
    id: 'deepseek',
    npm: '@ai-sdk/openai-compatible',
    api: 'https://api.deepseek.com',
    models: {
      'deepseek-v4-pro': {
        id: 'deepseek-v4-pro',
        name: 'DeepSeek V4 Pro',
        reasoning: true,
        tool_call: true,
        attachment: false,
        reasoning_options: [{ type: 'toggle' }, { type: 'effort', values: ['high', 'max'] }],
        modalities: { input: ['text'], output: ['text'] },
        limit: { context: 1_000_000, output: 384_000 },
        cost: { input: 0.435, output: 0.87, reasoning: 0.87, cache_read: 0.003625 },
        release_date: '2026-08-12',
      },
    },
  },
  opencode: {
    id: 'opencode',
    npm: '@ai-sdk/openai-compatible',
    api: 'https://opencode.ai/zen/v1',
    models: {
      'deepseek-v4-flash': { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', limit: { context: 1_000_000, output: 384_000 } },
      // No model-level `provider`, no limit, no cost: the inheritance case.
      'minimax-m3': { id: 'minimax-m3', name: 'MiniMax M3', tool_call: true },
      // Provider-level @ai-sdk/openai-compatible, overridden per model.
      'grok-4.6': { id: 'grok-4.6', name: 'Grok 4.6', provider: { npm: '@ai-sdk/openai' }, limit: { context: 256_000, output: 64_000 } },
      'claude-sonnet-4-6': { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6', provider: { npm: '@ai-sdk/anthropic' }, reasoning_options: ' ' },
      'whisper-large-v3': { id: 'whisper-large-v3', name: 'Whisper Large v3', modalities: { input: ['audio'], output: ['text'] } },
      'text-embedding-3-large': { id: 'text-embedding-3-large', name: 'Embedding 3 Large' },
      'legacy-chat': { id: 'legacy-chat', name: 'Legacy Chat', status: 'deprecated' },
    },
  },
  'opencode-go': {
    id: 'opencode-go',
    npm: '@ai-sdk/anthropic',
    api: 'https://opencode.ai/zen/go/v1',
    models: {
      // Inherits the provider default (anthropic) — this is what makes the
      // "not derivable from the model family" case work.
      'minimax-m3': { id: 'minimax-m3', name: 'MiniMax M3' },
      'qwen3.8-flash': { id: 'qwen3.8-flash', name: 'Qwen 3.8 Flash' },
      'grok-4.5': { id: 'grok-4.5', name: 'Grok 4.5', provider: { npm: '@ai-sdk/openai' } },
    },
  },
  google: {
    id: 'google',
    npm: '@ai-sdk/google',
    models: {
      'gemini-3.8-flash': { id: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash', limit: { context: 1_048_576, output: 65_536 }, cost: { input: 0.3, output: 2.5 } },
    },
  },
  groq: {
    id: 'groq',
    npm: '@ai-sdk/groq',
    models: {
      // `limit.context === 0` is upstream's way of saying "unknown"; and cost is absent.
      'whisper-large-v3': { id: 'whisper-large-v3', name: 'Whisper Large v3', limit: { context: 0, output: 0 }, modalities: { input: ['audio'], output: ['text'] } },
    },
  },
  'no-npm-provider': {
    id: 'no-npm-provider',
    models: {
      'mystery-model': { id: 'mystery-model', name: 'Mystery' },
    },
  },
} as unknown as ModelRegistryPayload

function memoryStorage(initial: Record<string, string> = {}): ModelRegistryStorage & { files: Record<string, string>; writes: string[] } {
  const files: Record<string, string> = { ...initial }
  const writes: string[] = []
  return {
    files,
    writes,
    readFile: (path: string) => (path in files ? files[path] : null),
    writeFile: (path: string, data: string) => {
      files[path] = data
      writes.push(path)
    },
    writeFileAtomic: (path: string, data: string) => {
      files[path] = data
      writes.push(path)
    },
  }
}

function response(status: number, body: string, headers: Record<string, string> = { contentType: 'application/json' }) {
  const map = new Map(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]))
  return {
    status,
    headers: { get: (name: string) => map.get(name.toLowerCase()) ?? null },
    text: async () => body,
  }
}

function makeRegistry(options: Partial<ModelRegistryOptions> = {}) {
  const storage = options.storage || memoryStorage()
  const registry = new ModelRegistry({
    cachePath: '/cache/models-cache.json',
    metaPath: '/cache/models-cache.meta.json',
    storage,
    fetch: vi.fn(),
    clock: { now: () => 1_000_000 },
    bundledSnapshot: PAYLOAD,
    ...options,
  })
  return { registry, storage }
}

function fetchReturning(impl: RegistryFetch): RegistryFetch {
  return vi.fn(impl) as unknown as RegistryFetch
}

function record(id: string, source: ModelSource, patch: Partial<ModelRecord> = {}): ModelRecord {
  return {
    id,
    name: id,
    capabilities: { attachment: false, reasoning: false, toolCall: false, chatCapable: true, modalities: { input: [], output: [] } },
    reasoningOptions: [],
    limits: {},
    provenance: source,
    ...patch,
  }
}

// ---------------------------------------------------------------------------
// 1. `GET {base}/models` envelope shapes
// ---------------------------------------------------------------------------

describe('extractModelIds — every observed /models envelope', () => {
  it('accepts the OpenAI/DeepSeek/Groq/Azure/xAI/Ollama-v1 `data[]` shape', () => {
    expect(extractModelIds({ object: 'list', data: [{ id: 'deepseek-v4-flash' }, { id: 'deepseek-v4-pro' }] })).toEqual([
      'deepseek-v4-flash',
      'deepseek-v4-pro',
    ])
  })

  it('accepts the Gemini-native / Ollama-tags `models[]` shape and strips the `models/` prefix', () => {
    expect(extractModelIds({ models: [{ name: 'models/gemini-3.8-flash' }, { name: 'models/gemini-3.7-flash' }] })).toEqual([
      'gemini-3.8-flash',
      'gemini-3.7-flash',
    ])
  })

  it('accepts the Cloudflare `result[]` shape', () => {
    expect(extractModelIds({ result: [{ name: '@cf/meta/llama-3.3-70b-instruct' }], success: true })).toEqual(['@cf/meta/llama-3.3-70b-instruct'])
  })

  it('accepts a bare array (Together AI, Mistral)', () => {
    expect(extractModelIds([{ id: 'mistral-large-latest' }, { id: 'mistral-small-latest' }])).toEqual([
      'mistral-large-latest',
      'mistral-small-latest',
    ])
  })

  it('accepts `{data:[...]}` with no `object` key (Open WebUI)', () => {
    expect(extractModelIds({ data: [{ id: 'llama3.1:8b' }] })).toEqual(['llama3.1:8b'])
  })

  it('accepts a bare array of strings (Mistral’s documented variant)', () => {
    expect(extractModelIds(['codestral-latest', 'open-mixtral-8x22b'])).toEqual(['codestral-latest', 'open-mixtral-8x22b'])
  })

  it('dedupes, trims, and drops empty ids', () => {
    expect(extractModelIds({ data: [{ id: 'gpt-5.6' }, { id: 'gpt-5.6' }, { id: '  ' }, { id: ' models/gpt-5.4 ' }, {}] })).toEqual([
      'gpt-5.6',
      'gpt-5.4',
    ])
  })

  it('returns [] for a payload with no recognizable list rather than inventing ids', () => {
    expect(extractModelIds({ error: { message: 'nope' } })).toEqual([])
    expect(extractModelIds(null)).toEqual([])
    expect(extractModelIds('<!doctype html>')).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// 2. Per-model protocol resolution
// ---------------------------------------------------------------------------

describe('per-model protocol resolution', () => {
  it('maps every models.dev npm package onto a wire protocol', () => {
    expect(NPM_TO_PROTOCOL['@ai-sdk/openai-compatible']).toBe('openai-compatible')
    expect(NPM_TO_PROTOCOL['@ai-sdk/openai']).toBe('openai')
    expect(NPM_TO_PROTOCOL['@ai-sdk/anthropic']).toBe('anthropic')
    expect(NPM_TO_PROTOCOL['@ai-sdk/google']).toBe('google')
  })

  it('prefers the model-level npm over the provider-level default (grok-4.6 → /responses, not /chat/completions)', () => {
    const snapshot = buildSnapshot(PAYLOAD, 'bundled')
    const zen = snapshot.providers.opencode
    expect(zen.npmDefault).toBe('@ai-sdk/openai-compatible')
    expect(zen.models['grok-4.6'].protocol).toBe('openai')
    expect(zen.models['deepseek-v4-flash'].protocol).toBe('openai-compatible')
  })

  it('resolves MiniMax M3 to Anthropic through the provider-level default, not from the model family', () => {
    const snapshot = buildSnapshot(PAYLOAD, 'bundled')
    // Zen serves minimax-m3 on the chat-completions format…
    expect(snapshot.providers.opencode.models['minimax-m3'].protocol).toBe('openai-compatible')
    // …while the Go gateway serves the same model id on /messages. This is the
    // case that no family-based heuristic can get right.
    expect(snapshot.providers['opencode-go'].models['minimax-m3'].protocol).toBe('anthropic')
    expect(snapshot.providers['opencode-go'].models['qwen3.8-flash'].protocol).toBe('anthropic')
    expect(snapshot.providers['opencode-go'].models['grok-4.5'].protocol).toBe('openai')
  })

  it('falls back to the profile protocol when no layer has evidence', () => {
    const { registry } = makeRegistry()
    const resolved = resolveModelMetadata({
      registry,
      registryProviderId: 'opencode-go',
      profile: { id: 'p1', protocol: 'openai-compatible' },
      modelId: 'a-model-nobody-knows',
    })
    expect(resolved.protocol).toBe('openai-compatible')
    expect(resolved.record.protocol).toBe('openai-compatible')
    expect(resolved.record.limits.context).toBeUndefined()
    expect(resolved.record.cost).toBeUndefined()
  })

  it('lets a live record override the registry protocol while keeping registry pricing (field-wise merge)', () => {
    const { registry } = makeRegistry()
    const resolved = resolveModelMetadata({
      registry,
      registryProviderId: 'opencode-go',
      profile: { id: 'p1', protocol: 'openai-compatible' },
      modelId: 'minimax-m3',
      live: record('minimax-m3', 'live', { protocol: 'openai-compatible' }),
    })
    // Live wins for protocol (it reflects what the gateway actually serves)…
    expect(resolved.protocol).toBe('openai-compatible')
    expect(resolved.record.provenance).toBe('live')
  })

  it('finds a model that only a sibling provider entry knows about', () => {
    const { registry } = makeRegistry()
    const resolved = resolveModelMetadata({
      registry,
      registryProviderId: 'opencode',
      profile: { id: 'p1', protocol: 'openai-compatible' },
      modelId: 'gemini-3.8-flash',
    })
    expect(resolved.protocol).toBe('google')
  })
})

// ---------------------------------------------------------------------------
// 3. Honest unknown values
// ---------------------------------------------------------------------------

describe('unknown is never rendered as a real 0', () => {
  it('drops `limit.context === 0` instead of reporting a 0-token window', () => {
    const snapshot = buildSnapshot(PAYLOAD, 'bundled')
    const whisper = snapshot.providers.groq.models['whisper-large-v3']
    expect(whisper.limits.context).toBeUndefined()
    expect(whisper.limits.output).toBeUndefined()
  })

  it('omits `cost` entirely when the provider published none', () => {
    const { registry } = makeRegistry()
    const resolved = resolveModelMetadata({
      registry,
      registryProviderId: 'opencode',
      profile: { id: 'p1', protocol: 'openai-compatible' },
      modelId: 'minimax-m3',
    })
    expect(resolved.record.cost).toBeUndefined()
    expect(Object.prototype.hasOwnProperty.call(resolved.record, 'cost')).toBe(true)
  })

  it('reports an incomplete estimate for unpriced metadata rather than $0.00', () => {
    expect(estimateModelCost(undefined, { promptTokens: 1000, completionTokens: 10 })).toEqual({ totalUsd: 0, complete: false })
    // Input price only: an honest output figure is impossible, so `complete` stays false.
    const inputOnly = estimateModelCost({ input: 1 }, { promptTokens: 1_000_000, completionTokens: 1_000_000 })
    expect(inputOnly.complete).toBe(false)
  })

  it('prices a complete run from real numbers, splitting cache hits from misses', () => {
    const cost = { input: 0.435, output: 0.87, cacheRead: 0.003625 }
    const estimate = estimateModelCost(cost, { promptTokens: 1_000_000, cacheHitTokens: 900_000, completionTokens: 100_000 })
    expect(estimate.complete).toBe(true)
    // 100k misses @0.435 + 900k hits @0.003625 + 100k output @0.87, all per 1M.
    expect(estimate.totalUsd).toBeCloseTo((100_000 * 0.435 + 900_000 * 0.003625 + 100_000 * 0.87) / 1_000_000, 10)
  })

  it('never lets a cache-hit count exceed the prompt total', () => {
    // 1M prompt tokens, 1M cache-hit tokens (all hits), 100k output: the miss
    // bucket must be 0, not `prompt - rawCacheHit` negative.
    const estimate = estimateModelCost({ input: 1, output: 1, cacheRead: 0 }, { promptTokens: 1_000_000, cacheHitTokens: 5_000_000, completionTokens: 100_000 })
    expect(estimate.totalUsd).toBeCloseTo(100_000 / 1_000_000, 12)
  })
})

// ---------------------------------------------------------------------------
// 4. Chat-capability filter
// ---------------------------------------------------------------------------

describe('isChatCapable', () => {
  const snapshot = buildSnapshot(PAYLOAD, 'bundled')
  const zen = snapshot.providers.opencode

  it('excludes whisper/embedding ids so the picker cannot offer them as chat models', () => {
    expect(isChatCapable(zen.models['whisper-large-v3'])).toBe(false)
    expect(isChatCapable(zen.models['text-embedding-3-large'])).toBe(false)
  })

  it('excludes a non-text output modality even when the id looks ordinary', () => {
    const record = normalizeModelRecord('p', { id: 'some-voice-model', modalities: { input: ['text'], output: ['audio'] } })
    expect(record && isChatCapable(record)).toBe(false)
  })

  it('excludes deprecated models', () => {
    expect(isChatCapable(zen.models['legacy-chat'])).toBe(false)
  })

  it('keeps models with no modality metadata (unknown is not a denial)', () => {
    expect(isChatCapable(zen.models['minimax-m3'])).toBe(true)
    expect(isChatCapable(zen.models['deepseek-v4-flash'])).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 5. Normalization details
// ---------------------------------------------------------------------------

describe('normalizeModelRecord', () => {
  it('survives the `reasoning_options: " "` records models.dev actually ships', () => {
    const record = normalizeModelRecord('opencode', { id: 'claude-sonnet-4-6', reasoning_options: ' ' })
    expect(record?.reasoningOptions).toEqual([])
    expect(record?.capabilities.reasoning).toBe(false)
  })

  it('parses all three reasoning_options shapes', () => {
    const record = normalizeModelRecord('p', {
      id: 'm',
      reasoning_options: [{ type: 'toggle' }, { type: 'effort', values: ['low', 'high'] }, { type: 'budget_tokens', min: 1024, max: 32000 }],
    })
    const options = record?.reasoningOptions as ReasoningOption[]
    expect(options).toEqual([{ type: 'toggle' }, { type: 'effort', values: ['low', 'high'] }, { type: 'budget_tokens', min: 1024, max: 32000 }])
  })

  it('reads cost in USD per million tokens', () => {
    const record = normalizeModelRecord('deepseek', {
      id: 'deepseek-v4-pro',
      cost: { input: 0.435, output: 0.87, reasoning: 0.87, cache_read: 0.003625 },
    })
    expect(record?.cost).toEqual({ input: 0.435, output: 0.87, reasoning: 0.87, cacheRead: 0.003625 })
  })

  it('falls back to `name` when a record carries no id (models.dev always ships one, but be tolerant)', () => {
    expect(normalizeModelRecord('p', { name: 'nameless' }, undefined, 'bundled')?.id).toBe('nameless')
  })

  it('returns null for a record with no id and no name instead of fabricating one', () => {
    expect(normalizeModelRecord('p', null)).toBeNull()
    expect(normalizeModelRecord('p', { description: 'has no identity' })).toBeNull()
    expect(normalizeModelRecord('p', { id: '   ' })).toBeNull()
  })

  it('ignores placeholder release dates', () => {
    expect(normalizeModelRecord('p', { id: 'm', release_date: '0000-00-00' })?.releaseDate).toBeUndefined()
    expect(normalizeModelRecord('p', { id: 'm', release_date: '2026-08-12' })?.releaseDate).toBe('2026-08-12')
  })

  it('keeps `free` unknown when nothing is published (a `-free` id often has no cost block)', () => {
    expect(normalizeModelRecord('p', { id: 'x-free' })?.free).toBeUndefined()
    expect(normalizeModelRecord('p', { id: 'x', cost: { input: 1 } })?.free).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 6. Merge precedence + provenance
// ---------------------------------------------------------------------------

describe('mergeCatalogMetadata', () => {
  it('prefers live over registry over bundled, field by field', () => {
    const merged = mergeCatalogMetadata('m', [
      { source: 'bundled', record: record('m', 'bundled', { name: 'bundled-name', limits: { context: 32_000, output: 1000 }, cost: { input: 9, output: 9 }, protocol: 'openai-compatible' }) },
      { source: 'registry', record: record('m', 'registry', { name: 'registry-name', limits: { context: 128_000 }, cost: { input: 1 }, protocol: 'google' }) },
      { source: 'live', record: record('m', 'live', { name: 'live-name' }) },
    ])
    expect(merged.name).toBe('live-name')
    expect(merged.limits.context).toBe(128_000) // live had no context, registry did
    expect(merged.limits.output).toBe(1000) // only bundled had an output limit
    expect(merged.cost).toEqual({ input: 1, output: 9 }) // merged across all three
    // Protocol is the one field where a higher layer that is SILENT still wins:
    // live discovery asserts "this model exists and is served here", so its
    // absence of a wire-format claim must not fall back to the registry's guess.
    expect(merged.protocol).toBe('openai-compatible')
    expect(merged.provenance).toBe('live')
  })

  it('falls back to a lower layer protocol only when the highest layer had no record at all', () => {
    const merged = mergeCatalogMetadata('m', [
      { source: 'registry', record: record('m', 'registry', { protocol: 'google' }) },
      { source: 'live', record: undefined },
    ])
    expect(merged.protocol).toBe('google')
  })

  it('labels identity provenance, not per-field provenance', () => {
    const merged = mergeCatalogMetadata('m', [
      { source: 'bundled', record: record('m', 'bundled', { limits: { context: 8_000 } }) },
      { source: 'registry', record: record('m', 'registry', { cost: { input: 2, output: 2 } }) },
    ])
    expect(merged.provenance).toBe('registry')
    expect(merged.limits.context).toBe(8_000)
  })

  it('stays usable with a single layer and with none at all', () => {
    const onlyBundled = mergeCatalogMetadata('m', [{ source: 'bundled', record: record('m', 'bundled') }])
    expect(onlyBundled.provenance).toBe('bundled')
    expect(onlyBundled.name).toBe('m')

    const nothing = mergeCatalogMetadata('m', [{ source: 'live', record: undefined }], { name: 'fallback', protocol: 'anthropic' })
    expect(nothing.protocol).toBe('anthropic')
    expect(nothing.name).toBe('fallback')
    expect(nothing.cost).toBeUndefined()
    expect(nothing.capabilities.chatCapable).toBe(true)
  })

  it('unions capabilities and keeps chatCapable false when any layer denies it', () => {
    const merged = mergeCatalogMetadata('m', [
      { source: 'bundled', record: record('m', 'bundled', { capabilities: { attachment: false, reasoning: true, toolCall: false, chatCapable: false, modalities: { input: ['audio'], output: ['text'] } } }) },
      { source: 'live', record: record('m', 'live', { capabilities: { attachment: true, reasoning: false, toolCall: true, chatCapable: true, modalities: { input: ['text'], output: ['text'] } } }) },
    ])
    expect(merged.capabilities.reasoning).toBe(true)
    expect(merged.capabilities.attachment).toBe(true)
    expect(merged.capabilities.toolCall).toBe(true)
    expect(merged.capabilities.chatCapable).toBe(false)
    expect(merged.capabilities.modalities.input.sort()).toEqual(['audio', 'text'])
  })
})

// ---------------------------------------------------------------------------
// 7. Cache behaviour
// ---------------------------------------------------------------------------

describe('ModelRegistry cache', () => {
  it('uses the bundled snapshot when there is no cache and no network', async () => {
    const { registry } = makeRegistry({ allowNetwork: false })
    expect(registry.current.source).toBe('bundled')
    expect(registry.getProviderEntry('opencode')?.models['minimax-m3']).toBeDefined()
    expect(await registry.refresh()).toEqual({ used: 'bundled', changed: false, skipped: true })
  })

  it('prefers the disk cache over the bundled snapshot', () => {
    const cached = { opencode: { npm: '@ai-sdk/openai-compatible', models: { 'only-in-cache': { id: 'only-in-cache', name: 'Cache Only' } } } }
    const { registry } = makeRegistry({
      allowNetwork: false,
      storage: memoryStorage({ '/cache/models-cache.json': JSON.stringify(cached) }),
    })
    expect(registry.current.source).toBe('registry')
    expect(registry.getProviderEntry('opencode')?.models['only-in-cache']).toBeDefined()
    // Providers the cache does not mention survive from the bundled snapshot.
    expect(registry.getProviderEntry('deepseek')?.models['deepseek-v4-pro']).toBeDefined()
  })

  it('treats an HTTP 304 as success with zero bytes and refreshes the TTL without rewriting the cache', async () => {
    const fetchImpl = fetchReturning(async (url) => {
      expect(url).toBe(MODELS_DEV_URL)
      return response(304, '', {})
    })
    const storage = memoryStorage({ '/cache/models-cache.meta.json': JSON.stringify({ etag: 'W/"abc"', fetchedAt: 0 }) })
    const { registry } = makeRegistry({ fetch: fetchImpl, storage, ttlMs: 1000 })
    const result = await registry.refresh()
    expect(result).toEqual({ used: 'bundled', changed: false, skipped: false, status: 304 })
    expect(storage.files['/cache/models-cache.json']).toBeUndefined()
    expect(JSON.parse(storage.files['/cache/models-cache.meta.json']).fetchedAt).toBe(1_000_000)
  })

  it('sends the stored ETag and an Accept-Encoding hint', async () => {
    const calls: Array<{ url: string; init: { headers: Record<string, string> } }> = []
    const fetchImpl = fetchReturning(async (url, init) => {
      calls.push({ url, init })
      return response(304, '', {})
    })
    const storage = memoryStorage({ '/cache/models-cache.meta.json': JSON.stringify({ etag: 'W/"etag-1"', fetchedAt: 0 }) })
    const { registry } = makeRegistry({ fetch: fetchImpl, storage })
    await registry.refresh()
    expect(calls[0].init.headers['If-None-Match']).toBe('W/"etag-1"')
    expect(calls[0].init.headers['Accept-Encoding']).toBe('gzip')
  })

  it('refuses an HTML 200 (the `/api/{provider}.json` SPA trap) instead of throwing', async () => {
    const fetchImpl = fetchReturning(async () => response(200, '<!doctype html><html></html>', { 'content-type': 'text/html; charset=utf-8' }))
    const storage = memoryStorage()
    const { registry } = makeRegistry({ fetch: fetchImpl, storage })
    await expect(registry.refresh()).resolves.toEqual({
      used: 'bundled',
      changed: false,
      skipped: false,
      status: 200,
      error: 'unexpected content-type: text/html; charset=utf-8',
    })
    // Nothing poisoned the on-disk cache.
    expect(storage.files['/cache/models-cache.json']).toBeUndefined()
    // Registry still usable afterwards.
    expect(registry.getProviderEntry('deepseek')?.models['deepseek-v4-pro']).toBeDefined()
  })

  it('rejects a JSON 200 that is not provider-keyed', async () => {
    const fetchImpl = fetchReturning(async () => response(200, JSON.stringify({ providers: [] }), { 'content-type': 'application/json' }))
    const storage = memoryStorage()
    const { registry } = makeRegistry({ fetch: fetchImpl, storage })
    const result = await registry.refresh()
    expect(result.error).toBe('unexpected payload shape')
    expect(result.changed).toBe(false)
    // Nothing parsed from it reaches the disk, so a poisoned response cannot
    // survive into the next cold start.
    expect(storage.files['/cache/models-cache.json']).toBeUndefined()
    expect(registry.getProviderEntry('deepseek')?.models['deepseek-v4-pro']).toBeDefined()
  })

  it('never throws on a network error and keeps the previous snapshot', async () => {
    const fetchImpl = fetchReturning(async () => {
      throw new Error('getaddrinfo ENOTFOUND models.dev')
    })
    const { registry } = makeRegistry({ fetch: fetchImpl })
    const result = await registry.refresh()
    expect(result.changed).toBe(false)
    expect(result.error).toContain('ENOTFOUND')
    expect(registry.getProviderEntry('opencode-go')?.models['minimax-m3']).toBeDefined()
  })

  it('never throws on truncated JSON either', async () => {
    const fetchImpl = fetchReturning(async () => response(200, '{"deepseek": {"models": {"a":', { 'content-type': 'application/json' }))
    const { registry } = makeRegistry({ fetch: fetchImpl })
    const result = await registry.refresh()
    expect(result.error).toContain('invalid JSON')
  })

  it('honours the TTL and skips the request entirely while the cache is fresh', async () => {
    const fetchImpl = fetchReturning(async () => response(200, JSON.stringify(PAYLOAD)))
    const storage = memoryStorage({ '/cache/models-cache.meta.json': JSON.stringify({ fetchedAt: 1_000_000 }) })
    const { registry } = makeRegistry({ fetch: fetchImpl, storage, ttlMs: 60_000 })
    expect(await registry.refresh()).toEqual({ used: 'bundled', changed: false, skipped: true })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('does not hammer a failing endpoint: a failed attempt defers the next one', async () => {
    let now = 1_000_000
    const fetchImpl = fetchReturning(async () => {
      throw new Error('offline')
    })
    const { registry } = makeRegistry({ fetch: fetchImpl, clock: { now: () => now } })
    await registry.refresh()
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    now += 1000
    expect((await registry.refresh()).skipped).toBe(true)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    // …but the deferral is bounded: once the failure window passes, it retries.
    now += 60 * 60 * 1000
    await registry.refresh()
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('applies a successful refresh and stores the payload atomically', async () => {
    const fetchImpl = fetchReturning(async () => response(200, JSON.stringify(PAYLOAD), { 'content-type': 'application/json', etag: 'W/"new"' }))
    const storage = memoryStorage()
    const { registry } = makeRegistry({ fetch: fetchImpl, storage, allowNetwork: true })
    const result = await registry.refresh({ force: true })
    expect(result).toMatchObject({ changed: true, status: 200, used: 'registry' })
    expect(JSON.parse(storage.files['/cache/models-cache.json'])).toHaveProperty('deepseek')
    expect(JSON.parse(storage.files['/cache/models-cache.meta.json']).etag).toBe('W/"new"')
    expect(registry.getProviderEntry('opencode')?.models['grok-4.6']).toBeDefined()
  })

  it('degrades quietly when the endpoint answers HTML: no warn noise, no poisoned cache', async () => {
    const onWarn = vi.fn()
    const fetchImpl = fetchReturning(async () => response(200, '<html>', { 'content-type': 'text/html' }))
    const storage = memoryStorage()
    const { registry } = makeRegistry({ fetch: fetchImpl, onWarn, storage })
    const result = await registry.refresh()
    // A mistyped endpoint is a caller-visible error, not a crash and not a
    // warning storm: `refresh` returns the reason and keeps the old snapshot.
    expect(result.error).toContain('unexpected content-type')
    expect(onWarn).not.toHaveBeenCalled()
    expect(storage.files['/cache/models-cache.json']).toBeUndefined()
    expect(registry.getProviderEntry('opencode')?.models['minimax-m3']).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// 8. Registry lookups
// ---------------------------------------------------------------------------

describe('ModelRegistry lookups', () => {
  it('finds models case-insensitively and reports their provider', () => {
    const { registry } = makeRegistry({ allowNetwork: false })
    expect(registry.findProviderModel('opencode', 'MINIMAX-M3')?.id).toBe('minimax-m3')
    expect(registry.findModel('Gemini-3.8-Flash')?.providerId).toBe('google')
    expect(registry.findModel('does-not-exist')).toBeUndefined()
  })

  it('reports emptiness honestly so callers can fall back', () => {
    const { registry } = makeRegistry({ allowNetwork: false, bundledSnapshot: null })
    expect(registry.isEmpty).toBe(true)
    expect(registry.getProviderEntry('deepseek')).toBeUndefined()
    const resolved = resolveModelMetadata({ registry, profile: { id: 'p', protocol: 'anthropic' }, modelId: 'claude-sonnet-5' })
    expect(resolved.protocol).toBe('anthropic')
    expect(resolved.record.limits.context).toBeUndefined()
  })
})
