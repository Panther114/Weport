/**
 * blobStore —— 克隆语料文件存储（v0.9.10）。
 *
 * 布局：{dataDir}/blobs/<cloneId>/
 *   chunks.jsonl   —— 每行一个 chunk {id, sid, ts, text}（UTF-8，\n 分隔）
 *   mds/*.md       —— 生成的知识文件（profile.md / relationships.md / ...）
 *
 * 内存策略：
 * - 写入：逐 chunk 序列化落盘（.tmp + rename 原子生效），不全量驻留内存；
 * - 读取：loadChunksStream 流式逐行产出，绝不整文件载入；
 * - readChunksForSearch 供 BM25 建索引用（调用方自行设上限）。
 */

import { createReadStream } from 'node:fs'
import {
  closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync,
  renameSync, rmSync, writeFileSync, writeSync,
} from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

/** 上传 payload 中的单个 chunk */
export interface WeCloneChunk {
  id?: string
  sid?: string
  ts?: number
  text: string
}

/** 原子写单个文本文件：tmp + rename */
function writeFileAtomic(target: string, data: string): void {
  const tmp = `${target}.tmp-${process.pid}-${Date.now()}`
  writeFileSync(tmp, data, 'utf8')
  renameSync(tmp, target)
}

export class BlobStore {
  readonly blobsDir: string

  constructor(dataDir: string) {
    this.blobsDir = join(dataDir, 'blobs')
    mkdirSync(this.blobsDir, { recursive: true })
  }

  // ------------------------------------------------------------------
  // 路径
  // ------------------------------------------------------------------

  private dirOf(id: string): string {
    // 防路径穿越：id 必须是 uuid/hex 形态
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw new Error('invalid clone id')
    return join(this.blobsDir, id)
  }

  private chunksPath(id: string): string {
    return join(this.dirOf(id), 'chunks.jsonl')
  }

  private mdsDirOf(id: string): string {
    return join(this.dirOf(id), 'mds')
  }

  // ------------------------------------------------------------------
  // 写入
  // ------------------------------------------------------------------

  /**
   * 保存 chunks 为 chunks.jsonl —— 逐条写入（流式、低内存），
   * 先写 .tmp 再 rename 原子替换。超过 maxBytes 抛 code=BLOB_TOO_LARGE。
   * 返回写入字节数。
   */
  async saveChunks(id: string, chunks: WeCloneChunk[], maxBytes: number): Promise<number> {
    const dir = this.dirOf(id)
    mkdirSync(dir, { recursive: true })
    const finalPath = this.chunksPath(id)
    const tmp = `${finalPath}.tmp-${process.pid}-${Date.now()}`
    let bytes = 0
    const handle = openSync(tmp, 'w')
    try {
      try {
        for (const chunk of chunks) {
          const line =
            `${JSON.stringify({ id: chunk.id ?? '', sid: chunk.sid ?? '', ts: chunk.ts ?? 0, text: chunk.text })}\n`
          const lineBytes = Buffer.byteLength(line, 'utf8')
          if (bytes + lineBytes > maxBytes) {
            const err = new Error(`chunks exceed ${maxBytes} bytes`) as Error & { code?: string }
            err.code = 'BLOB_TOO_LARGE'
            throw err
          }
          writeSync(handle, line, null, 'utf8')
          bytes += lineBytes
        }
      } finally {
        closeSync(handle) // Windows 上 rename 前必须先关句柄
      }
      renameSync(tmp, finalPath)
      return bytes
    } catch (err) {
      try { rmSync(tmp, { force: true }) } catch { /* ignore */ }
      throw err
    }
  }

  /** 保存知识文件到 mds/*.md（每份原子写；文件名白名单化防穿越） */
  async saveMds(id: string, mds: Record<string, string>): Promise<void> {
    const dir = this.mdsDirOf(id)
    mkdirSync(dir, { recursive: true })
    for (const [rawName, content] of Object.entries(mds)) {
      const safe = rawName.replace(/[^\w.-]/g, '_').slice(0, 64) || 'note.md'
      writeFileAtomic(join(dir, safe), String(content))
    }
  }

  // ------------------------------------------------------------------
  // 读取
  // ------------------------------------------------------------------

  /** 流式逐条产出 chunks（JSONL 行解析；损坏行跳过不中断） */
  async *loadChunksStream(id: string): AsyncGenerator<WeCloneChunk, void, undefined> {
    const path = this.chunksPath(id)
    if (!existsSync(path)) return
    const input = createReadStream(path, { encoding: 'utf8' })
    const rl = createInterface({ input, crlfDelay: Infinity })
    try {
      for await (const line of rl) {
        if (!line.trim()) continue
        try {
          yield JSON.parse(line) as WeCloneChunk
        } catch {
          continue
        }
      }
    } finally {
      rl.close()
      input.destroy()
    }
  }

  /**
   * 全量读出 chunks 数组（BM25 建索引用）。maxChunks 兜底防止超大语料爆内存
   * —— 超限部分由检索层的子串回退扫描兜底。
   */
  async readChunksForSearch(id: string, maxChunks = 20_000): Promise<WeCloneChunk[]> {
    const out: WeCloneChunk[] = []
    for await (const chunk of this.loadChunksStream(id)) {
      out.push(chunk)
      if (out.length >= maxChunks) break
    }
    return out
  }

  /** 读取 mds/*.md 正文 → { 'profile.md': '...', ... }；目录缺失返回 {} */
  getMds(id: string): Record<string, string> {
    const dir = this.mdsDirOf(id)
    const out: Record<string, string> = {}
    if (!existsSync(dir)) return out
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.md')) continue
      try {
        out[name] = readFileSync(join(dir, name), 'utf8')
      } catch { /* raced delete */ }
    }
    return out
  }

  hasBlob(id: string): boolean {
    return existsSync(this.chunksPath(id))
  }

  /** 删除整个 blob 目录（删除即焚毁） */
  async deleteBlob(id: string): Promise<void> {
    rmSync(this.dirOf(id), { recursive: true, force: true })
  }
}
