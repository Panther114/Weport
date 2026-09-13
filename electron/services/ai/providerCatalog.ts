import type { ProviderCatalogEntry, ProviderProtocol } from './providerTypes'

/**
 * Static provider catalog — the offline, always-available floor.
 *
 * `models` is a seed list only. The live list comes from
 * `GET {base}/models` and the models.dev registry; this array exists so the
 * provider picker and the free-text entry still work with no cache and no
 * network. `registryProviderId` is the models.dev key the provider layer uses to
 * look up per-model protocol, context window and pricing.
 *
 * `defaultModel` values were checked against the live `/models` responses and
 * the models.dev registry in 2026-09; the previous generation of defaults
 * (`claude-sonnet-4-20250514`, `claude-haiku-3-5-20241022`, `gemini-2.5-flash`)
 * named ids that no longer existed and were silently rejected by the providers.
 */
const CATALOG: ProviderCatalogEntry[] = [
  {
    id: 'openai',
    name: 'OpenAI',
    description: 'OpenAI Responses API，支持工具调用与流式输出。',
    protocol: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    defaultModel: 'gpt-5.6',
    models: ['gpt-5.6', 'gpt-5.5', 'gpt-5.4', 'gpt-4.1-mini'],
    website: 'https://platform.openai.com/docs/api-reference/responses',
    registryProviderId: 'openai',
  },
  {
    id: 'anthropic',
    name: 'Anthropic',
    description: 'Anthropic Messages API，使用 x-api-key 认证。',
    protocol: 'anthropic',
    baseUrl: 'https://api.anthropic.com/v1',
    defaultModel: 'claude-sonnet-5',
    models: ['claude-sonnet-5', 'claude-opus-5', 'claude-haiku-4-5'],
    website: 'https://docs.anthropic.com/en/api/messages',
    registryProviderId: 'anthropic',
  },
  {
    id: 'google',
    name: 'Google Gemini',
    description: 'Google Gemini 原生 generateContent API。',
    protocol: 'google',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    defaultModel: 'gemini-3.8-flash',
    models: ['gemini-3.8-flash', 'gemini-3.7-flash', 'gemini-3.5-flash'],
    website: 'https://ai.google.dev/gemini-api/docs',
    registryProviderId: 'google',
  },
  {
    id: 'gemini-compatible',
    name: 'Gemini 兼容接口',
    description: 'Google 提供的 OpenAI-compatible Gemini 入口。',
    protocol: 'gemini-compatible',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    defaultModel: 'gemini-3.8-flash',
    models: ['gemini-3.8-flash', 'gemini-3.7-flash', 'gemini-3.5-flash'],
    website: 'https://ai.google.dev/gemini-api/docs/openai',
    registryProviderId: 'google',
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    description: 'DeepSeek OpenAI-compatible API，兼容现有 WeportAI 配置。',
    protocol: 'openai-compatible',
    baseUrl: 'https://api.deepseek.com',
    // `deepseek-v4-flash` rather than the `deepseek-flash` alias: both are served
    // (both released 2026-09-10), but the former is also the id the OpenCode
    // gateways accept, so one id works everywhere.
    defaultModel: 'deepseek-v4-flash',
    models: ['deepseek-v4-flash', 'deepseek-v4-pro'],
    website: 'https://api-docs.deepseek.com/',
    registryProviderId: 'deepseek',
  },
  {
    id: 'qwen',
    name: 'Alibaba / Qwen',
    description: 'DashScope OpenAI-compatible API。',
    protocol: 'openai-compatible',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    defaultModel: 'qwen-plus',
    models: ['qwen-plus', 'qwen-max', 'qwen-turbo'],
    website: 'https://help.aliyun.com/zh/dashscope/',
    registryProviderId: 'alibaba',
  },
  {
    id: 'moonshot',
    name: 'Moonshot / Kimi',
    description: 'Moonshot AI OpenAI-compatible API。',
    protocol: 'openai-compatible',
    baseUrl: 'https://api.moonshot.cn/v1',
    defaultModel: 'kimi-k2.5',
    models: ['kimi-k2.5', 'moonshot-v1-128k'],
    website: 'https://platform.moonshot.cn/docs',
    registryProviderId: 'moonshotai',
  },
  {
    id: 'zhipu',
    name: 'Zhipu / GLM',
    description: 'Zhipu BigModel OpenAI-compatible API。',
    protocol: 'openai-compatible',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    defaultModel: 'glm-4.5',
    models: ['glm-4.5', 'glm-4.5-air', 'glm-4-flash'],
    website: 'https://open.bigmodel.cn/dev/api',
    registryProviderId: 'zhipuai',
  },
  {
    id: 'minimax',
    name: 'MiniMax',
    description: 'MiniMax API。注意：MiniMax 的 M 系列在官方端点是 Anthropic 格式（/messages），provider 层会按模型自动选择。',
    protocol: 'openai-compatible',
    baseUrl: 'https://api.minimaxi.com/v1',
    defaultModel: 'MiniMax-M2.5',
    models: ['MiniMax-M2.5', 'MiniMax-Text-01'],
    website: 'https://platform.minimaxi.com/document',
    registryProviderId: 'minimax',
  },
  {
    id: 'doubao',
    name: 'Doubao / Volcengine',
    description: 'Volcengine Ark OpenAI-compatible API。',
    protocol: 'openai-compatible',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    defaultModel: '',
    models: [],
    website: 'https://www.volcengine.com/docs/82379',
    registryProviderId: 'volcengine',
  },
  {
    id: 'groq',
    name: 'Groq',
    description: 'Groq low-latency OpenAI-compatible API。',
    protocol: 'openai-compatible',
    baseUrl: 'https://api.groq.com/openai/v1',
    defaultModel: 'llama-3.3-70b-versatile',
    models: ['llama-3.3-70b-versatile', 'openai/gpt-oss-120b'],
    website: 'https://console.groq.com/docs',
    registryProviderId: 'groq',
  },
  {
    id: 'mistral',
    name: 'Mistral',
    description: 'Mistral AI OpenAI-compatible API。',
    protocol: 'openai-compatible',
    baseUrl: 'https://api.mistral.ai/v1',
    defaultModel: 'mistral-large-latest',
    models: ['mistral-large-latest', 'mistral-small-latest'],
    website: 'https://docs.mistral.ai/api/',
    registryProviderId: 'mistral',
  },
  {
    id: 'xai',
    name: 'xAI / Grok',
    description: 'xAI OpenAI-compatible API。',
    protocol: 'openai-compatible',
    baseUrl: 'https://api.x.ai/v1',
    defaultModel: 'grok-4',
    models: ['grok-4', 'grok-3-mini'],
    website: 'https://docs.x.ai/',
    registryProviderId: 'xai',
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    description: 'OpenRouter unified OpenAI-compatible gateway。',
    protocol: 'openai-compatible',
    baseUrl: 'https://openrouter.ai/api/v1',
    defaultModel: 'openai/gpt-4.1-mini',
    models: ['openai/gpt-4.1-mini', 'anthropic/claude-sonnet-4'],
    website: 'https://openrouter.ai/docs',
    registryProviderId: 'openrouter',
  },
  {
    id: 'together',
    name: 'Together AI',
    description: 'Together AI OpenAI-compatible inference API。',
    protocol: 'openai-compatible',
    baseUrl: 'https://api.together.xyz/v1',
    defaultModel: 'openai/gpt-oss-120b',
    models: ['openai/gpt-oss-120b', 'meta-llama/Llama-3.3-70B-Instruct-Turbo'],
    website: 'https://docs.together.ai/',
    registryProviderId: 'togetherai',
  },
  {
    id: 'siliconflow',
    name: 'SiliconFlow',
    description: 'SiliconFlow OpenAI-compatible inference API。',
    protocol: 'openai-compatible',
    baseUrl: 'https://api.siliconflow.cn/v1',
    defaultModel: 'Qwen/Qwen3-32B',
    models: ['Qwen/Qwen3-32B', 'deepseek-ai/DeepSeek-V3'],
    website: 'https://docs.siliconflow.cn/',
    registryProviderId: 'siliconflow',
  },
  {
    id: 'azure-openai',
    name: 'Azure OpenAI',
    description: 'Azure OpenAI deployment endpoint。请填写部署地址和 API version。',
    protocol: 'openai-compatible',
    baseUrl: '',
    defaultModel: '',
    models: [],
    allowCustomBaseUrl: true,
    website: 'https://learn.microsoft.com/azure/ai-services/openai/',
    registryProviderId: 'azure',
  },
  {
    id: 'ollama',
    name: 'Ollama',
    description: '本地 Ollama OpenAI-compatible API，无需 API key。',
    protocol: 'openai-compatible',
    baseUrl: 'http://127.0.0.1:11434/v1',
    defaultModel: '',
    models: [],
    apiKeyOptional: true,
    website: 'https://ollama.com/blog/openai-compatibility',
    // models.dev has no plain `ollama` entry (only `ollama-cloud`), so this
    // provider keeps its static catalog as the authoritative source.
  },
  {
    id: 'lm-studio',
    name: 'LM Studio',
    description: '本地 LM Studio OpenAI-compatible API，无需 API key。',
    protocol: 'openai-compatible',
    baseUrl: 'http://127.0.0.1:1234/v1',
    defaultModel: '',
    models: [],
    apiKeyOptional: true,
    website: 'https://lmstudio.ai/docs/developer/openai-compat',
    registryProviderId: 'lmstudio',
  },
  {
    id: 'opencode-zen',
    name: 'OpenCode Zen',
    description: 'OpenCode Zen 按量付费网关（https://opencode.ai/zen/v1），覆盖 GPT/Claude/Gemini/DeepSeek 等全量模型。',
    protocol: 'openai-compatible',
    baseUrl: 'https://opencode.ai/zen/v1',
    defaultModel: 'deepseek-v4-flash',
    // Sample only: the live `/models` response (no auth required) returns ~70 ids
    // and this list cannot be kept accurate by hand. Model ids are resolved from
    // discovery, with this list as the offline seed.
    models: [
      'gpt-5.6-sol',
      'gpt-5.6-terra',
      'gpt-5.6-luna',
      'gpt-5.5',
      'claude-fable-5',
      'claude-opus-5',
      'claude-sonnet-5',
      'gemini-3.8-flash',
      'gemini-3.7-flash',
      'grok-4.6',
      'grok-4.5',
      'deepseek-v4-pro',
      'deepseek-v4-flash',
      'minimax-m3',
      'minimax-m2.7',
      'kimi-k2.7-code',
      'kimi-k3',
      'glm-5.2',
      'glm-5.1',
      'qwen3.7-max',
    ],
    website: 'https://opencode.ai/docs/zen',
    registryProviderId: 'opencode',
  },
  {
    id: 'opencode-go',
    name: 'OpenCode Go',
    description: 'OpenCode Go 订阅网关（https://opencode.ai/zen/go/v1），$10/月低成本订阅，适合国际用户。',
    protocol: 'openai-compatible',
    baseUrl: 'https://opencode.ai/zen/go/v1',
    defaultModel: 'deepseek-v4-flash',
    models: [
      'grok-4.6',
      'grok-4.5',
      'gpt-5.6-luna',
      'glm-5.3',
      'glm-5.2',
      'glm-5.1',
      'kimi-k3',
      'kimi-k2.7-code',
      'kimi-k2.6',
      'deepseek-v4-pro',
      'deepseek-v4-flash',
      'mimo-v2.5',
      'mimo-v2.5-pro',
      'minimax-m3',
      'minimax-m2.7',
      'qwen3.8-max',
      'qwen3.8-flash',
      'qwen3.7-max',
      'qwen3.7-plus',
      'qwen3.6-plus',
    ],
    website: 'https://opencode.ai/docs/go',
    registryProviderId: 'opencode-go',
  },
  {
    id: 'openai-compatible',
    name: 'OpenAI Compatible',
    description: '适用于本地服务、网关和第三方 OpenAI-compatible API。',
    protocol: 'openai-compatible',
    baseUrl: '',
    defaultModel: '',
    models: [],
    allowCustomBaseUrl: true,
    protocolOptions: ['openai-compatible', 'openai'],
  },
  {
    id: 'custom',
    name: '自定义服务',
    description: '自定义地址与协议，可选择 OpenAI、Anthropic、Google 或兼容入口。',
    protocol: 'openai-compatible',
    baseUrl: '',
    defaultModel: '',
    models: [],
    allowCustomBaseUrl: true,
    protocolOptions: ['openai', 'openai-compatible', 'anthropic', 'google', 'gemini-compatible'],
  },
]

