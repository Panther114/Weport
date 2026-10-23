/** Optional local embeddings. No downloads, cloud fallback or implicit builds. */
import { createHash } from 'crypto'
import { readFileSync, statSync } from 'fs'
import { join } from 'path'
import { gzipSync, gunzipSync } from 'zlib'
import { writeFileAtomic } from './atomicJson'

export interface LocalEmbeddingConfig {
  enabled: boolean
  /** Literal loopback only; OpenAI-compatible embedding endpoint. */
  endpoint: string
  model: string
  /** Pin a model digest/revision, not a mutable tag alone. */
  revision: string
  queryPrefix?: string
  passagePrefix?: string
}
export interface SemanticDocument {
  docKey: string; sessionId: string; tableKey: string; ts: number; text: string
}
export interface SemanticPartition { accountId: string; sourceId: string; generation: number }
interface Window { anchor: string; members: string[]; hash: string; vector: number[] }
interface Snapshot {
  version: number; partition: SemanticPartition; model: string; revision: string
  configHash: string; documentHash: string; dimensions: number; documents: number; windows: Window[]; truncated: boolean
}
export interface SemanticCoverage {
  model: string; revision: string; indexedDocuments: number; eligibleWindows: number
  scoredWindows: number; rerankedCandidates: number; truncated: boolean; error?: string
}
export interface SemanticMatch { docKey: string; members: string[]; score: number }
export interface SemanticBuildOptions {
  maxDocuments?: number; maxCharacters?: number; shouldCancel?: () => boolean
  onProgress?: (completed: number, total: number) => void
}
const VERSION = 1
const MAX_WINDOWS = 20_000
const MAX_FILE_BYTES = 128 * 1024 * 1024
const MAX_CHARACTERS = 8_000_000
const MAX_TEXT = 1600
const MAX_DIMENSIONS = 4096
const hash = (value: string): string => createHash('sha256').update(value).digest('hex')
const configHash = (config: LocalEmbeddingConfig): string => hash(JSON.stringify(config))
function documentHash(docs: SemanticDocument[]): string {
  const digest = createHash('sha256')
  for (const d of docs) digest.update(JSON.stringify([d.docKey, d.sessionId, d.tableKey, d.ts, d.text]))
  return digest.digest('hex')
}
export function validateLocalEmbeddingConfig(config: LocalEmbeddingConfig): URL {
  if (config.enabled !== true) throw new Error('Local semantic retrieval is disabled')
  const endpoint = new URL(config.endpoint)
  if (!['http:', 'https:'].includes(endpoint.protocol) || !['127.0.0.1', '[::1]'].includes(endpoint.hostname) ||
      endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new Error('Embedding endpoint must use a literal loopback address without credentials or query parameters')
  }
  if (!config.model.trim() || !config.revision.trim() || config.model.length > 256 || config.revision.length > 256) {
    throw new Error('A local model and pinned revision are required')
  }
  if ((config.queryPrefix || '').length > 100 || (config.passagePrefix || '').length > 100) throw new Error('Embedding prefix exceeds limit')
  return endpoint
}
function normalize(vector: unknown): number[] {
  if (!Array.isArray(vector) || !vector.length || vector.length > MAX_DIMENSIONS || vector.some(x => typeof x !== 'number' || !Number.isFinite(x))) {
    throw new Error('Invalid local embedding vector')
  }
  const norm = Math.sqrt(vector.reduce((sum, x) => sum + x * x, 0))
  if (!Number.isFinite(norm) || norm < 1e-12) throw new Error('Invalid local embedding norm')
  return vector.map(x => x / norm)
}
export async function embedLocal(config: LocalEmbeddingConfig, texts: string[], query = false): Promise<number[][]> {
  const endpoint = validateLocalEmbeddingConfig(config)
  if (!texts.length || texts.length > 16 || texts.some(text => text.length > MAX_TEXT)) throw new Error('Embedding batch exceeds local limits')
  const response = await fetch(endpoint, {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30_000),
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: config.model, revision: config.revision,
      input: texts.map(text => `${(query ? config.queryPrefix : config.passagePrefix) || ''}${text}`) }),
  })
  if (!response.ok || !response.body) throw new Error(`Local embedding request failed (${response.status})`)
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0
  try {
    while (true) {
      const part = await reader.read(); if (part.done) break
      size += part.value.length
      if (size > 4 * 1024 * 1024) { await reader.cancel(); throw new Error('Local embedding response exceeds limit') }
      chunks.push(part.value)
    }
  } finally { reader.releaseLock() }
  const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  if (payload.model !== config.model || payload.revision !== config.revision) {
    throw new Error('Local embedding server must return the configured model and pinned revision')
  }
  if (!Array.isArray(payload.data) || payload.data.length !== texts.length) throw new Error('Local embedding response count mismatch')
  const data = [...payload.data].sort((a, b) => a.index - b.index)
  const vectors = data.map((item, i) => {
    if (item.index !== i) throw new Error('Local embedding response indices mismatch')
    return normalize(item.embedding)
  })
  if (vectors.some(vector => vector.length !== vectors[0].length)) throw new Error('Local embedding dimensions mismatch')
  return vectors
}

