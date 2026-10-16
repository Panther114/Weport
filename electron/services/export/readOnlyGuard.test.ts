import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  WcdbReadOnlyGuard,
  classifySql,
  classifyStatement,
  splitSqlStatements,
  stripSqlComments,
  wcdbReadOnlyGuard,
} from './readOnlyGuard'
import { captureWalSignature, contentChanges, diffWalSignature } from './walSnapshot'

/**
 * 只读库访问闸门（v1.2 §10.3 ③）。
 *
 * 这里守的是"应用自己的代码路径不会去写用户的库"：
 * 只读上下文里出现写语句必须被拒绝（整条语句都发不到引擎），
 * 而显式声明的写路径（防撤回触发器 / SNS 删除 / 一键已读 / 改删消息）仍然可用。
 * 另外断言"读操作不会改 `-wal`/`-shm`"这件事本身是可测量的。
 */

let root = ''

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'weport-guard-'))
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

describe('语句判定表', () => {
  it('SELECT / WITH / EXPLAIN / VALUES 是只读', () => {
    expect(classifyStatement('SELECT * FROM message').allowed).toBe(true)
    expect(classifyStatement('  select 1').allowed).toBe(true)
    expect(classifyStatement('WITH x AS (SELECT 1) SELECT * FROM x').allowed).toBe(true)
    expect(classifyStatement('EXPLAIN QUERY PLAN SELECT 1').allowed).toBe(true)
    expect(classifyStatement('VALUES (1)').allowed).toBe(true)
  })

  /**
   * 数据修改 CTE（`WITH … DELETE`）—— 只读闸门曾经从这道缝里放过写语句。
   *
   * 首关键字是 WITH，看起来是只读的；真正的动词在 CTE 列表**之后**，而以前只查首关键字。
   * 这条闸门守的是用户的微信库，所以每种写动词都要挡住；同时不能误伤"别名里带 delete"
   * 或"字符串里出现 delete"的正常只读查询。
   */
  it('带写操作的 CTE 被拒绝，同名的只读 CTE 仍然放行', () => {
    expect(classifyStatement('WITH x AS (SELECT 1) DELETE FROM message').allowed).toBe(false)
    expect(classifyStatement('WITH x AS (SELECT 1) DELETE FROM message').kind).toBe('write:cte')
    expect(classifyStatement('WITH x AS (SELECT 1) INSERT INTO notes VALUES (1)').allowed).toBe(false)
    expect(classifyStatement('WITH x AS (SELECT 1) UPDATE message SET x = 1').allowed).toBe(false)
    expect(classifyStatement('WITH x AS (SELECT 1) REPLACE INTO notes VALUES (1)').allowed).toBe(false)
    // 括号里的子查询、字符串里的字样、别名，都不算顶层写动词
    expect(classifyStatement('WITH x AS (SELECT * FROM message) SELECT * FROM x').allowed).toBe(true)
    expect(classifyStatement("WITH deleted AS (SELECT 1) SELECT * FROM deleted").allowed).toBe(true)
    expect(classifyStatement("SELECT 'delete from t' AS note").allowed).toBe(true)
  })

  it('带引号的写 pragma 不因为引号被放过', () => {
    expect(classifyStatement('PRAGMA "wal_checkpoint"(TRUNCATE)').allowed).toBe(false)
    expect(classifyStatement('PRAGMA [journal_mode]=DELETE').allowed).toBe(false)
    expect(classifyStatement('PRAGMA "table_info"(message)').allowed).toBe(true)
  })

  it('schema-qualified writes and unknown PRAGMAs fail closed', () => {
    expect(classifyStatement('PRAGMA main.journal_mode=DELETE').allowed).toBe(false)
    expect(classifyStatement('PRAGMA "main"."wal_checkpoint"(TRUNCATE)').allowed).toBe(false)
    expect(classifyStatement('PRAGMA [main].[journal_mode]=DELETE').allowed).toBe(false)
    expect(classifyStatement('PRAGMA custom_setting=1').allowed).toBe(false)
    expect(classifyStatement('PRAGMA custom_setting').allowed).toBe(false)
    expect(classifyStatement('PRAGMA main.table_info(contact)').allowed).toBe(true)
  })

  it('PRAGMA table_info 是只读，PRAGMA wal_checkpoint 是写', () => {
    expect(classifyStatement('PRAGMA table_info(contact)').allowed).toBe(true)
    expect(classifyStatement('PRAGMA table_info(message)').kind).toBe('pragma')
    const checkpoint = classifyStatement('PRAGMA wal_checkpoint(TRUNCATE)')
    expect(checkpoint.allowed).toBe(false)
    expect(checkpoint.kind).toBe('pragma-write')
    expect(classifyStatement('PRAGMA journal_mode=DELETE').allowed).toBe(false)
    expect(classifyStatement('PRAGMA user_version = 0').allowed).toBe(false)  })

  it('写语句一律拒绝，并给出可读原因与语句片段', () => {
    const cases = [
      'INSERT INTO message(localId) VALUES (1)',
      'UPDATE message SET content = "" WHERE localId = 1',
      'DELETE FROM message WHERE localId = 1',
      'REPLACE INTO message(localId) VALUES (1)',
      'CREATE TABLE t (a INT)',
      'CREATE TRIGGER trg AFTER DELETE ON message BEGIN INSERT INTO x VALUES(1); END',
      'DROP TRIGGER trg',
      'ALTER TABLE message ADD COLUMN extra INT',
      'VACUUM',
      'ATTACH DATABASE "x.db" AS other',
      'BEGIN',
      'COMMIT',
    ]
    for (const sql of cases) {
      const decision = classifyStatement(sql)
      expect(decision.allowed, `${sql} 应当被拒绝`).toBe(false)
      expect(decision.reason).toBeTruthy()
      expect(decision.offender).toBeTruthy()
    }
  })

  it('注释不会把写语句伪装成只读', () => {
    expect(classifyStatement('/* SELECT */ DELETE FROM message').allowed).toBe(false)
    expect(classifyStatement('-- SELECT\nUPDATE message SET a=1').allowed).toBe(false)
    expect(classifyStatement('/* 只是注释 */ SELECT 1').allowed).toBe(true)
  })

  it('多条语句里只要有一条是写，整段就拒绝', () => {
    const decision = classifySql('SELECT 1; DELETE FROM message; SELECT 2')
    expect(decision.allowed).toBe(false)
    expect(decision.kind).toBe('write:delete')
  })

  it('字符串字面量里的分号不当作语句分隔符', () => {
    expect(splitSqlStatements("SELECT ';' AS a")).toEqual(["SELECT ';' AS a"])
    expect(splitSqlStatements("SELECT 'a'';''b'")).toHaveLength(1)
    expect(splitSqlStatements('SELECT 1; SELECT 2')).toHaveLength(2)
  })

  it('未列入白名单的语句默认拒绝（不是默认放行）', () => {
    const decision = classifyStatement('GRANT ALL ON message TO someone')
    expect(decision.allowed).toBe(false)
    expect(classifyStatement('SOMETHING WEIRD').allowed).toBe(false)
  })

  it('stripSqlComments 保留字符串字面量里的 -- 与 /*', () => {
    expect(stripSqlComments("SELECT '--not-comment'")).toContain('--not-comment')
    expect(stripSqlComments('SELECT 1 -- comment\nFROM t')).not.toContain('comment')
  })

  it('空语句放行（不会误伤到没有 SQL 的访问路径）', () => {
    expect(classifySql('').allowed).toBe(true)
    expect(classifySql('   ').allowed).toBe(true)
  })
})

