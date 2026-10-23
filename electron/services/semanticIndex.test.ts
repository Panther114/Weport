import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'http'
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { embedLocal, SemanticIndex, validateLocalEmbeddingConfig, type LocalEmbeddingConfig, type SemanticDocument } from './semanticIndex'

let server: Server; let dir: string; let config: LocalEmbeddingConfig; let inputs: string[][]
let respond: ((request: any) => any) | undefined
const partition = { accountId: 'alice', sourceId: 'source-A', generation: 1 }
const docs: SemanticDocument[] = [
  { docKey: 'db#table#local#9007199254740993', tableKey: 'db#table', sessionId: 'allowed', ts: 100, text: 'budget approved' },
  { docKey: 'db#table#local#2', tableKey: 'db#table', sessionId: 'allowed', ts: 110, text: 'private neighbor' },
  { docKey: 'db#other#local#1', tableKey: 'db#other', sessionId: 'denied', ts: 120, text: 'forbidden project' },
]
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'weport-semantic-')); inputs = []; respond = undefined
  server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk
    const request = JSON.parse(body); inputs.push(request.input)
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify(respond?.(request) || { model: request.model, revision: request.revision,
      data: request.input.map((text: string, index: number) => ({ index, embedding: text.includes('budget') ? [1, 0] : [0, 1] })) }))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  config = { enabled: true, endpoint: `http://127.0.0.1:${(server.address() as any).port}/v1/embeddings`, model: 'test-encoder', revision: 'artifact-sha' }
})
afterEach(async () => { await new Promise<void>(resolve => server.close(() => resolve())); rmSync(dir, { recursive: true, force: true }) })

describe('opt-in local semantic index boundaries (synthetic vectors, not a quality evaluation)', () => {
  it('rejects cloud endpoints, DNS names, credentials, query strings and disabled mode', () => {
    for (const endpoint of ['https://example.com/v1/embeddings', 'http://localhost:5034/v1/embeddings', 'http://user@127.0.0.1', 'http://127.0.0.1/?key=secret']) {
      expect(() => validateLocalEmbeddingConfig({ ...config, endpoint })).toThrow()
    }
    expect(() => validateLocalEmbeddingConfig({ ...config, enabled: false })).toThrow()
  })
  it('filters scope before embedding and never includes a denied contextual neighbor', async () => {
    const index = new SemanticIndex(dir)
    await index.build(partition, config, docs, d => d.docKey === docs[0].docKey)
    expect(inputs.flat()).toEqual(['budget approved'])
    const result = await index.search(partition, config, docs, d => d.docKey === docs[0].docKey, 'budget')
    expect(result.matches[0].docKey).toBe(docs[0].docKey)
    expect(result.matches[0].members).toEqual([docs[0].docKey])
    expect(result.coverage.eligibleWindows).toBe(1)
  })
  it('retains singletons for narrow scopes while filtering every contextual member', async () => {
    const index = new SemanticIndex(dir)
    await index.build(partition, config, docs, () => true)
    expect(inputs.flat()).toContain('budget approved\nprivate neighbor')
    const { matches, coverage } = await index.search(partition, config, docs, d => d.docKey === docs[0].docKey, 'budget')
    expect(coverage.scoredWindows).toBe(1)
    expect(matches.map(m => m.members)).toEqual([[docs[0].docKey]])
  })
  it('reloads committed vectors but rejects account, source, generation, model and content changes', async () => {
    await new SemanticIndex(dir).build(partition, config, docs, () => true)
    expect((await new SemanticIndex(dir).search(partition, config, docs, () => true, 'budget')).matches.map(m => m.docKey)).toContain(docs[0].docKey)
    for (const altered of [{ ...partition, accountId: 'bob' }, { ...partition, sourceId: 'source-B' }, { ...partition, generation: 2 }]) {
      await expect(new SemanticIndex(dir).search(altered, config, docs, () => true, 'budget')).rejects.toThrow()
    }
    await expect(new SemanticIndex(dir).search(partition, { ...config, revision: 'new' }, docs, () => true, 'budget')).rejects.toThrow()
    await expect(new SemanticIndex(dir).search(partition, config, [{ ...docs[0], text: 'edited' }, ...docs.slice(1)], () => true, 'budget')).rejects.toThrow()
  })
  it('fails closed on model revision drift, invalid dimensions and broken response indices', async () => {
    for (const payload of [
      { model: config.model, revision: 'drift', data: [{ index: 0, embedding: [1, 0] }] },
      { model: config.model, revision: config.revision, data: [{ index: 1, embedding: [1, 0] }] },
      { model: config.model, revision: config.revision, data: [{ index: 0, embedding: [0, 0] }] },
    ]) {
      respond = () => payload
      await expect(embedLocal(config, ['budget'])).rejects.toThrow()
    }
  })
  it('retains prior snapshot when canceled and rejects corrupted persisted vectors', async () => {
    const index = new SemanticIndex(dir)
    await index.build(partition, config, docs, () => true)
    await expect(index.build(partition, config, docs, () => true, { shouldCancel: () => true })).rejects.toThrow('cancelled')
    expect((await new SemanticIndex(dir).search(partition, config, docs, () => true, 'budget')).matches.length).toBe(3)
    const file = readdirSync(join(dir, 'semantic-v1'))[0]
    writeFileSync(join(dir, 'semantic-v1', file), 'damaged')
    await expect(new SemanticIndex(dir).search(partition, config, docs, () => true, 'budget')).rejects.toThrow()
  })
  it('discloses bounded indexing and unindexed scoped documents', async () => {
    const index = new SemanticIndex(dir)
    const built = await index.build(partition, config, docs, () => true, { maxDocuments: 1 })
    expect(built.truncated).toBe(true)
    const result = await index.search(partition, config, docs, () => true, 'budget')
    expect(result.coverage.truncated).toBe(true)
    expect(result.coverage.indexedDocuments).toBe(1)
  })
})
