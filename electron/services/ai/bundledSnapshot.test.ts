import { describe, expect, it } from 'vitest'
import bundledSnapshot from '../../assets/models/models-dev-snapshot.json'
import { ModelRegistry, isChatCapable, resolveModelMetadata } from './modelRegistry'
import type { ModelRegistryPayload, ModelRegistryStorage } from './modelRegistry'

/**
 * Pins the SHIPPED artifact, not a hand-written fixture.
 *
 * `models-dev-snapshot.json` is the offline floor for the provider layer: with no
 * network and no cache, it is the only thing that can tell Weport that
 * `minimax-m3` on OpenCode Go speaks the Anthropic wire format. A silently empty
 * or truncated snapshot would leave every profile on the profile-level protocol
 * with no context window, and nothing else in the test suite would notice —
 * hence this file reads the real bundled JSON.
 */
const emptyStorage: ModelRegistryStorage = {
  readFile: () => null,
  writeFile: () => undefined,
  writeFileAtomic: () => undefined,
}

function offlineRegistry() {
  return new ModelRegistry({
    cachePath: '/none/models-cache.json',
    metaPath: '/none/models-cache.meta.json',
    storage: emptyStorage,
    allowNetwork: false,
    bundledSnapshot: bundledSnapshot as unknown as ModelRegistryPayload,
  })
}

describe('bundled models.dev snapshot (offline first launch)', () => {
  const registry = offlineRegistry()

  it('carries the gateway and first-party providers the catalog addresses', () => {
    for (const providerId of ['opencode', 'opencode-go', 'deepseek', 'anthropic', 'openai', 'google']) {
      expect(registry.getProviderEntry(providerId), `missing provider ${providerId}`).toBeDefined()
      expect(Object.keys(registry.getProviderEntry(providerId)?.models || {}).length).toBeGreaterThan(0)
    }
  })

  it('routes a multi-protocol gateway model per model', () => {
    const go = resolveModelMetadata({
      registry,
      registryProviderId: 'opencode-go',
      profile: { id: 'p', protocol: 'openai-compatible' },
      modelId: 'minimax-m3',
    })
    // The Go gateway's provider-level npm is @ai-sdk/anthropic.
    expect(go.protocol).toBe('anthropic')

    const grok = resolveModelMetadata({
      registry,
      registryProviderId: 'opencode-go',
      profile: { id: 'p', protocol: 'openai-compatible' },
      modelId: 'grok-4.6',
    })
    // grok-4.6 carries its own model-level provider.npm override on this gateway.
    expect(grok.protocol).toBe('openai')
  })

  it('gives DeepSeek V4 Pro its real context window and real published prices', () => {
    const resolved = resolveModelMetadata({
      registry,
      registryProviderId: 'deepseek',
      profile: { id: 'p', protocol: 'openai-compatible' },
      modelId: 'deepseek-v4-pro',
    })
    expect(resolved.record.limits.context).toBeGreaterThan(0)
    // These are the values that the deleted renderer-side table got wrong by
    // 3–6× (it hard-coded 0.14 / 0.28 for every provider).
    expect(resolved.record.cost?.input).toBeCloseTo(0.435, 6)
    expect(resolved.record.cost?.output).toBeCloseTo(0.87, 6)
  })

  it('never exposes a 0 context window or an invented price', () => {
    for (const entry of Object.values(registry.current.providers)) {
      for (const record of Object.values(entry.models)) {
        if (record.limits.context !== undefined) expect(record.limits.context).toBeGreaterThan(0)
        if (record.limits.output !== undefined) expect(record.limits.output).toBeGreaterThan(0)
        if (record.cost) expect(Object.keys(record.cost).length).toBeGreaterThan(0)
      }
    }
  })

  it('keeps non-chat models out of the picker while keeping chat models in', () => {
    const openai = registry.getProviderEntry('openai')
    expect(openai).toBeDefined()
    const chatIds = Object.values(openai!.models).filter(isChatCapable).map((record) => record.id)
    expect(chatIds.length).toBeGreaterThan(0)
    // Embeddings/tts/whisper/dall-e must not survive the picker filter.
    expect(chatIds.some((id) => /embedding|whisper|tts|dall-e/i.test(id))).toBe(false)
  })
})
