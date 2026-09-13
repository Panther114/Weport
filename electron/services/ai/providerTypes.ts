export type ProviderProtocol =
  | 'openai'
  | 'openai-compatible'
  | 'anthropic'
  | 'google'
  | 'gemini-compatible'

export interface ProviderCatalogEntry {
  id: string
  name: string
  description: string
  protocol: ProviderProtocol
  baseUrl: string
  defaultModel: string
  models: string[]
  website?: string
  allowCustomBaseUrl?: boolean
  protocolOptions?: ProviderProtocol[]
  apiKeyOptional?: boolean
  /**
   * The provider's id in the models.dev registry. It is NOT always the app's own
   * id (`opencode-zen` → `opencode`, `qwen` → `alibaba`, `lm-studio` → `lmstudio`),
   * and a wrong value silently costs the profile its metadata, so it is declared
   * per entry rather than derived from the id.
   */
  registryProviderId?: string
}

/**
 * Per-model metadata resolved by the provider layer (models.dev registry merged
 * with live `/models` discovery). Every field is optional: the profile keeps
 * working, with honest `unknown` rendering, when no metadata could be resolved.
 */
export interface ProviderModelMetadata {
  /** Tokens. Consumed by the compaction trigger and the context meter. */
  contextWindow?: number
  /** Tokens. Sent as `max_tokens` / `max_output_tokens` on the main call path. */
  maxOutputTokens?: number
  /**
   * Wire protocol resolved for THIS model, which may differ from the profile
   * protocol: multi-protocol gateways route by model, not by profile.
   */
  protocol?: ProviderProtocol
  /** USD per million tokens, straight from the registry. Absent means "unknown", never 0. */
  cost?: {
    input?: number
    output?: number
    reasoning?: number
    cacheRead?: number
    cacheWrite?: number
  }
  capabilities?: {
    attachment: boolean
    reasoning: boolean
    toolCall: boolean
    chatCapable: boolean
    modalities: { input: string[]; output: string[] }
  }
  reasoningOptions?: Array<
    | { type: 'toggle' }
    | { type: 'effort'; values: string[] }
    | { type: 'budget_tokens'; min?: number; max?: number }
  >
  /** Which layer produced this metadata: `bundled` | `registry` | `live`. */
  source?: string
  /** False when the model is known to be non-chat; absent when unknown. */
  chatCapable?: boolean
}

export interface ProviderProfile {
  id: string
  name: string
  providerId: string
  protocol: ProviderProtocol
  baseUrl: string
  model: string
  apiKey: string
  headers?: Record<string, string>
  /**
   * Resolved context window (tokens) for `model`. Populated from the provider
   * layer once model metadata is known; absent means "unknown — fall back to
   * config". Consumed by the compaction trigger and the context meter so a
   * 128k model is never reported against a hard-coded 1M window.
   */
  modelContextWindow?: number
  modelMaxOutputTokens?: number
  modelProtocol?: ProviderProtocol
  modelCost?: ProviderModelMetadata['cost']
  modelCapabilities?: ProviderModelMetadata['capabilities']
  modelReasoningOptions?: ProviderModelMetadata['reasoningOptions']
  modelMetadataSource?: string
  modelMetadataUpdatedAt?: number
  createdAt: number
  updatedAt: number
  discovery?: {
    models: string[]
    fetchedAt: number
    error?: string
  }
}

export interface ProviderProfileInput {
  id?: string
  name: string
  providerId: string
  protocol: ProviderProtocol
  baseUrl?: string
  model: string
  apiKey?: string
  headers?: Record<string, string>
}

/**
 * Renderer-safe profile shape. It intentionally contains no secret or raw
 * request headers. The model metadata below is also safe to send: it describes
 * the model, never the credential.
 */
export interface ProviderProfileSummary {
  id: string
  name: string
  displayName: string
  providerId: string
  protocol: ProviderProtocol
  baseUrl: string
  model: string
  hasApiKey: boolean
  apiKeyHint: string
  modelContextWindow?: number
  modelMaxOutputTokens?: number
  modelProtocol?: ProviderProtocol
  modelCost?: ProviderModelMetadata['cost']
  modelCapabilities?: ProviderModelMetadata['capabilities']
  modelReasoningOptions?: ProviderModelMetadata['reasoningOptions']
  modelMetadataSource?: string
  modelMetadataUpdatedAt?: number
  createdAt: number
  updatedAt: number
  discovery?: {
    models: string[]
    fetchedAt: number
    error?: string
  }
}

/** 使用 AI 服务的三个功能面。 */
export type ProviderConsumer = 'chat' | 'weclone' | 'webot'

export interface ProviderProfileStore {
  version: 1
  activeProfileId: string
  /**
   * 每个功能面各自指定的服务（profile id）；缺省表示「跟随默认服务」。
   *
   * v1.0.1 之前只有一个全局 activeProfileId，而 WeClone 的强制 provider 会直接
   * `activate()` 一个自己新建的 profile —— 于是打开一次「人格克隆 · 新建」就把
   * WeportAI 的服务静默换成了 WeClone 的。三个功能面共用一个开关，谁都不能单独
   * 指向别的服务。现在默认仍跟随 active，但每个面可以各自覆盖。
   */
  consumerProfiles?: Partial<Record<ProviderConsumer, string>>
  profiles: ProviderProfile[]
}

export interface ProviderStreamInput {
  profile: ProviderProfile
  messages: Array<Record<string, unknown>>
  tools: Array<{
    type: 'function'
    function: {
      name: string
      description: string
      parameters: Record<string, unknown>
    }
  }>
  /** Optional adapter-level cap; normal requests omit it and use provider defaults. */
  maxOutputTokens?: number
  reasoningEffort: string
  signal: AbortSignal
  onReasoning: (text: string) => void
  onText: (text: string) => void
}

export interface ProviderStreamResult {
  content: string
  reasoning: string
  toolCalls: Array<{ id: string; name: string; args: Record<string, unknown> }>
  usage?: {
    promptTokens: number
    completionTokens: number
    reasoningTokens: number
    totalTokens: number
    promptCacheHitTokens: number
  }
  finishReason?: string
}

export interface ProviderAdapter {
  stream(input: ProviderStreamInput): Promise<ProviderStreamResult>
  listModels(profile: ProviderProfile, signal?: AbortSignal): Promise<string[]>
  /**
   * The same request as `listModels`, but returning the raw payload.
   *
   * There is no standard envelope for `GET {base}/models`, and the caller needs
   * the per-model objects (not just ids) to resolve each model's own protocol,
   * context window and pricing. Keeping the raw payload available is what makes
   * that possible without re-implementing five envelope shapes per adapter.
   */
  listModelsWithEnvelope(profile: ProviderProfile, signal?: AbortSignal): Promise<unknown>
}
