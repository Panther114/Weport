import { describe, expect, it, vi } from 'vitest'
import { runWithAbortSignal } from './abortRun'

describe('scheduler cancellation reaches its AI run', () => {
  it('aborts the active run and rejects an answer returned after cancellation', async () => {
    const controller = new AbortController()
    let finish!: (result: string) => void
    const abort = vi.fn()
    const pending = runWithAbortSignal(controller.signal, () => new Promise<string>(resolve => { finish = resolve }), abort)
    const rejected = expect(pending).rejects.toThrow('已中止')
    controller.abort()
    expect(abort).toHaveBeenCalledTimes(1)
    finish('late answer')
    await rejected
  })
  it('does not start an already-cancelled run and detaches after failure', async () => {
    const stopped = new AbortController()
    stopped.abort()
    const run = vi.fn(async () => 'answer')
    await expect(runWithAbortSignal(stopped.signal, run, vi.fn())).rejects.toThrow('已中止')
    expect(run).not.toHaveBeenCalled()
    const controller = new AbortController()
    const abort = vi.fn()
    await expect(runWithAbortSignal(controller.signal, async () => { throw new Error('provider failed') }, abort)).rejects.toThrow('provider failed')
    controller.abort()
    expect(abort).not.toHaveBeenCalled()
  })
})
