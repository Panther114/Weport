import { ConfigService } from '../config'
import type { Connector, ConnectorConnectionState, ConnectorDescriptor, ConnectorResult, ConnectorTarget, ConnectorTaskInput, ConnectorTaskResult } from './types'
import { todoistConnector } from './todoistConnector'

/**
 * Connector registry + credential store.
 *
 * Credentials live in a single safeStorage-encrypted config value
 * (`weportConnectorsBlob`), matching how provider profiles are stored: one
 * envelope means one place to audit, and ConfigService decrypts on read so no
 * other module has to know about the encryption.
 *
 * The token is only ever handed back to the connector that owns it — callers
 * outside this module see a masked hint (`····9f2c`) so a token cannot leak into
 * a log, a note, or an agent transcript by accident.
 */

const CONFIG_KEY = 'weportConnectorsBlob'
const ALLOW_AGENT_KEY = 'connectorsAllowAgent'

export interface ConnectorView extends ConnectorConnectionState {
  descriptor: ConnectorDescriptor
}

export interface ConnectorStoredState {
  token: string
  connectedAt: number
  lastCheck?: { at: number; ok: boolean; error?: string; accountName?: string }
}

interface Blob {
  version: 1
  connectors: Record<string, ConnectorStoredState>
}

const CONNECTORS: Connector[] = [todoistConnector]

function emptyBlob(): Blob {
  return { version: 1, connectors: {} }
}

/** `abcdef1234` → `····1234`: enough to tell two tokens apart, not enough to use. */
export function maskCredential(token: string): string {
  const value = String(token || '').trim()
  if (!value) return ''
  return `····${value.slice(-4)}`
}

export class ConnectorsService {
  private configService: ConfigService

  constructor(configService = ConfigService.getInstance()) {
    this.configService = configService
  }

  private read(): Blob {
    const raw = String(this.configService.get(CONFIG_KEY) || '').trim()
    if (!raw) return emptyBlob()
    try {
      const parsed = JSON.parse(raw) as Blob
      if (!parsed || typeof parsed !== 'object' || typeof parsed.connectors !== 'object' || !parsed.connectors) return emptyBlob()
      return { version: 1, connectors: parsed.connectors }
    } catch {
      // A corrupt blob must not brick the settings page: treat it as "nothing
      // connected" and let the user reconnect (the old value is overwritten on
      // the next successful save).
      return emptyBlob()
    }
  }

  private write(blob: Blob): void {
    this.configService.set(CONFIG_KEY, JSON.stringify({ version: 1, connectors: blob.connectors }))
  }

  private find(id: string): Connector | null {
    const key = String(id || '').trim().toLowerCase()
    return CONNECTORS.find((connector) => connector.descriptor.id === key) || null
  }

  /** Credential for internal callers (agent tool, scheduler). Never render this. */
  tokenFor(id: string): string {
    return String(this.read().connectors[String(id || '').trim().toLowerCase()]?.token || '')
  }

  list(): ConnectorView[] {
    const blob = this.read()
    return CONNECTORS.map((connector) => {
      const stored = blob.connectors[connector.descriptor.id]
      return {
        id: connector.descriptor.id,
        descriptor: connector.descriptor,
        connected: Boolean(stored?.token),
        credentialHint: maskCredential(stored?.token || ''),
        connectedAt: stored?.connectedAt,
        lastCheck: stored?.lastCheck,
      }
    })
  }

  get(id: string): ConnectorView | null {
    return this.list().find((connector) => connector.id === String(id || '').trim().toLowerCase()) || null
  }

