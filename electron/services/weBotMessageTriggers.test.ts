import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { WeBotService, type WeBotTriggerMessage } from './weBotService'

const services: WeBotService[] = [], roots: string[] = []
afterEach(() => { services.splice(0).forEach(service => service.stop()); roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })) })
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'weport-message-trigger-')); roots.push(root)
  const state = { account: 'A', now: 1700000000000 }
  const dispatch = vi.fn(async (_request: import('./weBotService').WeBotDispatchRequest) => ({ summary: 'Result' }))
  const options = { dataDir: root, currentAccountId: () => state.account, now: () => state.now, dispatch }
  const create = () => { const service = new WeBotService(options); services.push(service); return service }
  const service = create()
  const input = { title: 'Deadlines', description: 'Find the deadline', schedule: { kind: 'daily' as const, hour: 9, minute: 0 }, references: [{ id: 'room', label: 'Room', kind: 'group' as const }], trigger: { kind: 'message' as const, pattern: 'deadline', flags: 'i', cooldownSeconds: 60, accountId: 'untrusted' } }
  const message: WeBotTriggerMessage = { accountId: 'A', sessionId: 'room', messageKey: 'db-table-local-1', text: 'DEADLINE tomorrow', timestamp: state.now / 1000, isSend: 0 }
  return { state, dispatch, create, service, input, message }
}

describe('account-scoped WeBot message triggers', () => {
  it('matches selected incoming messages, records dedup before dispatch, and does not run from the time scheduler', async () => {
    const { service, input, message, dispatch } = fixture()
    const task = service.createTask(input)
    expect(task.trigger?.accountId).toBe('A')
    expect(task.nextRunAt).toBeNull()
    await (service as any).tick()
    expect(dispatch).not.toHaveBeenCalled()
    await service.handleIncomingMessage({ ...message, sessionId: 'other' })
    await service.handleIncomingMessage({ ...message, isSend: 1 })
    await service.handleIncomingMessage({ ...message, text: 'unrelated' })
    await service.handleIncomingMessage({ ...message, accountId: 'B' })
    expect(dispatch).not.toHaveBeenCalled()
    await service.handleIncomingMessage(message)
    await vi.waitFor(() => expect(service.listRuns()[0]?.status).toBe('ok'))
    expect(dispatch).toHaveBeenCalledOnce()
    expect(dispatch.mock.calls[0][0]).toMatchObject({ triggerMessage: message })
    expect(service.listTasks()[0].triggerState?.messageIds).toEqual([message.messageKey])
  })
  it('preserves cooldown and message dedup across service restart', async () => {
    const { service, input, message, state, dispatch, create } = fixture()
    service.createTask(input)
    await service.handleIncomingMessage(message)
    await vi.waitFor(() => expect(service.listRuns()[0]?.status).toBe('ok'))
    await service.handleIncomingMessage({ ...message, messageKey: 'second' })
    expect(dispatch).toHaveBeenCalledOnce()
    service.stop()
    state.now += 61000
    const restarted = create()
    await restarted.handleIncomingMessage(message)
    expect(dispatch).toHaveBeenCalledOnce()
    await restarted.handleIncomingMessage({ ...message, messageKey: 'third', timestamp: state.now / 1000 })
    await vi.waitFor(() => expect(dispatch).toHaveBeenCalledTimes(2))
  })
  it('invalidates a match when its account or rule changes during worker execution', async () => {
    const { service, input, message, state, dispatch } = fixture()
    const task = service.createTask(input)
    let release!: (value: boolean) => void
    vi.spyOn((service as any).regexMatcher, 'match').mockReturnValue(new Promise<boolean>(resolve => { release = resolve }))
    const matching = service.handleIncomingMessage(message)
    service.updateTask(task.id, { trigger: { ...input.trigger, pattern: 'different' } })
    state.account = 'B'
    release(true)
    await matching
    expect(dispatch).not.toHaveBeenCalled()
  })
  it('does not launch queued runs during shutdown', async () => {
    const { service, input, message, dispatch } = fixture()
    service.createTask(input)
    service.createTask({ ...input, title: 'Second task' })
    let release!: () => void
    dispatch.mockImplementationOnce(async () => { await new Promise<void>(resolve => { release = resolve }); return { summary: 'Result' } })
    await service.handleIncomingMessage(message)
    await vi.waitFor(() => expect(dispatch).toHaveBeenCalledOnce())
    service.stop(); release()
    await (service as any).messageRunQueue
    expect(dispatch).toHaveBeenCalledOnce()
  })
})
