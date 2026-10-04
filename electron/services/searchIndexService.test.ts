import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, truncateSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createHash } from 'crypto'
import { SearchIndexService, type SearchIndexDocSource, type SearchIndexServiceOptions } from './searchIndexService'

/**
 * 搜索索引（v1.2 §6 引擎侧）。
 *
 * 假数据源实现了服务真正用到的那三条 SQL 形态（max(rowid)/max(local_id)、
 * `WHERE <id> > x ORDER BY <id> LIMIT n`），所以增量逻辑是被真跑的，而不是被绕过。
 *
 * 守的故障：
 *   1. 重建一次索引把上次的成果也重算一遍（增量失效 → 每次启动都卡）；
 *   2. 索引文件写坏/被截断，整个搜索直接报错（应该跳过坏分片、还能用、下次自愈）；
 *   3. 写一半崩掉留下临时文件（下次启动把它当正式文件加载）。
 */

interface FakeRow {
  local_id: number
  server_id: number | string
  /** Test fixture's exact SQL integer text; ordinary row selection may round it. */
  server_id_exact?: string
  rowid?: number
  local_type: number
  create_time: number
  is_send: number
  message_content: string
  sender_username: string
}

interface FakeTable {
  dbFile: string
  table: string
  rows: FakeRow[]
}

let dir = ''
let tables: FakeTable[] = []

function dbPath(dbFile: string): string {
  return `D:\\fake\\db_storage\\message\\${dbFile}`
}

function createSource(): SearchIndexDocSource {
  return {
    async listMessageDbs(): Promise<string[]> {
      return [...new Set(tables.map((table) => dbPath(table.dbFile)))]
    },
    async listTables(_kind: string, path: string): Promise<string[]> {
      return tables.filter((table) => dbPath(table.dbFile) === path).map((table) => table.table)
    },
    async execQuery(path: string, sql: string): Promise<Array<Record<string, unknown>>> {
      const maxMatch = /SELECT max\(rowid\) AS rowid_max, max\(local_id\) AS local_max FROM "(.+?)"/.exec(sql)
      if (maxMatch) {
        const table = findTable(path, maxMatch[1])
        const rowidMax = table.rows.reduce((acc, row) => Math.max(acc, row.rowid ?? row.local_id), 0)
        const localMax = table.rows.reduce((acc, row) => Math.max(acc, row.local_id), 0)
        return [{ rowid_max: rowidMax, local_max: localMax }]
      }
      const selectMatch = /SELECT \*.* FROM "(.+?)" WHERE (\w+) > (-?\d+) ORDER BY \w+ ASC LIMIT (\d+)/.exec(sql)
      if (selectMatch) {
        const table = findTable(path, selectMatch[1])
        const idColumn = selectMatch[2]
        const from = Number(selectMatch[3])
        const limit = Number(selectMatch[4])
        const exactServerIdSelected = sql.includes('CAST(server_id AS TEXT) AS __weport_server_id_text')
        const cursorId = (row: FakeRow) => idColumn === 'rowid' ? row.rowid ?? row.local_id : row.local_id
        return table.rows
          .filter((row) => cursorId(row) > from)
          .sort((a, b) => cursorId(a) - cursorId(b))
          .slice(0, limit)
          .map((row) => ({
            ...row,
            ...(sql.includes('CAST(local_id AS TEXT) AS __weport_local_id_text')
              ? { __weport_local_id_text: String(row.local_id) }
              : {}),
            ...(exactServerIdSelected
              ? { __weport_server_id_text: row.server_id_exact || String(row.server_id) }
              : {}),
          }))
      }
      throw new Error(`unexpected sql: ${sql}`)
    },
    async getSessions(): Promise<Array<{ username: string; displayName?: string }>> {
      return [
        { username: 'wxid_alice', displayName: '小艾' },
        { username: 'wxid_group', displayName: '项目群' },
      ]
    },
    async getDisplayNames(usernames: string[]): Promise<Record<string, string>> {
      const map: Record<string, string> = { wxid_alice: '小艾' }
      const out: Record<string, string> = {}
      for (const username of usernames) if (map[username]) out[username] = map[username]
      return out
    },
  }
}

