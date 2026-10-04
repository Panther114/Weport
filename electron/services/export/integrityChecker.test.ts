import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  INTEGRITY_REPORT_FILE_NAME,
  MISSING_MEDIA_CSV_FILE_NAME,
  buildMissingMediaCsv,
  coerceMessageRow,
  compareSourceIdentityMultisets,
  countCsvRecords,
  countRowsInArtifact,
  detectDuplicates,
  escapeCsvCell,
  evaluateAttribution,
  evaluateMediaCoverage,
  evaluateTotals,
  mediaKindOf,
  mediaTokensOf,
  readIntegrityReport,
  runIntegrityCheck,
  runIntegrityCheckForExportRoot,
  type IntegrityDbAccess,
  type IntegrityMessageRow,
  type IntegritySessionInput,
  type IntegrityTableStat,
  type MediaRequestFlags,
} from './integrityChecker'
import { sourceMessageIdentityHash } from './sourceMessageIdentity'

/**
 * 导出正确性自检（v1.2 §10.2 ②）。
 *
 * 每条断言都在守一个具体的"静默错数据"：
 * 少行/多行必须被判定成缺口、解析不到或归到别人的 sender 不能被计成"归到本会话"、
 * 媒体"没请求"与"请求了没产出"必须分清、重复必须数出来、
 * 以及 `ok` 只有在**五项都跑成且都对上**时才是 true。
 */

const SESSION = 'wxid_me'
const OTHER_SESSION = 'wxid_other'
const MY_WXID = 'wxid_myself'
const DB0 = path.join(os.tmpdir(), 'weport-integrity-fixture', 'message', 'msg_0.db')

const noMedia: MediaRequestFlags = { enabled: false, images: false, voices: false, videos: false, emojis: false, files: false }
const allMedia: MediaRequestFlags = { enabled: true, images: true, voices: true, videos: true, emojis: true, files: true }

function row(overrides: Partial<IntegrityMessageRow> = {}): IntegrityMessageRow {
  return {
    sessionId: SESSION,
    localId: 1,
    createTime: 1700000000,
    localType: 1,
    isSend: false,
    dbPath: DB0,
    tableName: 'Msg_a',
    ...overrides,
  }
}

let root = ''
let reportRoot = ''

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'weport-integrity-'))
  reportRoot = path.join(root, 'TXT')
  fs.mkdirSync(reportRoot, { recursive: true })
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

describe('校验一：总数交叉核对', () => {
  it('相等 → equal，不算缺陷', () => {
    const verdict = evaluateTotals(120, 120)
    expect(verdict.status).toBe('equal')
    expect(verdict.gap).toBe(false)
    expect(verdict.missing).toBe(0)
    expect(verdict.extra).toBe(0)
  })

  it('产物少 → short，缺 7 行且算缺陷', () => {
    const verdict = evaluateTotals(120, 113)
    expect(verdict.status).toBe('short')
    expect(verdict.missing).toBe(7)
    expect(verdict.gap).toBe(true)
    expect(verdict.reason).toContain('7')
  })

  it('产物多 → long，多 3 行且算缺陷（重复导出/口径不一致）', () => {
    const verdict = evaluateTotals(120, 123)
    expect(verdict.status).toBe('long')
    expect(verdict.extra).toBe(3)
    expect(verdict.gap).toBe(true)
  })

  it('带时间范围/筛选的分片导出：少不算缺陷、多仍然算', () => {
    expect(evaluateTotals(120, 40, true).status).toBe('scoped-ok')
    expect(evaluateTotals(120, 40, true).gap).toBe(false)
    expect(evaluateTotals(120, 121, true).gap).toBe(true)
  })

  it('计数不可用（负数/NaN）→ unknown 且算缺陷，不假装通过', () => {
    expect(evaluateTotals(-1, 5).gap).toBe(true)
    expect(evaluateTotals(Number.NaN, 5).status).toBe('unknown')
  })
})

