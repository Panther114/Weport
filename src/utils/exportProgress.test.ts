import { describe, expect, it } from 'vitest'
import { isExportCompletionAuthoritative, normalizeExportProgressPhase } from './exportProgress'

describe('export progress lifecycle', () => {
  it('keeps per-session completion in the running phase', () => {
    expect(normalizeExportProgressPhase('complete', 2, 10)).toBe('exporting')
  })

  it('shows verification after message export reaches 100 percent', () => {
    expect(normalizeExportProgressPhase('complete', 10, 10)).toBe('verifying')
  })

  it('does not treat a full counter as task completion while busy or running', () => {
    expect(isExportCompletionAuthoritative({ busy: true, taskStatus: 'running', confirmedByResult: false })).toBe(false)
    expect(isExportCompletionAuthoritative({ busy: false, taskStatus: 'running', confirmedByResult: false })).toBe(false)
  })

  it('accepts an authoritative successful result or completed task snapshot', () => {
    expect(isExportCompletionAuthoritative({ busy: true, taskStatus: 'running', confirmedByResult: true })).toBe(true)
    expect(isExportCompletionAuthoritative({ busy: false, taskStatus: 'done', confirmedByResult: false })).toBe(true)
  })

  it('does not show success for a failed or aborted task snapshot', () => {
    expect(isExportCompletionAuthoritative({ busy: false, taskStatus: 'failed', confirmedByResult: false })).toBe(false)
    expect(isExportCompletionAuthoritative({ busy: false, taskStatus: 'aborted', confirmedByResult: false })).toBe(false)
  })
})