function findTable(path: string, tableName: string): FakeTable {
  const table = tables.find((item) => dbPath(item.dbFile) === path && item.table === tableName)
  if (!table) throw new Error(`unknown table ${tableName} in ${path}`)
  return table
}

/** 与微信一致的表名：Msg_<md5(username)>（会话反查就是靠这个哈希） */
function tableNameFor(sessionId: string): string {
  return `Msg_${createHash('md5').update(sessionId).digest('hex')}`
}

function row(localId: number, content: string, sender: string): FakeRow {
  return {
    local_id: localId,
    server_id: 100000 + localId,
    local_type: 1,
    create_time: 1_700_000_000 + localId,
    is_send: 0,
    message_content: content,
    sender_username: sender,
  }
}

/** 合成语料：5000 条消息、3 张表、2 个库 */
function buildSyntheticCorpus(): void {
  const alice: FakeRow[] = []
  for (let i = 1; i <= 3000; i += 1) {
    const text =
      i % 997 === 0
        ? '项目'
        : i % 500 === 0
          ? `项目复盘会议 第 ${i} 次 关于验收标准与排期`
          : i % 97 === 0
            ? `合同附件已发你邮箱 contract-${i}.pdf`
            : `今天的安排 ${i}：上午同步，下午写代码`
    alice.push(row(i, text, 'wxid_alice'))
  }
  const group: FakeRow[] = []
  for (let i = 1; i <= 1900; i += 1) {
    const text = i % 300 === 0 ? `项目 进度同步 ${i}` : i % 53 === 0 ? `会议纪要 ${i}` : `群里的第 ${i} 条消息`
    group.push({ ...row(i, text, i % 2 === 0 ? 'wxid_alice' : 'wxid_other'), local_type: 1 })
  }
  // 第三个库里的表对应一个**会话列表里已经不存在**的会话：md5 反查不到 → sessionId 为空
  const orphan: FakeRow[] = [{ ...row(1, '项目复盘会议 在另一个库里', 'wxid_ghost') }]
  tables = [
    { dbFile: 'message_0.db', table: tableNameFor('wxid_alice'), rows: alice },
    { dbFile: 'message_0.db', table: tableNameFor('wxid_group'), rows: group },
    { dbFile: 'message_1.db', table: 'Msg_33333333333333333333333333333333', rows: orphan },
  ]
}

function createService(overrides?: Partial<SearchIndexServiceOptions>): SearchIndexService {
  return new SearchIndexService({
    rootDir: dir,
    source: createSource(),
    decodeText: (raw) => ({
      text: String(raw.message_content || ''),
      senderUsername: String(raw.sender_username || ''),
    }),
    resolveWxid: () => 'wxid_test',
    now: () => 1_700_000_000_000,
    log: () => undefined,
    ...overrides,
  })
}

function corpusDir(): string {
  return join(dir, 'wxid_test')
}

function shardFiles(): string[] {
  const shardsDir = join(corpusDir(), 'shards')
  return existsSync(shardsDir) ? readdirSync(shardsDir).filter((name) => name.endsWith('.json.gz')) : []
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'weport-search-index-'))
  buildSyntheticCorpus()
})

afterEach(() => {
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    /* 清理失败不影响断言 */
  }
})

