import { randomUUID } from 'crypto'
import { ConfigService } from '../config'
import { getProviderCatalogEntry, isProviderProtocol, normalizeProviderId } from './providerCatalog'
import { isWireProtocol } from './modelRegistry'
import { makeDefaultProfile } from './providerAdapters'
import type { ProviderConsumer, ProviderModelMetadata, ProviderProfile, ProviderProfileInput, ProviderProfileStore, ProviderProfileSummary } from './providerTypes'

const EMPTY_STORE: ProviderProfileStore = { version: 1, activeProfileId: '', profiles: [] }

function maskApiKey(value: string): string {
  const key = String(value || '').trim()
  if (!key) return ''
  if (key.length <= 8) return `${key.slice(0, 2)}•••`
  return `${key.slice(0, 4)}•••${key.slice(-4)}`
}

/** Positive finite token counts only; anything else is "unknown" and must not be stored as 0. */
function optionalTokenCount(value: unknown): number | undefined {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : undefined
}

/**
 * Normalize resolved model metadata for storage.
 *
 * `cost` and `capabilities` are copied wholesale: they describe the model, never
 * the credential, so they are safe to keep in the same blob as the API key (the
 * blob itself is safeStorage-encrypted — see `ENCRYPTED_STRING_KEYS`) and to
 * expose through `ProviderProfileSummary`.
 */
function normalizeModelMetadata(profile: ProviderProfile): Pick<
  ProviderProfile,
  'modelContextWindow' | 'modelMaxOutputTokens' | 'modelProtocol' | 'modelCost' | 'modelCapabilities' | 'modelReasoningOptions' | 'modelMetadataSource' | 'modelMetadataUpdatedAt'
> {
  return {
    modelContextWindow: optionalTokenCount(profile.modelContextWindow),
    modelMaxOutputTokens: optionalTokenCount(profile.modelMaxOutputTokens),
    modelProtocol: isWireProtocol(profile.modelProtocol) ? profile.modelProtocol : undefined,
    modelCost: profile.modelCost && typeof profile.modelCost === 'object' ? { ...profile.modelCost } : undefined,
    modelCapabilities: profile.modelCapabilities && typeof profile.modelCapabilities === 'object'
      ? { ...profile.modelCapabilities, modalities: { input: [...(profile.modelCapabilities.modalities?.input || [])], output: [...(profile.modelCapabilities.modalities?.output || [])] } }
      : undefined,
    modelReasoningOptions: Array.isArray(profile.modelReasoningOptions) ? profile.modelReasoningOptions.map((option) => ({ ...option })) : undefined,
    modelMetadataSource: profile.modelMetadataSource ? String(profile.modelMetadataSource).slice(0, 40) : undefined,
    modelMetadataUpdatedAt: Number(profile.modelMetadataUpdatedAt) || undefined,
  }
}

function cloneStore(store: ProviderProfileStore): ProviderProfileStore {
  return {
    version: 1,
    activeProfileId: store.activeProfileId,
    consumerProfiles: store.consumerProfiles ? { ...store.consumerProfiles } : undefined,
    profiles: store.profiles.map((profile) => ({
      ...profile,
      modelCost: profile.modelCost ? { ...profile.modelCost } : undefined,
      modelCapabilities: profile.modelCapabilities
        ? { ...profile.modelCapabilities, modalities: { input: [...profile.modelCapabilities.modalities.input], output: [...profile.modelCapabilities.modalities.output] } }
        : undefined,
      modelReasoningOptions: profile.modelReasoningOptions ? profile.modelReasoningOptions.map((option) => ({ ...option })) : undefined,
      headers: profile.headers ? { ...profile.headers } : undefined,
      discovery: profile.discovery ? { ...profile.discovery, models: [...profile.discovery.models] } : undefined,
    })),
  }
}

