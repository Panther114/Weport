/**
 * 原子 JSON 落盘 / 容错读取（v1.2 §6）。
 *
 * 搜索索引与标注存储都要求「写一半崩了不能读出一半」：
 *   - 索引的提交点是 manifest 的 rename，分片先写新世代再改 manifest；
 *   - 标注存储本身就是唯一的真相来源（用户手打的标签，没有第二个副本）。
 *
 * 所以这里是**唯一**的写入口：同目录临时文件 → fsync → rename 覆盖。
 * Windows 上 rename 覆盖已存在文件走 MoveFileEx(REPLACE_EXISTING)，是原子的：
 * 读侧要么看到旧文件、要么看到新文件，绝不会看到中间态。
 *
 * 读取侧的容错策略：文件坏了**不抛异常**，而是备份成 `<name>.corrupt-<时间戳>`
 * 再让调用方按「没有数据」起步 —— 一个坏 JSON 把整个功能卡死（连清理都没法做）
 * 比丢配置更糟。
 */
import {
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'fs'
import { dirname, join } from 'path'

/** 临时文件前缀：加载时按它识别「上一次崩在写一半」的残留 */
const TMP_MARK = '.tmp-'

let tmpCounter = 0

function nextTmpPath(filePath: string): string {
  tmpCounter += 1
  return `${filePath}${TMP_MARK}${process.pid}-${tmpCounter}`
}

/** 清掉同目录下遗留的临时文件（崩溃残留）。返回删除数量。 */
export function cleanupTmpFiles(dir: string, keepPrefix?: string): number {
  let removed = 0
  try {
    if (!existsSync(dir)) return 0
    for (const name of readdirSync(dir)) {
      if (!name.includes(TMP_MARK)) continue
      if (keepPrefix && !name.startsWith(keepPrefix)) continue
      try {
        unlinkSync(join(dir, name))
        removed += 1
      } catch {
        /* 删不掉也不致命：它也永远不会被当成正式文件读 */
      }
    }
  } catch {
    /* 目录读不了就算了 */
  }
  return removed
}

/**
 * 原子写文本。目录不存在会自动建（`recursive`）。
 * `sync: false` 用于体积大、可重建的分片（掉电丢失可由下次构建补齐），
 * 默认 true（manifest / 标注这类"提交点"必须落盘后再 rename）。
 */
export function writeFileAtomic(filePath: string, data: string | Buffer, options?: { sync?: boolean }): void {
  const dir = dirname(filePath)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const tmpPath = nextTmpPath(filePath)
  const payload = typeof data === 'string' ? Buffer.from(data, 'utf8') : data

  const fd = openSync(tmpPath, 'w')
  try {
    let offset = 0
    while (offset < payload.length) {
      offset += writeSync(fd, payload, offset, payload.length - offset)
    }
    if (options?.sync !== false) fsyncSync(fd)
  } finally {
    closeSync(fd)
  }

  try {
    renameSync(tmpPath, filePath)
  } catch (error) {
    try {
      unlinkSync(tmpPath)
    } catch {
      /* 临时文件清不掉不影响正确性 */
    }
    throw error
  }
}

export function writeJsonAtomic(filePath: string, value: unknown, options?: { pretty?: boolean; sync?: boolean }): void {
  const text = options?.pretty ? JSON.stringify(value, null, 2) : JSON.stringify(value)
  writeFileAtomic(filePath, text, { sync: options?.sync })
}

export interface TolerantReadResult<T> {
  /** 解析成功时的值；文件不存在或损坏时为 null */
  value: T | null
  /** 文件存在但 JSON 解析失败（或不是对象）时为 true */
  corrupt: boolean
  /** 损坏文件的备份路径（备份失败时为空） */
  backedUpTo?: string
  /** 文件不存在（与"损坏"区分：首次运行不该留下备份） */
  missing: boolean
  error?: string
}

/**
 * 容错读 JSON：
 *   - 不存在 → `{ value:null, missing:true }`
 *   - 损坏   → 备份到 `<file>.corrupt-<ts>`，返回 `{ value:null, corrupt:true }`
 * 任何情况下都不抛。空文件也算损坏（写到一半掉电的典型产物）。
 */
export function readJsonTolerant<T>(filePath: string, options?: { backupOnCorrupt?: boolean }): TolerantReadResult<T> {
  if (!existsSync(filePath)) {
    return { value: null, corrupt: false, missing: true }
  }
  let raw = ''
  try {
    raw = readFileSync(filePath, 'utf8')
  } catch (error) {
    return { value: null, corrupt: true, missing: false, error: `读取失败: ${String((error as Error)?.message || error)}` }
  }

  const backup = (reason: string): TolerantReadResult<T> => {
    let backedUpTo: string | undefined
    if (options?.backupOnCorrupt !== false) {
      try {
        const stamp = new Date().toISOString().replace(/[:.]/g, '-')
        backedUpTo = `${filePath}.corrupt-${stamp}`
        copyFileSync(filePath, backedUpTo)
      } catch {
        backedUpTo = undefined
      }
    }
    return { value: null, corrupt: true, missing: false, backedUpTo, error: reason }
  }

  const trimmed = raw.trim()
  if (!trimmed) return backup('文件为空')

  try {
    const parsed = JSON.parse(trimmed) as T
    if (parsed === null || typeof parsed !== 'object') {
      return backup('顶层不是对象')
    }
    return { value: parsed, corrupt: false, missing: false }
  } catch (error) {
    return backup(`JSON 解析失败: ${String((error as Error)?.message || error)}`)
  }
}

/** 文件大小（字节），读不到返回 0 —— 索引体积上报用，不需要抛 */
export function fileSize(filePath: string): number {
  try {
    return statSync(filePath).size
  } catch {
    return 0
  }
}
