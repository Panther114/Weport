/**
 * Per-model metadata registry for the Weport AI provider layer.
 *
 * This module is deliberately free of `electron` imports (and of any other
 * process-bound dependency) so the whole thing runs under plain Node in vitest:
 * every filesystem path, the clock and the `fetch` implementation are injected.
 * The Electron-side singleton lives in `registryRuntime.ts`.
 *
 * Two upstream facts drive the design, both verified against
 * https://models.dev/api.json (downloaded 2026-09-13: 4,623,805 bytes, 213
 * providers, 7,758 model records):
 *
 *  1. `provider.npm` is a *provider-level* default in practice — only 301 of
 *     7,758 model records carry their own `provider` object. On the OpenCode
 *     gateways, `grok-4.6` and the `claude-*` family do; `minimax-m3`,
 *     `deepseek-v4-pro` and `qwen3.8-flash` do not (they inherit
 *     `@ai-sdk/anthropic` from the provider entry, and on `opencode` they
 *     inherit `@ai-sdk/openai-compatible`). Protocol resolution therefore has
 *     to be a chain — model-level → provider-level → caller default — because
 *     the per-model signal is real but sparse.
 *  2. `cost` is optional and `limit.context` can be `0`. Neither may be
 *     rendered as a real 0 — see `normalizeModelRecord` and `estimateModelCost`.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Wire format for a model. These names (rather than the npm package ids) are
 * used everywhere else in the app because they map 1:1 onto the HTTP endpoint,
 * and the endpoint is what decides whether a request succeeds:
 *
 * `openai-compatible` → `/chat/completions`, `openai` → `/responses`,
 * `anthropic` → `/messages`, `google` → `generateContent`.
 */
export const WIRE_PROTOCOLS = ['openai-compatible', 'openai', 'anthropic', 'google'] as const
export type WireProtocol = (typeof WIRE_PROTOCOLS)[number]

/** Where a metadata layer came from; used for precedence and for provenance. */
export type ModelSource = 'bundled' | 'registry' | 'live'

/** Precedence order for `mergeCatalogMetadata`; later entries beat earlier ones. */
export const SOURCE_PRECEDENCE: readonly ModelSource[] = ['bundled', 'registry', 'live']

/** models.dev `provider.npm` → wire protocol. Non-AI-SDK providers are absent on purpose. */
export const NPM_TO_PROTOCOL: Readonly<Record<string, WireProtocol>> = {
  '@ai-sdk/openai-compatible': 'openai-compatible',
  '@ai-sdk/openai': 'openai',
  '@ai-sdk/anthropic': 'anthropic',
  '@ai-sdk/google': 'google',
}

/**
 * models.dev reports cost in **USD per million tokens**. Every field is
 * optional upstream, so `ModelCost` keeps them optional too: a record either
 * carries a real number or says nothing. Prices are never defaulted to 0, and an
 * entirely absent cost is represented by omitting the object — which is how the
 * UI distinguishes "unknown" (`N/A`) from "free" (`$0.0000`).
 */
export interface ModelCost {
  input?: number
  output?: number
  reasoning?: number
  cacheRead?: number
  cacheWrite?: number
}

export type ReasoningOption =
  | { type: 'toggle' }
  | { type: 'effort'; values: string[] }
  | { type: 'budget_tokens'; min?: number; max?: number }

export interface ModelModalities {
  input: string[]
  output: string[]
}

export interface ModelCapabilities {
  attachment: boolean
  reasoning: boolean
  toolCall: boolean
  /**
   * Picker filter. Upstream metadata that is *absent* yields `true` — unknown
   * is not a denial, otherwise every gateway-only model would vanish from the
   * picker. Only explicit negative evidence sets it to `false`: a non-text
   * output modality, a non-chat model id, or `status: 'deprecated'`.
   */
  chatCapable: boolean
  modalities: ModelModalities
}

export interface ModelLimits {
  /** `0` means "unknown" upstream and is normalized to `undefined`. */
  context?: number
  output?: number
}

export interface ModelRecord {
  id: string
  name: string
  /** Absent when no layer had per-model evidence; callers must apply their profile default. */
  protocol?: WireProtocol
  capabilities: ModelCapabilities
  reasoningOptions: ReasoningOption[]
  limits: ModelLimits
  cost?: ModelCost
  releaseDate?: string
  lastUpdated?: string
  status?: string
  /** Derived: `false` when a price is published. Unknown (not `false`) otherwise. */
  free?: boolean
  provenance: ModelSource
}

/**
 * Structural boundary for the models.dev payload so tests (and the bundled
 * snapshot) can pass plain objects. Values stay `unknown` on purpose: this is a
 * network payload and every accessor validates before use.
 */
export interface ModelRegistryPayload {
  [providerId: string]: unknown
}

