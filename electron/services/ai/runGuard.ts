import { createHash } from 'node:crypto'

export function toolResultBudget(configured: unknown, contextWindow: number, promptTokens: number): number {
  const value = Number(configured)
  const requested = value > 0 && value !== 12000 ? value : 240000
  // Reserve room for the next answer and stop tool results overrunning a small
  // model's context. 12000 was the former default, not an explicit preference.
  const available = Math.floor(Math.max(0, contextWindow * 0.75 - promptTokens) * 2.5)
  return Math.max(1000, Math.min(requested, available))
}

export function toolRoundLimit(value: unknown): number {
  const limit = Number(value)
  // 48 was the old default, rather than a user-selected budget.
  return Number.isFinite(limit) && limit > 0 && limit !== 48 ? Math.max(1, Math.floor(limit)) : Infinity
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]))
  return value
}

export class AiRunGuard {
  private previous = ''
  private repeated = 0

  observeBatch(calls: Array<{ name: string; args: unknown; result?: string }>): void {
    const fingerprint = createHash('sha256').update(JSON.stringify(canonical(calls.map(({ name, args, result }) => ({ name, args, result }))))).digest('hex')
    this.repeated = fingerprint === this.previous ? this.repeated + 1 : 1
    this.previous = fingerprint
  }

  shouldFinalize(rounds: number, limit: number, promptTokens: number, contextWindow: number): boolean {
    return rounds >= limit || this.repeated >= 5 || (contextWindow > 0 && promptTokens >= contextWindow * 0.8)
  }
}
