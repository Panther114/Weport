import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'

const { spawn } = vi.hoisted(() => ({ spawn: vi.fn() }))
vi.mock('node:child_process', () => ({ spawn }))
import { WeportEngine } from '../../packages/weport-tui/src/engine'

function mockChild() {
  const child = Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(), stderr: new EventEmitter(), connected: true,
    send: vi.fn(), kill: vi.fn(),
  })
  spawn.mockReturnValue(child)
  return child
}

afterEach(() => { vi.useRealTimers(); vi.clearAllMocks() })

describe('TUI engine startup failures', () => {
  it('rejects immediately when the engine exits before its handshake', async () => {
    vi.useFakeTimers()
    const child = mockChild()
    const result = new WeportEngine('Weport.exe').start()
    const assertion = expect(result).rejects.toThrow('code=0')
    child.emit('exit', 0)
    await assertion
    expect(vi.getTimerCount()).toBe(0)
  })

  it('handles a missing executable without an unhandled error or startup wait', async () => {
    vi.useFakeTimers()
    const child = mockChild()
    const assertion = expect(new WeportEngine('missing.exe').start()).rejects.toThrow('ENOENT')
    child.emit('error', new Error('spawn ENOENT'))
    await assertion
    expect(vi.getTimerCount()).toBe(0)
  })

  it('preserves an actionable host error rather than replacing it with exit status', async () => {
    vi.useFakeTimers()
    const child = mockChild()
    const assertion = expect(new WeportEngine('Weport.exe').start()).rejects.toThrow('Desktop app is running')
    child.emit('message', { kind: 'error', error: 'Desktop app is running' })
    child.emit('exit', 1)
    await assertion
    expect(vi.getTimerCount()).toBe(0)
  })

  it('terminates a timed-out startup and ignores its late handshake', async () => {
    vi.useFakeTimers()
    const child = mockChild()
    const engine = new WeportEngine('Weport.exe')
    const assertion = expect(engine.start(100)).rejects.toThrow('启动超时')
    await vi.advanceTimersByTimeAsync(100)
    await assertion
    expect(child.kill).toHaveBeenCalledOnce()
    child.emit('message', { kind: 'ready', version: 'stale', pid: 1 })
    expect(engine.info).toBeNull()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('shares a pending startup instead of spawning competing engines', async () => {
    vi.useFakeTimers()
    const child = mockChild()
    const engine = new WeportEngine('Weport.exe')
    const first = engine.start()
    const second = engine.start()
    child.emit('message', { kind: 'ready', version: '1.2.1', pid: 42 })
    expect(await first).toEqual(await second)
    expect(spawn).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not let an old child exit invalidate a replacement engine', async () => {
    vi.useFakeTimers()
    const oldChild = mockChild()
    const engine = new WeportEngine('Weport.exe')
    const assertion = expect(engine.start(100)).rejects.toThrow('启动超时')
    await vi.advanceTimersByTimeAsync(100)
    await assertion
    const child = mockChild()
    const ready = engine.start()
    child.emit('message', { kind: 'ready', version: '1.2.1', pid: 42 })
    await ready
    oldChild.emit('exit', 1)
    expect(engine.info?.pid).toBe(42)
    const reply = engine.call('cli.ping')
    const request = child.send.mock.calls.at(-1)?.[0]
    child.emit('message', { id: request.id, success: true, data: 'pong' })
    expect(await reply).toMatchObject({ success: true, data: 'pong' })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('rejects outstanding commands when stopped instead of waiting for their timeout', async () => {
    vi.useFakeTimers()
    const child = mockChild()
    const engine = new WeportEngine('Weport.exe')
    const ready = engine.start()
    child.emit('message', { kind: 'ready', version: '1.2.1', pid: 42 })
    await ready
    const assertion = expect(engine.call('sessions.list')).rejects.toThrow('引擎已停止')
    engine.stop()
    await assertion
    expect(engine.info).toBeNull()
    await vi.advanceTimersByTimeAsync(1500)
    expect(child.kill).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('rejects an IPC send failure immediately and removes its deadline', async () => {
    vi.useFakeTimers()
    const child = mockChild()
    const engine = new WeportEngine('Weport.exe')
    const ready = engine.start()
    child.emit('message', { kind: 'ready', version: '1.2.1', pid: 42 })
    await ready
    child.send.mockImplementationOnce((_message, callback) => callback(new Error('IPC channel closed')))
    await expect(engine.call('cli.ping')).rejects.toThrow('IPC channel closed')
    expect(vi.getTimerCount()).toBe(0)
  })
})
