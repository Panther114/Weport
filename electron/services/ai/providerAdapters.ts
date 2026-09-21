import { randomUUID } from 'crypto'
import { getProviderCatalogEntry } from './providerCatalog'
import { extractModelIds } from './modelRegistry'
import { enrichNetworkError, fetchWithRetry } from './netError'
import type { ProviderAdapter, ProviderProfile, ProviderProtocol, ProviderStreamInput, ProviderStreamResult } from './providerTypes'

const DEFAULT_HEADERS = { 'Content-Type': 'application/json' }

/**
 * 图片附件的形状（与 `weportAiService.AiMessage.images` 一致）。
 *
 * 这里做一次**运行时**校验而不是直接相信上游：这些对象来自工具执行结果，
 * 形状错了会让整个请求 400，而错误信息只会说"content 无效"。
 */
function imageParts(value: unknown): Array<{ mimeType: string; data: string }> {
  if (!Array.isArray(value)) return []
  const out: Array<{ mimeType: string; data: string }> = []
  for (const item of value) {
    const record = item as { mimeType?: unknown; data?: unknown } | null
    const mimeType = String(record?.mimeType || '').trim()
    const data = String(record?.data || '').trim()
    if (!mimeType || !data) continue
    out.push({ mimeType, data })
  }
  return out
}

function imageDataUrl(image: { mimeType: string; data: string }): string {
  return `data:${image.mimeType};base64,${image.data}`
}

/**
 * 工具消息带图片时的 OpenAI 兼容转换。
 *
 * 图片必须是**独立的内容块**（`image_url`），不能拼进文本：拼进去模型只会
 * 收到一坨 base64 字符。没有图片的消息原样透传 —— 这条路径每一步都要重发整段
 * 前缀，多余的改写会毁掉提供商的 prefix cache。
 */
export function openAIChatMessages(messages: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return messages.map((message) => {
    if (message.role !== 'tool') return message
    const images = imageParts(message.images)
    if (images.length === 0) return message
    return {
      role: 'tool',
      tool_call_id: message.tool_call_id,
      content: [
        { type: 'text', text: String(message.content || '') },
        ...images.map((image) => ({ type: 'image_url', image_url: { url: imageDataUrl(image) } })),
      ],
    }
  })
}

/**
 * Default `User-Agent` for gateway requests.
 *
 * The OpenCode gateway operator asks clients to identify themselves (the plan
 * records this under C1.4). It is advisory only — both `/models` and the chat
 * endpoints answer without any auth or identification — so a policy that blocks
 * it can only cost the header, never the request. The version is intentionally
 * coarse: a per-release UA would be one more thing to keep in sync.
 */
const DEFAULT_USER_AGENT = 'Weport (+https://github.com/PantryHost/weport)'

function normalizeBaseUrl(value: string): string {
  return String(value || '').trim().replace(/\/+$/, '')
}

function endpoint(baseUrl: string, path: string): string {
  const base = normalizeBaseUrl(baseUrl)
  if (!base) throw new Error('未配置服务地址')
  return `${base}${path.startsWith('/') ? path : `/${path}`}`
}

function providerError(payload: unknown): string {
  if (payload && typeof payload === 'object') {
    const record = payload as Record<string, unknown>
    const nested = record.error
    if (typeof nested === 'string' && nested.trim()) return nested.trim()
    if (nested && typeof nested === 'object') {
      const error = nested as Record<string, unknown>
      for (const value of [error.message, error.detail, error.error]) {
        if (typeof value === 'string' && value.trim()) return value.trim()
      }
    }
    for (const value of [record.message, record.detail]) {
      if (typeof value === 'string' && value.trim()) return value.trim()
    }
  }
  return String(payload || '').trim().slice(0, 1200)
}

async function readError(response: Response): Promise<never> {
  const raw = await response.text().catch(() => '')
  let detail = raw
  try { detail = providerError(JSON.parse(raw)) || raw } catch { /* plain text */ }
  const error = new Error(detail || `HTTP ${response.status}`)
  ;(error as Error & { status?: number }).status = response.status
  throw error
}

/**
 * Every provider request goes through this.
 *
 * `fetchWithRetry` only retries connect-phase failures (DNS / connection setup)
 * and rethrows a readable message — without it a transient DNS hiccup surfaced
 * in a WeBot note as `fetch failed`, which tells the user nothing. See
 * `netError.ts`.
 */
function providerFetch(url: string, init: RequestInit): Promise<Response> {
  return fetchWithRetry(url, init)
}

