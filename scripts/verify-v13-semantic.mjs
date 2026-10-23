/** Real local-model bilingual recall evaluation. Start local-embedding-server.py first.
 * Only synthetic public fixtures are used. Receipt never includes private content.
 */
import { build } from 'esbuild'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir, cpus, totalmem } from 'node:os'
import { performance } from 'node:perf_hooks'

const root = resolve(process.env.WEPORT_SEMANTIC_OUT || '.ui-probe/v13-semantic'); mkdirSync(root, { recursive: true })
const fixtureBytes = readFileSync('scripts/fixtures/semantic-recall.json')
const fixture = JSON.parse(fixtureBytes)
const config = {
  enabled: true, endpoint: process.env.WEPORT_EMBEDDING_ENDPOINT || 'http://127.0.0.1:5083/v1/embeddings',
  model: process.env.WEPORT_EMBEDDING_MODEL || 'Xenova/multilingual-e5-small',
  revision: process.env.WEPORT_EMBEDDING_REVISION || 'e3b222633d142ec3041c486c4537b027807035608f159d8fd99d4a858a2e51e7',
  queryPrefix: process.env.WEPORT_EMBEDDING_QUERY_PREFIX ?? 'query: ',
  passagePrefix: process.env.WEPORT_EMBEDDING_PASSAGE_PREFIX ?? 'passage: ',
}
await build({ entryPoints: ['electron/services/searchIndexService.ts'], outfile: join(root, 'search.cjs'), bundle: true, platform: 'node', format: 'cjs' })
const { SearchIndexService } = createRequire(import.meta.url)(join(root, 'search.cjs'))
const dir = mkdtempSync(join(tmpdir(), 'weport-recall-'))
const md5 = text => createHash('md5').update(text).digest('hex')
const groups = new Map()
for (const [id, session, text] of fixture.documents) {
  const table = `Msg_${md5(session)}`
  if (!groups.has(table)) groups.set(table, [])
  groups.get(table).push({ local_id: Number(id), server_id: `900719925474${id.padStart(4, '0')}`, local_type: 1,
    create_time: 1700000000 + Number(id), is_send: 0, sender_username: 'fixture-sender', message_content: text })
}
const db = join(dir, 'message_0.db'); writeFileSync(db, 'fixture')
const source = {
  listMessageDbs: async () => [db], listTables: async () => [...groups.keys()],
  getSessions: async () => [...new Set(fixture.documents.map(d => d[1]))].map(username => ({ username, displayName: username })),
  getDisplayNames: async () => ({}),
  execQuery: async (_db, sql) => {
    const table = /FROM "([^"]+)"/.exec(sql)?.[1]; const rows = groups.get(table) || []
    if (sql.includes('max(rowid)')) return [{ rowid_max: Math.max(0, ...rows.map(r => r.local_id)), local_max: Math.max(0, ...rows.map(r => r.local_id)) }]
    const match = /WHERE (?:rowid|local_id) > (\d+).*LIMIT (\d+)/.exec(sql)
    if (match) return rows.filter(r => r.local_id > Number(match[1])).slice(0, Number(match[2])).map(r => ({ ...r,
      __weport_local_id_text: String(r.local_id), __weport_server_id_text: r.server_id }))
    throw new Error('Unexpected fixture SQL shape')
  },
}
const options = { rootDir: join(dir, 'search'), source, decodeText: row => ({ text: row.message_content, senderUsername: row.sender_username }),
  resolveWxid: () => 'synthetic-recall', resolveDbPath: () => dir, semantic: () => config }
try {
  let service = new SearchIndexService(options)
  await service.build()
  const start = performance.now(); const built = await service.buildSemantic(); const buildMs = performance.now() - start
  const results = []
  for (const mode of ['lexical', 'semantic', 'hybrid']) {
    const rows = []
    for (let i = 0; i < fixture.queries.length; i++) {
      const query = fixture.queries[i]
      const start = performance.now()
      const result = await service.query({ text: query.text, retrieval: mode, limit: 5 })
      if (result.error) throw new Error(result.error)
      const ids = result.hits.map(hit => hit.localId)
      rows.push({ query: i + 1, kind: query.kind, top5: ids, hit1: query.relevant.includes(ids[0]), hit5: ids.some(id => query.relevant.includes(id)),
        reciprocalRank: ids.some(id => query.relevant.includes(id)) ? 1 / (ids.findIndex(id => query.relevant.includes(id)) + 1) : 0,
        elapsedMs: performance.now() - start })
      // Every row preserves account, physical table, decimal ID and exact content hash.
      for (const hit of result.hits) {
        const doc = fixture.documents.find(d => d[0] === hit.localId)
        if (!doc || hit.table !== `Msg_${md5(doc[1])}` || hit.db !== 'message_0.db' || hit.accountId !== 'synthetic-recall' ||
          hit.contentHash !== createHash('sha256').update(doc[2]).digest('hex')) throw new Error('Exact source provenance mismatch')
      }
    }
    const latencies = rows.map(row => row.elapsedMs).sort((a, b) => a - b)
    results.push({ mode, recallAt1: rows.filter(r => r.hit1).length / rows.length, recallAt5: rows.filter(r => r.hit5).length / rows.length,
      p95Ms: latencies[Math.ceil(latencies.length * .95) - 1], queries: rows })
  }
  // Fresh service exercises disk reload and narrow sender/chat/date scope before top-K.
  service = new SearchIndexService(options)
  const coldStart = performance.now()
  const scoped = await service.query({ text: 'customer presentation afternoon', retrieval: 'hybrid',
    scope: { sessionIds: ['context'], from: 1700000024, to: 1700000024 }, limit: 5 })
  if (scoped.error || scoped.hits.some(h => h.localId !== '24') || !scoped.hits.length || scoped.coverage.semantic.scoredWindows !== 1 ||
      scoped.hits.some(h => h.semanticContext.some(m => m.localId !== '24'))) throw new Error('Scope-first singleton retrieval failed')
  const receipt = { timestamp: new Date().toISOString(), fixtureSha256: createHash('sha256').update(fixtureBytes).digest('hex'),
    model: config.model, revision: config.revision, upstreamRevision: process.env.WEPORT_EMBEDDING_UPSTREAM_REVISION || '761b726dd34fb83930e26aab4e9ac3899aa1fa78',
    preprocessing: { queryPrefix: config.queryPrefix, passagePrefix: config.passagePrefix },
    runtime: { node: process.version, platform: process.platform, cpu: cpus()[0]?.model, logicalCpus: cpus().length, systemMemory: totalmem(), processMemory: process.memoryUsage() },
    documents: fixture.documents.length, queries: fixture.queries.length, built, buildMs, scopedColdMs: performance.now() - coldStart,
    exactProvenance: true, scopeFirst: true, results,
    limitations: ['Small synthetic hand-labeled set; not representative private-history quality.', 'One context query; contextual quality needs broader evaluation.',
      'Cosine reranking is capped at 20,000 local windows and 200 retained anchors; larger sources explicitly disclose partial coverage.',
      'No native source-opening acceptance is inferred from fixture identity checks.'] }
  writeFileSync(join(root, 'result.json'), JSON.stringify(receipt, null, 2))
  console.log(JSON.stringify({ documents: receipt.documents, queries: receipt.queries, buildMs, results: results.map(({ queries, ...summary }) => summary), scopeFirst: true, exactProvenance: true }))
  if (results.find(r => r.mode === 'hybrid').recallAt5 <= results.find(r => r.mode === 'lexical').recallAt5) throw new Error('No measured hybrid recall benefit')
} finally { rmSync(dir, { recursive: true, force: true }) }