describe('构建与增量', () => {
  it('首次构建索引全部消息，第二次什么都不新增', async () => {
    const service = createService()
    const first = await service.build()
    expect(first.docs).toBe(4901)
    expect(first.indexed).toBe(4901)
    expect(first.truncated).toBe(false)

    const shardsAfterFirst = shardFiles().sort()
    expect(shardsAfterFirst.length).toBeGreaterThan(0)

    const second = await createService().build()
    expect(second.indexed).toBe(0)
    expect(second.docs).toBe(4901)
    // 第二次没有写任何分片（tail 重解析不该造成重写）
    expect(shardFiles().sort()).toEqual(shardsAfterFirst)
  })

  it('同一个会话拆在多张表里时不互相覆盖（真实库就是这样，local_id 会撞）', async () => {
    // 真实库里 49481110859@chatroom 这类会话会同时有 Msg_<md5> 与带后缀的第二张表，
    // 两张表的 local_id 都从 1 开始 —— 早先按"会话#id"去重会把它们合成一条，
    // 结果是"文本来回翻转 + 每次增量重写分片 + 索引里少一半消息"。
    const secondTableKey = `${tableNameFor('wxid_alice')}_1`
    tables.push({
      dbFile: 'message_1.db',
      table: secondTableKey,
      rows: [
        row(1, '项目复盘会议 第二张表里的 l1', 'wxid_alice'),
        row(2, '第二张表里的 l2 会议纪要', 'wxid_alice'),
      ],
    })
    const built = await createService().build()
    expect(built.docs).toBe(4903)
    // 同一条 local_id 在两表里都要在
    const hits = await createService().query({ text: '第二张表里的', limit: 10 })
    expect(hits.hits.map((hit) => hit.localIdNumber).sort()).toEqual([1, 2])
    expect(hits.hits.every((hit) => hit.table === secondTableKey)).toBe(true)

    // 增量再来一次：内容没变 → 不重写任何分片
    const shardsBefore = shardFiles().sort()
    const second = await createService().build()
    expect(second.docs).toBe(4903)
    expect(second.scanned).toBeGreaterThan(0)
    expect(shardFiles().sort()).toEqual(shardsBefore)
  })

  it('新增的行会被增量补上（每张表只取 id > maxRowId）', async () => {
    const service = createService()
    await service.build()
    const alice = tables.find((table) => table.table === tableNameFor('wxid_alice'))!
    alice.rows.push(row(3001, '项目复盘会议 增量新增的那条', 'wxid_alice'))

    const second = await createService().build()
    expect(second.indexed).toBe(1)
    expect(second.docs).toBe(4902)
    expect(second.scanned).toBeLessThan(100) // 只扫到 tail 与新增那一行
  })

  /**
   * 回归：增量构建**中途读失败**时，不能把没读到的那一段标成"已索引"。
   *
   * 以前读失败只是 `break`，然后照旧提交 `maxRowId = 表尾` —— 于是那一段被当成已索引，
   * 之后每轮增量都从表尾开始，**那些消息永远进不了索引，而且没有任何提示**。现在失败时
   * 只提交真的读到的那一格，下一轮从断点接着读。
   */
  it('读失败不推进 maxRowId：断点之后的消息下一轮还能补上', async () => {
    const first = await createService().build()
    const alice = tables.find((table) => table.table === tableNameFor('wxid_alice'))!
    alice.rows.push(row(3101, '项目复盘会议 断点之后的第一条', 'wxid_alice'))
    alice.rows.push(row(3102, '项目复盘会议 断点之后的第二条', 'wxid_alice'))

    // 这一轮：第一次批量读 tail 成功，接着那批抛错
    const inner = createSource()
    let selects = 0
    const flakySource: SearchIndexDocSource = {
      ...inner,
      async execQuery(dbPath: string, sql: string) {
        if (/SELECT \* FROM/.test(sql)) {
          selects += 1
          if (selects > 1) throw new Error('模拟：这一批读失败了')
        }
        return inner.execQuery(dbPath, sql)
      },
    }
    await createService({ source: flakySource }).build()

    // 下一轮：数据源恢复正常，那两条必须能被补进来
    const recovered = await createService().build()
    expect(recovered.docs).toBe(first.docs + 2)
    const hits = await createService().query({ text: '断点之后', limit: 10 })
    expect(hits.hits.length).toBe(2)
  })

  it('force 重建从零重写，结果与首次一致', async () => {
    await createService().build()
    const rebuilt = await createService().build({ force: true })
    expect(rebuilt.docs).toBe(4901)
    expect(rebuilt.indexed).toBe(4901)
  })

  /**
   * 字节闸：`maxDocs` 之外还要有"总文本字节"上限。
   *
   * 只有条数上限时，1M 条 × 2000 字符 × 两份（小写副本）理论上能吃掉几个 GB；到那一步不是
   * "索引慢"，是进程被吃光。这里把上限压到很小，验证构建会**停下来**并如实标 truncated，
   * 而不是继续往内存里塞。
   */
  it('文本字节到上限就停，并标 truncated', async () => {
    const service = createService({ maxTotalTextBytes: 64 * 1024 })
    const result = await service.build()
    expect(result.truncated).toBe(true)
    expect(result.docs).toBeLessThan(4901) // 没全部装下
    expect(service.status().error || '').not.toContain('损坏') // 是"装不下"，不是"坏了"
  })

  it('force 重建会重置"曾经超限"的粘住标记', async () => {
    // 先用很小的字节上限建一次：这一次的结果就是"曾经超限"
    const capped = await createService({ maxTotalTextBytes: 64 * 1024 }).build()
    expect(capped.truncated).toBe(true)
    // 同一份数据、这次不限字节，再强制重建：不该再永远显示"结果已截断"
    const roomy = await createService().build({ force: true })
    expect(roomy.truncated).toBe(false)
    expect(roomy.docs).toBe(4901)
  })

  it('tail 重解析吸收原地编辑（撤回/编辑改的是最后几行，不是新行）', async () => {
    await createService().build()
    const alice = tables.find((table) => table.table === tableNameFor('wxid_alice'))!
    const newest = alice.rows[alice.rows.length - 1]
    newest.message_content = '这条被编辑过 撤销标记'

    const second = await createService().build()
    expect(second.indexed).toBe(0) // 不是新增行
    expect(second.scanned).toBeGreaterThan(0) // 但 tail 确实被重读（曾经这里恒为 0）

    const result = await createService().query({ text: '这条被编辑过' })
    expect(result.hits.length).toBe(1)
    expect(result.hits[0].localIdNumber).toBe(newest.local_id)
  })

  it('manifest 记录每张表的 table / maxRowId / indexedAt，分片是压缩文件', async () => {
    await createService().build()
    const manifest = JSON.parse(readFileSync(join(corpusDir(), 'manifest.json'), 'utf8'))
    expect(manifest.v).toBe(2)
    expect(manifest.wxid).toBe('wxid_test')
    expect(manifest.docs).toBe(4901)
    const entries = Object.values(manifest.perDb) as Array<Record<string, unknown>>
    expect(entries.length).toBe(3)
    for (const entry of entries) {
      expect(String(entry.table)).toMatch(/^Msg_/)
      expect(Number(entry.maxRowId)).toBeGreaterThan(0)
      expect(Number(entry.indexedAt)).toBeGreaterThan(0)
      expect(String(entry.shard)).toMatch(/^shards\/.+\.json\.gz$/)
      expect(existsSync(join(corpusDir(), String(entry.shard)))).toBe(true)
    }
    const firstShard = join(corpusDir(), String(entries[0].shard))
    const head = readFileSync(firstShard).subarray(0, 2)
    expect([head[0], head[1]]).toEqual([0x1f, 0x8b]) // gzip magic
  })

  it('写入完成后没有临时文件残留', async () => {
    await createService().build()
    expect(readdirSync(corpusDir()).filter((name) => name.includes('.tmp-'))).toEqual([])
    expect(readdirSync(join(corpusDir(), 'shards')).filter((name) => name.includes('.tmp-'))).toEqual([])
  })

  it('没有 message_*.db 时给出明确错误，而不是写出一个空索引', async () => {
    tables = []
    const service = createService()
    await expect(service.build()).rejects.toThrow(/未找到任何 message_\*\.db/)
  })
})

