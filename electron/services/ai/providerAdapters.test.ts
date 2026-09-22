import { describe, expect, it } from 'vitest'
import { anthropicMessages, getProviderAdapter, googleContents, openAIChatBody, openAIChatMessages, selectAdapter, usageFromAnthropic, usageFromOpenAI } from './providerAdapters'
import type { ProviderProfile, ProviderStreamInput } from './providerTypes'

function profile(patch: Partial<ProviderProfile> = {}): ProviderProfile {
  return {
    id: 'profile-1',
    name: 'OpenCode Go',
    providerId: 'opencode-go',
    protocol: 'openai-compatible',
    baseUrl: 'https://opencode.ai/zen/go/v1',
    model: 'deepseek-v4-flash',
    apiKey: 'sk-test',
    createdAt: 0,
    updatedAt: 0,
    ...patch,
  }
}

function streamInput(patch: Partial<ProviderStreamInput> = {}): ProviderStreamInput {
  return {
    profile: profile(),
    messages: [
      { role: 'system', content: 'You are WeportAI.' },
      { role: 'user', content: '总结一下我和家人的聊天' },
    ],
    tools: [
      {
        type: 'function',
        function: { name: 'list_sessions', description: 'List sessions', parameters: { type: 'object', properties: {} } },
      },
    ],
    reasoningEffort: 'high',
    signal: new AbortController().signal,
    onReasoning: () => undefined,
    onText: () => undefined,
    ...patch,
  }
}

/**
 * Prefix caching requires the request prefix to be byte-identical between
 * consecutive calls, so any per-request value inside the wire body destroys the
 * cache. `SYSTEM_PROMPT` is frozen by `requestShape`; this pins the body.
 */
describe('wire body has no per-request volatility', () => {
  const VOLATILE_TOP_LEVEL_KEYS = ['time', 'timestamp', 'seq', 'sequence', 'id', 'uuid', 'request_id', 'requestId', 'session_id', 'sessionId']

  it('omits time/sequence/identity fields at the top level', () => {
    const body = openAIChatBody(streamInput())
    for (const key of VOLATILE_TOP_LEVEL_KEYS) {
      expect(Object.prototype.hasOwnProperty.call(body, key), `unexpected top-level key "${key}"`).toBe(false)
    }
  })

  it('produces a byte-identical body for the same input', () => {
    const first = JSON.stringify(openAIChatBody(streamInput()))
    const second = JSON.stringify(openAIChatBody(streamInput()))
    expect(second).toBe(first)
    expect(first).not.toMatch(/\d{4}-\d{2}-\d{2}T/) // no ISO timestamp smuggled into the body
  })

  it('emits exactly the expected keys', () => {
    const body = openAIChatBody(streamInput({ maxOutputTokens: 64000 }))
    expect(Object.keys(body).sort()).toEqual(['max_tokens', 'messages', 'model', 'reasoning_effort', 'stream', 'stream_options', 'tool_choice', 'tools'].sort())
  })

  it('omits `max_tokens` entirely when no output cap was resolved', () => {
    // Sending a guessed cap would be worse than letting the provider decide.
    expect(Object.prototype.hasOwnProperty.call(openAIChatBody(streamInput()), 'max_tokens')).toBe(false)
  })

  it('passes maxOutputTokens through instead of silently dropping it', () => {
    // `ProviderStreamInput.maxOutputTokens` used to be declared but never sent, so
    // Anthropic fell back to a hard-coded 32768 on the main call path.
    expect(openAIChatBody(streamInput({ maxOutputTokens: 64000 })).max_tokens).toBe(64000)
  })

  it('stream_options.include_usage 现在无条件下发（非 deepseek 也一样）', () => {
    // 旧实现只在 deepseek 上带它 —— 严格遵循 OpenAI 语义的 chat-completions
    // 网关**没有 include_usage 就完全不回 usage**：TPS 徽标和命中率读数双双归零。
    const body = openAIChatBody(streamInput({ profile: profile({ providerId: 'custom', model: 'some-model' }) }))
    expect(body.stream_options).toEqual({ include_usage: true })
  })

  it('reasoning_effort 仍然只发给 deepseek 系（协议差异，不是缓存问题）', () => {
    const foreign = openAIChatBody(streamInput({ profile: profile({ providerId: 'custom', model: 'some-model' }) }))
    expect(Object.prototype.hasOwnProperty.call(foreign, 'reasoning_effort')).toBe(false)
    expect(Object.prototype.hasOwnProperty.call(openAIChatBody(streamInput()), 'reasoning_effort')).toBe(true)
  })
})