async function requestJson(url: string, init: RequestInit): Promise<any> {
  const response = await providerFetch(url, init)
  if (!response.ok) return readError(response)
  return response.json()
}

/**
 * Headers for a request, keyed off the PROFILE's protocol rather than the
 * resolved per-model wire protocol.
 *
 * That split is deliberate: a multi-protocol gateway serves several wire formats
 * behind ONE credential, so routing a model to `/messages` must not also switch
 * a Bearer-token gateway over to `x-api-key`. Only a profile explicitly
 * configured as `anthropic` or `google` uses those auth schemes.
 */
function authHeaders(profile: ProviderProfile): Record<string, string> {
  const custom = profile.headers || {}
  if (profile.protocol === 'anthropic') {
    return { ...DEFAULT_HEADERS, 'User-Agent': DEFAULT_USER_AGENT, 'x-api-key': profile.apiKey, 'anthropic-version': '2023-06-01', ...custom }
  }
  if (profile.protocol === 'google') {
    return { ...DEFAULT_HEADERS, 'User-Agent': DEFAULT_USER_AGENT, 'x-goog-api-key': profile.apiKey, ...custom }
  }
  return { ...DEFAULT_HEADERS, 'User-Agent': DEFAULT_USER_AGENT, ...(profile.apiKey ? { Authorization: `Bearer ${profile.apiKey}` } : {}), ...custom }
}

async function* sseEvents(response: Response): AsyncGenerator<{ event: string; data: any }> {
  if (!response.body) return
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let eventName = ''
  let dataLines: string[] = []
  const flush = async function* (): AsyncGenerator<{ event: string; data: any }> {
    if (dataLines.length === 0) return
    const raw = dataLines.join('\n').trim()
    dataLines = []
    const event = eventName
    eventName = ''
    if (!raw || raw === '[DONE]') return
    try { yield { event, data: JSON.parse(raw) } } catch { /* ignore malformed provider fragments */ }
  }
  while (true) {
    // 流中途断开（ND_ERR_SOCKET / ECONNRESET）同样只抛 `terminated` 这类裸错误。
    // 这里补一次翻译，让"回答写到一半网络断了"也能读出来是什么原因。
    let chunk: { value?: Uint8Array; done: boolean }
    try {
      chunk = await reader.read()
    } catch (error) {
      throw enrichNetworkError(error)
    }
    const { value, done } = chunk
    buffer += decoder.decode(value, { stream: !done })
    const lines = buffer.split(/\r?\n/)
    buffer = lines.pop() || ''
    for (const line of lines) {
      if (line === '') {
        for await (const item of flush()) yield item
      } else if (line.startsWith('event:')) {
        eventName = line.slice(6).trim()
      } else if (line.startsWith('data:')) {
        dataLines.push(line.slice(5).trim())
      }
    }
    if (done) break
  }
  if (buffer.startsWith('data:')) dataLines.push(buffer.slice(5).trim())
  for await (const item of flush()) yield item
}

function emptyResult(): ProviderStreamResult {
  return { content: '', reasoning: '', toolCalls: [], usage: undefined }
}

function usageFromOpenAI(usage: any) {
  if (!usage) return undefined
  return {
    promptTokens: Number(usage.prompt_tokens ?? usage.input_tokens) || 0,
    completionTokens: Number(usage.completion_tokens ?? usage.output_tokens) || 0,
    reasoningTokens: Number(usage.completion_tokens_details?.reasoning_tokens ?? usage.output_tokens_details?.reasoning_tokens) || 0,
    totalTokens: Number(usage.total_tokens) || 0,
    promptCacheHitTokens: Number(usage.prompt_tokens_details?.cached_tokens ?? usage.input_tokens_details?.cached_tokens) || 0,
  }
}

function toolDefinitions(input: ProviderStreamInput) {
  return input.tools.map((tool) => ({
    type: 'function' as const,
    function: {
      name: tool.function.name,
      description: tool.function.description,
      parameters: tool.function.parameters,
    },
  }))
}

