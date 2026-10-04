export type AntiRevokeAction = 'install' | 'uninstall'

export interface AntiRevokeOperationResult {
  success: boolean
  alreadyInstalled?: boolean
  error?: string
}

export interface AntiRevokeVerificationResult {
  success: boolean
  installed?: boolean
  error?: string
}

export interface AntiRevokeRowResult {
  sessionId: string
  success: boolean
  error?: string
}

export interface AntiRevokeCheckRow extends AntiRevokeRowResult {
  installed?: boolean
}

export function isAntiRevokeSessionEligible(
  username: string,
  options: { isContact: boolean; hasMessageTables: boolean }
): boolean {
  const sessionId = String(username || '').trim()
  if (!sessionId || sessionId.startsWith('gh_') || sessionId.toLowerCase().includes('placeholder_foldgroup')) return false
  const isGroup = sessionId.toLowerCase().endsWith('@chatroom')
  return (isGroup || options.isContact) && options.hasMessageTables
}

/** Confirm the native write changed the trigger state that the user requested. */
export function verifyAntiRevokeTransition(
  action: AntiRevokeAction,
  operation: AntiRevokeOperationResult,
  verification: AntiRevokeVerificationResult
): AntiRevokeOperationResult {
  if (!operation.success) return operation

  const expectedInstalled = action === 'install'
  const actionLabel = action === 'install' ? '安装' : '还原'
  if (!verification.success) {
    return {
      success: false,
      alreadyInstalled: operation.alreadyInstalled,
      error: `${actionLabel}操作已返回成功，但无法确认触发器状态：${verification.error || '状态检查失败'}`,
    }
  }

  if (verification.installed !== expectedInstalled) {
    return {
      success: false,
      alreadyInstalled: operation.alreadyInstalled,
      error: expectedInstalled ? '安装后未检测到防撤回触发器' : '还原后仍检测到防撤回触发器',
    }
  }

  return { success: true, alreadyInstalled: operation.alreadyInstalled }
}

/** Keep per-session errors while making the batch-level success flag truthful. */
export function makeAntiRevokeBatchResult<T extends AntiRevokeRowResult>(rows: T[]): {
  success: boolean
  rows: T[]
  error?: string
} {
  const failedRows = rows.filter((row) => !row.success)
  return {
    success: failedRows.length === 0,
    rows,
    ...(failedRows.length > 0
      ? { error: failedRows.find((row) => row.error)?.error || `${failedRows.length} 个会话处理失败` }
      : {}),
  }
}

/** Merge rejected IDs and native results without dropping either failure source. */
export function mergeAntiRevokeBatchResult<T extends AntiRevokeRowResult>(
  nativeResult: { success: boolean; rows?: T[]; error?: string },
  rejectedRows: T[]
): { success: boolean; rows: T[]; error?: string } {
  const rows = [...(nativeResult.rows || []), ...rejectedRows]
  const rowResult = makeAntiRevokeBatchResult(rows)
  const success = nativeResult.success && rowResult.success
  return {
    ...rowResult,
    success,
    ...(!success && !rowResult.error && nativeResult.error ? { error: nativeResult.error } : {}),
    ...(!success && !rowResult.error && !nativeResult.error ? { error: '批量操作未完成' } : {}),
  }
}

/** Separate confirmed states from failed/missing checks before auto-install retries. */
export function classifyAntiRevokeCheckRows(sessionIds: string[], rows: AntiRevokeCheckRow[] | undefined): {
  installedIds: string[]
  missingIds: string[]
  unknownIds: string[]
} {
  const bySessionId = new Map((rows || []).map((row) => [String(row.sessionId || '').trim(), row]))
  const installedIds: string[] = []
  const missingIds: string[] = []
  const unknownIds: string[] = []
  for (const rawId of sessionIds) {
    const sessionId = String(rawId || '').trim()
    if (!sessionId) continue
    const row = bySessionId.get(sessionId)
    if (!row?.success || typeof row.installed !== 'boolean') unknownIds.push(sessionId)
    else if (row.installed) installedIds.push(sessionId)
    else missingIds.push(sessionId)
  }
  return { installedIds, missingIds, unknownIds }
}
