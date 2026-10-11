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
})
