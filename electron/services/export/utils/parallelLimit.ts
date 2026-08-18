/**
 * 并发控制：限制同时执行的 Promise 数量
 */
export async function parallelLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const normalizedLimit = Number.isFinite(limit) ? Math.max(1, Math.floor(limit)) : 1
  const results: R[] = new Array(items.length)
  let currentIndex = 0
  let hasError = false
  let globalError: any = null

  const worker = async () => {
    while (currentIndex < items.length && !hasError) {
      const index = currentIndex++
      try {
        results[index] = await fn(items[index], index)
      } catch (err) {
        hasError = true
        globalError = err
      }
    }
  }

  const workers = Array.from({ length: Math.min(normalizedLimit, items.length) }, () => worker())
  await Promise.all(workers)

  if (hasError) throw globalError
  return results
}

export type BoundedPoolStatus = 'complete' | 'paused' | 'stopped'

export interface BoundedPoolOptions {
  concurrency: number
  shouldPause?: () => boolean
  shouldStop?: () => boolean
}

export interface BoundedPoolResult<T> {
  pending: T[]
  paused: boolean
  stopped: boolean
}

/**
 * Run an ordered list through a bounded async work pool.
 *
 * A worker claims exactly one item before awaiting it, so the number of
 * in-flight callbacks never exceeds `concurrency`. When a callback reports
 * pause/stop, that item is returned to `pending` for a resumable caller.
 */
export async function runBoundedPool<T>(
  items: readonly T[],
  options: BoundedPoolOptions,
  fn: (item: T, index: number) => Promise<BoundedPoolStatus | void>
): Promise<BoundedPoolResult<T>> {
  const normalizedLimit = Number.isFinite(options.concurrency)
    ? Math.max(1, Math.floor(options.concurrency))
    : 1
  let nextIndex = 0
  let paused = false
  let stopped = false
  const pendingIndexes = new Set(items.map((_item, index) => index))

  const getStopStatus = (): BoundedPoolStatus | null => {
    if (options.shouldStop?.()) return 'stopped'
    if (options.shouldPause?.()) return 'paused'
    return null
  }

  const worker = async () => {
    while (true) {
      const requestedStatus = getStopStatus()
      if (requestedStatus === 'stopped') {
        stopped = true
        return
      }
      if (requestedStatus === 'paused') {
        paused = true
        return
      }

      const index = nextIndex++
      if (index >= items.length) return
      pendingIndexes.delete(index)

      const status = await fn(items[index], index)
      if (status === 'stopped') {
        stopped = true
        pendingIndexes.add(index)
        return
      }
      if (status === 'paused') {
        paused = true
        pendingIndexes.add(index)
        return
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(normalizedLimit, items.length) }, () => worker())
  )

  return {
    pending: items.filter((_item, index) => pendingIndexes.has(index)),
    paused,
    stopped,
  }
}
