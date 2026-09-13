/**
 * Electron-side wiring for `modelRegistry`.
 *
 * `modelRegistry.ts` is intentionally dependency-free so it can be unit tested
 * under plain Node; this module is the only place that knows about `electron`,
 * the real filesystem and the bundled snapshot. The split means the
 * cache/protocol/merge logic has tests instead of being "verified by running the
 * app", which was the pre-existing state of this layer.
 */
import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import bundledSnapshot from '../../assets/models/models-dev-snapshot.json'
import { ModelRegistry } from './modelRegistry'
import type { ModelRegistryPayload, ModelRegistryStorage, RegistryFetch, ResolvedModel } from './modelRegistry'
import type { ProviderProfile, ProviderProtocol } from './providerTypes'

const nodeStorage: ModelRegistryStorage = {
  readFile(path) {
    try {
      return existsSync(path) ? readFileSync(path, 'utf8') : null
    } catch {
      return null
    }
  },
  writeFile(path, data) {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, data, 'utf8')
  },
  writeFileAtomic(path, data) {
    // A half-written cache is worse than no cache: the next cold start would read
    // truncated JSON and silently lose every piece of metadata. Write a sibling
    // temp file and rename it into place.
    mkdirSync(dirname(path), { recursive: true })
    const temp = `${path}.${process.pid}.tmp`
    writeFileSync(temp, data, 'utf8')
    try {
      renameSync(temp, path)
    } catch {
      // Windows refuses to rename onto an existing file; replace it explicitly.
      try {
        rmSync(path, { force: true })
        renameSync(temp, path)
      } catch {
        writeFileSync(path, data, 'utf8')
        rmSync(temp, { force: true })
      }
    }
  },
}

let instance: ModelRegistry | null = null

/** Lazily-built singleton; `app.getPath('userData')` is only valid after `ready`. */
export function getModelRegistry(): ModelRegistry {
  if (instance) return instance
  const userData = app.getPath('userData')
  instance = new ModelRegistry({
    cachePath: join(userData, 'models-cache.json'),
    metaPath: join(userData, 'models-cache.meta.json'),
    storage: nodeStorage,
    fetch: globalThis.fetch as unknown as RegistryFetch,
    bundledSnapshot: bundledSnapshot as unknown as ModelRegistryPayload,
    userAgent: `Weport/${app.getVersion()}`,
    onWarn: (message) => console.warn(`[modelRegistry] ${message}`),
  })
  return instance
}

/** Test/DI seam; also lets QA modes force an offline registry. */
export function setModelRegistry(registry: ModelRegistry | null): void {
  instance = registry
}

/** Fire-and-forget background refresh. Never awaited on a request path. */
export function refreshModelRegistry(force = false): void {
  void getModelRegistry()
    .refresh({ force })
    .catch(() => undefined)
}

/**
 * Persist the metadata the provider layer resolved for a profile's active model.
 *
 * This is what makes the context window per-model: `weportAiService` reads
 * `profile.modelContextWindow` (falling back to the global
 * `weportAiContextWindow`, default 1,000,000), so without this field a 128k
 * model reports against a 1M window and compaction never fires.
 *
 * `protocol` is a `WireProtocol` (the registry's vocabulary), which is a subset
 * of the app's `ProviderProtocol`; it is assigned without a cast because
 * `openai-compatible` | `openai` | `anthropic` | `google` all satisfy it.
 */
export interface ResolvedProfileCache {
  modelContextWindow?: number
  modelMaxOutputTokens?: number
  modelProtocol?: ProviderProtocol
  modelCost?: ProviderProfile['modelCost']
  modelCapabilities?: ProviderProfile['modelCapabilities']
  modelReasoningOptions?: ProviderProfile['modelReasoningOptions']
  modelMetadataSource?: string
  modelMetadataUpdatedAt?: number
}

export function resolvedProfileCache(resolved: ResolvedModel): ResolvedProfileCache {
  return {
    modelContextWindow: resolved.record.limits.context,
    modelMaxOutputTokens: resolved.record.limits.output,
    modelProtocol: resolved.protocol,
    modelCost: resolved.record.cost,
    modelCapabilities: resolved.record.capabilities,
    modelReasoningOptions: resolved.record.reasoningOptions,
    modelMetadataSource: resolved.record.provenance,
    modelMetadataUpdatedAt: Date.now(),
  }
}
