/**
 * WeportAI 面板与「设置 → AI 服务」对话框共用的类型。
 *
 * 拆出来是因为 provider 配置整体搬到了设置页：对话框不再住在面板文件里，而两边
 * 都要描述同一套 setup / catalog / profile 结构，各写一份会立刻漂移。
 */

export type ProviderProtocol = 'openai' | 'openai-compatible' | 'anthropic' | 'google' | 'gemini-compatible'

export type ProviderCatalogEntry = {
  id: string
  name: string
  description: string
  protocol: ProviderProtocol
  baseUrl: string
  defaultModel: string
  models: string[]
  allowCustomBaseUrl?: boolean
  protocolOptions?: ProviderProtocol[]
  apiKeyOptional?: boolean
}

/** Per-model metadata resolved by the provider layer (models.dev + live discovery). */
export type ProviderModelMetadata = {
  contextWindow?: number
  maxOutputTokens?: number
  protocol?: string
  /** USD per million tokens. Absent means "unknown" and MUST render as `N/A`. */
  cost?: { input?: number; output?: number; reasoning?: number; cacheRead?: number; cacheWrite?: number }
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
  source?: string
}

export type ProviderProfileSummary = {
  id: string
  name: string
  displayName: string
  providerId: string
  protocol: ProviderProtocol
  baseUrl: string
  model: string
  hasApiKey: boolean
  apiKeyHint: string
  updatedAt: number
  discovery?: { models: string[]; fetchedAt: number; error?: string }
} & ProviderModelMetadata

export type SetupInfo = {
  hasApiKey: boolean
  baseUrl: string
  baseUrlError?: string
  model: string
  reasoningEffort: string
  customPrompt: string
  workspaceRoot: string
  exportPath: string
  dbReady: boolean
  disabledTools: string[]
  activeProfileId: string
  profiles: ProviderProfileSummary[]
  catalog: ProviderCatalogEntry[]
}

export type AiAction = { id: string; name: string; prompt: string }