describe('闸门：只读上下文拒绝写语句', () => {
  it('默认是只读模式，写语句被拒绝且不发给引擎', () => {
    const guard = new WcdbReadOnlyGuard()
    expect(guard.getMode()).toBe('read-only')
    const decision = guard.assertSqlAllowed('DELETE FROM message', { operation: 'execQuery', table: 'message' })
    expect(decision.allowed).toBe(false)
    expect(guard.getAudit().rejections).toHaveLength(1)
    expect(guard.getAudit().rejections[0].operation).toBe('execQuery')
  })

  it('只读语句在只读模式下放行，并留下审计（不含 SQL 原文，只有长度）', () => {
    const guard = new WcdbReadOnlyGuard()
    const decision = guard.assertSqlAllowed('SELECT COUNT(1) FROM message', { operation: 'execQuery', table: 'message' })
    expect(decision.allowed).toBe(true)
    const audit = guard.getAudit()
    expect(audit.records).toHaveLength(1)
    expect(audit.records[0].allowed).toBe(true)
    expect(audit.records[0].sqlLength).toBe('SELECT COUNT(1) FROM message'.length)
    expect(JSON.stringify(audit)).not.toContain('COUNT(1)')
  })

  it('拒绝会触发回调（宿主/主进程可以据此落日志）', () => {
    const guard = new WcdbReadOnlyGuard()
    const seen: string[] = []
    guard.setRejectHandler((record) => seen.push(record.reason || ''))
    guard.assertSqlAllowed('CREATE TABLE t (a INT)')
    expect(seen).toHaveLength(1)
    expect(seen[0]).toContain('CREATE')
  })

  it('runWrite 期间放行写语句，结束后立刻回到只读（写模式不会漏给后面的只读路径）', async () => {
    const guard = new WcdbReadOnlyGuard()
    let insideAllowed = false
    await guard.runWrite('anti-revoke-trigger-install', 'installTriggers', async () => {
      insideAllowed = guard.assertSqlAllowed('CREATE TRIGGER t AFTER DELETE ON message BEGIN SELECT 1; END').allowed
      expect(guard.getMode()).toBe('write')
      expect(guard.assertSqlAllowed('PRAGMA main.journal_mode=DELETE').allowed).toBe(false)
      expect(guard.assertSqlAllowed('PRAGMA unknown_setting=1').allowed).toBe(false)
    })
    expect(insideAllowed).toBe(true)
    expect(guard.getMode()).toBe('read-only')
    expect(guard.assertSqlAllowed('CREATE TRIGGER t AFTER DELETE ON message BEGIN SELECT 1; END').allowed).toBe(false)
    expect(guard.getAudit().modeChanges.map((entry) => entry.mode)).toEqual(['write', 'read-only'])
  })

  it('write permission is scoped to the authorized async call tree', async () => {
    const guard = new WcdbReadOnlyGuard()
    let entered!: () => void
    let release!: () => void
    const started = new Promise<void>((resolve) => { entered = resolve })
    const blocked = new Promise<void>((resolve) => { release = resolve })
    const authorizedWrite = guard.runWrite('test-write', 'test', async () => {
      entered()
      await blocked
      expect(guard.getMode()).toBe('write')
      expect(guard.assertSqlAllowed('DELETE FROM message').allowed).toBe(true)
    })

    await started
    expect(guard.getMode()).toBe('read-only')
    expect(guard.assertSqlAllowed('DELETE FROM message').allowed).toBe(false)
    release()
    await authorizedWrite
    expect(guard.getMode()).toBe('read-only')
  })

  it('runWrite 里抛异常也会切回只读', async () => {
    const guard = new WcdbReadOnlyGuard()
    await expect(guard.runWrite('x', 'op', async () => { throw new Error('boom') })).rejects.toThrow(/boom/)
    expect(guard.getMode()).toBe('read-only')
  })

  it('写模式漏收尾时，只读操作会留下告警审计（不是静默通过）', async () => {
    const guard = new WcdbReadOnlyGuard()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => { /* 静音 */ })
    try {
      await guard.runWrite('long-write', 'op', async () => {
        // 写模式窗口内做一次只读打卡：这正是"写模式漏给只读路径"的样子
        guard.assertReadOnlyOperation('openMessageCursor', { sessionId: 'wxid_a' })
      })
      const audit = guard.getAudit()
      const entry = audit.records.find((record) => record.operation === 'openMessageCursor')
      expect(entry).toBeDefined()
      expect(entry?.allowed).toBe(false)
      expect(entry?.reason).toContain('写模式未收尾')
      expect(warn).toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })

  it('进程级单例存在且默认只读（wcdbCore 认这个对象）', () => {
    expect(wcdbReadOnlyGuard).toBeInstanceOf(WcdbReadOnlyGuard)
    wcdbReadOnlyGuard.resetToReadOnly()
    expect(wcdbReadOnlyGuard.getMode()).toBe('read-only')
  })
})