function summary(profile: ProviderProfile): ProviderProfileSummary {
  return {
    id: profile.id,
    name: profile.name,
    displayName: profile.name,
    providerId: profile.providerId,
    protocol: profile.protocol,
    baseUrl: profile.baseUrl,
    model: profile.model,
    hasApiKey: Boolean(profile.apiKey),
    apiKeyHint: maskApiKey(profile.apiKey),
    modelContextWindow: profile.modelContextWindow,
    modelMaxOutputTokens: profile.modelMaxOutputTokens,
    modelProtocol: profile.modelProtocol,
    modelCost: profile.modelCost ? { ...profile.modelCost } : undefined,
    modelCapabilities: profile.modelCapabilities
      ? { ...profile.modelCapabilities, modalities: { input: [...profile.modelCapabilities.modalities.input], output: [...profile.modelCapabilities.modalities.output] } }
      : undefined,
    modelReasoningOptions: profile.modelReasoningOptions ? profile.modelReasoningOptions.map((option) => ({ ...option })) : undefined,
    modelMetadataSource: profile.modelMetadataSource,
    modelMetadataUpdatedAt: profile.modelMetadataUpdatedAt,
    createdAt: profile.createdAt,
    updatedAt: profile.updatedAt,
    discovery: profile.discovery ? { ...profile.discovery, models: [...profile.discovery.models] } : undefined,
  }
}

export class ProviderProfileService {
  private readonly config: ConfigService

  constructor(config = ConfigService.getInstance()) {
    this.config = config
  }