describe('校验二：分片 real_sender_id 归属', () => {
  const tables: IntegrityTableStat[] = [
    { dbName: 'msg_0', dbPath: DB0, tableName: 'Msg_a', count: 100 },
  ]

  it('全部解析回本会话 → 全计入 rowsAttributed 且 ok', () => {
    const report = evaluateAttribution({
      sessionId: SESSION,
      myWxid: MY_WXID,
      tables,
      rows: [
        row({ localId: 1, realSenderId: 7, resolvedUsername: SESSION }),
        row({ localId: 2, realSenderId: 8, resolvedUsername: SESSION, isSend: true }),
        row({ localId: 3, realSenderId: 9, resolvedUsername: MY_WXID }),
      ],
      knownSessionIds: [OTHER_SESSION],
      sampled: false,
    })
    expect(report.rowsAttributed).toBe(3)
    expect(report.rowsUnattributed).toBe(0)
    expect(report.ok).toBe(true)
    expect(report.tables[0].rowsSkipped).toBe(97)
  })

  it('归到**另一个会话**的行被报出来，且不计进 rowsAttributed', () => {
    const report = evaluateAttribution({
      sessionId: SESSION,
      myWxid: MY_WXID,
      tables,
      rows: [
        row({ localId: 1, realSenderId: 7, resolvedUsername: SESSION }),
        row({ localId: 2, realSenderId: 42, resolvedUsername: OTHER_SESSION }),
      ],
      knownSessionIds: [OTHER_SESSION],
      sampled: false,
    })
    expect(report.rowsAttributed).toBe(1)
    expect(report.rowsUnattributed).toBe(1)
    expect(report.foreignSenders).toHaveLength(1)
    expect(report.foreignSenders[0]).toMatchObject({ senderId: 42, username: OTHER_SESSION })
    expect(report.ok).toBe(false)
  })

  it('解析不到的 id 被报出来（跨库解析的典型症状），也不计进 rowsAttributed', () => {
    const report = evaluateAttribution({
      sessionId: SESSION,
      myWxid: MY_WXID,
      tables,
      rows: [
        row({ localId: 1, realSenderId: 7, resolvedUsername: SESSION }),
        row({ localId: 2, realSenderId: 99, resolvedUsername: null }),
      ],
      knownSessionIds: [],
      sampled: true,
    })
    expect(report.unresolvedSenderIds).toEqual([99])
    expect(report.rowsAttributed).toBe(1)
    expect(report.rowsUnattributed).toBe(1)
    expect(report.ok).toBe(false)
    // 抽样时不编 rowsSkipped
    expect(report.rowsSkipped).toBeNull()
    expect(report.tables[0].rowsSkipped).toBeNull()
  })

  it('本账号的 sender id 解析不到名字时不算缺口（Name2Id 里"自己"那条没有 user_name）', () => {
    const report = evaluateAttribution({
      sessionId: SESSION,
      myWxid: MY_WXID,
      tables,
      rows: [
        // 自己发的两条：id 2 就是本账号在这个库里的 sender id
        row({ localId: 1, realSenderId: 2, isSend: true }),
        row({ localId: 2, realSenderId: 2, isSend: true }),
        // 收到的：同一个 id，Name2Id 查不到名字 —— 但它是"我"，不是解析不了
        row({ localId: 3, realSenderId: 2 }),
        row({ localId: 4, realSenderId: 7, resolvedUsername: SESSION }),
      ],
      knownSessionIds: [OTHER_SESSION],
      sampled: false,
    })
    expect(report.unresolvedSenderIds).toEqual([])
    expect(report.rowsAttributed).toBe(4)
    expect(report.selfSenderIds).toEqual([{ dbName: 'msg_0', senderIds: [2] }])
    expect(report.ok).toBe(true)
  })

  it('第 3 个会话的行里真的解析不到 id 时照旧报出来（不是被上面那条规则吃掉）', () => {
    const report = evaluateAttribution({
      sessionId: SESSION,
      myWxid: MY_WXID,
      tables,
      rows: [
        row({ localId: 1, realSenderId: 2, isSend: true }),
        row({ localId: 2, realSenderId: 55 }),
      ],
      knownSessionIds: [],
      sampled: true,
    })
    expect(report.unresolvedSenderIds).toEqual([55])
    expect(report.ok).toBe(false)
  })

  it.each([10000, 10002, 266287972401])('系统消息（localType %s）挂着没名字的 sender id 是正常数据，不算缺陷', (localType) => {
    const report = evaluateAttribution({
      sessionId: SESSION,
      myWxid: MY_WXID,
      tables,
      rows: [
        row({ localId: 1, localType, realSenderId: 2 }),
        row({ localId: 2, realSenderId: 7, resolvedUsername: SESSION }),
      ],
      knownSessionIds: [],
      sampled: true,
    })
    expect(report.unresolvedSenderIds).toEqual([])
    expect(report.systemSenderIds).toEqual([2])
    expect(report.ok).toBe(true)
    expect(report.unresolvedSamples[0]).toMatchObject({ senderId: 2, system: true })
  })

  it('非系统消息解析不到 id 仍然算缺陷', () => {
    const report = evaluateAttribution({
      sessionId: SESSION,
      myWxid: MY_WXID,
      tables,
      rows: [row({ localId: 1, localType: 1, realSenderId: 77 })],
      knownSessionIds: [],
      sampled: true,
    })
    expect(report.unresolvedSenderIds).toEqual([77])
    expect(report.systemSenderIds).toEqual([])
    expect(report.ok).toBe(false)
  })

  it('群聊：解析到别的联系人**不**算错误（没有权威成员名单，避免误报）', () => {
    const report = evaluateAttribution({
      sessionId: '12345@chatroom',
      myWxid: MY_WXID,
      tables: [{ dbName: 'msg_0', dbPath: DB0, tableName: 'Msg_g', count: 10 }],
      rows: [row({ sessionId: '12345@chatroom', localId: 1, realSenderId: 5, resolvedUsername: OTHER_SESSION })],
      knownSessionIds: [OTHER_SESSION],
      sampled: true,
    })
    expect(report.foreignSenders).toHaveLength(0)
    expect(report.rowsAttributed).toBe(1)
    expect(report.ok).toBe(true)
  })

  it('行里自带 sender_username 的行不必查 Name2Id（群聊很常见）', () => {
    const report = evaluateAttribution({
      sessionId: SESSION,
      myWxid: MY_WXID,
      tables,
      rows: [row({ localId: 1, realSenderId: 3, senderUsername: OTHER_SESSION })],
      knownSessionIds: [OTHER_SESSION],
      sampled: false,
    })
    expect(report.rowsAttributed).toBe(1)
    expect(report.rowsUnattributed).toBe(0)
  })

  it('同库多张分片表 + 行不带表名 → 只降到库这一级，不编按表的 rowsSkipped', () => {
    const report = evaluateAttribution({
      sessionId: SESSION,
      myWxid: MY_WXID,
      tables: [
        { dbName: 'msg_0', dbPath: DB0, tableName: 'Msg_a', count: 40 },
        { dbName: 'msg_0', dbPath: DB0, tableName: 'Msg_b', count: 60 },
      ],
      rows: [row({ localId: 1, realSenderId: 7, resolvedUsername: SESSION, tableName: undefined })],
      knownSessionIds: [OTHER_SESSION],
      sampled: false,
    })
    expect(report.perTableResolved).toBe(false)
    expect(report.rowsSkipped).toBeNull()
    expect(report.tables.every((table) => table.rowsSkipped === null)).toBe(true)
    expect(report.rowsAttributed).toBe(1)
    expect(report.ok).toBe(true)
  })

  it('行带表名时按表落位（多表库里也能算准 rowsSkipped）', () => {
    const report = evaluateAttribution({
      sessionId: SESSION,
      myWxid: MY_WXID,
      tables: [
        { dbName: 'msg_0', dbPath: DB0, tableName: 'Msg_a', count: 40 },
        { dbName: 'msg_0', dbPath: DB0, tableName: 'Msg_b', count: 60 },
      ],
      rows: [row({ localId: 1, realSenderId: 7, resolvedUsername: SESSION, tableName: 'Msg_b' })],
      knownSessionIds: [OTHER_SESSION],
      sampled: false,
    })
    expect(report.perTableResolved).toBe(true)
    const msgB = report.tables.find((table) => table.tableName === 'Msg_b')
    expect(msgB?.rowsAttributed).toBe(1)
    expect(msgB?.rowsSkipped).toBe(59)
    const msgA = report.tables.find((table) => table.tableName === 'Msg_a')
    expect(msgA?.rowsSkipped).toBe(40)
  })
})