describe('损坏索引容忍', () => {
  it('分片被截断：加载不抛异常、坏的跳过、其余仍可查询，重建后自愈', async () => {
    const built = await createService().build()
    expect(built.docs).toBe(4901)
    const shards = shardFiles()
    const victim = join(corpusDir(), 'shards', shards[0])
    const size = statSync(victim).size
    truncateSync(victim, Math.max(4, Math.floor(size / 3)))

    const service = createService()
    // 加载（query 会触发）之后 status 才看得到损坏信息
    const result = await service.query({ text: '项目复盘会议', limit: 50 })
    expect(service.status().error).toContain('损坏')
    expect(result.error).toBeUndefined()
    // 坏分片之外的文档仍然可查
    expect(result.hits.length).toBeGreaterThan(0)

    // 重建：损坏分片对应的表被归零后从头补，文档数回到完整
    const rebuilt = await service.build()
    expect(rebuilt.docs).toBe(4901)
    expect(rebuilt.indexed).toBeGreaterThan(0)
    const after = await createService().query({ text: '项目复盘会议', limit: 50 })
    expect(after.hits.length).toBe(7)
  })

  it('manifest 损坏：备份并从零重建，不抛异常', async () => {
    await createService().build()
    const manifestPath = join(corpusDir(), 'manifest.json')
    writeFileSync(manifestPath, '{"v":1,"perDb":{', 'utf8')

    const service = createService()
    await service.ensureLoaded()
    const status = service.status()
    expect(status.ready).toBe(false)
    expect(status.error).toContain('损坏')
    expect(readdirSync(corpusDir()).some((name) => name.includes('.corrupt-'))).toBe(true)

    const rebuilt = await service.build()
    expect(rebuilt.docs).toBe(4901)
  })

  it('分片直接缺失（被外部删掉）也当作损坏处理', async () => {
    await createService().build()
    const victim = join(corpusDir(), 'shards', shardFiles()[0])
    rmSync(victim)
    const service = createService()
    await expect(service.query({ text: '会议', limit: 5 })).resolves.toBeTruthy()
    expect(service.status().error).toContain('损坏')
  })
})