function openAIInput(messages: Array<Record<string, unknown>>): { instructions: string; input: Array<Record<string, unknown>> } {
  const system = messages.filter((message) => message.role === 'system').map((message) => String(message.content || '')).filter(Boolean).join('\n\n')
  const input: Array<Record<string, unknown>> = []
  for (const message of messages) {
    const role = String(message.role || '')
    if (role === 'system') continue
    if (role === 'tool') {
      const images = imageParts(message.images)
      // Responses 的函数输出接受内容块数组：`input_text` + `input_image`。
      const output = images.length > 0
        ? [
            { type: 'input_text', text: String(message.content || '') },
            ...images.map((image) => ({ type: 'input_image', image_url: imageDataUrl(image) })),
          ]
        : String(message.content || '')
      input.push({ type: 'function_call_output', call_id: String(message.tool_call_id || ''), output })
      continue
    }
    if (role === 'assistant' && Array.isArray(message.tool_calls)) {
      if (message.content) input.push({ role: 'assistant', content: String(message.content) })
      for (const call of message.tool_calls as Array<Record<string, any>>) {
        input.push({
          type: 'function_call',
          call_id: String(call.id || randomUUID()),
          name: String(call.function?.name || ''),
          arguments: String(call.function?.arguments || '{}'),
        })
      }
      continue
    }
    input.push({ role: role === 'assistant' ? 'assistant' : 'user', content: String(message.content || '') })
  }
  return { instructions: system, input }
}

const openAIResponsesAdapter: ProviderAdapter = {
  async stream(input) {
    const { instructions, input: requestInput } = openAIInput(input.messages)
    const body: Record<string, unknown> = {
      model: input.profile.model,
      input: requestInput,
      stream: true,
      tools: input.tools.map((tool) => ({ type: 'function', name: tool.function.name, description: tool.function.description, parameters: tool.function.parameters })),
    }
    if (input.maxOutputTokens !== undefined) body.max_output_tokens = input.maxOutputTokens
    if (instructions) body.instructions = instructions
    const response = await providerFetch(endpoint(input.profile.baseUrl, '/responses'), {
      method: 'POST', headers: authHeaders(input.profile), body: JSON.stringify(body), signal: input.signal,
    })
    if (!response.ok) return readError(response)
    const result = emptyResult()
    const calls = new Map<string, { id: string; name: string; args: string }>()
    for await (const item of sseEvents(response)) {
      const data = item.data as Record<string, any>
      if (item.event === 'response.output_text.delta' || data.type === 'response.output_text.delta') {
        const text = String(data.delta || '')
        result.content += text
        input.onText(text)
      } else if (item.event === 'response.reasoning_summary_text.delta' || data.type === 'response.reasoning_summary_text.delta') {
        const text = String(data.delta || '')
        result.reasoning += text
        input.onReasoning(text)
      } else if (item.event === 'response.output_item.added' || data.type === 'response.output_item.added') {
        const output = data.item
        if (output?.type === 'function_call') calls.set(String(output.call_id || output.id || randomUUID()), { id: String(output.call_id || output.id || randomUUID()), name: String(output.name || ''), args: String(output.arguments || '') })
      } else if (item.event === 'response.function_call_arguments.delta' || data.type === 'response.function_call_arguments.delta') {
        const id = String(data.call_id || data.item_id || '')
        const call = calls.get(id)
        if (call) call.args += String(data.delta || '')
      } else if (item.event === 'response.completed' || data.type === 'response.completed') {
        result.usage = usageFromOpenAI(data.response?.usage || data.usage)
        result.finishReason = String(data.response?.status || 'completed')
      }
    }
    result.toolCalls = Array.from(calls.values()).filter((call) => call.name).map((call) => ({ id: call.id, name: call.name, args: parseArgs(call.args) }))
    return result
  },
  async listModels(profile, signal) { return listModelsFromEnvelope(await fetchModelEnvelope(profile, signal)) },
  listModelsWithEnvelope(profile, signal) { return fetchModelEnvelope(profile, signal) },
}

function parseArgs(value: string): Record<string, unknown> {
  try { return JSON.parse(value || '{}') as Record<string, unknown> } catch { return { _raw: value } }
}

/** Exported for the prefix-stability test: the wire body must be byte-identical across calls. */
export function openAIChatBody(input: ProviderStreamInput): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: input.profile.model,
    messages: openAIChatMessages(input.messages),
    stream: true,
  }
  if (input.maxOutputTokens !== undefined) body.max_tokens = input.maxOutputTokens
  if (input.tools.length > 0) {
    body.tools = toolDefinitions(input)
    body.tool_choice = 'auto'
  }
  if (input.profile.providerId === 'deepseek' || /deepseek/i.test(input.profile.model)) {
    body.stream_options = { include_usage: true }
    body.reasoning_effort = input.reasoningEffort
  }
  return body
}