/**
 * 命中率读数的字段链：不同上游报不同的字段（DeepSeek `prompt_cache_hit_tokens`、
 * OpenAI `prompt_tokens_details.cached_tokens`、Anthropic 中继 `cache_read_input_tokens`），
 * 漏读任何一种都会把真实的 98% 显示成 0%。
 */
describe('usage 归一化', () => {
  it('读 OpenAI 形状的 cached_tokens', () => {
    expect(usageFromOpenAI({ prompt_tokens: 1000, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 900 } })).toMatchObject({
      promptTokens: 1000,
      promptCacheHitTokens: 900,
    })
  })

  it('缺 cached_tokens 时回落到 DeepSeek 原生 prompt_cache_hit_tokens', () => {
    expect(usageFromOpenAI({ prompt_tokens: 12000, completion_tokens: 5, prompt_cache_hit_tokens: 11776 })).toMatchObject({
      promptTokens: 12000,
      promptCacheHitTokens: 11776,
    })
  })

  it('缺 usage 时返回 undefined（而不是全 0 假装读到了）', () => {
    expect(usageFromOpenAI(undefined)).toBeUndefined()
    expect(usageFromAnthropic(undefined)).toBeUndefined()
  })

  it('Anthropic usage 归一到「prompt 含缓存」的统一口径', () => {
    // Anthropic 的 input_tokens 与缓存桶是**不相交**的：input=100 + read=800 +
    // write=50 才是这次请求的全部输入。UI 只有一个公式 hit/prompt，不归一就会
    // 算出 800% 这种命中率。
    const usage = usageFromAnthropic({ input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 800, cache_creation_input_tokens: 50 })
    expect(usage).toMatchObject({ promptTokens: 950, promptCacheHitTokens: 800, completionTokens: 20, totalTokens: 970 })
  })

  it('Anthropic 没有缓存桶时就是裸 token 数', () => {
    expect(usageFromAnthropic({ input_tokens: 42, output_tokens: 7 })).toMatchObject({ promptTokens: 42, promptCacheHitTokens: 0 })
  })
})

/**
 * Multi-protocol gateways route by model, so the adapter must follow
 * `profile.modelProtocol` rather than the profile's own `protocol`.
 */
describe('per-model protocol selects the endpoint adapter', () => {
  it('routes a chat-completions model to the OpenAI-compatible adapter', () => {
    expect(getProviderAdapter(profile())).toBe(selectAdapter('openai-compatible'))
  })

  it('overrides the profile protocol when the model protocol disagrees', () => {
    const routed = profile({ protocol: 'openai-compatible', modelProtocol: 'openai' })
    expect(getProviderAdapter(routed)).toBe(selectAdapter('openai'))
    expect(getProviderAdapter(routed)).not.toBe(selectAdapter('openai-compatible'))
  })

  it('honours an anthropic model protocol on a bearer-token gateway', () => {
    const routed = profile({ modelProtocol: 'anthropic' })
    expect(getProviderAdapter(routed)).toBe(selectAdapter('anthropic'))
  })

  it('treats gemini-compatible as the OpenAI-compatible entry point', () => {
    expect(selectAdapter('gemini-compatible')).toBe(selectAdapter('openai-compatible'))
    expect(selectAdapter('google')).not.toBe(selectAdapter('openai-compatible'))
  })
})

/**
 * 图片（v1.0.1）：`read_chat_images` 的结果必须变成**独立的内容块**，
 * 不能拼进文本。拼进去模型只会收到一坨 base64 字符，等于没给它看图。
 */