const ALIASES: Record<string, string> = {
  gemini: 'google',
  'google-gemini': 'google',
  opencode: 'opencode-zen',
  'open-code': 'opencode-zen',
  'open-code-zen': 'opencode-zen',
  'open-code-go': 'opencode-go',
  kimi: 'moonshot',
  glm: 'zhipu',
  volcengine: 'doubao',
  grok: 'xai',
  lmstudio: 'lm-studio',
}

/**
 * Provider ids whose live discovery has produced a chat-capable model list.
 *
 * Kept as module-level state rather than a parameter because
 * `getProviderCatalog()` is called from the IPC boundary with no registry in
 * scope, and because a missing override must degrade to the static seed rather
 * than to an empty list. Written only through `invalidateCatalogOverride`.
 */
let modelCatalogOverride: Record<string, string[]> = {}

/**
 * Replace one provider's discovered list, keeping the others.
 *
 * Merging (rather than replacing the whole map) matters because discovery is
 * per-profile: saving one provider must not wipe the lists another profile
 * discovered in the same session. There is no whole-map setter on purpose —
 * one existed during development and silently dropped every other provider's
 * list because the caller passed a single-entry object.
 */
export function invalidateCatalogOverride(providerId: string, modelIds: string[]): void {
  modelCatalogOverride = { ...modelCatalogOverride, [normalizeProviderId(providerId)]: Array.from(new Set(modelIds.map(String).filter(Boolean))) }
}