describe('`-wal` / `-shm` 不被修改是可测量的', () => {
  it('采样包含 session.db / -wal / -shm 三个文件', async () => {
    const sessionDb = path.join(root, 'session.db')
    fs.writeFileSync(sessionDb, 'main-db')
    fs.writeFileSync(`${sessionDb}-wal`, 'wal-bytes')
    fs.writeFileSync(`${sessionDb}-shm`, 'shm-bytes')
    const signature = await captureWalSignature(sessionDb)
    expect(signature.map((item) => item.path)).toEqual([sessionDb, `${sessionDb}-wal`, `${sessionDb}-shm`])
    expect(signature.every((item) => item.exists)).toBe(true)
    expect(signature.every((item) => item.sha256.length === 64)).toBe(true)
  })

  it('文件缺失时也返回条目（exists=false），不抛异常', async () => {
    const sessionDb = path.join(root, 'session.db')
    const signature = await captureWalSignature(sessionDb)
    expect(signature).toHaveLength(3)
    expect(signature.every((item) => item.exists === false)).toBe(true)
  })

  it('只读采样不改动任何字节（前后 sha256 一致）', async () => {
    const sessionDb = path.join(root, 'session.db')
    fs.writeFileSync(sessionDb, 'main-db')
    fs.writeFileSync(`${sessionDb}-wal`, 'wal-bytes')
    const before = await captureWalSignature(sessionDb)
    await captureWalSignature(sessionDb)
    const after = await captureWalSignature(sessionDb)
    expect(diffWalSignature(before, after)).toEqual([])
  })

  it('内容被改写会被 diff 抓住（这就是验收断言的手段）', async () => {
    const sessionDb = path.join(root, 'session.db')
    fs.writeFileSync(sessionDb, 'main-db')
    fs.writeFileSync(`${sessionDb}-wal`, 'wal-bytes')
    const before = await captureWalSignature(sessionDb)
    fs.writeFileSync(`${sessionDb}-wal`, 'wal-bytes-changed')
    const after = await captureWalSignature(sessionDb)
    const diffs = diffWalSignature(before, after)
    // 内容变了就是变了（大小变与内容变都算"被改写"，不再按大小分优先级）
    expect(diffs.some((diff) => diff.path.endsWith('-wal'))).toBe(true)
    // session.db 本身没被动，contentChanges 只关心库主体与 -wal
    expect(contentChanges(diffs, sessionDb).some((diff) => diff.path === sessionDb)).toBe(false)
  })

  it('-shm 的出现/消失不算"内容被改"（SQLite 打开连接就会重建它，是易失文件）', async () => {
    const sessionDb = path.join(root, 'session.db')
    fs.writeFileSync(sessionDb, 'main-db')
    fs.writeFileSync(`${sessionDb}-wal`, 'wal-bytes')
    const before = await captureWalSignature(sessionDb)
    fs.writeFileSync(`${sessionDb}-shm`, 'sqlite-shm')
    const after = await captureWalSignature(sessionDb)
    const diffs = diffWalSignature(before, after)
    expect(diffs.some((diff) => diff.path.endsWith('-shm') && diff.change === 'appeared')).toBe(true)
    expect(contentChanges(diffs, sessionDb)).toEqual([])
  })
})
