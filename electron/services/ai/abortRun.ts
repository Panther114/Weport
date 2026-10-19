/** Tie a scheduler's lifetime to the AI run it owns, including late completion. */
export async function runWithAbortSignal<T>(signal: AbortSignal, run: () => Promise<T>, abort: () => void): Promise<T> {
  if (signal.aborted) throw new Error('已中止')
  signal.addEventListener('abort', abort, { once: true })
  try {
    const result = await run()
    if (signal.aborted) throw new Error('已中止')
    return result
  } finally {
    signal.removeEventListener('abort', abort)
  }
}