export function getModelCatalogOverride(): Record<string, string[]> {
  return { ...modelCatalogOverride }
}

/** Static seed model ids, ignoring any discovery override. */
export function getCatalogSeedModels(providerId: string): string[] {
  const entry = CATALOG.find((item) => item.id === normalizeProviderId(providerId))
  return entry ? [...entry.models] : []
}

/** models.dev provider id for the app's provider id, when the catalog declares one. */
export function getRegistryProviderId(providerId: string): string | undefined {
  return getProviderCatalogEntry(providerId)?.registryProviderId
}

/** Every distinct models.dev provider id this catalog can address. */
export function getRegistryProviderIds(): string[] {
  return Array.from(new Set(CATALOG.map((entry) => entry.registryProviderId).filter(Boolean) as string[]))
}

function cloneEntry(entry: ProviderCatalogEntry): ProviderCatalogEntry {
  const discovered = modelCatalogOverride[entry.id] || []
  return {
    ...entry,
    models: Array.from(new Set([...discovered, ...entry.models])),
    protocolOptions: entry.protocolOptions ? [...entry.protocolOptions] : undefined,
  }
}

export function normalizeProviderId(value: string): string {
  const id = String(value || '').trim().toLowerCase()
  return ALIASES[id] || id
}

export function getProviderCatalog(): ProviderCatalogEntry[] {
  return CATALOG.map(cloneEntry)
}

export function getProviderCatalogEntry(providerId: string): ProviderCatalogEntry | undefined {
  const id = normalizeProviderId(providerId)
  const entry = CATALOG.find((item) => item.id === id)
  return entry ? cloneEntry(entry) : undefined
}

export function isProviderProtocol(value: unknown): value is ProviderProtocol {
  return value === 'openai' || value === 'openai-compatible' || value === 'anthropic' || value === 'google' || value === 'gemini-compatible'
}
