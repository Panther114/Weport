/** Internal marker carried from collection to orchestration for a verified empty chat. */
export const CONFIRMED_EMPTY_SESSION_SKIP = 'WEPORT_CONFIRMED_EMPTY_SESSION_SKIP'

function isExplicitZero(value: unknown): boolean {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value === 0
  if (typeof value === 'bigint') return value === 0n
  return typeof value === 'string' && /^0+$/.test(value.trim())
}

/**
 * Only a successful native table-stat result and explicit per-session count can
 * confirm emptiness. Missing, malformed, or failed results stay unknown.
 */
export function hasConfirmedEmptyMessageInventory(
  sessionId: string,
  tableStats: { success?: unknown; tables?: unknown } | null | undefined,
  sessionCounts: { success?: unknown; counts?: unknown } | null | undefined,
  explicitSessionMessageCountHint?: unknown,
): boolean {
  if (tableStats?.success !== true || !Array.isArray(tableStats.tables)) return false
  if (!tableStats.tables.every((table) => (
    table !== null && typeof table === 'object' && isExplicitZero((table as Record<string, unknown>).count)
  ))) return false

  if (sessionCounts?.success === true && sessionCounts.counts && typeof sessionCounts.counts === 'object' && !Array.isArray(sessionCounts.counts) &&
      Object.prototype.hasOwnProperty.call(sessionCounts.counts, sessionId)) {
    return isExplicitZero((sessionCounts.counts as Record<string, unknown>)[sessionId])
  }

  // Some supported native versions omit a zero-count key. Only the raw session
  // table hint from a successful getSessions read may fill that gap.
  return isExplicitZero(explicitSessionMessageCountHint)
}