export class SemanticIndex {
  private snapshot?: Snapshot
  constructor(private readonly rootDir: string) {}
  private path(partition: SemanticPartition, config: LocalEmbeddingConfig): string {
    return join(this.rootDir, 'semantic-v1', hash(JSON.stringify([partition, configHash(config)])) + '.json.gz')
  }
  private load(partition: SemanticPartition, config: LocalEmbeddingConfig, docs: SemanticDocument[]): Snapshot {
    validateLocalEmbeddingConfig(config)
    const identity = JSON.stringify(partition); const signature = documentHash(docs)
    const valid = (snapshot: Snapshot): boolean => snapshot.version === VERSION &&
      JSON.stringify(snapshot.partition) === identity && snapshot.configHash === configHash(config) && snapshot.documentHash === signature
    if (this.snapshot && valid(this.snapshot)) return this.snapshot
    const path = this.path(partition, config)
    if (statSync(path).size > MAX_FILE_BYTES) throw new Error('Local semantic index exceeds limit')
    const envelope = JSON.parse(gunzipSync(readFileSync(path), { maxOutputLength: MAX_FILE_BYTES }).toString('utf8'))
    if (typeof envelope.body !== 'string' || envelope.sha256 !== hash(envelope.body)) throw new Error('Local semantic index checksum mismatch')
    const snapshot = JSON.parse(envelope.body) as Snapshot
    if (!valid(snapshot) || snapshot.windows.length > MAX_WINDOWS || snapshot.dimensions < 1 || snapshot.dimensions > MAX_DIMENSIONS) {
      throw new Error('Local semantic index is unavailable for this account/source/model; build it first')
    }
    const keys = new Set(docs.map(d => d.docKey))
    for (const window of snapshot.windows) {
      if (!keys.has(window.anchor) || !window.members.includes(window.anchor) || window.members.length > 3 ||
          window.members.some(key => !keys.has(key)) || window.vector.length !== snapshot.dimensions) throw new Error('Invalid semantic source provenance')
      window.vector = normalize(window.vector)
    }
    this.snapshot = snapshot
    return snapshot
  }