describe('校验三：媒体覆盖', () => {
  it('没请求媒体导出 → 记 not-requested，不报缺失', () => {
    const coverage = evaluateMediaCoverage({
      sessionId: SESSION,
      rows: [row({ localId: 1, localType: 3, content: '<img md5="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"/>' })],
      files: [],
      dirExists: false,
      mediaRequested: noMedia,
    })
    expect(coverage.requested).toBe(0)
    expect(coverage.notRequested).toBe(1)
    expect(coverage.missing).toHaveLength(0)
  })

  it('请求了且产物在 → produced', () => {
    const md5 = 'a'.repeat(32)
    const coverage = evaluateMediaCoverage({
      sessionId: SESSION,
      rows: [row({ localId: 7, localType: 3, content: `<img md5="${md5}"/>` })],
      files: [`wxid_me/media/images/${md5}.jpg`],
      dirExists: true,
      mediaRequested: { ...allMedia, voices: false, videos: false, emojis: false, files: false },
    })
    expect(coverage.requested).toBe(1)
    expect(coverage.produced).toBe(1)
    expect(coverage.missing).toHaveLength(0)
  })

  it('请求了但产物不在 → file-missing（原因可进 CSV）', () => {
    const md5 = 'b'.repeat(32)
    const coverage = evaluateMediaCoverage({
      sessionId: SESSION,
      rows: [row({ localId: 9, localType: 3, content: `<img md5="${md5}"/>` })],
      files: ['wxid_me/media/images/ffff.jpg'],
      dirExists: true,
      mediaRequested: { ...allMedia, voices: false, videos: false, emojis: false, files: false },
    })
    expect(coverage.requested).toBe(1)
    expect(coverage.produced).toBe(0)
    expect(coverage.missing).toEqual([
      { sessionId: SESSION, messageLocalId: 9, type: 'image', reason: 'file-missing' },
    ])
  })

  it('媒体目录根本不存在 → dir-missing（与"没请求"明确区分）', () => {
    const coverage = evaluateMediaCoverage({
      sessionId: SESSION,
      rows: [row({ localId: 11, localType: 34, content: '' })],
      files: [],
      dirExists: false,
      mediaRequested: allMedia,
    })
    expect(coverage.missing[0]).toMatchObject({ type: 'voice', reason: 'dir-missing' })
  })

  it('语音按 `voice_<会话>_<localId>_<时间>` 文件名命中', () => {
    const coverage = evaluateMediaCoverage({
      sessionId: SESSION,
      rows: [row({ localId: 42, createTime: 1700000123, localType: 34 })],
      files: [`t/wxid_me/media/voices/voice_wxid_me_42_1700000123_0.wav`],
      dirExists: true,
      mediaRequested: { ...allMedia, images: false, videos: false, emojis: false, files: false },
    })
    expect(coverage.produced).toBe(1)
  })

  it('localType 49 的普通链接不算文件媒体（否则整类误报）', () => {
    const link = row({ localType: 49, content: '<msg><appmsg><type>5</type><title>一条链接</title></appmsg></msg>' })
    const file = row({ localType: 49, content: '<msg><appmsg><type>6</type><title>x.pdf</title><filename>x.pdf</filename></appmsg></msg>' })
    expect(mediaKindOf(link)).toBeNull()
    expect(mediaKindOf(file)).toBe('file')
  })

  it('文件媒体按文件名命中产出（matchAll 必须用全局正则 —— 非全局会直接抛 TypeError）', () => {
    const file = row({
      localId: 12,
      localType: 49,
      content: '<msg><appmsg><type>6</type><title>报告 v2.pdf</title><filename>报告 v2.pdf</filename></appmsg></msg>',
    })
    expect(mediaTokensOf(file, 'file')).toContain('报告 v2.pdf')
    const coverage = evaluateMediaCoverage({
      sessionId: SESSION,
      rows: [file],
      files: ['t/x/media/file/pdf/报告 v2.pdf'],
      dirExists: true,
      mediaRequested: { ...allMedia, images: false, voices: false, videos: false, emojis: false },
    })
    expect(coverage.produced).toBe(1)
    expect(coverage.missing).toHaveLength(0)
  })

  it('图片按 md5 命中产出（真实库里图片正文里的 md5 与落盘文件名一致）', () => {
    const md5 = 'd'.repeat(32)
    const coverage = evaluateMediaCoverage({
      sessionId: SESSION,
      rows: [row({ localId: 3, localType: 3, content: `<msg><img aeskey="x" md5="${md5}" /></msg>` })],
      files: [`t/wxid_me/media/images/${md5}.jpg`],
      dirExists: true,
      mediaRequested: { ...allMedia, voices: false, videos: false, emojis: false, files: false },
    })
    expect(coverage.produced).toBe(1)
  })
})

describe('校验四：重复检测', () => {
  it('同一 DB/表/local_id 即使时间不同也算同一源身份重复', () => {
    const report = detectDuplicates([
      row({ localId: 1, createTime: 100 }),
      row({ localId: 1, createTime: 101 }),
      row({ localId: 2, createTime: 100 }),
    ])
    expect(report.groups).toBe(1)
    expect(report.extraRows).toBe(1)
    expect(report.examples[0]).toMatchObject({ kind: 'message-key', count: 2, localId: 1 })
  })

  it('同一 server id 出现在两条消息里 → 也能抓到（本地 id 不同）', () => {
    const report = detectDuplicates([
      row({ localId: 1, serverIdRaw: '555' }),
      row({ localId: 2, serverIdRaw: '555' }),
    ])
    expect(report.groups).toBe(1)
    expect(report.examples[0].kind).toBe('server-id')
  })

  it('同一 uint64 server ID 的有符号整数与无符号文本别名归为一组', () => {
    const report = detectDuplicates([
      row({ localId: 1, serverId: '-6' }),
      row({ localId: 2, serverIdRaw: '18446744073709551610' }),
    ])
    expect(report.groups).toBe(1)
    expect(report.extraRows).toBe(1)
    expect(report.examples[0]).toMatchObject({ kind: 'server-id', count: 2 })
    expect(report.examples[0].key).toContain('18446744073709551610')
  })

  it('同一本地分片路径的点段别名仍命中同一 local key', () => {
    const dbPath = path.join(root, 'message_0.db')
    const dbPathAlias = `${path.dirname(dbPath)}${path.sep}.${path.sep}${path.basename(dbPath)}`
    const report = detectDuplicates([
      row({ localId: 12, createTime: 100, dbPath }),
      row({ localId: 12, createTime: 100, dbPath: dbPathAlias }),
    ])
    expect(report.groups).toBe(1)
    expect(report.examples[0].kind).toBe('message-key')
  })

  it('不同消息分片里相同 local_id 和时间是不同消息', () => {
    const report = detectDuplicates([
      row({ localId: 12, createTime: 100, dbPath: 'C:/fixture/message_0.db' }),
      row({ localId: 12, createTime: 100, dbPath: 'C:/fixture/message_1.db' }),
    ])
    expect(report.groups).toBe(0)
    expect(report.unscopedRows).toBe(0)
  })

  it('同 basename 但不同完整数据库路径的 local IDs 是不同消息', () => {
    const report = detectDuplicates([
      row({ localId: 12, createTime: 100, dbPath: path.join(root, 'message', 'message_0.db') }),
      row({ localId: 12, createTime: 100, dbPath: path.join(root, 'biz_message', 'message_0.db') }),
    ])
    expect(report.groups).toBe(0)
    expect(report.unscopedRows).toBe(0)
  })

  it('同一重复行对命中 local key 和 server ID 时只计一组', () => {
    const report = detectDuplicates([
      row({ localId: 12, createTime: 100, serverIdRaw: '9007199254740993' }),
      row({ localId: 12, createTime: 100, serverIdRaw: '9007199254740993' }),
    ])
    expect(report.groups).toBe(1)
    expect(report.extraRows).toBe(1)
    expect(report.examples[0]).toMatchObject({ kind: 'server-id', count: 2 })
  })

  it('保留大于 2^53 的 local ID 精度，避免相邻 ID 被合并', () => {
    const first = coerceMessageRow(SESSION, {
      local_id: '9007199254740993', create_time: 100, local_type: 1, db_path: DB0, table_name: 'Msg_a',
    })!
    const second = coerceMessageRow(SESSION, {
      local_id: '9007199254740994', create_time: 100, local_type: 1, db_path: DB0, table_name: 'Msg_a',
    })!
    expect(first.localIdRaw).toBe('9007199254740993')
    expect(second.localIdRaw).toBe('9007199254740994')
    expect(detectDuplicates([first, second]).groups).toBe(0)
  })

  it('unsafe Number local_id 不作为精确身份，也不把相邻 int64 合并成重复', () => {
    const rounded = coerceMessageRow(SESSION, {
      local_id: 9007199254740992,
      create_time: 100,
      local_type: 1,
      db_path: DB0,
      table_name: 'Msg_a',
    })!
    expect(rounded.localId).toBe(0)
    expect(rounded.localIdRaw).toBeUndefined()
    expect(rounded.localIdPrecisionLost).toBe(true)

    const report = detectDuplicates([
      row({ localId: 9007199254740992 }),
      row({ localId: 9007199254740994 }),
    ])
    expect(report.cursorDuplicateGroups).toBe(0)
    expect(report.unscopedRows).toBe(2)
  })

  it('缺失来源时明确报告本地 ID 重复检查未覆盖', () => {
    const report = detectDuplicates([
      row({ localId: 12, createTime: 100, dbPath: undefined, tableName: undefined }),
      row({ localId: 12, createTime: 100, dbPath: undefined, tableName: undefined }),
    ])
    expect(report.groups).toBe(0)
    expect(report.unscopedRows).toBe(2)
  })

  it('示例最多 20 条', () => {
    const rows: IntegrityMessageRow[] = []
    for (let i = 1; i <= 25; i += 1) {
      rows.push(row({ localId: i, createTime: 1000 + i }))
      rows.push(row({ localId: i, createTime: 1000 + i }))
    }
    const report = detectDuplicates(rows)
    expect(report.groups).toBe(25)
    expect(report.examples).toHaveLength(20)
  })
})

