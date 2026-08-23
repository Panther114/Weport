/**
 * bm25 —— 手写轻量 BM25 检索（v0.9.10，零依赖）。
 *
 * - 分词：空白/标点切 ASCII 词元 + CJK 二元 bigram（连续汉字两两组合），
 *   小停用词表；长数字串（脱敏域残留）不索引。
 * - 索引：每 clone 懒构建 —— 首次检索时 readChunksForSearch 载入数组建
 *   倒排（term → [docIdx, tf, ...] 平铺对），LRU 缓存最近 5 个 clone。
 * - 内存护栏：单 clone 最多索引 MAX_DOCS_PER_INDEX 条 / MAX_INDEX_CHARS
 *   字符正文（≈2MB 堆）；超限部分不进倒排，检索时回退为流式子串扫描兜底。
 */

import type { BlobStore, WeCloneChunk } from '../store/blobStore'

// ---------------------------------------------------------------------------
// 参数与常量
// ---------------------------------------------------------------------------

const BM25_K1 = 1.5
const BM25_B = 0.75

/** LRU 缓存的索引个数上限 */
const LRU_MAX_INDEXES = 5
/** 单个 clone 索引的文档数上限 */
const MAX_DOCS_PER_INDEX = 20_000
/** 单个 clone 索引吸收的正文字符总量上限（控制堆占用 ≈2MB） */
const MAX_INDEX_CHARS = 1_000_000
/** 子串回退扫描的最大行数 */
const FALLBACK_SCAN_MAX_LINES = 20_000

const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'is', 'are', 'was', 'it',
  '的', '了', '是', '我', '你', '他', '她', '它', '我们', '你们', '他们', '在',
  '有', '和', '就', '不', '都', '一', '一个', '上', '也', '很', '到', '说',
  '要', '去', '会', '着', '没', '看', '好', '这', '那', '啊', '吧', '吗', '呢',
])

// ---------------------------------------------------------------------------
// 分词：ASCII 词元 + CJK bigram。纯函数。
// ---------------------------------------------------------------------------

const ASCII_TOKEN_RE = /[a-z0-9][a-z0-9_'+#./-]{0,23}/g
const CJK_RUN_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+/g

export function tokenize(text: string): string[] {
  const out: string[] = []
  const lower = String(text ?? '').toLowerCase()

  ASCII_TOKEN_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = ASCII_TOKEN_RE.exec(lower))) {
    const tok = m[0].replace(/[-.'_/#]+$/, '')
    if (!tok) continue
    if (/^\d{7,}$/.test(tok)) continue // 长数字串：脱敏域，不索引
    if (STOPWORDS.has(tok)) continue
    out.push(tok)
  }

  CJK_RUN_RE.lastIndex = 0
  while ((m = CJK_RUN_RE.exec(lower))) {
    const run = m[0]
    if (run.length === 1) {
      if (!STOPWORDS.has(run)) out.push(run)
      continue
    }
    for (let i = 0; i < run.length - 1; i += 1) out.push(run.slice(i, i + 2))
  }
  return out
}

// ---------------------------------------------------------------------------
// BM25 索引
// ---------------------------------------------------------------------------

interface IndexedDoc {
  chunk: WeCloneChunk
}

export class Bm25Index {
  private docs: IndexedDoc[] = []
  private docLen: number[] = []
  /** term → [docIdx, tf, docIdx, tf, ...] 平铺对 */
  private postings = new Map<string, number[]>()
  private avgdl = 1
  private finalized = false

  /** true = 语料超出上限，仅部分文档被索引 */
  truncated = false

  get docCount(): number {
    return this.docs.length
  }

  addDoc(chunk: WeCloneChunk, tokens: string[]): void {
    if (this.finalized) throw new Error('index finalized')
    const docIdx = this.docs.length
    this.docs.push({ chunk })
    this.docLen.push(tokens.length)
    const tfByTerm = new Map<string, number>()
    for (const t of tokens) tfByTerm.set(t, (tfByTerm.get(t) ?? 0) + 1)
    for (const [term, tf] of tfByTerm) {
      let arr = this.postings.get(term)
      if (!arr) {
        arr = []
        this.postings.set(term, arr)
      }
      arr.push(docIdx, tf)
    }
  }

  /** 计算 avgdl 并冻结结构 */
  finalize(): void {
    if (this.finalized) return
    let sum = 0
    for (const len of this.docLen) sum += len
    this.avgdl = this.docs.length > 0 ? Math.max(1, sum / this.docs.length) : 1
    this.finalized = true
  }

  /** Okapi BM25 打分，返回按分数降序的 {docIdx, score} 列表 */
  search(queryTokens: string[], topK: number): Array<{ docIdx: number; score: number }> {
    if (queryTokens.length === 0 || this.docs.length === 0) return []
    const n = this.docs.length
    const scores = new Map<number, number>()
    const seenTerms = new Set<string>()
    for (const term of queryTokens) {
      if (seenTerms.has(term)) continue
      seenTerms.add(term)
      const arr = this.postings.get(term)
      if (!arr || arr.length === 0) continue
      const df = arr.length / 2
      const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5))
      for (let i = 0; i < arr.length; i += 2) {
        const docIdx = arr[i]
        const tf = arr[i + 1]
        const dl = this.docLen[docIdx]
        const denom = tf + BM25_K1 * (1 - BM25_B + (BM25_B * dl) / this.avgdl)
        const gain = (idf * (tf * (BM25_K1 + 1))) / denom
        scores.set(docIdx, (scores.get(docIdx) ?? 0) + gain)
      }
    }
    return [...scores.entries()]
      .map(([docIdx, score]) => ({ docIdx, score }))
      .sort((a, b) => b.score - a.score)
      .slice(0, topK)
  }

  docAt(docIdx: number): WeCloneChunk | undefined {
    return this.docs[docIdx]?.chunk
  }
}