  private read(): ProviderProfileStore {
    const raw = String(this.config.get('weportAiProfilesBlob') || '').trim()
    let store: ProviderProfileStore = cloneStore(EMPTY_STORE)
    let hasValidProfileStore = false
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as Partial<ProviderProfileStore>
        if (parsed && parsed.version === 1 && Array.isArray(parsed.profiles)) {
          hasValidProfileStore = true
          store = {
            version: 1,
            activeProfileId: String(parsed.activeProfileId || ''),
            consumerProfiles: parsed.consumerProfiles && typeof parsed.consumerProfiles === 'object'
              ? { ...parsed.consumerProfiles }
              : undefined,
            profiles: parsed.profiles.map((profile) => this.normalizeStoredProfile(profile as ProviderProfile)).filter(Boolean) as ProviderProfile[],
          }
        }
      } catch (error) {
        console.warn('[WeportAI] provider profile blob 无法解析，保留旧配置:', error)
      }
    }
    // An empty, valid profile blob is an intentional user state (for example
    // after deleting the last provider). Only migrate the legacy fields when
    // no provider-profile blob exists yet; otherwise every read would
    // resurrect the deleted legacy profile.
    if (store.profiles.length === 0 && !hasValidProfileStore) {
      const migrated = this.migrateLegacyProfile()
      if (migrated) {
        store = { version: 1, activeProfileId: migrated.id, profiles: [migrated] }
        this.write(store)
      }
    }
    if (store.activeProfileId && !store.profiles.some((profile) => profile.id === store.activeProfileId)) store.activeProfileId = store.profiles[0]?.id || ''
    if (!store.activeProfileId && store.profiles[0]) {
      store.activeProfileId = store.profiles[0].id
      this.write(store)
    }
    return store
  }

  private normalizeStoredProfile(profile: ProviderProfile): ProviderProfile | null {
    if (!profile || typeof profile !== 'object') return null
    const providerId = normalizeProviderId(String(profile.providerId || 'custom'))
    const catalog = getProviderCatalogEntry(providerId)
    if (!profile.id || !profile.name || !profile.model) return null
    return {
      id: String(profile.id),
      name: String(profile.name).slice(0, 80),
      providerId,
      protocol: isProviderProtocol(profile.protocol) ? profile.protocol : catalog?.protocol || 'openai-compatible',
      baseUrl: String(profile.baseUrl || catalog?.baseUrl || '').trim().replace(/\/+$/, ''),
      model: String(profile.model).trim().slice(0, 200),
      apiKey: String(profile.apiKey || ''),
      // Resolved model metadata survives a reload: re-deriving it needs network
      // access, and the cached values are what the context meter and the cost
      // panel read on the first paint after a restart.
      ...normalizeModelMetadata(profile),
      headers: profile.headers && typeof profile.headers === 'object' ? Object.fromEntries(Object.entries(profile.headers).map(([key, value]) => [String(key).slice(0, 80), String(value).slice(0, 500)])) : undefined,
      createdAt: Number(profile.createdAt) || Date.now(),
      updatedAt: Number(profile.updatedAt) || Date.now(),
      discovery: profile.discovery && Array.isArray(profile.discovery.models)
        ? { models: profile.discovery.models.map(String).slice(0, 500), fetchedAt: Number(profile.discovery.fetchedAt) || 0, error: profile.discovery.error ? String(profile.discovery.error).slice(0, 500) : undefined }
        : undefined,
    }
  }

  private migrateLegacyProfile(): ProviderProfile | null {
    const apiKey = String(this.config.get('weportAiApiKey') || '').trim()
    const baseUrl = String(this.config.get('weportAiBaseUrl') || '').trim()
    const model = String(this.config.get('weportAiModel') || '').trim()
    if (!apiKey && !baseUrl && !model) return null
    const providerId = /deepseek/i.test(baseUrl) || /^deepseek/i.test(model) ? 'deepseek' : 'custom'
    const profile = makeDefaultProfile({
      providerId,
      name: providerId === 'deepseek' ? 'DeepSeek（已迁移）' : '旧版 WeportAI 配置',
      baseUrl,
      model,
      apiKey,
    })
    return { ...profile, id: `profile-legacy-${randomUUID().slice(0, 8)}` }
  }

  private write(store: ProviderProfileStore): void {
    this.config.set('weportAiProfilesBlob', JSON.stringify(store))
  }

  list(): ProviderProfileSummary[] {
    return this.read().profiles.map(summary)
  }

  getActive(): ProviderProfile | null {
    const store = this.read()
    return store.profiles.find((profile) => profile.id === store.activeProfileId) || store.profiles[0] || null
  }

  /**
   * 某个功能面该用哪个服务。
   *
   * 没有单独指定时回落到默认服务 —— 因此绝大多数用户看到的仍然是"一个服务，
   * 三处都用"。指定过的那一面才走自己的，互不干扰。
   */
  getForConsumer(consumer: ProviderConsumer): ProviderProfile | null {
    const store = this.read()
    const assignedId = store.consumerProfiles?.[consumer]
    if (assignedId) {
      const assigned = store.profiles.find((profile) => profile.id === assignedId)
      if (assigned) return assigned
    }
    return store.profiles.find((profile) => profile.id === store.activeProfileId) || store.profiles[0] || null
  }

  /** 指定某个功能面使用哪个服务；`profileId` 为空表示恢复「跟随默认」。 */
  assign(consumer: ProviderConsumer, profileId: string): boolean {
    const store = this.read()
    const id = String(profileId || '').trim()
    if (id && !store.profiles.some((profile) => profile.id === id)) return false
    const next = { ...(store.consumerProfiles || {}) }
    if (id) next[consumer] = id
    else delete next[consumer]
    store.consumerProfiles = next
    this.write(store)
    return true
  }

  /** 三个功能面当前各自指向哪个服务（含"跟随默认"的解析结果）。 */
  consumerAssignments(): Array<{ consumer: ProviderConsumer; profileId: string; profileName: string; followsDefault: boolean; providerId: string; model: string }> {
    const store = this.read()
    const consumers: ProviderConsumer[] = ['chat', 'weclone', 'webot']
    return consumers.map((consumer) => {
      const assignedId = String(store.consumerProfiles?.[consumer] || '')
      const assigned = assignedId ? store.profiles.find((profile) => profile.id === assignedId) : undefined
      const resolved = assigned || store.profiles.find((profile) => profile.id === store.activeProfileId) || store.profiles[0] || null
      return {
        consumer,
        profileId: resolved?.id || '',
        profileName: resolved?.name || '',
        followsDefault: !assigned,
        providerId: resolved?.providerId || '',
        model: resolved?.model || '',
      }
    })
  }

  getById(id: string): ProviderProfile | null {
    return this.read().profiles.find((profile) => profile.id === id) || null
  }

  save(input: ProviderProfileInput): ProviderProfileSummary {
    const store = this.read()
    const existing = input.id ? store.profiles.find((profile) => profile.id === input.id) : undefined
    const catalog = getProviderCatalogEntry(input.providerId)
    const now = Date.now()
    const profile: ProviderProfile = {
      ...(existing || makeDefaultProfile({ providerId: input.providerId, protocol: input.protocol, name: input.name, baseUrl: input.baseUrl, model: input.model })),
      id: existing?.id || input.id || `profile-${randomUUID()}`,
      name: String(input.name || catalog?.name || 'AI 服务').trim().slice(0, 80),
      providerId: normalizeProviderId(input.providerId),
      protocol: input.protocol || catalog?.protocol || 'openai-compatible',
      baseUrl: String(input.baseUrl || catalog?.baseUrl || '').trim().replace(/\/+$/, ''),
      model: String(input.model || catalog?.defaultModel || '').trim().slice(0, 200),
      apiKey: typeof input.apiKey === 'string' && input.apiKey.trim() ? input.apiKey.trim() : existing?.apiKey || '',
      headers: input.headers && typeof input.headers === 'object' ? { ...input.headers } : existing?.headers,
      createdAt: existing?.createdAt || now,
      updatedAt: now,
    }
    if (!profile.name || !profile.model) throw new Error('服务名称与模型不能为空')
    if (!profile.baseUrl) throw new Error('服务地址不能为空')
    if (!profile.apiKey && !catalog?.apiKeyOptional) throw new Error('请先填写 API key')
    let parsed: URL
    try { parsed = new URL(profile.baseUrl) } catch { throw new Error('服务地址必须以 http:// 或 https:// 开头') }
    const host = parsed.hostname.toLowerCase()
    const local = host === 'localhost' || host === '127.0.0.1' || host === '::1' || host.endsWith('.localhost')
    if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && local)) throw new Error('服务地址必须使用 HTTPS（仅 localhost 可使用 HTTP）')
    // A different model invalidates the resolved metadata. Keeping the previous
    // model's context window would make the context meter (and the compaction
    // trigger) describe a model the profile no longer uses.
    const sameTarget = Boolean(existing) && existing!.model === profile.model && existing!.baseUrl === profile.baseUrl && existing!.providerId === profile.providerId
    if (sameTarget && existing) Object.assign(profile, normalizeModelMetadata(existing))
    if (existing) store.profiles = store.profiles.map((item) => item.id === existing.id ? profile : item)
    else store.profiles.push(profile)
    if (!store.activeProfileId) store.activeProfileId = profile.id
    this.write(store)
    return summary(profile)
  }

  /**
   * Persist metadata resolved for the profile's current model.
   *
   * Called after discovery/registry resolution. Only the fields in
   * `ProviderModelMetadata` are touched, so a concurrent settings save cannot be
   * clobbered by a stale in-memory copy of the profile.
   */
  setModelMetadata(id: string, metadata: Partial<ProviderModelMetadata>): boolean {
    const store = this.read()
    const profile = store.profiles.find((item) => item.id === id)
    if (!profile) return false
    profile.modelContextWindow = metadata.contextWindow
    profile.modelMaxOutputTokens = metadata.maxOutputTokens
    profile.modelProtocol = isWireProtocol(metadata.protocol) ? metadata.protocol : undefined
    profile.modelCost = metadata.cost
    profile.modelCapabilities = metadata.capabilities
    profile.modelReasoningOptions = metadata.reasoningOptions
    profile.modelMetadataSource = metadata.source
    profile.modelMetadataUpdatedAt = Date.now()
    profile.updatedAt = Date.now()
    this.write(store)
    return true
  }

  activate(id: string): boolean {
    const store = this.read()
    if (!store.profiles.some((profile) => profile.id === id)) return false
    store.activeProfileId = id
    this.write(store)
    return true
  }

  remove(id: string): boolean {
    const store = this.read()
    const next = store.profiles.filter((profile) => profile.id !== id)
    if (next.length === store.profiles.length) return false
    store.profiles = next
    if (store.activeProfileId === id) store.activeProfileId = next[0]?.id || ''
    // 指向已删除服务的功能面要一起清掉：留着悬空 id 会让它悄悄回落到默认服务，
    // 而设置页仍显示"已单独指定"。
    if (store.consumerProfiles) {
      const remaining: Partial<Record<ProviderConsumer, string>> = {}
      for (const [consumer, profileId] of Object.entries(store.consumerProfiles) as Array<[ProviderConsumer, string]>) {
        if (profileId && profileId !== id) remaining[consumer] = profileId
      }
      store.consumerProfiles = remaining
    }
    this.write(store)
    return true
  }

  recordDiscovery(id: string, models: string[], error?: string): void {
    const store = this.read()
    const profile = store.profiles.find((item) => item.id === id)
    if (!profile) return
    profile.discovery = { models: Array.from(new Set(models.map(String).filter(Boolean))).slice(0, 500), fetchedAt: Date.now(), error: error ? String(error).slice(0, 500) : undefined }
    profile.updatedAt = Date.now()
    this.write(store)
  }
}

export function profileSummary(profile: ProviderProfile): ProviderProfileSummary {
  return summary(profile)
}