describe('校验四之二：重复 server_id 与重复源行必须分开', () => {
  it('不同 local_id 共用同一 server_id → 报成源 ID 冲突，不算重复导出', () => {
    const report = detectDuplicates([
      row({ localId: 1, serverIdRaw: '777', realSenderId: 7, content: '第一条' }),
      row({ localId: 2, serverIdRaw: '777', realSenderId: 7, content: '完全不同的正文' }),
    ])
    expect(report.sourceIdCollisionGroups).toBe(1)
    expect(report.sourceIdCollisionExtraRows).toBe(1)
    expect(report.cursorDuplicateGroups).toBe(0)
    expect(report.conflictingSourceIdPayloadGroups).toBe(1)
    expect(report.examples[0]).toMatchObject({ kind: 'server-id', classification: 'source-id-collision', payloadClass: 'conflicting' })
  })

  it('同一 server_id 且 payload 完全相同 → identical 分组，源行仍然保留', () => {
    const report = detectDuplicates([
      row({ localId: 1, serverIdRaw: '778', realSenderId: 7, content: '同一句' }),
      row({ localId: 2, serverIdRaw: '778', realSenderId: 7, content: '同一句' }),
    ])
    expect(report.identicalSourceIdPayloadGroups).toBe(1)
    expect(report.conflictingSourceIdPayloadGroups).toBe(0)
    expect(report.sourceIdCollisionGroups).toBe(1)
  })

  it('没有正文也没有发送者身份 → payload 判 unknown，不硬说"相同"', () => {
    const report = detectDuplicates([
      row({ localId: 1, serverIdRaw: '781' }),
      row({ localId: 2, serverIdRaw: '781' }),
    ])
    expect(report.unknownSourceIdPayloadGroups).toBe(1)
    expect(report.identicalSourceIdPayloadGroups).toBe(0)
    expect(report.conflictingSourceIdPayloadGroups).toBe(0)
    // 身份齐全，仍然要按源 ID 冲突报出来
    expect(report.sourceIdCollisionGroups).toBe(1)
  })

  it('缺 DB/表来源时不敢下结论 → unknown，不冒充冲突', () => {
    const report = detectDuplicates([
      row({ localId: 1, serverIdRaw: '779', content: 'x', dbPath: undefined, tableName: undefined }),
      row({ localId: 2, serverIdRaw: '779', content: 'y', dbPath: undefined, tableName: undefined }),
    ])
    expect(report.sourceIdCollisionGroups).toBe(0)
    expect(report.unknownSourceIdIdentityGroups).toBe(1)
    expect(report.unknownSourceIdIdentityRows).toBe(2)
    expect(report.examples[0].classification).toBe('unknown-source-identity')
  })

  it('同一物理行被读两次（local key + server id 同时命中）→ 仍然只算游标重复', () => {
    const report = detectDuplicates([
      row({ localId: 5, serverIdRaw: '780', realSenderId: 7, content: '同一行' }),
      row({ localId: 5, serverIdRaw: '780', realSenderId: 7, content: '同一行' }),
    ])
    expect(report.cursorDuplicateGroups).toBe(1)
    expect(report.sourceIdCollisionGroups).toBe(0)
    expect(report.examples[0].classification).toBe('cursor-repeat')
  })
})

describe('missing-media.csv', () => {
  it('表头固定，字段按 RFC4180 转义', () => {
    const csv = buildMissingMediaCsv([
      { sessionId: 'a,b', messageLocalId: 3, type: 'image', reason: 'file-missing' },
      { sessionId: 'q"x', messageLocalId: 4, type: 'file', reason: 'dir-missing' },
    ])
    const lines = csv.content.trim().split('\n')
    expect(lines[0]).toBe('sessionId,messageLocalId,type,reason')
    expect(lines[1]).toBe('"a,b",3,image,file-missing')
    expect(lines[2]).toBe('"q""x",4,file,dir-missing')
    expect(csv.written).toBe(2)
    expect(csv.truncated).toBe(false)
  })

  it('超过上限时截断并写一行诚实的说明', () => {
    const rows = Array.from({ length: 5 }, (_, index) => ({
      sessionId: SESSION,
      messageLocalId: index,
      type: 'image',
      reason: 'file-missing',
    }))
    const csv = buildMissingMediaCsv(rows, 2)
    expect(csv.written).toBe(2)
    expect(csv.total).toBe(5)
    expect(csv.truncated).toBe(true)
    expect(csv.content).toContain('# truncated: 2 of 5 rows listed (cap=2)')
    // 数据行只有 2 条（表头 + 2 + 注释）
    expect(csv.content.trim().split('\n')).toHaveLength(4)
  })

  it('escapeCsvCell 只在必要时加引号', () => {
    expect(escapeCsvCell('plain')).toBe('plain')
    expect(escapeCsvCell('a,b')).toBe('"a,b"')
    expect(escapeCsvCell('a"b')).toBe('"a""b"')
    expect(escapeCsvCell('a\nb')).toBe('"a\nb"')
    expect(escapeCsvCell(null)).toBe('')
  })
})

