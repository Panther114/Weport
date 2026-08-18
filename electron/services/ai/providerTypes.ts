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

/** Renderer-safe profile shape. It intentionally contains no secret or raw request headers. */
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
  createdAt: number
  updatedAt: number
  discovery?: {
    models: string[]
    fetchedAt: number
    error?: string
  }
}

export interface ProviderProfileStore {
  version: 1
  activeProfileId: string
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
}