describe('工具结果里的图片 → 内容块', () => {
  const withImage = (): Array<Record<string, unknown>> => [
    { role: 'system', content: 'sys' },
    { role: 'assistant', content: '', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read_chat_images', arguments: '{}' } }] },
    {
      role: 'tool',
      tool_call_id: 'call_1',
      content: '「化学群」已附上 1 张图片',
      images: [{ mimeType: 'image/jpeg', data: 'AAAA' }],
    },
  ]

  it('图片走 tool 之后的一条 user 消息（tool 的 content 必须仍是字符串）', () => {
    const converted = openAIChatMessages(withImage())
    const toolMessage = converted.find((message) => message.role === 'tool')
    // 网关只接受字符串 content —— 这条是本轮修的那个 422
    expect(typeof toolMessage?.content).toBe('string')
    const imageMessage = converted[converted.length - 1]
    expect(imageMessage.role).toBe('user')
    expect((imageMessage.content as Array<Record<string, unknown>>)[1]).toEqual({
      type: 'image_url',
      image_url: { url: 'data:image/jpeg;base64,AAAA' },
    })
  })

  it('没有图片的消息**原样透传**（多一次改写就多一次前缀缓存失效）', () => {
    const messages = [{ role: 'tool', tool_call_id: 'call_9', content: '纯文本结果' }]
    expect(openAIChatMessages(messages)[0]).toBe(messages[0])
    expect(openAIChatMessages(messages).length).toBe(1)
  })

  it('形状坏掉的图片被丢掉，而不是把整个请求搞成 400', () => {
    const messages = [
      { role: 'tool', tool_call_id: 'call_1', content: 'x', images: [{ mimeType: '', data: '' }, { mimeType: 'image/png' }, null, 'nope'] },
    ]
    expect(openAIChatMessages(messages)[0]).toBe(messages[0])
    const partial = [{ role: 'tool', tool_call_id: 'call_1', content: 'x', images: [{ mimeType: 'image/png', data: 'BBBB' }, { data: 'CCCC' }] }]
    const converted = openAIChatMessages(partial)
    expect(converted.length).toBe(2)
    expect((converted[1].content as unknown[]).length).toBe(2)
  })

  it('非 tool 角色上的 images 字段被忽略（不会伪造出一条图片消息）', () => {
    const messages = [{ role: 'user', content: '你好', images: [{ mimeType: 'image/png', data: 'X' }] }]
    expect(openAIChatMessages(messages)[0]).toBe(messages[0])
  })

  it('openAIChatBody 也走同一条转换（否则图片静默丢失）', () => {
    const body = openAIChatBody(streamInput({ messages: withImage() }))
    const messages = body.messages as Array<Record<string, unknown>>
    const toolMessage = messages.find((message) => message.role === 'tool')
    expect(typeof toolMessage?.content).toBe('string')
    expect(messages[messages.length - 1].role).toBe('user')
    expect(JSON.stringify(messages)).toContain('image_url')
  })

  it('同一份输入两次转换结果逐字节一致（前缀缓存不能被打散）', () => {
    const first = JSON.stringify(openAIChatMessages(withImage()))
    const second = JSON.stringify(openAIChatMessages(withImage()))
    expect(second).toBe(first)
  })

  it('Anthropic：图片进 tool_result 的 content 里', () => {
    const converted = anthropicMessages(withImage())
    const toolTurn = converted.messages.find((message) => Array.isArray(message.content) && (message.content as Array<Record<string, unknown>>)[0]?.type === 'tool_result')
    const content = (toolTurn?.content as Array<Record<string, unknown>>)[0]?.content as Array<Record<string, unknown>>
    expect(content[0]).toMatchObject({ type: 'text' })
    expect(content[1]).toEqual({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'AAAA' } })
  })

  it('Anthropic：没有图片时 content 仍是字符串（保持原样）', () => {
    const converted = anthropicMessages([{ role: 'tool', tool_call_id: 'c1', content: '纯文本' }])
    const content = (converted.messages[0].content as Array<Record<string, unknown>>)[0]?.content
    expect(content).toBe('纯文本')
  })

  it('Gemini：functionResponse 之后补一条带 inlineData 的 user 消息', () => {
    const contents = googleContents(withImage()).contents
    const toolTurnIndex = contents.findIndex(
      (item) => Array.isArray((item as { parts?: unknown[] }).parts)
        && Boolean(((item as { parts: Array<Record<string, unknown>> }).parts[0] || {}).functionResponse)
    )
    expect(toolTurnIndex).toBeGreaterThanOrEqual(0)
    const parts = (contents[toolTurnIndex] as { parts: Array<Record<string, unknown>> }).parts
    expect(parts[0]).toHaveProperty('functionResponse')
    const imageTurn = contents[toolTurnIndex + 1] as { role: string; parts: Array<Record<string, unknown>> }
    expect(imageTurn.role).toBe('user')
    expect(imageTurn.parts[0]).toEqual({ inlineData: { mimeType: 'image/jpeg', data: 'AAAA' } })
  })

  it('Gemini：没有图片时不多造一条内容（协议里多一条都是噪声）', () => {
    const contents = googleContents([{ role: 'tool', tool_call_id: 'c1', toolName: 'read_note', content: '纯文本' }]).contents
    expect(contents).toHaveLength(1)
  })
})