describe('产物行数解析', () => {
  it('json：数 messages 数组', async () => {
    const file = path.join(root, 'a.json')
    fs.writeFileSync(file, JSON.stringify({ messages: [{ a: 1 }, { b: 2 }, { c: 3 }] }))
    // 没有 sourceIdentityHash 的旧产物：身份行数为 0，由 identityAudit 判成 legacy-artifact
    expect(await countRowsInArtifact(file, 'json')).toEqual({
      ok: true,
      rows: 3,
      how: 'json',
      sourceIdentityCounts: {},
      sourceIdentityPresentRows: 0,
      sourceIdentityInvalidRows: 0,
    })
  })

  it('jsonl：数非空行', async () => {
    const file = path.join(root, 'a.jsonl')
    fs.writeFileSync(file, '{"a":1}\n\n{"a":2}\n')
    expect(await countRowsInArtifact(file, 'chatlab-jsonl')).toEqual({ ok: true, rows: 2, how: 'jsonl' })
  })

  it('weclone：引号感知地数记录并减掉表头', async () => {
    const file = path.join(root, 'a.csv')
    fs.writeFileSync(file, 'sender,content\na,"第一行\n第二行"\nb,c\n')
    expect(countCsvRecords(fs.readFileSync(file, 'utf-8'))).toBe(3)
    expect(await countRowsInArtifact(file, 'weclone')).toEqual({ ok: true, rows: 2, how: 'csv' })
  })

  it('失败原因要分得清：格式不支持 / 文件缺失 / 被截断读不出来', async () => {
    const xlsx = path.join(root, 'a.xlsx')
    fs.writeFileSync(xlsx, 'not really xlsx')
    expect(await countRowsInArtifact(xlsx, 'excel')).toEqual({ ok: false, reason: 'unsupported-format' })

    expect(await countRowsInArtifact(path.join(root, 'nope.json'), 'json')).toEqual({ ok: false, reason: 'missing' })

    const broken = path.join(root, 'broken.json')
    fs.writeFileSync(broken, '{"messages":[{"a":1}')
    // 被截断的 JSON：**不是**"格式不支持"，而是读不出来 —— 报告要能说出这个区别
    expect(await countRowsInArtifact(broken, 'json')).toEqual({ ok: false, reason: 'unparsable' })

    const big = path.join(root, 'big.json')
    fs.writeFileSync(big, JSON.stringify({ messages: [], pad: 'x'.repeat(5000) }))
    expect(await countRowsInArtifact(big, 'json', { maxBytes: 1024 })).toEqual({ ok: false, reason: 'too-large' })
  })
})

// ---------------------------------------------------------------------------
// 端到端（假数据库 + 真落盘）
// ---------------------------------------------------------------------------

function fakeDb(options: {
  tableCount: number
  rows: IntegrityMessageRow[]
  senders?: Record<string, string | null>
  scanFails?: boolean
  identities?: Record<string, number>
  unscopedSourceRows?: number
  identityScanFails?: boolean
  /** 刻意不给这个方法：模拟真实适配器还没接上身份多重集查询。 */
  withoutIdentityScan?: boolean
}): IntegrityDbAccess {
  const db: IntegrityDbAccess = {
    async getTableStats() {
      return {
        success: true,
        tables: [{ dbName: 'msg_0', dbPath: DB0, tableName: 'Msg_a', count: options.tableCount }],
      }
    },
    async getSessionMessageCount() {
      return { success: true, count: options.tableCount }
    },
    async getSessionCounter() {
      return { success: true, count: options.tableCount }
    },
    async scanMessages() {
      if (options.scanFails) return { success: false, error: '游标打开失败' }
      return { success: true, rows: options.rows, truncated: true }
    },
    async resolveSenderUsername(dbPath, senderId) {
      return options.senders?.[`${dbPath}#${senderId}`] ?? null
    },
    async listSessionIds() {
      return [SESSION, OTHER_SESSION]
    },
  }
  if (!options.withoutIdentityScan) {
    db.scanMessageIdentityMultiset = async () => {
      if (options.identityScanFails) return { success: false, error: '身份查询失败' }
      return {
        success: true,
        identities: options.identities ?? {},
        scannedRows: options.tableCount,
        unscopedRows: options.unscopedSourceRows ?? 0,
      }
    }
  }
  return db
}

function sessionInput(overrides: Partial<IntegritySessionInput> = {}): IntegritySessionInput {
  return {
    sessionId: SESSION,
    format: 'json',
    scoped: false,
    mediaRequested: noMedia,
    ...overrides,
  }
}