  /**
   * Save a credential and verify it in one step.
   *
   * Verification is deliberately part of the save: an unverified token sitting in
   * the store is the failure mode that produces "connected" badges on a broken
   * integration. A failed check stores nothing.
   */
  async connect(id: string, token: string): Promise<ConnectorResult<ConnectorView>> {
    const connector = this.find(id)
    if (!connector) return { success: false, error: `未知连接器：${id}` }
    const value = String(token || '').trim()
    if (!value) return { success: false, error: '请先填写 API 令牌' }

    const check = await connector.verify(value)
    if (!check.success) return { success: false, error: check.error || '连接失败', status: check.status }

    const blob = this.read()
    blob.connectors[connector.descriptor.id] = {
      token: value,
      connectedAt: Date.now(),
      lastCheck: { at: Date.now(), ok: true, accountName: check.data?.accountName },
    }
    this.write(blob)
    return { success: true, data: this.get(connector.descriptor.id) as ConnectorView }
  }

  disconnect(id: string): ConnectorResult<ConnectorView> {
    const connector = this.find(id)
    if (!connector) return { success: false, error: `未知连接器：${id}` }
    const blob = this.read()
    delete blob.connectors[connector.descriptor.id]
    this.write(blob)
    return { success: true, data: this.get(connector.descriptor.id) as ConnectorView }
  }

  /** Re-check a stored credential without replacing it. */
  async verify(id: string): Promise<ConnectorResult<ConnectorView>> {
    const connector = this.find(id)
    if (!connector) return { success: false, error: `未知连接器：${id}` }
    const blob = this.read()
    const stored = blob.connectors[connector.descriptor.id]
    if (!stored?.token) return { success: false, error: '尚未连接' }
    const check = await connector.verify(stored.token)
    const next: ConnectorStoredState = {
      ...stored,
      lastCheck: { at: Date.now(), ok: check.success, error: check.success ? undefined : check.error, accountName: check.data?.accountName },
    }
    blob.connectors[connector.descriptor.id] = next
    this.write(blob)
    return check.success
      ? { success: true, data: this.get(connector.descriptor.id) as ConnectorView }
      : { success: false, error: check.error, status: check.status }
  }

  async listTargets(id: string): Promise<ConnectorResult<ConnectorTarget[]>> {
    const connector = this.find(id)
    if (!connector) return { success: false, error: `未知连接器：${id}` }
    const token = this.tokenFor(connector.descriptor.id)
    if (!token) return { success: false, error: '尚未连接' }
    if (!connector.descriptor.capabilities.hasTargets) return { success: true, data: [] }
    return connector.listTargets(token)
  }

  async createTask(id: string, input: ConnectorTaskInput): Promise<ConnectorResult<ConnectorTaskResult>> {
    const connector = this.find(id)
    if (!connector) return { success: false, error: `未知连接器：${id}` }
    if (!connector.descriptor.capabilities.write) return { success: false, error: `${connector.descriptor.name} 不支持写入` }
    const token = this.tokenFor(connector.descriptor.id)
    if (!token) return { success: false, error: `${connector.descriptor.name} 尚未连接` }
    const result = await connector.createTask(token, input)
    if (!result.success && (result.status === 401 || result.status === 403)) {
      // A token that dies between sessions is the most likely remote failure;
      // record it so the settings panel stops showing a green "connected" badge.
      const blob = this.read()
      const stored = blob.connectors[connector.descriptor.id]
      if (stored) {
        blob.connectors[connector.descriptor.id] = { ...stored, lastCheck: { at: Date.now(), ok: false, error: result.error } }
        this.write(blob)
      }
    }
    return result
  }

  /** The agent may only write when the user has left this on (default: on). */
  agentWriteAllowed(): boolean {
    return this.configService.get(ALLOW_AGENT_KEY) !== false
  }

  setAgentWriteAllowed(allowed: boolean): void {
    this.configService.set(ALLOW_AGENT_KEY, Boolean(allowed))
  }

  /** Only connectors that are connected *and* expose the read side. */
  listConnectedIds(): string[] {
    const blob = this.read()
    return Object.entries(blob.connectors)
      .filter(([, state]) => Boolean(state?.token))
      .map(([id]) => id)
  }
}

export const connectorsService = new ConnectorsService()