const openAICompatibleAdapter: ProviderAdapter = {
  async stream(input) {
    const body = openAIChatBody(input)
    const response = await providerFetch(endpoint(input.profile.baseUrl, '/chat/completions'), {
      method: 'POST', headers: authHeaders(input.profile), body: JSON.stringify(body), signal: input.signal,
    })
    if (!response.ok) return readError(response)
    const result = emptyResult()
    const calls = new Map<number, { id: string; name: string; args: string }>()
    for await (const item of sseEvents(response)) {
      const chunk = item.data as any
      result.usage = usageFromOpenAI(chunk?.usage) || result.usage
      const choice = chunk?.choices?.[0]
      if (!choice) continue
      result.finishReason = choice.finish_reason || result.finishReason
      const delta = choice.delta || {}
      const text = typeof delta.content === 'string' ? delta.content : ''
      if (text) { result.content += text; input.onText(text) }
      const reasoning = typeof delta.reasoning_content === 'string' ? delta.reasoning_content : ''
      if (reasoning) { result.reasoning += reasoning; input.onReasoning(reasoning) }
      for (const toolCall of Array.isArray(delta.tool_calls) ? delta.tool_calls : []) {
        const index = Number(toolCall.index ?? 0)
        const current = calls.get(index) || { id: String(toolCall.id || randomUUID()), name: '', args: '' }
        if (toolCall.id) current.id = String(toolCall.id)
        if (toolCall.function?.name) current.name += String(toolCall.function.name)
        if (typeof toolCall.function?.arguments === 'string') current.args += toolCall.function.arguments
        calls.set(index, current)
      }
    }
    result.toolCalls = Array.from(calls.values()).filter((call) => call.name).map((call) => ({ id: call.id, name: call.name, args: parseArgs(call.args) }))
    return result
  },
  async listModels(profile, signal) { return listModelsFromEnvelope(await fetchModelEnvelope(profile, signal)) },
  listModelsWithEnvelope(profile, signal) { return fetchModelEnvelope(profile, signal) },
}

/**
 * `GET {base}/models` for the OpenAI-shaped providers.
 *
 * Every OpenAI-shaped provider shares this, so discovery works for the
 * Responses protocol too (OpenAI serves the same list on `/models`). The
 * envelope normalization lives in `modelRegistry.extractModelIds`; the previous
 * inline version only understood `data[]` and `models[]` and therefore returned
 * `[]` for Together AI, Mistral, Cloudflare and Open WebUI.
 */
async function fetchModelEnvelope(profile: ProviderProfile, signal?: AbortSignal): Promise<unknown> {
  return requestJson(endpoint(profile.baseUrl, '/models'), { method: 'GET', headers: authHeaders(profile), signal })
}

function listModelsFromEnvelope(envelope: unknown): string[] {
  return extractModelIds(envelope)
}

/** Exported for the image-path test: Anthropic carries images inside `tool_result`. */
export function anthropicMessages(messages: Array<Record<string, unknown>>) {
  let system = ''
  const result: Array<Record<string, unknown>> = []
  for (const message of messages) {
    const role = String(message.role || '')
    if (role === 'system') { system += `${system ? '\n\n' : ''}${String(message.content || '')}`; continue }
    if (role === 'tool') {
      const images = imageParts(message.images)
      // Anthropic 的 tool_result 内容块直接接受 image block（内联 base64）。
      const content: unknown = images.length > 0
        ? [
            { type: 'text', text: String(message.content || '') },
            ...images.map((image) => ({
              type: 'image',
              source: { type: 'base64', media_type: image.mimeType, data: image.data },
            })),
          ]
        : String(message.content || '')
      result.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: String(message.tool_call_id || ''), content }] })
      continue
    }
    if (role === 'assistant' && Array.isArray(message.tool_calls)) {
      const content: Array<Record<string, unknown>> = []
      if (message.content) content.push({ type: 'text', text: String(message.content) })
      for (const call of message.tool_calls as Array<Record<string, any>>) {
        content.push({ type: 'tool_use', id: String(call.id || randomUUID()), name: String(call.function?.name || ''), input: parseArgs(String(call.function?.arguments || '{}')) })
      }
      result.push({ role: 'assistant', content })
      continue
    }
    result.push({ role: role === 'assistant' ? 'assistant' : 'user', content: String(message.content || '') })
  }
  return { system, messages: result }
}