describe('报告形状与 ok 语义', () => {
  it('五项对上 → ok:true，报告落在导出根目录且是原子写的完整 JSON', async () => {
    const artifact = path.join(reportRoot, 'wxid_me.json')
    fs.writeFileSync(artifact, JSON.stringify({ messages: [{ a: 1 }, { b: 2 }, { c: 3 }] }))
    const report = await runIntegrityCheck({
      wxid: MY_WXID,
      outputRoot: reportRoot,
      ledgerEntries: 1,
      mediaFileIndex: [],
      db: fakeDb({
        tableCount: 3,
        // 刻意不预置 resolvedUsername：让归属走一遍"查 Name2Id"的真实路径。
        rows: [
          row({ localId: 1, realSenderId: 7 }),
          row({ localId: 2, realSenderId: 8 }),
        ],
        senders: { [`${DB0}#7`]: SESSION, [`${DB0}#8`]: SESSION },
      }),
      sessions: [sessionInput({
        artifactPath: artifact,
        runExportedMessages: 3,
        artifactFingerprints: [{ path: artifact, bytes: fs.statSync(artifact).size }],
      })],
    })

    expect(report.ok).toBe(true)
    expect(report.v).toBe(1)
    expect(report.wxid).toBe(MY_WXID)
    expect(report.outputRoot).toBe(path.resolve(reportRoot))
    expect(report.ledgerEntries).toBe(1)
    expect(report.totals).toEqual({
      sessions: 1,
      messages: 3,
      mismatches: 0,
      missingMedia: 0,
      duplicates: 0,
      sourceIdCollisions: 0,
      sourceIdCollisionExtraRows: 0,
      identicalSourceIdPayloadGroups: 0,
      conflictingSourceIdPayloadGroups: 0,
      unknownSourceIdPayloadGroups: 0,
      unknownSourceIdIdentityGroups: 0,
      unknownSourceIdIdentityRows: 0,
      identityMissingRows: 0,
      identityExtraRows: 0,
    })
    expect(report.sessions[0]).toMatchObject({ sessionId: SESSION, expected: 3, written: 3, writtenSource: 'artifact' })
    expect(report.notes.join()).toContain('总数、归属、媒体与产物校验通过')

    const onDisk = JSON.parse(fs.readFileSync(path.join(reportRoot, INTEGRITY_REPORT_FILE_NAME), 'utf-8'))
    expect(onDisk.ok).toBe(true)
    expect(onDisk.sessions[0].written).toBe(3)
    // 没有缺失媒体 → 不写 CSV（空文件比没有文件更容易被误解成"检查过了"）
    expect(fs.existsSync(path.join(reportRoot, MISSING_MEDIA_CSV_FILE_NAME))).toBe(false)
    expect(onDisk.missingMediaCsv).toBeNull()
  })

  it('产物被截断（少 2 行）→ ok:false、mismatches 计到、notes 有中文原因', async () => {
    const artifact = path.join(reportRoot, 'wxid_me.json')
    fs.writeFileSync(artifact, JSON.stringify({ messages: [{ a: 1 }] }))
    const report = await runIntegrityCheck({
      wxid: MY_WXID,
      outputRoot: reportRoot,
      ledgerEntries: 1,
      db: fakeDb({
        tableCount: 3,
        rows: [row({ localId: 1, realSenderId: 7 })],
        senders: { [`${DB0}#7`]: SESSION },
      }),
      sessions: [sessionInput({
        artifactPath: artifact,
        runExportedMessages: 3,
        artifactFingerprints: [{ path: artifact, bytes: 999999 }],
      })],
    })

    expect(report.ok).toBe(false)
    expect(report.totals.mismatches).toBe(1)
    expect(report.sessions[0].gaps.map((gap) => gap.kind).sort()).toEqual(['artifact-integrity', 'artifact-rows', 'totals'])
    expect(report.sessions[0].written).toBe(1)
    expect(report.sessions[0].expected).toBe(3)
    expect(report.notes.some((note) => note.includes('产物比数据库计数少 2 行'))).toBe(true)
    expect(report.notes.some((note) => note.includes('size-mismatch'))).toBe(true)
  })

  it('媒体缺失 → ok:false、CSV 落盘并在报告里给出相对路径', async () => {
    const artifact = path.join(reportRoot, 'wxid_me.json')
    fs.writeFileSync(artifact, JSON.stringify({ messages: [{ a: 1 }] }))
    const report = await runIntegrityCheck({
      wxid: MY_WXID,
      outputRoot: reportRoot,
      ledgerEntries: 1,
      mediaFileIndex: ['wxid_me/media/images/other.jpg'],
      db: fakeDb({
        tableCount: 1,
        rows: [row({ localId: 5, localType: 3, content: `<img md5="${'c'.repeat(32)}"/>` })],
      }),
      sessions: [sessionInput({
        artifactPath: artifact,
        runExportedMessages: 1,
        artifactFingerprints: [{ path: artifact, bytes: fs.statSync(artifact).size }],
        mediaRequested: allMedia,
      })],
    })

    expect(report.ok).toBe(false)
    expect(report.totals.missingMedia).toBe(1)
    expect(report.missingMediaCsv).toBe(MISSING_MEDIA_CSV_FILE_NAME)
    const csv = fs.readFileSync(path.join(reportRoot, MISSING_MEDIA_CSV_FILE_NAME), 'utf-8')
    expect(csv).toContain('sessionId,messageLocalId,type,reason')
    expect(csv).toContain('file-missing')

    const readBack = await readIntegrityReport(reportRoot)
    expect(readBack.success).toBe(true)
    expect(readBack.report?.totals.missingMedia).toBe(1)
    expect(readBack.csvPath).toBe(path.join(reportRoot, MISSING_MEDIA_CSV_FILE_NAME))
    expect(readBack.path).toBe(path.join(reportRoot, INTEGRITY_REPORT_FILE_NAME))
  })

  it('抽样重扫失败 → ok:false（"没检查"不等于"通过"），并把原因写进 notes', async () => {
    const artifact = path.join(reportRoot, 'wxid_me.json')
    fs.writeFileSync(artifact, JSON.stringify({ messages: [{ a: 1 }] }))
    const report = await runIntegrityCheck({
      wxid: MY_WXID,
      outputRoot: reportRoot,
      ledgerEntries: 0,
      db: fakeDb({ tableCount: 1, rows: [], scanFails: true }),
      sessions: [sessionInput({
        artifactPath: artifact,
        runExportedMessages: 1,
        artifactFingerprints: [{ path: artifact, bytes: fs.statSync(artifact).size }],
      })],
    })
    expect(report.ok).toBe(false)
    expect(report.dbAccessOk).toBe(false)
    expect(report.notes.join()).toContain('数据库侧的检查没有全部跑成')
  })

  it('分片导出（scoped）：产物少不算缺陷，仍落盘 ok:true', async () => {
    const artifact = path.join(reportRoot, 'wxid_me.json')
    fs.writeFileSync(artifact, JSON.stringify({ messages: [{ a: 1 }] }))
    const report = await runIntegrityCheck({
      wxid: MY_WXID,
      outputRoot: reportRoot,
      ledgerEntries: 1,
      db: fakeDb({
        tableCount: 500,
        rows: [row({ localId: 1, realSenderId: 7 })],
        senders: { [`${DB0}#7`]: SESSION },
      }),
      sessions: [sessionInput({
        artifactPath: artifact,
        runExportedMessages: 1,
        scoped: true,
        artifactFingerprints: [{ path: artifact, bytes: fs.statSync(artifact).size }],
      })],
    })
    expect(report.ok).toBe(true)
    expect(report.sessions[0].scoped).toBe(true)
    expect(report.sessions[0].notes.join()).toContain('属正常')
  })

  it('readIntegrityReport：报告不存在时返回 success:false 而不是抛异常', async () => {
    const result = await readIntegrityReport(reportRoot)
    expect(result.success).toBe(false)
    expect(result.error).toContain('integrity-report.json')
  })

  it('rejects manifest references outside its export directory', async () => {
    fs.writeFileSync(path.join(reportRoot, 'export-manifest.json'), JSON.stringify({ format: 'TXT', units: [{ sessionId: SESSION, artifact: '../outside.txt' }] }))
    const result = await runIntegrityCheckForExportRoot(reportRoot, { db: fakeDb({ rows: [], tableCount: 0 }) })
    expect(result.success).toBe(false)
    expect(result.error).toContain('目录之外')
  })

  it('verifies relative manifest artifacts after the export folder is copied', async () => {
    const original = path.join(reportRoot, 'original')
    const copied = path.join(reportRoot, 'copied')
    fs.mkdirSync(original)
    fs.writeFileSync(path.join(original, 'messages.json'), JSON.stringify({ messages: [] }))
    const bytes = fs.statSync(path.join(original, 'messages.json')).size
    fs.writeFileSync(path.join(original, 'export-manifest.json'), JSON.stringify({ format: 'json', units: [{ sessionId: SESSION, artifact: 'messages.json', bytes }] }))
    fs.cpSync(original, copied, { recursive: true })
    fs.rmSync(original, { recursive: true })
    const result = await runIntegrityCheckForExportRoot(copied, { db: fakeDb({ rows: [], tableCount: 0 }) })
    expect(result.success).toBe(true)
    expect(result.report?.sessions[0].artifact.ok).toBe(true)
    expect(result.report?.sessions[0].artifact.checked).toBe(1)
  })

  /**
   * 回归：导出把 `export-manifest.json` 写在**格式子目录**里（跟着产物走），而调用方给的
   * 通常只是导出根目录。原来 `runIntegrityCheckForExportRoot` 只查根目录，实测在真实导出上
   * 必然返回 `读取导出清单失败：… ENOENT … export-manifest.json` —— "重跑自检"整个功能是坏的。
   * 同一处还要把重跑的报告写回格式子目录，否则一个导出目录里会散着两份报告。
   */
  it('重跑自检：清单在格式子目录里也要找得到，且报告写回那个目录', async () => {
    const formatDir = path.join(reportRoot, 'TXT')
    fs.mkdirSync(formatDir, { recursive: true })
    const artifact = path.join(formatDir, 'wxid_me.txt')
    fs.writeFileSync(artifact, 'one\ntwo\nthree\n', 'utf-8')
    fs.writeFileSync(
      path.join(formatDir, 'export-manifest.json'),
      JSON.stringify({
        format: 'TXT',
        units: [{ sessionId: 'wxid_me', artifact, bytes: fs.statSync(artifact).size, sha256: 'deadbeef' }],
      }),
      'utf-8'
    )

    const result = await runIntegrityCheckForExportRoot(reportRoot, { db: fakeDb({ rows: [], tableCount: 0 }) })
    expect(result.success).toBe(true)
    expect(result.error).toBeUndefined()
    // 报告落在格式子目录里（跟产物和第一次的报告在一起），不是散在导出根目录
    expect(fs.existsSync(path.join(formatDir, INTEGRITY_REPORT_FILE_NAME))).toBe(true)
    // 而且读回来仍然是成功 —— 读的那一侧用的是同一套查找
    const readBack = await readIntegrityReport(reportRoot)
    expect(readBack.success).toBe(true)
  })
})