describe('查询', () => {
  it('中文多字查询：命中、片段、高亮都对得上，且带时长', async () => {
    await createService().build()
    const service = createService()
    const started = Date.now()
    const result = await service.query({ text: '项目复盘会议', limit: 20 })
    const wall = Date.now() - started

    expect(result.hits.length).toBeGreaterThan(0)
    expect(result.total).toBeGreaterThanOrEqual(result.hits.length)
    expect(result.error).toBeUndefined()
    for (const hit of result.hits) {
      expect(hit.snippet).toContain('项目复盘会议')
      expect(hit.highlights.length).toBeGreaterThan(0)
      const [from, to] = hit.highlights[0]
      expect(hit.snippet.slice(from, to)).toBe('项目复盘会议')
    }
    // 宽松但真实：5 千条语料上一次全扫描应该是毫秒级
    expect(result.elapsedMs).toBeLessThan(1000)
    expect(wall).toBeLessThan(2000)
  })

  it('没有命中时返回空结果而不是报错', async () => {
    await createService().build()
    const result = await createService().query({ text: '这四个字一定不存在于语料里' })
    expect(result.hits).toEqual([])
    expect(result.total).toBe(0)
    expect(result.truncated).toBe(false)
    expect(result.cursor).toBeNull()
  })

  it('同一条件两次执行结果完全一致（含排序）', async () => {
    await createService().build()
    const service = createService()
    const first = await service.query({ text: '会议', limit: 25 })
    const second = await service.query({ text: '会议', limit: 25 })
    const shape = (result: typeof first): string[] =>
      result.hits.map((hit) => `${hit.sessionId}#${hit.localId}#${hit.score}#${hit.snippet}`)
    expect(shape(second)).toEqual(shape(first))
  })

  it('scope 过滤：会话集合 / 类型 / 时间范围（毫秒，兼容秒）', async () => {
    await createService().build()
    const service = createService()
    const bySession = await service.query({ text: '项目', scope: { sessionIds: ['wxid_group'] }, limit: 50 })
    expect(bySession.hits.length).toBeGreaterThan(0)
    expect(bySession.hits.every((hit) => hit.sessionId === 'wxid_group')).toBe(true)

    const byKind = await service.query({ text: '项目', scope: { kinds: ['voice'] }, limit: 50 })
    expect(byKind.hits).toEqual([])

    const fromMs = (1_700_000_000 + 400) * 1000
    const toMs = (1_700_000_000 + 600) * 1000
    const byTime = await service.query({ text: '项目复盘会议', scope: { from: fromMs, to: toMs }, limit: 50 })
    expect(byTime.hits.length).toBeGreaterThan(0)
    expect(byTime.hits.every((hit) => hit.ts >= fromMs && hit.ts <= toMs)).toBe(true)

    // 老调用方传秒：值域不重叠，按秒解释，结果一致
    const bySeconds = await service.query({
      text: '项目复盘会议',
      scope: { from: fromMs / 1000, to: toMs / 1000 },
      limit: 50,
    })
    expect(bySeconds.hits.map((hit) => hit.localIdNumber)).toEqual(byTime.hits.map((hit) => hit.localIdNumber))
  })

  it('分页：游标翻页不重复、不丢结果；篡改的游标当作第一页', async () => {
    await createService().build()
    const service = createService()
    const all = await service.query({ text: '会议', limit: 200 })
    const pageOne = await service.query({ text: '会议', limit: 5 })
    expect(pageOne.hits.length).toBe(5)
    expect(pageOne.cursor).toBeTruthy()
    const pageTwo = await service.query({ text: '会议', limit: 5, cursor: pageOne.cursor })
    const keysOne = pageOne.hits.map((hit) => `${hit.sessionId}#${hit.localIdNumber}`)
    const keysTwo = pageTwo.hits.map((hit) => `${hit.sessionId}#${hit.localIdNumber}`)
    expect(keysTwo.some((key) => keysOne.includes(key))).toBe(false)
    expect(keysTwo).toEqual(all.hits.slice(5, 10).map((hit) => `${hit.sessionId}#${hit.localIdNumber}`))

    const invalid = await service.query({ text: '会议', limit: 5, cursor: 'not-a-cursor' })
    expect(invalid.hits.length).toBe(5)
    expect(invalid.error).toContain('游标')
  })

  it('会话名与发送者名来自会话表（不是裸 username）', async () => {
    await createService().build()
    const result = await createService().query({ text: '项目复盘会议', limit: 5 })
    expect(result.hits[0].sessionName).toBe('小艾')
    expect(result.hits[0].senderName).toBe('小艾')
    // ts 是毫秒（库里是秒），localId 是数字 + 字符串两种形态
    expect(result.hits[0].ts).toBeGreaterThan(1_000_000_000_000)
    expect(result.hits[0].localId).toBe(String(result.hits[0].localIdNumber))
    expect(result.hits[0].idKind).toBe('local')
  })

  it('SQL CAST 保留超出安全整数的 server_id，分片重载后仍可精确定位', async () => {
    const serverId = '9007199254740993'
    tables = [{
      dbFile: 'message_0.db',
      table: tableNameFor('wxid_alice'),
      rows: [{
        ...row(0, '精确服务端 ID 命中', 'wxid_alice'),
        rowid: 1,
        server_id: Number(serverId),
        server_id_exact: serverId,
      }],
    }]
    await createService().build()

    const result = await createService().query({ text: '精确服务端 ID' })
    expect(result.hits).toMatchObject([{ localId: serverId, localIdNumber: 0, idKind: 'server' }])
  })

  it('rebuilds a previous index format before serving results', async () => {
    await createService().build()
    const manifestPath = join(corpusDir(), 'manifest.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    manifest.v = 1
    writeFileSync(manifestPath, JSON.stringify(manifest), 'utf8')

    const service = createService()
    expect((await service.query({ text: '项目复盘会议' })).hits).toHaveLength(0)
    expect(service.status().error).toContain('重新构建')
    const rebuilt = await service.build()
    expect(rebuilt.indexed).toBe(4901)
    expect((await service.query({ text: '项目复盘会议' })).hits.length).toBeGreaterThan(0)
    expect(service.status().error).toBeUndefined()
  })

  it('建议词来自语料词表', async () => {
    await createService().build()
    const suggestions = await createService().suggest('项目', 10)
    expect(suggestions.length).toBeGreaterThan(0)
    expect(suggestions.every((word) => word.startsWith('项目'))).toBe(true)
    expect(await createService().suggest('', 10)).toEqual([])
  })

  it('空查询立即返回，不去扫语料', async () => {
    await createService().build()
    const result = await createService().query({ text: '   ' })
    expect(result.hits).toEqual([])
    expect(result.elapsedMs).toBe(0)
  })
})
