/**
 * 分片提炼（map 阶段）的磁盘缓存。
 *
 * ## 为什么需要它
 *
 * 生成一次克隆最贵的一段是 map：38 片 × 每片 24k 字正文，实测 **40 分钟**、
 * 三十多万 token。而它的输入**只有** `chunks.jsonl`（外加分片参数）—— 语料没变，
 * 分片摘要就不该变。可现实是：只要后面任何一步失败（reduce 空回复、网络抖动、
 * 用户取消、看门狗误杀），这 40 分钟就白烧了，而且**下一次还得从头再烧一遍**。
 * 实测被这个坑掉过三次完整生成。
 *
 * 有了缓存之后：
 *   - 失败重试几乎立即从 map 之后继续；
 *   - 迭代循环里可以只改 reduce / MD / 聊天侧，不必每次都重跑 map。
 *
 * ## 键怎么取
 *
 * 用 `语料文件 size + mtime + 分片数 + 每桶分块数`。语料是原子换名写出来的，
 * size/mtime 一变键就变，所以"重新扫过库"绝不会读到上一轮的摘要。
 * 故意**不用内容哈希**：22MB 的文件每次全量 sha1 要几百毫秒，而 size+mtime
 * 在我们的写入方式下已经足够区分（原子 rename + 每次扫描都是新文件）。
 *
 * 缓存目录放在 `weclone-staging/.cache/`：`listLocalClones` 只认含
 * `metadata.json` 的目录，所以它不会被误当成一个克隆。
 */

import { createHash } from 'crypto'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, renameSync, statSync, writeFileSync } from 'fs'
import { join } from 'path'

export interface CloneMapCacheEntry {
  key: string
  createdAt: string
  /** 分片数（用于校验缓存与本次分片一致） */
  shardCount: number
  /** 每片摘要，按时间顺序；失败片已在里面写成"兜底摘要" */
  digests: string[]
  /** 其中失败了几片（会照原样写进 metadata.json） */
  failures: number
  /** 语料规模，便于人工判断这条缓存是不是同一个语料 */
  corpusBytes: number
  corpusMtimeMs: number
}

/** 缓存根目录（与克隆目录同级，但在一个不含 metadata.json 的子目录里） */
export function cloneMapCacheDir(stagingRoot: string): string {
  return join(stagingRoot, '.cache')
}

/**
 * 缓存键：语料**内容** + 分片参数。
 *
 * 刻意**不用 mtime**：每轮生成都会重新扫一遍库（约 2–3 分钟）并原子换名写出新文件，
 * mtime 必然变化 —— 键里含 mtime 就等于"每轮都 miss"，缓存白做。改用
 * `size + 头尾各 200KB 的 sha1`：重新扫出来的同一份语料键相同（命中），
 * 真的有新消息时 size 会变（miss）。头尾采样足够区分"同一个人的相邻版本"，
 * 又不用为 22MB 做全量哈希。
 */
export function cloneMapCacheKey(corpusPath: string, shardCount: number, perBucket: number): string {
  const st = statSync(corpusPath)
  return createHash('sha1')
    .update(`${st.size}|${sampleHash(corpusPath, st.size)}|${shardCount}|${perBucket}`)
    .digest('hex')
    .slice(0, 20)
}

/** 头 200KB + 尾 200KB 的 sha1（语料较小时就是全文） */
function sampleHash(path: string, size: number): string {
  const SAMPLE = 200 * 1024
  try {
    if (size <= SAMPLE * 2) return createHash('sha1').update(readFileSync(path)).digest('hex')
    const fd = openSync(path, 'r')
    try {
      const head = Buffer.allocUnsafe(SAMPLE)
      const tail = Buffer.allocUnsafe(SAMPLE)
      readSync(fd, head, 0, SAMPLE, 0)
      readSync(fd, tail, 0, SAMPLE, size - SAMPLE)
      return createHash('sha1').update(head).update(tail).digest('hex')
    } finally {
      closeSync(fd)
    }
  } catch {
    // 读不到就退回 size-only：宁可偶尔 miss，也不能抛错
    return String(size)
  }
}

/** 缓存是否启用（`WECLONE_MAP_CACHE=0` 关掉；做最终对照跑时用得到） */
export function cloneMapCacheEnabled(): boolean {
  return String(process.env.WECLONE_MAP_CACHE ?? '1') !== '0'
}

export function readCloneMapCache(dir: string, key: string): CloneMapCacheEntry | null {
  const file = join(dir, `${key}.json`)
  if (!existsSync(file)) return null
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<CloneMapCacheEntry>
    if (!raw || raw.key !== key) return null
    if (!Array.isArray(raw.digests) || raw.digests.length === 0) return null
    const digests = raw.digests.filter((d): d is string => typeof d === 'string' && d.trim().length > 0)
    if (digests.length === 0) return null
    return {
      key,
      createdAt: String(raw.createdAt || ''),
      shardCount: Number(raw.shardCount) || digests.length,
      digests,
      failures: Number(raw.failures) || 0,
      corpusBytes: Number(raw.corpusBytes) || 0,
      corpusMtimeMs: Number(raw.corpusMtimeMs) || 0,
    }
  } catch {
    // 半截文件/损坏缓存不能影响生成：当作没有缓存
    return null
  }
}

export function writeCloneMapCache(dir: string, entry: CloneMapCacheEntry): void {
  try {
    mkdirSync(dir, { recursive: true })
    const file = join(dir, `${entry.key}.json`)
    const tmp = `${file}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify(entry), 'utf8')
    // 原子收尾：读的一侧永远看不到半个文件
    renameSync(tmp, file)
  } catch {
    // 写缓存失败不该让生成失败 —— 它只是加速手段
  }
}