describe('源行身份多重集核对（JSON 产物的 sourceIdentityHash）', () => {
  const identityOf = (localId: number) => sourceMessageIdentityHash({ localId, dbPath: DB0, tableName: 'Msg_a' })!

  function jsonArtifact(messages: Array<Record<string, unknown>>): string {
    const artifact = path.join(reportRoot, 'wxid_me.json')
    fs.writeFileSync(artifact, JSON.stringify({ messages }))
    return artifact
  }

  async function runJsonExport(options: {
    artifact: string
    db: IntegrityDbAccess
    scoped?: boolean
    rows?: IntegrityMessageRow[]
    tableCount?: number
  }) {
    return runIntegrityCheck({
      wxid: MY_WXID,
      outputRoot: reportRoot,
      ledgerEntries: 1,
      mediaFileIndex: [],
      db: options.db,
      sessions: [sessionInput({
        artifactPath: options.artifact,
        runExportedMessages: 2,
        scoped: options.scoped ?? false,
        artifactFingerprints: [{ path: options.artifact, bytes: fs.statSync(options.artifact).size }],
      })],
    })
  }

  it('产物身份与源库身份一一对上 → checked + complete，ok 仍为 true', async () => {
    const artifact = jsonArtifact([
      { sourceIdentityHash: identityOf(1) },
      { sourceIdentityHash: identityOf(2) },
    ])
    const report = await runJsonExport({
      artifact,
      tableCount: 2,
      rows: [row({ localId: 1, realSenderId: 7 }), row({ localId: 2, realSenderId: 7 })],
      db: fakeDb({
        tableCount: 2,
        rows: [row({ localId: 1, realSenderId: 7 }), row({ localId: 2, realSenderId: 7 })],
        senders: { [`${DB0}#7`]: SESSION },
        identities: { [identityOf(1)]: 1, [identityOf(2)]: 1 },
      }),
    })
    expect(report.sessions[0].identityAudit).toMatchObject({
      status: 'checked',
      complete: true,
      expectedRows: 2,
      artifactRows: 2,
      matchedRows: 2,
      missingRows: 0,
      extraRows: 0,
    })
    expect(report.ok).toBe(true)
    expect(report.notes.join()).toContain('JSON 源身份完整核对 1 个会话')
  })

  it('源库与产物多重集相同也不能掩盖重复的完整源身份', async () => {
    const identity = identityOf(1)
    const artifact = jsonArtifact([
      { sourceIdentityHash: identity },
      { sourceIdentityHash: identity },
    ])
    const report = await runJsonExport({
      artifact,
      tableCount: 2,
      // 有界样本只看到一行，重复身份由完整扫描发现。
      db: fakeDb({
        tableCount: 2,
        rows: [row({ localId: 1, realSenderId: 7 })],
        senders: { [`${DB0}#7`]: SESSION },
        identities: { [identity]: 2 },
      }),
    })

    expect(report.sessions[0].identityAudit).toMatchObject({
      status: 'checked',
      complete: false,
      repeatedIdentityGroups: 1,
      repeatedIdentityExtraRows: 1,
    })
    expect(report.totals.duplicates).toBe(1)
    expect(report.sessions[0].gaps.find((gap) => gap.kind === 'identity')?.detail).toContain('重复源身份 1 组')
    expect(report.ok).toBe(false)
  })

  it('产物少了一条源行（表计数照样对得上）→ identity gap、ok:false', async () => {
    const artifact = jsonArtifact([{ sourceIdentityHash: identityOf(1) }, { sourceIdentityHash: identityOf(2) }])
    const report = await runJsonExport({
      artifact,
      // 表计数说 2 条、产物也是 2 行 —— 总数核对通过；身份多重集说源侧其实有 3 行。
      tableCount: 2,
      rows: [row({ localId: 1, realSenderId: 7 }), row({ localId: 2, realSenderId: 7 })],
      db: fakeDb({
        tableCount: 2,
        rows: [row({ localId: 1, realSenderId: 7 }), row({ localId: 2, realSenderId: 7 })],
        senders: { [`${DB0}#7`]: SESSION },
        identities: { [identityOf(1)]: 1, [identityOf(2)]: 2 },
      }),
    })
    expect(report.totals.mismatches).toBe(0)
    expect(report.sessions[0].identityAudit).toMatchObject({ status: 'checked', complete: false, missingRows: 1 })
    expect(report.totals.identityMissingRows).toBe(1)
    expect(report.sessions[0].gaps.map((gap) => gap.kind)).toContain('identity')
    expect(report.ok).toBe(false)
  })

  it('旧产物（没有 sourceIdentityHash）→ legacy-artifact，只记 note，不算缺陷也不假装核对过', async () => {
    const artifact = jsonArtifact([{ a: 1 }, { b: 2 }])
    const report = await runJsonExport({
      artifact,
      tableCount: 2,
      rows: [row({ localId: 1, realSenderId: 7 })],
      db: fakeDb({ tableCount: 2, rows: [row({ localId: 1, realSenderId: 7 })], senders: { [`${DB0}#7`]: SESSION } }),
    })
    expect(report.sessions[0].identityAudit.status).toBe('legacy-artifact')
    expect(report.sessions[0].identityAudit.complete).toBe(false)
    expect(report.sessions[0].notes.join()).toContain('没有 sourceIdentityHash')
    expect(report.sessions[0].gaps.map((gap) => gap.kind)).not.toContain('identity')
  })

  it('只有一部分行带身份 → 直接判为不完整，不拿"有的那部分"凑一个假结论', async () => {
    const artifact = jsonArtifact([{ sourceIdentityHash: identityOf(1) }, { b: 2 }])
    const report = await runJsonExport({
      artifact,
      tableCount: 2,
      rows: [row({ localId: 1, realSenderId: 7 })],
      db: fakeDb({
        tableCount: 2,
        rows: [row({ localId: 1, realSenderId: 7 })],
        senders: { [`${DB0}#7`]: SESSION },
        identities: { [identityOf(1)]: 1 },
      }),
    })
    expect(report.sessions[0].identityAudit).toMatchObject({ status: 'checked', complete: false, extraRows: 1 })
    expect(report.ok).toBe(false)
  })

  it('身份哈希不是 64 位 hex → 记 invalid 并报出来（不许静默跳过）', async () => {
    const artifact = jsonArtifact([{ sourceIdentityHash: 'zzz' }, { sourceIdentityHash: identityOf(2) }])
    const report = await runJsonExport({
      artifact,
      tableCount: 2,
      rows: [row({ localId: 1, realSenderId: 7 })],
      db: fakeDb({
        tableCount: 2,
        rows: [row({ localId: 1, realSenderId: 7 })],
        senders: { [`${DB0}#7`]: SESSION },
        identities: { [identityOf(2)]: 1 },
      }),
    })
    expect(report.sessions[0].identityAudit).toMatchObject({ status: 'checked', complete: false })
    expect(report.sessions[0].identityAudit.extraRows).toBeGreaterThan(0)
    expect(report.ok).toBe(false)
  })

  it('源侧有行定位不到身份 → complete:false（不完整的核对不等于通过）', async () => {
    const artifact = jsonArtifact([{ sourceIdentityHash: identityOf(1) }, { sourceIdentityHash: identityOf(2) }])
    const report = await runJsonExport({
      artifact,
      tableCount: 2,
      rows: [row({ localId: 1, realSenderId: 7 })],
      db: fakeDb({
        tableCount: 2,
        rows: [row({ localId: 1, realSenderId: 7 })],
        senders: { [`${DB0}#7`]: SESSION },
        identities: { [identityOf(1)]: 1, [identityOf(2)]: 1 },
        unscopedSourceRows: 4,
      }),
    })
    expect(report.sessions[0].identityAudit).toMatchObject({ status: 'checked', complete: false, unscopedSourceRows: 4 })
    expect(report.ok).toBe(false)
  })

  it('数据库侧根本查不了身份多重集 → unavailable + 明确 gap（"没检查"不等于"通过"）', async () => {
    const artifact = jsonArtifact([{ sourceIdentityHash: identityOf(1) }, { sourceIdentityHash: identityOf(2) }])
    const report = await runJsonExport({
      artifact,
      tableCount: 2,
      rows: [row({ localId: 1, realSenderId: 7 })],
      db: fakeDb({
        tableCount: 2,
        rows: [row({ localId: 1, realSenderId: 7 })],
        senders: { [`${DB0}#7`]: SESSION },
        withoutIdentityScan: true,
      }),
    })
    expect(report.sessions[0].identityAudit.status).toBe('unavailable')
    expect(report.sessions[0].gaps.map((gap) => gap.kind)).toContain('identity')
    expect(report.ok).toBe(false)
  })

  it('分片导出（scoped）产物只是全量的一部分 → not-applicable，不做身份核对', async () => {
    const artifact = jsonArtifact([{ sourceIdentityHash: identityOf(1) }, { sourceIdentityHash: identityOf(2) }])
    const report = await runJsonExport({
      artifact,
      scoped: true,
      tableCount: 500,
      rows: [row({ localId: 1, realSenderId: 7 })],
      db: fakeDb({
        tableCount: 500,
        rows: [row({ localId: 1, realSenderId: 7 })],
        senders: { [`${DB0}#7`]: SESSION },
        identities: {},
      }),
    })
    expect(report.sessions[0].identityAudit.status).toBe('not-applicable')
    expect(report.ok).toBe(true)
  })

  it('身份查询失败 → unavailable，而不是当成"没有差异"', async () => {
    const artifact = jsonArtifact([{ sourceIdentityHash: identityOf(1) }, { sourceIdentityHash: identityOf(2) }])
    const report = await runJsonExport({
      artifact,
      tableCount: 2,
      rows: [row({ localId: 1, realSenderId: 7 })],
      db: fakeDb({
        tableCount: 2,
        rows: [row({ localId: 1, realSenderId: 7 })],
        senders: { [`${DB0}#7`]: SESSION },
        identityScanFails: true,
      }),
    })
    expect(report.sessions[0].identityAudit.status).toBe('unavailable')
    expect(report.ok).toBe(false)
  })

  it('compareSourceIdentityMultisets：同一身份出现多次按重数配平', () => {
    expect(compareSourceIdentityMultisets({ a: 2, b: 1 }, { a: 1, b: 2 })).toEqual({
      matchedRows: 2,
      missingRows: 1,
      extraRows: 1,
    })
    expect(compareSourceIdentityMultisets({ a: 1 }, { a: 1 })).toEqual({ matchedRows: 1, missingRows: 0, extraRows: 0 })
  })
})

