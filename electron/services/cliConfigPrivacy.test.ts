import { beforeEach, describe, expect, it, vi } from 'vitest'

const { values, set } = vi.hoisted(() => ({ values: new Map<string, unknown>(), set: vi.fn() }))
vi.mock('electron', () => ({ app: { getVersion: () => '1.2.1' } }))
vi.mock('./chatService', () => ({ chatService: {} }))
vi.mock('./snsService', () => ({ snsService: {} }))
vi.mock('./analyticsService', () => ({ analyticsService: {} }))
vi.mock('./groupAnalyticsService', () => ({ groupAnalyticsService: {} }))
vi.mock('./connectors/connectorsService', () => ({ connectorsService: {} }))
vi.mock('./weportAiService', () => ({ weportAiService: {} }))
vi.mock('./weCloneService', () => ({ weCloneService: {} }))
vi.mock('./config', () => ({ ConfigService: { getInstance: () => ({ get: (key: string) => values.get(key), set }) } }))
import { registerCliCommands } from './cliCommands'
import { getCommandRegistry, runCommand } from './weportCommands'

beforeEach(() => {
  values.clear()
  set.mockClear()
  getCommandRegistry().clear()
  registerCliCommands()
})

describe('CLI config credential privacy', () => {
  it.each(['aiModelApiKey', 'aiInsightApiKey', 'aiInsightWeiboCookie', 'aiInsightTelegramToken', 'imageXorKey', 'wxidConfigs'])('does not expose %s via config.get', async key => {
    values.set(key, key === 'wxidConfigs' ? { qa_account: { decryptKey: 'private-key', imageAesKey: 'private-media-key' } } : 'private-token')
    const result = await runCommand('config.get', { keys: key }, { origin: 'cli' })
    expect(result).toEqual({ success: true, data: { [key]: true } })
  })

  it('reports an absent secret as false', async () => {
    values.set('aiInsightTelegramToken', '')
    expect(await runCommand('config.get', { keys: 'aiInsightTelegramToken' }, { origin: 'cli' }))
      .toEqual({ success: true, data: { aiInsightTelegramToken: false } })
  })

  it('saves a secret without echoing it into the command response', async () => {
    values.set('mcpToken', '')
    const result = await runCommand('config.set', { key: 'mcpToken', value: 'private-token' }, { origin: 'cli' })
    expect(set).toHaveBeenCalledWith('mcpToken', 'private-token')
    expect(JSON.stringify(result)).not.toContain('private-token')
    expect(result.data).toEqual({ key: 'mcpToken', value: true })
  })

  it('preserves ordinary config values and type conversion', async () => {
    values.set('notificationDuration', 5)
    const write = await runCommand('config.set', { key: 'notificationDuration', value: '8' }, { origin: 'cli' })
    expect(write.data).toEqual({ key: 'notificationDuration', value: 8 })
    expect(set).toHaveBeenCalledWith('notificationDuration', 8)
  })
})