const anthropicAdapter: ProviderAdapter = {
  async stream(input) {
    const converted = anthropicMessages(input.messages)
    const body: Record<string, unknown> = {
      model: input.profile.model,
      messages: converted.messages,
      stream: true,
    }
    // Anthropic currently requires max_tokens in Messages requests. This is
    // an adapter protocol requirement, not a user-facing Weport setting.
    body.max_tokens = input.maxOutputTokens ?? 32768
    if (converted.system) body.system = converted.system
    if (input.tools.length > 0) body.tools = input.tools.map((tool) => ({ name: tool.function.name, description: tool.function.description, input_schema: tool.function.parameters }))
    const response = await providerFetch(endpoint(input.profile.baseUrl, '/messages'), {
      method: 'POST', headers: authHeaders(input.profile), body: JSON.stringify(body), signal: input.signal,
    })
    if (!response.ok) return readError(response)
    const result = emptyResult()
    const calls = new Map<number, { id: string; name: string; args: string }>()
    for await (const item of sseEvents(response)) {
      const data = item.data as any
      if (data.type === 'message_start') result.usage = usageFromAnthropic(data.message?.usage)
      if (data.type === 'content_block_start' && data.content_block?.type === 'tool_use') {
        calls.set(Number(data.index), { id: String(data.content_block.id || randomUUID()), name: String(data.content_block.name || ''), args: '' })
      }
      if (data.type === 'content_block_delta') {
        if (data.delta?.type === 'text_delta') { const text = String(data.delta.text || ''); result.content += text; input.onText(text) }
        if (data.delta?.type === 'thinking_delta') { const text = String(data.delta.thinking || ''); result.reasoning += text; input.onReasoning(text) }
        if (data.delta?.type === 'input_json_delta') { const call = calls.get(Number(data.index)); if (call) call.args += String(data.delta.partial_json || '') }
      }
      if (data.type === 'message_delta') {
        result.finishReason = String(data.delta?.stop_reason || '')
        if (data.usage) result.usage = { ...(result.usage || emptyUsage()), ...usageFromAnthropic(data.usage) }
      }
    }
    result.toolCalls = Array.from(calls.values()).filter((call) => call.name).map((call) => ({ id: call.id, name: call.name, args: parseArgs(call.args) }))
    return result
  },
  async listModels(profile, signal) {
    return listModelsFromEnvelope(await fetchModelEnvelope(profile, signal))
  },
  listModelsWithEnvelope(profile, signal) {
    // Anthropic answers `data[]`; the tolerant parser also covers gateways that
    // speak the Messages protocol but return a bare array or `models[]`.
    return fetchModelEnvelope(profile, signal)
  },
}

function emptyUsage() { return { promptTokens: 0, completionTokens: 0, reasoningTokens: 0, totalTokens: 0, promptCacheHitTokens: 0 } }

function usageFromAnthropic(usage: any) {
  if (!usage) return undefined
  const prompt = Number(usage.input_tokens) || 0
  const completion = Number(usage.output_tokens) || 0
  return { promptTokens: prompt, completionTokens: completion, reasoningTokens: 0, totalTokens: prompt + completion, promptCacheHitTokens: Number(usage.cache_read_input_tokens) || 0 }
}

/**
 * Exported for the image-path test.
 *
 * Gemini's `functionResponse` cannot carry images, so this pushes an extra
 * `user` content with `inlineData` right after the tool result.
 */
export function googleContents(messages: Array<Record<string, unknown>>) {
  let system = ''
  const contents: Array<Record<string, unknown>> = []
  for (const message of messages) {
    const role = String(message.role || '')
    if (role === 'system') { system += `${system ? '\n\n' : ''}${String(message.content || '')}`; continue }
    const parts: Array<Record<string, unknown>> = []
    if (role === 'tool') {
      parts.push({ functionResponse: { name: String(message.toolName || message.tool_call_id || 'tool'), response: { result: String(message.content || '') } } })
      contents.push({ role: 'user', parts })
      // Gemini 的 functionResponse 只能放文本，图片要作为**紧随其后的一个 user
      // content**递进去（`inlineData`）。这是它的协议差异，不是我们的形状问题。
      const images = imageParts(message.images)
      if (images.length > 0) {
        contents.push({ role: 'user', parts: images.map((image) => ({ inlineData: { mimeType: image.mimeType, data: image.data } })) })
      }
      continue
    }
    if (role === 'assistant' && Array.isArray(message.tool_calls)) {
      if (message.content) parts.push({ text: String(message.content) })
      for (const call of message.tool_calls as Array<Record<string, any>>) parts.push({ functionCall: { name: String(call.function?.name || ''), args: parseArgs(String(call.function?.arguments || '{}')) } })
      contents.push({ role: 'model', parts })
      continue
    }
    parts.push({ text: String(message.content || '') })
    contents.push({ role: role === 'assistant' ? 'model' : 'user', parts })
  }
  return { system, contents }
}