describe('数据库行归一化', () => {
  it('isSend 读 computed_is_send（宿主算好的），没有它才退到 is_send', () => {
    expect(coerceMessageRow(SESSION, { local_id: 1, create_time: 10, computed_is_send: 1 })?.isSend).toBe(true)
    expect(coerceMessageRow(SESSION, { local_id: 1, create_time: 10, is_send: 1 })?.isSend).toBe(true)
    expect(coerceMessageRow(SESSION, { local_id: 1, create_time: 10 })?.isSend).toBe(false)
  })

  it('缺 local_id 与 create_time 的行被丢掉（无法定位，留着只会算错）', () => {
    expect(coerceMessageRow(SESSION, { local_id: 0, create_time: 0 })).toBeNull()
    const row = coerceMessageRow(SESSION, {
      local_id: '123',
      create_time: 1700000000,
      local_type: 34,
      is_send: 1,
      server_id_raw: '999',
      real_sender_id: '7',
      _db_path: DB0,
      _table_name: 'Msg_a',
      message_content: 'hi',
    })
    expect(row).toMatchObject({
      localId: 123,
      createTime: 1700000000,
      localType: 34,
      isSend: true,
      serverIdRaw: '999',
      realSenderId: 7,
      dbPath: DB0,
      tableName: 'Msg_a',
      content: 'hi',
    })
  })
})
