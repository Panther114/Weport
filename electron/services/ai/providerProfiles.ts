import { randomUUID } from 'crypto'
import { ConfigService } from '../config'
import { getProviderCatalogEntry, isProviderProtocol, normalizeProviderId } from './providerCatalog'
import { makeDefaultProfile } from './providerAdapters'
import type { ProviderProfile, ProviderProfileInput, ProviderProfileStore, ProviderProfileSummary } from './providerTypes'

const EMPTY_STORE: ProviderProfileStore = { version: 1, activeProfileId: '', profiles: [] }

function maskApiKey(value: string): string {
  const key = String(value || '').trim()
  if (!key) return ''
  if (key.length <= 8) return `${key.slice(0, 2)}•••`
  return `${key.slice(0, 4)}•••${key.slice(-4)}`
}

function cloneStore(store: ProviderProfileStore): ProviderProfileStore {
  return {
    version: 1,
    activeProfileId: store.activeProfileId,
    profiles: store.profiles.map((profile) => ({
      ...profile,
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
    if (existing) store.profiles = store.profiles.map((item) => item.id === existing.id ? profile : item)
    else store.profiles.push(profile)
    if (!store.activeProfileId) store.activeProfileId = profile.id
    this.write(store)
    return summary(profile)
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