  async build(partition: SemanticPartition, config: LocalEmbeddingConfig, allDocs: SemanticDocument[],
    allowed: (doc: SemanticDocument) => boolean, options: SemanticBuildOptions = {}): Promise<{ documents: number; windows: number; truncated: boolean }> {
    validateLocalEmbeddingConfig(config)
    const maximum = Math.max(1, Math.min(10_000, options.maxDocuments || 10_000))
    const charBudget = Math.max(1, Math.min(MAX_CHARACTERS, options.maxCharacters || MAX_CHARACTERS))
    // Scope filtering precedes grouping, clipping, window creation and all model calls.
    const eligible = allDocs.filter(allowed)
    const docs = eligible.slice(0, maximum).sort((a, b) => a.sessionId.localeCompare(b.sessionId) || a.tableKey.localeCompare(b.tableKey) || a.ts - b.ts || a.docKey.localeCompare(b.docKey))
    const windows: Window[] = []; const texts: string[] = []; let characters = 0
    let truncated = eligible.length > docs.length
    for (let i = 0; i < docs.length; i++) {
      const anchor = docs[i]
      const neighbors = docs.slice(Math.max(0, i - 1), i + 2).filter(d => d.sessionId === anchor.sessionId && d.tableKey === anchor.tableKey && Math.abs(d.ts - anchor.ts) <= 300)
      // Singletons keep narrow sender/date scopes usable without vectors influenced by forbidden context.
      for (const members of neighbors.length > 1 ? [[anchor], neighbors] : [[anchor]]) {
        const text = members.map(d => d.text.slice(0, Math.floor(MAX_TEXT / members.length) - 1)).join('\n')
        if (windows.length >= MAX_WINDOWS || characters + text.length > charBudget) { truncated = true; break }
        characters += text.length; texts.push(text)
        windows.push({ anchor: anchor.docKey, members: members.map(d => d.docKey), hash: hash(text), vector: [] })
      }
      if (truncated && (windows.length >= MAX_WINDOWS || characters >= charBudget - MAX_TEXT)) break
    }
    let dimensions = 0
    for (let offset = 0; offset < windows.length; offset += 16) {
      if (options.shouldCancel?.()) throw new Error('Local semantic indexing cancelled or source changed')
      const vectors = await embedLocal(config, texts.slice(offset, offset + 16))
      if (dimensions && dimensions !== vectors[0].length) throw new Error('Local model dimensions changed during indexing')
      dimensions = vectors[0].length
      vectors.forEach((vector, i) => { windows[offset + i].vector = vector })
      options.onProgress?.(Math.min(offset + 16, windows.length), windows.length)
      await new Promise(resolve => setImmediate(resolve))
    }
    if (options.shouldCancel?.()) throw new Error('Local semantic indexing cancelled or source changed')
    if (!windows.length) throw new Error('No scoped documents to embed')
    const snapshot: Snapshot = { version: VERSION, partition, configHash: configHash(config), documentHash: documentHash(allDocs),
      model: config.model, revision: config.revision, dimensions, documents: new Set(windows.map(w => w.anchor)).size, windows, truncated }
    const body = JSON.stringify(snapshot)
    if (Buffer.byteLength(body) > MAX_FILE_BYTES - 1024) throw new Error('Local semantic index exceeds limit')
    writeFileAtomic(this.path(partition, config), gzipSync(JSON.stringify({ body, sha256: hash(body) })), { sync: true })
    this.snapshot = snapshot
    return { documents: snapshot.documents, windows: windows.length, truncated }
  }

  async search(partition: SemanticPartition, config: LocalEmbeddingConfig, docs: SemanticDocument[],
    allowed: (doc: SemanticDocument) => boolean, text: string, limit = 200): Promise<{ matches: SemanticMatch[]; coverage: SemanticCoverage }> {
    const snapshot = this.load(partition, config, docs)
    const eligible = new Set(docs.filter(allowed).map(doc => doc.docKey))
    // A contextual vector is eligible only if every contributing message is inside scope.
    const windows = snapshot.windows.filter(window => window.members.every(key => eligible.has(key)))
    const covered = new Set(windows.map(window => window.anchor))
    const coverage: SemanticCoverage = { model: config.model, revision: config.revision, indexedDocuments: snapshot.documents,
      eligibleWindows: windows.length, scoredWindows: 0, rerankedCandidates: 0, truncated: snapshot.truncated || covered.size < eligible.size }
    if (!windows.length) return { matches: [], coverage }
    const [query] = await embedLocal(config, [text.slice(0, MAX_TEXT)], true)
    if (query.length !== snapshot.dimensions) throw new Error('Local model dimensions changed; rebuild semantic index')
    const best = new Map<string, SemanticMatch>()
    for (let i = 0; i < windows.length; i++) {
      const window = windows[i]
      const score = query.reduce((sum, value, j) => sum + value * window.vector[j], 0)
      coverage.scoredWindows++
      if (!best.has(window.anchor) || best.get(window.anchor)!.score < score) best.set(window.anchor, { docKey: window.anchor, members: window.members, score })
      if ((i & 1023) === 1023) await new Promise(resolve => setImmediate(resolve))
    }
    const matches = [...best.values()].sort((a, b) => b.score - a.score || a.docKey.localeCompare(b.docKey)).slice(0, Math.min(200, Math.max(1, limit)))
    coverage.rerankedCandidates = matches.length
    if (best.size > matches.length) coverage.truncated = true
    return { matches, coverage }
  }
}
