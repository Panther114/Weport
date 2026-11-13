import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AvatarLoadQueue } from './AvatarLoadQueue'

class FakeImage {
  static images: FakeImage[] = []
  onload: (() => void) | null = null
  onerror: (() => void) | null = null
  src = ''
  referrerPolicy = ''
  constructor() { FakeImage.images.push(this) }
}
beforeEach(() => { vi.useFakeTimers(); FakeImage.images = []; vi.stubGlobal('Image', FakeImage) })
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })
describe('avatar request lifecycle', () => {
  it('deduplicates concurrent authors sharing an avatar', async () => {
    const queue = new AvatarLoadQueue()
    const one = queue.enqueue('avatar'), two = queue.enqueue('avatar')
    expect(FakeImage.images).toHaveLength(1)
    FakeImage.images[0].onload!()
    await Promise.all([one, two])
  })
  it('times out stalled images and releases concurrency slots for queued requests', async () => {
    const queue = new AvatarLoadQueue()
    const tasks = Array.from({ length: 9 }, (_, index) => queue.enqueue(`avatar-${index}`).catch(() => undefined))
    expect(FakeImage.images).toHaveLength(8)
    await vi.advanceTimersByTimeAsync(15002)
    expect(FakeImage.images).toHaveLength(9)
    FakeImage.images[8].onload!()
    await Promise.all(tasks)
  })
  it('allows bounded component retries to recover from a transient failure', async () => {
    const queue = new AvatarLoadQueue()
    const failed = queue.enqueue('avatar').catch(() => undefined)
    FakeImage.images[0].onerror!(); await failed
    expect(queue.hasFailed('avatar')).toBe(true)
    const retried = queue.enqueue('avatar', true)
    FakeImage.images[1].onload!(); await retried
    expect(queue.hasFailed('avatar')).toBe(false)
  })
  it('settles cleared queued tasks without corrupting active slot counts', async () => {
    const queue = new AvatarLoadQueue()
    const tasks = Array.from({ length: 10 }, (_, index) => queue.enqueue(`avatar-${index}`).catch(() => undefined))
    queue.clear()
    for (const image of FakeImage.images) image.onload?.()
    await Promise.all(tasks)
    const next = queue.enqueue('next')
    FakeImage.images[FakeImage.images.length - 1].onload!(); await next
  })
})
