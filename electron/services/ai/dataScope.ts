import { createHash } from 'crypto'
import type { ProviderConsumer } from './providerTypes'
import type { DataAccessScope } from '../dataAccessService'

/** Filesystem-safe namespace; raw account names never become path segments. */
export function accountNamespace(accountId: string): string {
  return createHash('sha256').update(String(accountId || '').trim() || 'unselected').digest('hex')
}

export interface AiRunOptions {
  consumer?: ProviderConsumer
  accountId?: string
  tools?: 'none'
  maxSteps?: number
  /** Measured aggregate usage gate between requests, not a provider billing cap. */
  maxTotalTokens?: number
  scope?: DataAccessScope
  processing?: 'local-only' | 'cloud-enabled'
}

export function assertRunAccount(expected: string, current: string): void {
  if (expected !== current) throw new Error('The selected account changed. Start a new run for this account.')
}
