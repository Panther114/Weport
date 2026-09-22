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
  // 定价（cost）不再下发到渲染层：定价估算功能已在 v1.0.1 移除。
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
  /** 图片输入开关（默认开）：关掉后 read_chat_images 不再把图片本体发给模型 */
  imageInputs?: boolean
  customPrompt: string
  workspaceRoot: string
  exportPath: string
  dbReady: boolean
  disabledTools: string[]
  activeProfileId: string
  profiles: ProviderProfileSummary[]
  catalog: ProviderCatalogEntry[]
  // 定价（modelCosts）在 v1.0.1 移除：渲染层的每次「花费估算」都建立在
  // models.dev 那张覆盖不全的定价表上，显示的多数是「未定价」，偶尔有值也只能
  // 当估算用。真正的账单在服务商后台。
}

export type AiAction = { id: string; name: string; prompt: string }
