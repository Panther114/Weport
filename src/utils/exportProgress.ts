export type ExportTaskStatus = 'idle' | 'running' | 'done' | 'failed' | 'aborted' | string

/**
 * The orchestrator reports `complete` both after one session and at 100% before
 * it performs the export integrity check. Neither event is the task's terminal
 * state; reserve that decision for the completed IPC result or task snapshot.
 */
export function normalizeExportProgressPhase(rawPhase: unknown, current: number, total: number): string {
  const phase = String(rawPhase || '')
  if (phase !== 'complete') return phase || 'running'
  if (total > 0 && current >= total) return 'verifying'
  return 'exporting'
}

export function isExportCompletionAuthoritative(input: {
  busy: boolean
  taskStatus: ExportTaskStatus
  confirmedByResult: boolean
}): boolean {
  return input.confirmedByResult || (!input.busy && input.taskStatus === 'done')
}
