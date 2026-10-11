import { afterEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  const run = vi.fn()
  const execFile = Object.assign(vi.fn(), { [Symbol.for('nodejs.util.promisify.custom')]: run })
  return { run, execFile }
})
vi.mock('electron', () => ({ app: {} }))
vi.mock('child_process', () => ({ execFile: mocks.execFile, exec: vi.fn() }))
vi.mock('./wechatLinux', () => ({
  defaultCommandEnvironment: () => ({}),
  findWeChatRootPid: async () => 123,
  launchWeChat: vi.fn(),
  resolveExecutable: vi.fn(),
}))
import { KeyServiceLinux } from './keyServiceLinux'
afterEach(() => vi.restoreAllMocks())

describe('Linux image acquisition privacy', () => {
  const key = 'syntheticAESkey16'
  const prepare = () => {
    const service = new KeyServiceLinux()
    vi.spyOn(service as any, 'getLinuxRuntimeDiagnostics').mockResolvedValue({ fatal: [], warnings: [] })
    vi.spyOn(service as any, 'getHelperPath').mockReturnValue('/fixture/helper')
    vi.spyOn(service as any, '_findTemplateData').mockResolvedValue({ ciphertext: Buffer.alloc(16), xorKey: 42 })
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    return { service, calls: () => JSON.stringify([...log.mock.calls, ...warning.mock.calls, ...error.mock.calls]) }
  }
  it('returns a key without logging helper stdout or stderr credentials', async () => {
    const { service, calls } = prepare()
    mocks.run.mockResolvedValue({ stdout: JSON.stringify({ success: true, key }), stderr: `debug key=${key}` })
    expect(await service.autoGetImageKeyByMemoryScan('/fixture/account')).toMatchObject({ success: true, aesKey: key })
    expect(calls()).not.toContain(key)
  })
  it('does not expose failed helper buffers through logs or returned errors', async () => {
    const { service, calls } = prepare()
    mocks.run.mockRejectedValue(Object.assign(new Error(`helper failed: ${key}`), { stdout: key, stderr: key }))
    const result = await service.autoGetImageKeyByMemoryScan('/fixture/account')
    expect(result.success).toBe(false)
    expect(JSON.stringify(result)).not.toContain(key)
    expect(calls()).not.toContain(key)
  })
})