/** A provider entry extracted from models.dev, with its model records normalized. */
export interface RegistryProviderEntry {
  providerId: string
  /** models.dev `provider.npm` for the whole provider — the layer-2 protocol default. */
  npmDefault?: string
  name?: string
  baseUrl?: string
  models: Record<string, ModelRecord>
  /** Lowercased model id → canonical id, for case-insensitive lookups. */
  indexByLowerId: Map<string, string>
}

export interface ModelRegistrySnapshot {
  source: ModelSource
  attribution: string
  providers: Record<string, RegistryProviderEntry>
  /** Model id → provider ids that carry it. */
  indexByModelId: Map<string, string[]>
}

// ---------------------------------------------------------------------------
// Pure record normalization
// ---------------------------------------------------------------------------

export interface NormalizeModelInput {
  /** Fallback protocol derived from models.dev `provider.npm`. */
  npmDefault?: string
  source: ModelSource
}

function own(record: Record<string, unknown>, key: string): unknown {
  return Object.prototype.hasOwnProperty.call(record, key) ? record[key] : undefined
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

/** models.dev writes some `reasoning_options` as the string `" "` (seen on `opencode`), so truthiness is not enough. */
function asTrueFlag(record: Record<string, unknown>, key: string): boolean {
  return own(record, key) === true
}

/** Positive token counts only; `0`, negatives and non-numbers all mean "unknown". */
function asTokenLimit(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined
}

function asMoney(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

function asIsoDate(value: unknown): string | undefined {
  const text = str(value)
  // `0000-00-00` appears upstream for an unknown release date.
  return text && /^\d{4}-\d{2}-\d{2}/.test(text) && !text.startsWith('0000') ? text : undefined
}

function asStatus(value: unknown): string | undefined {
  const text = str(value)?.toLowerCase()
  return text === 'alpha' || text === 'beta' || text === 'deprecated' ? text : undefined
}

function mapNpmToProtocol(npm: string | undefined): WireProtocol | undefined {
  return npm ? NPM_TO_PROTOCOL[npm.trim()] : undefined
}

function normalizeModalities(record: Record<string, unknown>): ModelModalities {
  const raw = asRecord(own(record, 'modalities'))
  return {
    input: asArray(raw?.input).map(String).filter(Boolean),
    output: asArray(raw?.output).map(String).filter(Boolean),
  }
}

function normalizeReasoningOptions(record: Record<string, unknown>): ReasoningOption[] {
  const options: ReasoningOption[] = []
  for (const raw of asArray(own(record, 'reasoning_options'))) {
    const option = asRecord(raw)
    const type = str(option?.type)
    if (type === 'toggle') {
      options.push({ type: 'toggle' })
    } else if (type === 'effort') {
      const values = asArray(option?.values).map(String).filter(Boolean)
      if (values.length > 0) options.push({ type: 'effort', values })
    } else if (type === 'budget_tokens') {
      options.push({ type: 'budget_tokens', min: asTokenLimit(option?.min), max: asTokenLimit(option?.max) })
    }
  }
  return options
}

function normalizeCost(record: Record<string, unknown>): ModelCost | undefined {
  const raw = asRecord(own(record, 'cost'))
  if (!raw) return undefined
  const cost: ModelCost = {}
  const input = asMoney(raw.input)
  const output = asMoney(raw.output)
  const reasoning = asMoney(raw.reasoning)
  const cacheRead = asMoney(own(raw, 'cache_read'))
  const cacheWrite = asMoney(own(raw, 'cache_write'))
  if (input !== undefined) cost.input = input
  if (output !== undefined) cost.output = output
  if (reasoning !== undefined) cost.reasoning = reasoning
  if (cacheRead !== undefined) cost.cacheRead = cacheRead
  if (cacheWrite !== undefined) cost.cacheWrite = cacheWrite
  // Omit the object rather than returning `{}` so "no price published" stays
  // distinguishable from a real price of zero.
  return Object.keys(cost).length > 0 ? cost : undefined
}

/**
 * Model-id heuristics for non-chat models. `/models` returns the whole
 * catalogue: OpenAI's list is ~130 ids including `text-embedding-*`,
 * `whisper-*`, `tts-*` and `dall-e-*`, and Groq mixes in `whisper-large-v3`.
 * Offering those as chat models turns into a confusing provider error later.
 */
const NON_CHAT_ID_PATTERN =
  /(^|[/_-])(embed|embedding|rerank|whisper|tts|dall-e|dalle|moderation|stable-diffusion|flux|sdxl|guard|omni-moderation)([/_-]|$)/i

/** Normalize one models.dev model record. Never throws: a useless record yields `null`. */
export function normalizeModelRecord(
  providerId: string,
  raw: unknown,
  npmDefault?: string,
  provenance: ModelSource = 'registry'
): ModelRecord | null {
  const record = asRecord(raw)
  if (!record) return null
  const id = str(own(record, 'id')) || str(own(record, 'name'))
  if (!id) return null
  void providerId

  const modalities = normalizeModalities(record)
  // Layer 1 (this model's own `provider.npm`) beats layer 2 (the provider's).
  const protocol = mapNpmToProtocol(str(asRecord(own(record, 'provider'))?.npm)) || mapNpmToProtocol(npmDefault)

  const status = asStatus(own(record, 'status'))
  const nonTextOutput = modalities.output.length > 0 && !modalities.output.includes('text')
  const chatCapable = status !== 'deprecated' && isChatCapableById(id) && !nonTextOutput

  // `free` is not an upstream field. Only the negative side is derivable (a
  // published price is definitely not free); the positive side would need
  // explicit upstream data, and some gateways publish `-free` ids with no cost block.
  const free = asMoney(asRecord(own(record, 'cost'))?.input) !== undefined ? false : undefined

  const limitRecord = asRecord(own(record, 'limit'))
  return {
    id,
    name: str(own(record, 'name')) || id,
    protocol,
    capabilities: {
      attachment: asTrueFlag(record, 'attachment'),
      reasoning: asTrueFlag(record, 'reasoning'),
      toolCall: asTrueFlag(record, 'tool_call'),
      chatCapable,
      modalities,
    },
    reasoningOptions: normalizeReasoningOptions(record),
    limits: { context: asTokenLimit(limitRecord?.context), output: asTokenLimit(limitRecord?.output) },
    cost: normalizeCost(record),
    releaseDate: asIsoDate(own(record, 'release_date')),
    lastUpdated: asIsoDate(own(record, 'last_updated')),
    status,
    free,
    provenance,
  }
}

/** Exposed separately so the picker filter has a name and a test contract. */
export function isChatCapable(record: ModelRecord): boolean {
  return record.capabilities.chatCapable
}

export function isChatCapableById(id: string): boolean {
  return !NON_CHAT_ID_PATTERN.test(id)
}

// ---------------------------------------------------------------------------
// Tolerant `/models` envelope parsing
// ---------------------------------------------------------------------------

/**
 * Extract model ids from a `GET {base}/models` response.
 *
 * There is no standard envelope, so all five observed shapes are accepted:
 * `data[]` (OpenAI, DeepSeek, Groq, Azure, xAI, Ollama `/v1`, LM Studio `/v1`),
 * `models[]` (Gemini native, Ollama `/api/tags`, xAI `/v1/language-models`),
 * `result[]` (Cloudflare), a bare array (Together AI, Mistral), and
 * `{data:[...]}` without an `object` key (Open WebUI). Handling only the first
 * two is why the picker used to answer "接口未返回可用模型" for four working providers.
 *
 * A payload with no recognizable list yields `[]` on purpose: the caller cannot
 * tell "empty account" from "unknown shape", and both are better served by the
 * free-text model field than by a fabricated id.
 */
export function extractModelIds(payload: unknown): string[] {
  let rows: unknown[] = []
  if (Array.isArray(payload)) {
    rows = payload
  } else {
    const record = asRecord(payload)
    if (record) {
      for (const key of ['data', 'models', 'result']) {
        const candidate = own(record, key)
        if (Array.isArray(candidate)) {
          rows = candidate
          break
        }
      }
    }
  }
  const seen = new Set<string>()
  for (const row of rows) {
    const item = asRecord(row)
    // `id` first (the wire model id everywhere it exists), then `name` — which is
    // the model id for Gemini-native and Ollama `/api/tags` — then `key`. A
    // `label`/`display_name` is deliberately NOT consulted: it is a display
    // string, not something the provider will accept as a model id.
    const candidate = typeof row === 'string' ? row : str(item?.id) || str(item?.name) || str(item?.key) || ''
    // Gemini's native list returns `models/gemini-2.5-pro`; the wire id drops the prefix.
    const id = candidate.replace(/^models\//, '').trim()
    if (id) seen.add(id)
  }
  return Array.from(seen)
}

// ---------------------------------------------------------------------------
// Registry payload → snapshot
// ---------------------------------------------------------------------------

/**
 * Build a snapshot from a parsed models.dev payload.
 *
 * The top level is a **provider-id-keyed object**, not `{ providers: [...] }`.
 * A payload with no usable providers yields a snapshot with zero providers,
 * which callers treat as "no registry metadata".
 */
export function buildSnapshot(
  payload: ModelRegistryPayload | undefined | null,
  source: ModelSource,
  attribution = ''
): ModelRegistrySnapshot {
  const providers: Record<string, RegistryProviderEntry> = {}
  const indexByModelId = new Map<string, string[]>()
  const root = asRecord(payload)
  if (root) {
    for (const [providerId, rawProvider] of Object.entries(root)) {
      const provider = asRecord(rawProvider)
      const rawModels = asRecord(provider?.models)
      if (!provider || !rawModels) continue
      const npmDefault = str(provider.npm)
      const models: Record<string, ModelRecord> = {}
      const indexByLowerId = new Map<string, string>()
      for (const rawModel of Object.values(rawModels)) {
        const record = normalizeModelRecord(providerId, rawModel, npmDefault, source)
        if (!record) continue
        models[record.id] = record
        indexByLowerId.set(record.id.toLowerCase(), record.id)
        const owners = indexByModelId.get(record.id)
        if (owners) owners.push(providerId)
        else indexByModelId.set(record.id, [providerId])
      }
      providers[providerId] = {
        providerId,
        npmDefault,
        name: str(provider.name),
        baseUrl: str(provider.api),
        models,
        indexByLowerId,
      }
    }
  }
  return { source, attribution, providers, indexByModelId }
}

// ---------------------------------------------------------------------------
// Field-wise merge with provenance
// ---------------------------------------------------------------------------

function preferNumber(high: number | undefined, low: number | undefined): number | undefined {
  return high !== undefined ? high : low
}

/**
 * The first defined value in descending-precedence order.
 *
 * "Highest layer wins" is not the same as "the highest layer wins even when it
 * is silent": a live `/models` response usually carries no limits, pricing or
 * names, and taking its `undefined` would discard what the registry actually
 * knows.
 */
function firstDefined<T>(values: Array<T | undefined>): T | undefined {
  for (const value of values) {
    if (value !== undefined) return value
  }
  return undefined
}

function mergeCost(high: ModelCost | undefined, low: ModelCost | undefined): ModelCost | undefined {
  if (!high) return low ? { ...low } : undefined
  if (!low) return { ...high }
  const merged: ModelCost = {}
  const input = preferNumber(high.input, low.input)
  const output = preferNumber(high.output, low.output)
  const reasoning = preferNumber(high.reasoning, low.reasoning)
  const cacheRead = preferNumber(high.cacheRead, low.cacheRead)
  const cacheWrite = preferNumber(high.cacheWrite, low.cacheWrite)
  if (input !== undefined) merged.input = input
  if (output !== undefined) merged.output = output
  if (reasoning !== undefined) merged.reasoning = reasoning
  if (cacheRead !== undefined) merged.cacheRead = cacheRead
  if (cacheWrite !== undefined) merged.cacheWrite = cacheWrite
  return Object.keys(merged).length > 0 ? merged : undefined
}

/** Read-only views over an optional record, so the merge loop stays flat. */
function emptyView(): ModelRecord {
  return {
    id: '',
    name: '',
    capabilities: { attachment: false, reasoning: false, toolCall: false, chatCapable: true, modalities: { input: [], output: [] } },
    reasoningOptions: [],
    limits: {},
    provenance: 'bundled',
  }
}

/**
 * Merge metadata layers, highest precedence winning field by field.
 *
 * Field-wise (rather than whole-record) merging matters because the layers fail
 * differently: a live `/models` response proves the id exists but carries no
 * pricing, while the registry knows the pricing but may be a day stale. Merging
 * whole records would discard whichever half each layer actually has.
 *
 * `provenance` is the one deliberate exception to "highest wins": it names the
 * source of the *identity* (which layer told us this model exists), not the
 * source of each field — a model only the bundled snapshot knows about stays
 * labelled `bundled` even after a registry layer contributes a price.
 */
export function mergeCatalogMetadata(
  id: string,
  layers: Array<{ source: ModelSource; record?: ModelRecord }>,
  fallback?: { name?: string; protocol?: WireProtocol }
): ModelRecord {
  const ordered = layers
    .filter((layer): layer is { source: ModelSource; record: ModelRecord } => Boolean(layer.record))
    .slice()
    // Ascending precedence, so the LAST element is the highest layer. The sort
    // is stable in V8, so equal-precedence layers keep the caller's order.
    .sort((a, b) => SOURCE_PRECEDENCE.indexOf(a.source) - SOURCE_PRECEDENCE.indexOf(b.source))
  const highest = ordered[ordered.length - 1]?.record
  const lowest = ordered[0]?.record

  let capabilities: ModelCapabilities | undefined
  let reasoningOptions: ReasoningOption[] = []
  let cost: ModelCost | undefined
  for (const layer of ordered) {
    const record = layer.record
    capabilities = capabilities
      ? {
          attachment: record.capabilities.attachment || capabilities.attachment,
          reasoning: record.capabilities.reasoning || capabilities.reasoning,
          toolCall: record.capabilities.toolCall || capabilities.toolCall,
          chatCapable: record.capabilities.chatCapable && capabilities.chatCapable,
          modalities: {
            input: Array.from(new Set([...capabilities.modalities.input, ...record.capabilities.modalities.input])),
            output: Array.from(new Set([...capabilities.modalities.output, ...record.capabilities.modalities.output])),
          },
        }
      : {
          ...record.capabilities,
          modalities: { input: [...record.capabilities.modalities.input], output: [...record.capabilities.modalities.output] },
        }
    if (record.reasoningOptions.length > 0) reasoningOptions = record.reasoningOptions.map((option) => ({ ...option }))
    // `ordered` is ascending, so each iteration's record is the NEWER, higher
    // precedence layer and must therefore be `mergeCost`'s `high` argument.
    cost = mergeCost(record.cost, cost)
  }

  // Protocol follows the highest layer that actually had evidence for it; a
  // lower layer's guess must never override a higher layer's answer.
  const protocol = (highest?.protocol ?? lowest?.protocol) || fallback?.protocol

  // `ordered` is ascending, so reverse a COPY (`.reverse()` mutates) for
  // "highest first" lookups.
  const descending = ordered.map((layer) => layer.record).reverse()

  return {
    id,
    name: firstDefined([...descending.map((item) => item.name), fallback?.name]) || id,
    protocol,
    capabilities: capabilities ? capabilities : emptyView().capabilities,
    reasoningOptions,
    limits: {
      context: firstDefined(descending.map((item) => item.limits.context)),
      output: firstDefined(descending.map((item) => item.limits.output)),
    },
    cost,
    releaseDate: firstDefined(descending.map((item) => item.releaseDate)),
    lastUpdated: firstDefined(descending.map((item) => item.lastUpdated)),
    status: firstDefined(descending.map((item) => item.status)),
    free: firstDefined(descending.map((item) => item.free)),
    provenance: highest?.provenance || lowest?.provenance || 'registry',
  }
}

// ---------------------------------------------------------------------------
// Cost estimation
// ---------------------------------------------------------------------------

export interface CostEstimate {
  totalUsd: number
  /** False when the metadata cannot produce an honest number, so the UI must render `N/A`. */
  complete: boolean
}

export interface CostUsage {
  promptTokens: number
  cacheHitTokens?: number
  completionTokens: number
}

/**
 * Estimate run cost from the model's own prices (USD per million tokens, the
 * models.dev unit).
 *
 * `complete: false` means the metadata is missing an input or output price, and
 * the caller must render `N/A` rather than a confident `$0.00`. Output pricing is
 * part of the requirement: an input-only price cannot honestly price a run that
 * produced output tokens.
 */
export function estimateModelCost(cost: ModelCost | undefined, usage: CostUsage): CostEstimate {
  const priced = Boolean(cost) && (cost?.input !== undefined || cost?.output !== undefined)
  if (!cost || !priced) return { totalUsd: 0, complete: false }
  const prompt = Math.max(0, Number(usage.promptTokens) || 0)
  const cacheHit = Math.min(prompt, Math.max(0, Number(usage.cacheHitTokens) || 0))
  const completion = Math.max(0, Number(usage.completionTokens) || 0)
  const cachePrice = cost.cacheRead !== undefined ? cost.cacheRead : (cost.input ?? 0)
  const total =
    ((prompt - cacheHit) * (cost.input ?? 0) + cacheHit * cachePrice + completion * (cost.output ?? 0)) / 1_000_000
  return { totalUsd: total, complete: cost.input !== undefined && cost.output !== undefined }
}

// ---------------------------------------------------------------------------
// Injected environment (structural, so tests need neither Electron nor a real fs)
// ---------------------------------------------------------------------------

export interface RegistryFetchResponse {
  status: number
  headers: { get(name: string): string | null }
  text(): Promise<string>
}

export interface RegistryFetchInit {
  method: string
  headers: Record<string, string>
  signal?: AbortSignal
}

export type RegistryFetch = (url: string, init: RegistryFetchInit) => Promise<RegistryFetchResponse>

export interface ModelRegistryStorage {
  readFile(path: string): string | null
  writeFile(path: string, data: string): void
  /** Atomic replace where the platform supports it; may fall back to `writeFile`. */
  writeFileAtomic(path: string, data: string): void
}

export interface ModelRegistryClock {
  now(): number
}

export interface ModelRegistryOptions {
  /** `{userData}/models-cache.json` — the raw models.dev payload, cached as-is. */
  cachePath: string
  /** Sidecar holding the ETag plus last-attempt/last-success timestamps. */
  metaPath: string
  storage: ModelRegistryStorage
  fetch?: RegistryFetch
  clock?: ModelRegistryClock
  /** Bundled offline snapshot, used when no usable live cache exists. */
  bundledSnapshot?: ModelRegistryPayload | null
  /** Set false for a purely offline registry (tests, screenshot mode). */
  allowNetwork?: boolean
  ttlMs?: number
  failureRetryMs?: number
  userAgent?: string
  onWarn?: (message: string) => void
}

export interface RegistryRefreshResult {
  used: ModelSource
  changed: boolean
  /** True when the TTL/mode gate refused to even attempt a request. */
  skipped: boolean
  status?: number
  error?: string
}

export const MODELS_DEV_URL = 'https://models.dev/api.json'
/** Data-usage terms for models.dev are undocumented, so this stays a cache and never a shipped fork. */
export const MODELS_DEV_ATTRIBUTION = 'model metadata © models.dev contributors (MIT), fetched at runtime'
/** Matches the plan's ~24 h refresh window; the payload is ~458 KB gzipped and 304s are free. */
export const DEFAULT_REGISTRY_TTL_MS = 24 * 60 * 60 * 1000
/** A failed refresh must not be retried on every call. */
export const DEFAULT_FAILURE_RETRY_MS = 15 * 60 * 1000

interface RegistryMeta {
  etag?: string
  fetchedAt?: number
  lastAttemptAt?: number
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/**
 * Three-tier registry: bundled snapshot < live cache < network.
 *
 * Every failure path degrades instead of throwing. This feeds model discovery
 * and pricing, so an offline user must still get the bundled metadata and a
 * models.dev outage must not break the picker.
 */
export class ModelRegistry {
  private readonly storage: ModelRegistryStorage
  private readonly fetchImpl?: RegistryFetch
  private readonly clock: ModelRegistryClock
  private readonly bundledPayload: ModelRegistryPayload | null
  private readonly cachePath: string
  private readonly metaPath: string
  private readonly allowNetwork: boolean
  private readonly ttlMs: number
  private readonly failureRetryMs: number
  private readonly userAgent: string
  private readonly onWarn: (message: string) => void

  private snapshot: ModelRegistrySnapshot
  private meta: RegistryMeta

  /**
   * Construct synchronously: the initial snapshot comes from the disk cache plus
   * the bundled snapshot, and the network refresh is always an explicit
   * `refresh()`. Startup must never block on a multi-megabyte download.
   */
  constructor(options: ModelRegistryOptions) {
    this.storage = options.storage
    this.fetchImpl = options.fetch
    this.clock = options.clock || { now: () => Date.now() }
    this.bundledPayload = options.bundledSnapshot || null
    this.cachePath = options.cachePath
    this.metaPath = options.metaPath
    this.allowNetwork = options.allowNetwork !== false
    this.ttlMs = options.ttlMs ?? DEFAULT_REGISTRY_TTL_MS
    this.failureRetryMs = options.failureRetryMs ?? DEFAULT_FAILURE_RETRY_MS
    this.userAgent = options.userAgent || 'Weport/unknown'
    this.onWarn = options.onWarn || ((message: string) => console.warn(`[modelRegistry] ${message}`))
    this.meta = this.readMeta()
    this.snapshot = this.loadInitialSnapshot()
  }

  private warn(message: string): void {
    this.onWarn(message)
  }

  private readMeta(): RegistryMeta {
    try {
      const raw = this.storage.readFile(this.metaPath)
      if (!raw) return {}
      const parsed = JSON.parse(raw) as RegistryMeta
      return parsed && typeof parsed === 'object' ? parsed : {}
    } catch {
      // A corrupt sidecar only costs us a conditional GET.
      return {}
    }
  }

  private writeMeta(): void {
    try {
      this.storage.writeFileAtomic(this.metaPath, JSON.stringify(this.meta))
    } catch (error) {
      this.warn(`registry meta write failed: ${String((error as Error)?.message || error)}`)
    }
  }

  private bundledSnapshot(): ModelRegistrySnapshot {
    return buildSnapshot(this.bundledPayload, 'bundled')
  }

  private cachedSnapshot(): ModelRegistrySnapshot | undefined {
    try {
      const raw = this.storage.readFile(this.cachePath)
      if (!raw) return undefined
      const snapshot = buildSnapshot(JSON.parse(raw) as ModelRegistryPayload, 'registry', MODELS_DEV_ATTRIBUTION)
      return Object.keys(snapshot.providers).length > 0 ? snapshot : undefined
    } catch (error) {
      this.warn(`registry cache unreadable, falling back to the bundled snapshot: ${String((error as Error)?.message || error)}`)
      return undefined
    }
  }

  private loadInitialSnapshot(): ModelRegistrySnapshot {
    const cached = this.cachedSnapshot()
    const bundled = this.bundledSnapshot()
    if (!cached) return bundled
    return this.overlay(bundled, cached, 'registry')
  }

  /**
   * Layer a higher-precedence provider map over a lower one, keeping the lower
   * map's providers that the higher map does not mention. A disk cache written
   * before a provider was added to the bundled snapshot must not delete it.
   */
  private overlay(base: ModelRegistrySnapshot, over: ModelRegistrySnapshot, source: ModelSource): ModelRegistrySnapshot {
    if (Object.keys(base.providers).length === 0) return over
    const providers: Record<string, RegistryProviderEntry> = { ...base.providers }
    const indexByModelId = new Map(base.indexByModelId)
    for (const [providerId, entry] of Object.entries(over.providers)) {
      const existing = providers[providerId]
      providers[providerId] = existing
        ? {
            ...entry,
            models: { ...existing.models, ...entry.models },
            indexByLowerId: new Map([...existing.indexByLowerId, ...entry.indexByLowerId]),
          }
        : entry
      for (const modelId of Object.keys(entry.models)) {
        const owners = indexByModelId.get(modelId)
        if (owners && !owners.includes(providerId)) owners.push(providerId)
        else if (!owners) indexByModelId.set(modelId, [providerId])
      }
    }
    return { source, attribution: over.attribution || base.attribution, providers, indexByModelId }
  }

  get current(): ModelRegistrySnapshot {
    return this.snapshot
  }

  /** Provider ids present in the current snapshot, for diagnostics. */
  providerIds(): string[] {
    return Object.keys(this.snapshot.providers)
  }

  /** True when there is no metadata at all (no cache and no bundled snapshot). */
  get isEmpty(): boolean {
    return Object.keys(this.snapshot.providers).length === 0
  }

  getProviderEntry(providerId: string): RegistryProviderEntry | undefined {
    return this.snapshot.providers[providerId]
  }

  /** Look up one model on one provider entry, case-insensitively. */
  findProviderModel(providerId: string, modelId: string): ModelRecord | undefined {
    const entry = this.snapshot.providers[providerId]
    if (!entry) return undefined
    const canonical = entry.indexByLowerId.get(modelId.toLowerCase())
    return canonical ? entry.models[canonical] : undefined
  }

  /** Look a model up across every provider. Returns the first match. */
  findModel(modelId: string): { providerId: string; record: ModelRecord } | undefined {
    const owners = this.snapshot.indexByModelId.get(modelId)
    const orderedOwners = owners && owners.length > 0 ? owners : this.fallbackOwners(modelId)
    for (const providerId of orderedOwners) {
      const record = this.findProviderModel(providerId, modelId)
      if (record) return { providerId, record }
    }
    return undefined
  }

  private fallbackOwners(modelId: string): string[] {
    const lower = modelId.toLowerCase()
    for (const entry of Object.values(this.snapshot.providers)) {
      if (entry.indexByLowerId.has(lower)) return [entry.providerId]
    }
    return []
  }

  private shouldRefresh(force: boolean): boolean {
    if (!this.allowNetwork || !this.fetchImpl) return false
    if (force) return true
    const now = this.clock.now()
    const lastAttemptAt = Number(this.meta.lastAttemptAt) || 0
    // Check the failure window BEFORE the TTL: after a failed attempt
    // `fetchedAt` is still 0, so a TTL-first order would retry on every single
    // call while the endpoint is down.
    if (lastAttemptAt && now - lastAttemptAt < this.failureRetryMs) return false
    const fetchedAt = Number(this.meta.fetchedAt) || 0
    if (!fetchedAt) return true
    return now - fetchedAt >= this.ttlMs
  }

  /**
   * Refresh from models.dev. Never throws.
   *
   * Guarded by a `Content-Type` check (there is **no** per-provider endpoint —
   * `/api/{provider}.json` answers `200` with the SPA's HTML, so parsing
   * whatever comes back would throw "Unexpected token <"), a top-level shape
   * check (`parsed.deepseek` must exist), a conditional `If-None-Match` request,
   * and atomic cache writes.
   */
  async refresh(options: { force?: boolean; signal?: AbortSignal } = {}): Promise<RegistryRefreshResult> {
    if (!this.shouldRefresh(Boolean(options.force)) || !this.fetchImpl) {
      return { used: this.snapshot.source, changed: false, skipped: true }
    }
    const fetchImpl = this.fetchImpl
    this.meta.lastAttemptAt = this.clock.now()
    try {
      const headers: Record<string, string> = {
        Accept: 'application/json',
        // Without an explicit Accept-Encoding some intermediaries answer
        // uncompressed; the payload is ~4.6 MB raw against ~458 KB gzipped.
        'Accept-Encoding': 'gzip',
        'User-Agent': this.userAgent,
      }
      if (this.meta.etag) headers['If-None-Match'] = this.meta.etag
      const response = await fetchImpl(MODELS_DEV_URL, { method: 'GET', headers, signal: options.signal })

      if (response.status === 304) {
        // Zero bytes, and proof that the cached copy is still current.
        this.meta.fetchedAt = this.clock.now()
        this.writeMeta()
        return { used: this.snapshot.source, changed: false, skipped: false, status: 304 }
      }
      if (response.status !== 200) {
        this.writeMeta()
        return { used: this.snapshot.source, changed: false, skipped: false, status: response.status, error: `HTTP ${response.status}` }
      }

      const contentType = response.headers.get('content-type') || ''
      if (!/json/i.test(contentType)) {
        this.writeMeta()
        return {
          used: this.snapshot.source,
          changed: false,
          skipped: false,
          status: response.status,
          error: `unexpected content-type: ${contentType || '(none)'}`,
        }
      }

      const text = await response.text()
      let parsed: unknown
      try {
        parsed = JSON.parse(text)
      } catch (error) {
        this.writeMeta()
        return { used: this.snapshot.source, changed: false, skipped: false, status: response.status, error: `invalid JSON: ${String((error as Error)?.message || error)}` }
      }

      const root = asRecord(parsed)
      if (!root || !('deepseek' in root)) {
        this.writeMeta()
        return { used: this.snapshot.source, changed: false, skipped: false, status: response.status, error: 'unexpected payload shape' }
      }

      const live = buildSnapshot(root as ModelRegistryPayload, 'registry', MODELS_DEV_ATTRIBUTION)
      if (Object.keys(live.providers).length === 0) {
        this.writeMeta()
        return { used: this.snapshot.source, changed: false, skipped: false, status: response.status, error: 'payload had no usable providers' }
      }

      this.meta.etag = response.headers.get('etag') || this.meta.etag
      this.meta.fetchedAt = this.clock.now()
      try {
        this.storage.writeFileAtomic(this.cachePath, text)
      } catch (error) {
        // In-memory success is still success; only the next cold start degrades.
        this.warn(`registry cache write failed: ${String((error as Error)?.message || error)}`)
      }
      this.writeMeta()
      this.snapshot = this.overlay(this.bundledSnapshot(), live, 'registry')
      return { used: this.snapshot.source, changed: true, skipped: false, status: response.status }
    } catch (error) {
      this.writeMeta()
      const message = String((error as Error)?.message || error)
      this.warn(`registry refresh failed, keeping cached metadata: ${message}`)
      return { used: this.snapshot.source, changed: false, skipped: false, error: message }
    }
  }
}

// ---------------------------------------------------------------------------
// Caller-facing resolution
// ---------------------------------------------------------------------------

export interface ResolveModelInput {
  registry: ModelRegistry
  /**
   * models.dev provider id. The catalog maps app provider ids onto it
   * (`opencode-zen` → `opencode`, `opencode-go` → `opencode-go`), because unlike
   * the app's ids the registry's are the upstream ones.
   */
  registryProviderId?: string
  /** Fallback protocol for a model no layer knows about (catalog entry or profile). */
  defaultProtocol?: string
  profile: { id: string; protocol: string }
  modelId: string
  /** Record synthesized from a live `GET {base}/models` response, when available. */
  live?: ModelRecord
}

export interface ResolvedModel {
  record: ModelRecord
  /** The protocol the request must use. Always concrete. */
  protocol: WireProtocol
}

export function coerceWireProtocol(value: string | undefined): WireProtocol | undefined {
  return (WIRE_PROTOCOLS as readonly string[]).includes(String(value)) ? (value as WireProtocol) : undefined
}

/** Type guard for values arriving from persisted JSON or IPC. */
export function isWireProtocol(value: unknown): value is WireProtocol {
  return typeof value === 'string' && (WIRE_PROTOCOLS as readonly string[]).includes(value)
}

/**
 * Resolve the metadata and wire protocol for one model on one profile.
 *
 * The profile-level `protocol` is only a *default*: multi-protocol gateways
 * route by model (verified — `POST /zen/go/v1/chat/completions` with `grok-4.6`
 * answers `Model grok-4.6 is not supported for format oa-compat`, while the same
 * model is served on `/responses`), so the registry's per-model and
 * per-provider answers must win over it.
 */
export function resolveModelMetadata(input: ResolveModelInput): ResolvedModel {
  const registryRecord =
    (input.registryProviderId ? input.registry.findProviderModel(input.registryProviderId, input.modelId) : undefined) ||
    input.registry.findModel(input.modelId)?.record

  const record = mergeCatalogMetadata(
    input.modelId,
    [
      { source: 'registry', record: registryRecord },
      { source: 'live', record: input.live },
    ],
    { protocol: coerceWireProtocol(input.defaultProtocol) }
  )
  const protocol =
    record.protocol ||
    coerceWireProtocol(input.profile.protocol) ||
    coerceWireProtocol(input.defaultProtocol) ||
    'openai-compatible'
  return { record: { ...record, protocol }, protocol }
}
