import { describe, expect, it } from 'vitest'
import { runGuardedAntiRevokeWrite } from './antiRevokeLease'

function createQueue() {
  let tail: Promise<void> = Promise.resolve()
  return <T>(operation: () => Promise<T>): Promise<T> => {
    const run = tail.then(operation, operation)
    tail = run.then(() => undefined, () => undefined)
    return run
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

describe('anti-revoke connection lease', () => {
  it('rejects a queued write after the account changes before it gets the connection', async () => {
    const enqueue = createQueue()
    const blocker = deferred<void>()
    const release = enqueue(async () => blocker.promise)
    let configuredAccount = 'wxid-old'
    let connectedAccount = 'wxid-old'
    const writes: string[] = []
    const write = runGuardedAntiRevokeWrite<{ success: boolean; error?: string }>(
      enqueue,
      () => configuredAccount === 'wxid-old' && connectedAccount === 'wxid-old',
      { success: false, error: 'stale account' },
      async () => { writes.push(connectedAccount); return { success: true } }
    )
    configuredAccount = 'wxid-new'
    const switchAccount = enqueue(async () => { connectedAccount = 'wxid-new' })
    blocker.resolve()
    await Promise.all([release, write, switchAccount])
    expect(writes).toEqual([])
  })

  it('keeps an active write ahead of account close/reconnect in queue order', async () => {
    const enqueue = createQueue()
    let configuredAccount = 'wxid-old'
    let connectedAccount = 'wxid-old'
    const writeStarted = deferred<void>()
    const finishWrite = deferred<void>()
    const writes: string[] = []
    const write = runGuardedAntiRevokeWrite<{ success: boolean; error?: string }>(
      enqueue,
      () => configuredAccount === 'wxid-old' && connectedAccount === 'wxid-old',
      { success: false, error: 'stale account' },
      async () => {
        writeStarted.resolve()
        await finishWrite.promise
        writes.push(connectedAccount)
        return { success: true }
      }
    )
    await writeStarted.promise
    configuredAccount = 'wxid-new'
    const switchAccount = enqueue(async () => { connectedAccount = 'wxid-new' })
    finishWrite.resolve()
    await Promise.all([write, switchAccount])
    expect(writes).toEqual(['wxid-old'])
    expect(connectedAccount).toBe('wxid-new')
  })
})
