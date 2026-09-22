/**
 * DSH-style tool-call scheduling, ported from `dsh-agent-loop` `src/tool-calls.ts`:
 *
 * - parallel-safe calls share a **bounded rolling pool** (`maxParallelToolCalls`,
 *   DSH default 10 — we default lower because Weport's tools hit one shared
 *   WCDB FFI host whose message cursors are a finite resource);
 * - exclusive (mutating) calls run **alone, in submission order**, as ordering
 *   barriers — the same unary-classification rule DSH documents in
 *   `dsh-tools/README.md` ("safe calls run concurrently; mutating calls run
 *   alone, in submission order");
 * - results always come back indexed by **submission order**, so the wire
 *   message array stays byte-deterministic no matter which call finishes first.
 *
 * Pure and dependency-free (no electron, no config, no I/O) so the scheduling
 * invariants are unit-testable without opening a database.
 */

export interface ToolScheduleOptions {
  /** Max parallel-safe calls in flight. Clamped to ≥1. */
  maxParallel: number
  /** Unary classification: true = run alone as an ordering barrier. */
  isExclusive: (name: string) => boolean
}

export interface ToolBatchOutcome<T> {
  /** Resolved value when `execute` settled without throwing. */
  result?: T
  /** Thrown error when `execute` rejected (never rethrown to the caller). */
  error?: unknown
  /** False when `shouldAbort` stopped this call from ever starting. */
  started: boolean
}

export interface ToolBatchHooks {
  /** Called synchronously, in submission order, right before the call launches. */
  onStart?: (index: number) => void
  /** Called once per call after it settles (or is skipped by abort). */
  onSettled?: (index: number, outcome: ToolBatchOutcome<unknown>) => void
  /** Polled before launching each call; when true, no further calls start. */
  shouldAbort?: () => boolean
}

/**
 * Run `count` tool calls with DSH scheduling semantics.
 *
 * Never rejects: a throwing `execute` is captured per index as `outcome.error`,
 * mirroring the agent loop's "a tool failure never ends the turn" contract.
 * On abort, not-yet-started calls resolve as `started: false` — the caller
 * decides what text (if any) to put on the wire for them, which keeps the
 * assistant/tool pairing complete instead of stranding orphan tool_calls.
 */
export async function runToolBatch<T>(
  calls: Array<{ name: string }>,
  options: ToolScheduleOptions,
  execute: (index: number) => Promise<T>,
  hooks: ToolBatchHooks = {},
): Promise<Array<ToolBatchOutcome<T>>> {
  const count = calls.length
  const outcomes: Array<ToolBatchOutcome<T> | undefined> = new Array(count).fill(undefined)
  const settled = new Set<number>()
  const maxParallel = Math.max(1, Math.floor(options.maxParallel) || 1)
  const inflight = new Map<number, Promise<void>>()
  let aborted = Boolean(hooks.shouldAbort?.())

  const notify = (index: number): void => {
    if (settled.has(index)) return
    settled.add(index)
    hooks.onSettled?.(index, outcomes[index]!)
  }

  const launch = (index: number): void => {
    hooks.onStart?.(index)
    const promise = (async () => {
      const value = await execute(index)
      outcomes[index] = { result: value, started: true }
    })().catch((error) => {
      outcomes[index] = { error, started: true }
    }).finally(() => {
      inflight.delete(index)
      notify(index)
    })
    inflight.set(index, promise)
  }

  const drain = async (): Promise<void> => {
    while (inflight.size > 0) await Promise.all([...inflight.values()])
  }

  /** Rolling pool: when full, wait for ANY call to settle, then continue. */
  const waitSlot = async (): Promise<void> => {
    await Promise.race([...inflight.values()])
    // The raced promise's own `.finally` may run a microtask later; tolerate a
    // momentarily-stale map entry by draining one microtask tick.
    await Promise.resolve()
  }

  for (let index = 0; index < count; index += 1) {
    if (!aborted) aborted = Boolean(hooks.shouldAbort?.())
    if (aborted) break

    if (options.isExclusive(calls[index].name)) {
      // Ordering barrier: drain the pool, run alone, keep submission order.
      await drain()
      if (Boolean(hooks.shouldAbort?.())) break
      launch(index)
      await drain()
      continue
    }

    while (inflight.size >= maxParallel) await waitSlot()
    launch(index)
  }

  await drain()

  // Fill in whatever abort prevented from starting, then notify uniformly.
  for (let index = 0; index < count; index += 1) {
    if (outcomes[index] === undefined) {
      outcomes[index] = { started: false }
    }
    notify(index)
  }
  return outcomes as Array<ToolBatchOutcome<T>>
}
