/** Private generated-data verification. Never opens Electron or a WeChat database.
 * Run: node --expose-gc scripts/verify-v13-search.mjs [--million]
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, cpSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import { build } from 'esbuild'

const root = mkdtempSync(join(tmpdir(), 'weport-v13-search-'))
const receipt = { generatedAt: new Date().toISOString(), platform: process.platform, node: process.version,
  source: 'generated-only; production SearchIndexService and AnnotationsService', checks: [], measurements: [] }
const table = `Msg_${createHash('md5').update('fixture-chat').digest('hex')}`
const db = join(root, 'source', 'message_0.db')
const check = (label, condition) => { assert.ok(condition, label); receipt.checks.push(label) }
try {
  await build({ stdin: { contents: "export { SearchIndexService } from './electron/services/searchIndexService'; export { AnnotationsService } from './electron/services/annotationsService'", resolveDir: process.cwd() },
    bundle: true, platform: 'node', format: 'cjs', outfile: join(root, 'services.cjs'), logLevel: 'silent' })
  const { SearchIndexService, AnnotationsService } = createRequire(import.meta.url)(join(root, 'services.cjs'))
  let account = 'fixture-account-a'
  let rows = Array.from({ length: 40 }, (_, i) => ({ local_id: i + 1, server_id: String(1000 + i),
    local_type: 1, create_time: 1700000000 + i, is_send: 0,
    message_content: `普通 message ${i + 1}`, sender_username: 'fixture-sender' }))
  const source = {
    listMessageDbs: async () => [db], listTables: async () => [table],
    getSessions: async () => [{ username: 'fixture-chat', displayName: 'Fixture chat' }],
    execQuery: async (_path, sql) => {
      if (/SELECT max\(/.test(sql)) return [{ rowid_max: Math.max(0, ...rows.map(r => r.local_id)), local_max: Math.max(0, ...rows.map(r => r.local_id)) }]
      const match = /WHERE \w+ > (-?\d+) ORDER BY \w+ ASC LIMIT (\d+)/.exec(sql)
      assert.ok(match, 'source queries remain SELECT cursor batches')
      return rows.filter(r => r.local_id > Number(match[1])).slice(0, Number(match[2])).map(r => ({ ...r,
        __weport_local_id_text: String(r.local_id), __weport_server_id_text: String(r.server_id) }))
    },
  }
  const indexRoot = join(root, 'index')
  const options = { rootDir: indexRoot, source, resolveWxid: () => account,
    decodeText: row => ({ text: row.message_content, senderUsername: row.sender_username }), log: () => {} }
  const service = new SearchIndexService(options)
  rows[5].message_content = '中文合同 AlphaBeta MIX-2026'
  rows[6].message_content = '中文合同 alphabeta MIX-2026'
  await service.build({ force: true })
  let result = await service.query({ text: '合同 ALPHABETA mix-2026' })
  check('Chinese/English/mixed case AND query returns both exact rows', result.total === 2)
  check('exact db/table/local-ID provenance survives search', result.hits.every(h => h.db === 'message_0.db' && h.table === table && ['6', '7'].includes(h.localId)))
  result = await service.query({ text: '合同', scope: { from: 1700000005000, to: 1700000005000, sessionIds: ['fixture-chat'], senders: ['fixture-sender'], kinds: ['text'] } })
  check('inclusive millisecond date/session/sender/kind boundaries', result.total === 1 && result.hits[0].localId === '6')
  check('seconds date compatibility', (await service.query({ text: '合同', scope: { from: 1700000005, to: 1700000005 } })).total === 1)
  check('excluded session has no results', (await service.query({ text: '合同', scope: { sessionIds: ['other-chat'] } })).total === 0)
  account = 'fixture-account-b'
  check('unindexed account cannot query account A corpus', (await service.query({ text: '合同' })).total === 0)
  account = 'fixture-account-a'
  check('returning account reloads its persisted corpus', (await service.query({ text: '合同' })).total === 2)
  rows[39].message_content = 'tail-edit-current'
  await service.build()
  check('tail refresh absorbs recent in-place edit', (await service.query({ text: 'tail-edit-current' })).total === 1)
  rows[0].message_content = 'old-edit-needs-force'
  rows = rows.filter(r => r.local_id !== 6)
  rows.push({ ...rows[0], local_id: 41, message_content: 'new-row-backfill' })
  await service.build()
  check('incremental new-row backfill', (await service.query({ text: 'new-row-backfill' })).total === 1)
  check('default reconciliation repairs edits outside the old tail window', (await service.query({ text: 'old-edit-needs-force' })).total === 1)
  check('default reconciliation removes deleted rows', (await service.query({ text: '合同' })).total === 1)
  await service.build({ force: true })
  check('forced rebuild repairs old edits and deletions', (await service.query({ text: 'old-edit-needs-force' })).total === 1 && (await service.query({ text: '合同' })).total === 1)
  const relocated = join(root, 'relocated-index')
  cpSync(indexRoot, relocated, { recursive: true })
  check('explicitly copied index reloads from alternate root', (await new SearchIndexService({ ...options, rootDir: relocated }).query({ text: '合同' })).total === 1)
  const annotations = new AnnotationsService({ userDataDir: join(root, 'annotations'), resolveAccountId: () => account, log: () => {} })
  annotations.mutate({ op: 'tag.add', payload: { sessionIds: ['fixture-chat'], tag: 'A-only' } })
  account = 'fixture-account-b'
  check('annotation account B cannot see A tag', Object.keys(annotations.list().tags).length === 0)
  annotations.mutate({ op: 'tag.add', payload: { sessionIds: ['fixture-chat'], tag: 'B-only' } })
  account = 'fixture-account-a'
  check('annotations restore original account independently', annotations.list().tags['fixture-chat'].join() === 'A-only')
  const annotationsRoot = join(root, 'relocated-annotations')
  cpSync(join(root, 'annotations'), annotationsRoot, { recursive: true })
  check('explicitly copied annotations reload at alternate userData root', new AnnotationsService({ userDataDir: annotationsRoot, resolveAccountId: () => account, log: () => {} }).list().tags['fixture-chat'].join() === 'A-only')

  for (const count of (process.argv.includes('--million') ? [100000, 1000000] : [100000])) {
    // Each benchmark gets its own process so prior corpora cannot inflate its RAM.
    const worker = `const { SearchIndexService } = require(${JSON.stringify(join(root, 'services.cjs'))});
      const { performance } = require('node:perf_hooks');
      const count = ${count}; const table = ${JSON.stringify(table)}; const db = ${JSON.stringify(db)};
      const text = i => i % 997 === 0 ? '中文合同 AlphaBeta mixed-2026 ' + i : '普通聊天 baseline message ' + i;
      const source = { listMessageDbs: async () => [db], listTables: async () => [table], getSessions: async () => [{ username: 'fixture-chat' }],
        execQuery: async (_, sql) => { if (/SELECT max\\(/.test(sql)) return [{rowid_max: count, local_max: count}];
          const m = /WHERE \\w+ > (-?\\d+) ORDER BY \\w+ ASC LIMIT (\\d+)/.exec(sql); if (!m) throw new Error('unexpected SQL');
          const out=[]; for(let i=Number(m[1])+1; i<=Math.min(count,Number(m[1])+Number(m[2]));i++)out.push({local_id:i,server_id:String(1000000+i),__weport_local_id_text:String(i),__weport_server_id_text:String(1000000+i),local_type:1,create_time:1700000000+i,message_content:text(i)}); return out; } };
      (async()=> { let service=new SearchIndexService({rootDir:${JSON.stringify(join(root, 'bench-' + count))},source,resolveWxid:()=> 'benchmark',decodeText:r=>({text:r.message_content}),log:()=>{},batchSize:5000});
        console.error('benchmark stage: build');
        const start=performance.now();const built=await service.build({force:true}); const buildMs=performance.now()-start;
        if(built.docs!==count)throw new Error('benchmark corpus incomplete: '+JSON.stringify(built));
        global.gc?.(); const memory=process.memoryUsage(); const queries=[];
        for(const query of ['合同','ALPHABETA','合同 ALPHABETA mixed-2026','no-such-token-unique','普通']) { const runs=[];let result;
          for(let i=0;i<20;i++){const t=performance.now();result=await service.query({text:query,limit:30});runs.push(Math.round((performance.now()-t)*100)/100);}
          if(query==='no-such-token-unique' && result.total!==0)throw new Error('absent query mismatch');
          if(['合同','ALPHABETA','合同 ALPHABETA mixed-2026'].includes(query) && result.total!==Math.floor(count/997))throw new Error('sparse exact count mismatch');
          if(query==='普通' && !result.truncated)throw new Error('broad result cap must be explicit');
          queries.push({query,runsMs:runs,p95Ms:[...runs].sort((a,b)=>a-b)[18],total:result.total,truncated:result.truncated,coverage:result.coverage}); }
        console.error('benchmark stage: cold reload');
        service = null; global.gc?.();
        const restarted = new SearchIndexService({rootDir:${JSON.stringify(join(root, 'bench-' + count))},source,resolveWxid:()=> 'benchmark',decodeText:r=>({text:r.message_content}),log:()=>{}});
        const coldStart=performance.now();const coldResult=await restarted.query({text:'合同'});const coldMs=performance.now()-coldStart;
        if(coldResult.total!==Math.floor(count/997))throw new Error('cold reload mismatch');
        console.log(JSON.stringify({count,buildMs:Math.round(buildMs),coldReloadQueryMs:Math.round(coldMs),buildTruncated:built.truncated,bytes:built.bytes,heapUsedMiB:Math.round(memory.heapUsed/1048576),rssMiB:Math.round(memory.rss/1048576),queries})); })().catch(e=>{console.error(e);process.exitCode=1});`
    const workerPath = join(root, 'worker.cjs')
    writeFileSync(workerPath, worker)
    const requestedHeap = process.argv.find(value => value.startsWith('--heap-mib='))?.split('=')[1] || '4096'
    if (!/^\d+$/.test(requestedHeap)) throw Error('Invalid --heap-mib value')
    const result = spawnSync(process.execPath, ['--expose-gc', `--max-old-space-size=${requestedHeap}`, workerPath], { encoding: 'utf8', timeout: 240000, maxBuffer: 1024 * 1024, windowsHide: true })
    assert.equal(result.status, 0, result.stderr || 'benchmark failed')
    receipt.measurements.push(JSON.parse(result.stdout.trim()))
  }
  const outputDir = resolve('.ui-probe')
  mkdirSync(outputDir, { recursive: true })
  writeFileSync(join(outputDir, 'v13-search-receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
  console.log(JSON.stringify(receipt, null, 2))
} finally {
  rmSync(root, { recursive: true, force: true })
}