const googleAdapter: ProviderAdapter = {
  async stream(input) {
    const converted = googleContents(input.messages)
    const body: Record<string, unknown> = { contents: converted.contents }
    if (converted.system) body.systemInstruction = { parts: [{ text: converted.system }] }
    if (input.maxOutputTokens !== undefined) body.generationConfig = { maxOutputTokens: input.maxOutputTokens }
    if (input.tools.length > 0) body.tools = [{ functionDeclarations: input.tools.map((tool) => ({ name: tool.function.name, description: tool.function.description, parameters: tool.function.parameters })) }]
    const url = endpoint(input.profile.baseUrl, `/models/${encodeURIComponent(input.profile.model)}:streamGenerateContent?alt=sse`)
    const response = await providerFetch(url, { method: 'POST', headers: authHeaders(input.profile), body: JSON.stringify(body), signal: input.signal })
    if (!response.ok) return readError(response)
    const result = emptyResult()
    for await (const item of sseEvents(response)) {
      const payload = item.data as any
      const parts = payload?.candidates?.[0]?.content?.parts || []
      for (const part of parts) {
        if (part.thought === true && typeof part.text === 'string') { result.reasoning += part.text; input.onReasoning(part.text) }
        else if (typeof part.text === 'string') { result.content += part.text; input.onText(part.text) }
        if (part.functionCall) result.toolCalls.push({ id: `call_${randomUUID()}`, name: String(part.functionCall.name || ''), args: (part.functionCall.args || {}) as Record<string, unknown> })
      }
      const usage = payload?.usageMetadata
      if (usage) result.usage = { promptTokens: Number(usage.promptTokenCount) || 0, completionTokens: Number(usage.candidatesTokenCount) || 0, reasoningTokens: Number(usage.thoughtsTokenCount) || 0, totalTokens: Number(usage.totalTokenCount) || 0, promptCacheHitTokens: Number(usage.cachedContentTokenCount) || 0 }
      result.finishReason = String(payload?.candidates?.[0]?.finishReason || result.finishReason || '')
    }
    return result
  },
  async listModels(profile, signal) {
    return listModelsFromEnvelope(await fetchModelEnvelope(profile, signal))
  },
  listModelsWithEnvelope(profile, signal) {
    return fetchModelEnvelope(profile, signal)
  },
}

/**
 * Adapter for a wire protocol. `gemini-compatible` is the OpenAI-compatible
 * Gemini entry point (Google's `/v1beta/openai`), so it shares the chat adapter.
 */
export function selectAdapter(protocol: ProviderProtocol): ProviderAdapter {
  if (protocol === 'openai') return openAIResponsesAdapter
  if (protocol === 'anthropic') return anthropicAdapter
  if (protocol === 'google') return googleAdapter
  return openAICompatibleAdapter
}

/**
 * Pick the adapter from `profile.modelProtocol` when the provider layer resolved
 * one, falling back to the profile's own `protocol`.
 *
 * Multi-protocol gateways route by model, not by profile: a single OpenCode Go
 * profile serves `deepseek-v4-flash` on `/chat/completions` and `grok-4.6` on
 * `/responses`, and sending the latter to `/chat/completions` answers
 * "Model grok-4.6 is not supported for format oa-compat".
 */
export function getProviderAdapter(profile: ProviderProfile): ProviderAdapter {
  return selectAdapter(profile.modelProtocol || profile.protocol)
}

export function makeDefaultProfile(input: { providerId: string; protocol?: ProviderProfile['protocol']; name?: string; baseUrl?: string; model?: string; apiKey?: string }): ProviderProfile {
  const catalog = getProviderCatalogEntry(input.providerId)
  const protocol = input.protocol || catalog?.protocol || 'openai-compatible'
  return {
    id: `profile-${randomUUID()}`,
    name: input.name || catalog?.name || 'AI 服务',
    providerId: input.providerId || 'custom',
    protocol,
    baseUrl: normalizeBaseUrl(input.baseUrl || catalog?.baseUrl || ''),
    model: input.model || catalog?.defaultModel || '',
    apiKey: input.apiKey || '',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
}