// ---------------------------------------------------------------------------
// 检索结果与管理器（懒构建 + LRU + 回退扫描）
// ---------------------------------------------------------------------------

export interface RetrievedChunk {
  cid: string
  sid: string
  ts: number
  text: string
  score: number
}

export class RetrievalManager {
  private cache = new Map<string, Bm25Index>()

  constructor(private blobs: BlobStore) {}

  /** 上传/删除后使索引失效 */
  invalidate(cloneId: string): void {
    this.cache.delete(cloneId)
  }

  get cachedCount(): number {
    return this.cache.size
  }

  /** 取索引（无则 readChunksForSearch 建一次）；语料为空返回 null */
  async getIndex(cloneId: string): Promise<Bm25Index | null> {
    const hit = this.cache.get(cloneId)
    if (hit) {
      // LRU touch：删除再插入保持插入序 = 使用序
      this.cache.delete(cloneId)
      this.cache.set(cloneId, hit)
      return hit
    }

    const chunks = await this.blobs.readChunksForSearch(cloneId, MAX_DOCS_PER_INDEX)
    if (chunks.length === 0) return null

    const index = new Bm25Index()
    let chars = 0
    for (const chunk of chunks) {
      if (index.docCount >= MAX_DOCS_PER_INDEX || chars >= MAX_INDEX_CHARS) {
        index.truncated = true
        break
      }
      chars += chunk.text.length
      index.addDoc(chunk, tokenize(chunk.text))
    }
    if (index.docCount === 0) return null
    index.finalize()

    this.cache.set(cloneId, index)
    while (this.cache.size > LRU_MAX_INDEXES) {
      const oldest = this.cache.keys().next().value
      if (oldest === undefined) break
      this.cache.delete(oldest)
    }
    return index
  }

  /**
   * 检索 top-K chunks（默认 8）。BM25 无命中时回退为流式子串扫描
   * （同时覆盖未入索引的超限尾部语料）。
   */
  async search(cloneId: string, query: string, topK = 8): Promise<RetrievedChunk[]> {
    const k = Math.max(1, Math.min(Math.floor(topK) || 8, 16))
    const index = await this.getIndex(cloneId)

    if (index) {
      const hits = index.search(tokenize(query), k)
      if (hits.length > 0) {
        const out: RetrievedChunk[] = []
        for (const h of hits) {
          const chunk = index.docAt(h.docIdx)
          if (!chunk || !chunk.text) continue
          out.push({
            cid: chunk.id ?? '',
            sid: chunk.sid ?? '',
            ts: chunk.ts ?? 0,
            text: chunk.text,
            score: h.score,
          })
        }
        if (out.length > 0) return out
      }
    }

    return this.fallbackSubstringScan(cloneId, query, k)
  }

  /** 回退：流式子串匹配（不落缓存，覆盖未入索引部分） */
  private async fallbackSubstringScan(cloneId: string, query: string, topK: number): Promise<RetrievedChunk[]> {
    const needle = String(query ?? '').trim().toLowerCase().slice(0, 48)
    if (!needle) return []
    const found: RetrievedChunk[] = []
    let scanned = 0
    for await (const chunk of this.blobs.loadChunksStream(cloneId)) {
      scanned += 1
      if (scanned > FALLBACK_SCAN_MAX_LINES) break
      const text = String(chunk.text ?? '')
      if (text.toLowerCase().includes(needle)) {
        found.push({ cid: chunk.id ?? '', sid: chunk.sid ?? '', ts: chunk.ts ?? 0, text, score: 0 })
      }
      if (found.length >= topK) break
    }
    return found
  }
}
