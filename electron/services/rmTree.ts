/**
 * Windows 上可靠的递归删除。
 *
 * ## 这个文件存在的原因（一次真实的报错）
 *
 * 用户删 WeClone 时看到「删除失败」，但克隆其实已经没了 —— 残留的目录里只剩下
 * 两个大文件（`chunks.jsonl` 23 MB / `voice.jsonl` 3.8 MB），`meta.json` 和所有
 * MD 都已删除。也就是说 `rmSync(target, { recursive: true, force: true })`
 * **删掉了大部分内容之后才抛错**。
 *
 * 机制：Node 的 `rmSync` 默认 `maxRetries: 0`。它逐个删子项，删完再 rmdir 父目录；
 * 只要有一个文件在那一刻打不开（实时杀毒正在扫刚刚写下的 23 MB 文件、
 * 索引器、或者上一次写入尚未完全释放），那一步就立刻抛 EBUSY / EPERM，
 * 紧接着的 rmdir 因目录非空抛 **ENOTEMPTY** —— 用户看到的正是"目录不为空"。
 * 一次都没重试，于是"其实已经删掉了"和"报错"同时成立。
 *
 * 三件事各自解决一层：
 *   1. **重试**（`maxRetries` + `retryDelay`）：Node 在同步路径上用
 *      `Atomics.wait` 实现等待，所以这里保持同步、调用方不需要改成 async。
 *   2. **清只读属性后重试一次**：Windows 上只读文件会让递归删除在 EPERM 上卡死，
 *      `force: true` 只忽略 ENOENT，不管只读。
 *   3. **按结果而不是按返回值判定**：删除请求的语义是"这个目录不该再存在"。
 *      抛错之后再 stat 一次，真没了就当成功 —— 否则用户会被告知失败、
 *      然后自己去看发现已经删干净了，只能再点一次。
 */
import { chmodSync, existsSync, readdirSync, rmSync, statSync } from 'fs'
import { join } from 'path'

export interface RemoveTreeResult {
  /** 目录最终不再存在（或本来就不存在） */
  ok: boolean
  /** 这次调用真的删掉了东西（而不是本来就没有） */
  removed: boolean
  /** 失败原因（`ok === false` 时有值） */
  error?: string
  /** 第一次尝试抛出的错误（已经删掉时用它解释"为什么报过错"） */
  firstError?: string
}

const DEFAULT_ATTEMPTS = 4
const RETRY_DELAY_MS = 150

/** 递归清掉只读/隐藏属性；失败不抛（有些文件确实锁着，交给重试） */
function clearReadOnly(target: string): void {
  let stat
  try {
    stat = statSync(target)
  } catch {
    return
  }
  try {
    if (stat.isDirectory()) {
      for (const entry of readdirSync(target)) clearReadOnly(join(target, entry))
    } else {
      chmodSync(target, 0o666)
    }
  } catch {
    /* 单文件失败不影响其余的清理 */
  }
}

/**
 * 删除一个目录（或文件），失败时给出真实结论。
 *
 * 同步是刻意的：调用方（IPC handler）本来就是同步删除，改成 async 会把
 * "删完立刻列目录"的时序打散。
 */
export function removeTree(
  target: string,
  options: { attempts?: number; retryDelayMs?: number } = {}
): RemoveTreeResult {
  const attempts = Math.max(1, options.attempts ?? DEFAULT_ATTEMPTS)
  const retryDelay = Math.max(0, options.retryDelayMs ?? RETRY_DELAY_MS)

  if (!existsSync(target)) return { ok: true, removed: false }

  let firstError: unknown = null
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      rmSync(target, { recursive: true, force: true, maxRetries: 8, retryDelay })
    } catch (error) {
      if (firstError === null) firstError = error
      // 第二次之后先清只读属性：Windows 上这是 EPERM/ENOTEMPTY 的常见来源
      if (attempt === 1) clearReadOnly(target)
    }
    if (!existsSync(target)) {
      return { ok: true, removed: true, firstError: firstError ? String((firstError as Error)?.message || firstError) : undefined }
    }
  }

  const message = firstError ? String((firstError as Error)?.message || firstError) : '目录仍然存在'
  return { ok: false, removed: false, error: message }
}
