/**
 * `-wal` / `-shm` 观测（v1.2 §10.3 ③）。
 *
 * 这个模块**只读**：它存在的意义是让"我们没有改用户的 `-wal`/`-shm`"这件事
 * 可以被断言（单测 + 诊断页），而不是去碰它们。任何"替微信做 checkpoint"的想法
 * 都被明确拒绝 —— 理由写在 `readOnlyGuard.ts` 的文件头（-wal 处理决策）。
 */
import * as crypto from 'crypto'
import * as fs from 'fs'

export type DbAccessMode = 'read-only' | 'write'

export interface WalSignature {
  path: string
  exists: boolean
  bytes: number
  mtimeMs: number
  sha256: string
}

/** 采样 `session.db` / `-wal` / `-shm` 的大小、mtime 与哈希（只读，绝不写）。 */
export async function captureWalSignature(sessionDbPath: string): Promise<WalSignature[]> {
  const candidates = [sessionDbPath, `${sessionDbPath}-wal`, `${sessionDbPath}-shm`]
  const out: WalSignature[] = []
  for (const candidate of candidates) {
    try {
      const stat = await fs.promises.stat(candidate)
      const data = await fs.promises.readFile(candidate)
      out.push({
        path: candidate,
        exists: true,
        bytes: stat.size,
        mtimeMs: stat.mtimeMs,
        sha256: crypto.createHash('sha256').update(data).digest('hex'),
      })
    } catch {
      out.push({ path: candidate, exists: false, bytes: 0, mtimeMs: 0, sha256: '' })
    }
  }
  return out
}

export interface WalChange {
  path: string
  change: string
}

/**
 * 比较两组签名。
 * 注意：`-shm` 的**出现**是 SQLite 打开连接时的正常副作用（易失文件，不含用户数据），
 * 调用方要断言"内容未被改写"应当是断言 `-wal` 与 `session.db`，
 * 而不是要求 `-shm` 完全不出现。
 */
export function diffWalSignature(before: WalSignature[], after: WalSignature[]): WalChange[] {
  const diffs: WalChange[] = []
  const byPath = new Map(before.map((item) => [item.path, item]))
  for (const item of after) {
    const prev = byPath.get(item.path)
    if (!prev) {
      diffs.push({ path: item.path, change: 'appeared' })
      continue
    }
    if (prev.exists !== item.exists) {
      diffs.push({ path: item.path, change: item.exists ? 'appeared' : 'removed' })
      continue
    }
    if (!item.exists) continue
    if (prev.sha256 !== item.sha256) {
      // 内容哈希是最硬的证据：大小相同但内容变了（例如原地改一个字节）也要报出来
      diffs.push({
        path: item.path,
        change: prev.bytes === item.bytes
          ? 'content changed'
          : `size ${prev.bytes} -> ${item.bytes}`,
      })
    }
  }
  return diffs
}

/**
 * 只关心**内容是否落在盘上被改写**。
 * 注意这里无法区分"我们写的"与"微信同时写的" —— 微信正在运行时 `-wal` 本来就会动。
 * 因此这条断言的正确用法是在**没有其它写者**的前提下（单测里的静态样本、或诊断快照前后），
 * 把它当作"只读采样本身没有落盘写"的证明。
 */
export function contentChanges(diffs: WalChange[], sessionDbPath: string): WalChange[] {
  const watched = new Set([sessionDbPath, `${sessionDbPath}-wal`])
  return diffs.filter((diff) => watched.has(diff.path))
}
