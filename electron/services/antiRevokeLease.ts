export type AntiRevokeConnectionQueue = <T>(operation: () => Promise<T>) => Promise<T>

/** Run a native anti-revoke write only after its account/opt-in lease is rechecked in queue order. */
export function runGuardedAntiRevokeWrite<T>(
  enqueue: AntiRevokeConnectionQueue,
  isCurrent: () => boolean,
  rejected: T,
  write: () => Promise<T>
): Promise<T> {
  return enqueue(async () => {
    if (!isCurrent()) return rejected
    return write()
  })
}
