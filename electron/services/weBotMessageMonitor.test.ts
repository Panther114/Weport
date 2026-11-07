import { afterEach, describe, expect, it, vi } from 'vitest'
import { WeBotMessageMonitor } from './weBotMessageMonitor'

const monitors: WeBotMessageMonitor[] = []
afterEach(() => monitors.splice(0).forEach(monitor => monitor.stop()))
function fixture() {
  const now = Math.floor(Date.now() / 1000)
  const state = { account: 'A', enabled: true, messages: [{ sessionId: 'room', messageKey: 'baseline', timestamp: now, text: 'old', isSend: 0 }] }
  const deliver = vi.fn(async (_message: { accountId: string; messageKey: string }) => undefined), error = vi.fn()
  const options = {
    account: () => state.account, enabled: () => state.enabled,
    connect: vi.fn(async () => undefined),
    sessions: vi.fn(async () => [{ id: 'room', latestTimestamp: now }]),
    scan: vi.fn(async function* (_id: string, since: number) { yield state.messages.filter(message => message.timestamp >= since) }),
    deliver, error,
  }
  const monitor = new WeBotMessageMonitor(options); monitors.push(monitor)
  return { now, state, options, deliver, error, monitor }
}
const idle = async (monitor: WeBotMessageMonitor) => { await vi.waitFor(() => expect((monitor as any).running).toBe(false)) }

describe('notification-independent message monitor', () => {
  it('establishes a historical baseline and processes new same-second messages without replay', async () => {
    const { state, monitor, deliver } = fixture()
    monitor.start(); await idle(monitor)
    expect(deliver).not.toHaveBeenCalled()
    state.messages.push({ ...state.messages[0], messageKey: 'new', text: 'new deadline' })
    await monitor.poll()
    expect(deliver).toHaveBeenCalledOnce()
    expect(deliver.mock.calls[0][0]).toMatchObject({ accountId: 'A', messageKey: 'new' })
    await monitor.poll()
    expect(deliver).toHaveBeenCalledOnce()
  })
  it('reads every page and does not depend on notification enablement or mute settings', async () => {
    const { now, monitor, options, deliver } = fixture()
    monitor.start(); await idle(monitor)
    options.scan.mockImplementation(async function* () {
      yield [{ sessionId: 'room', messageKey: 'first', text: 'first', timestamp: now, isSend: 0 }]
      yield [{ sessionId: 'room', messageKey: 'second', text: 'second', timestamp: now, isSend: 0 }]
    })
    await monitor.poll()
    expect(deliver).toHaveBeenCalledTimes(2)
  })
  it('drops an in-flight account read and closes its generator after switching accounts', async () => {
    const { monitor, options, state, deliver } = fixture()
    monitor.start(); await idle(monitor)
    const closed = vi.fn()
    options.scan.mockImplementation(async function* () {
      try { state.account = 'B'; yield [{ ...state.messages[0], messageKey: 'new' }] } finally { closed() }
    })
    await monitor.poll()
    expect(deliver).not.toHaveBeenCalled()
    expect(closed).toHaveBeenCalledOnce()
  })
  it('retains the watermark when a source read fails, allowing a later retry', async () => {
    const { monitor, options, error } = fixture()
    monitor.start(); await idle(monitor)
    options.scan.mockImplementationOnce(async function* () { throw new Error('source unavailable') })
    await monitor.poll()
    expect(error).toHaveBeenCalledWith('source unavailable')
    expect((monitor as any).watermarks.get('room').ids.has('baseline')).toBe(true)
  })
})
