import { describe, expect, it } from 'vitest'
import { getProviderAdapter, openAIChatBody, selectAdapter } from './providerAdapters'
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
