/**
 * 只读库访问闸门（v1.2 §10.3 ③）。
 *
 * ## 为什么是"拒绝写语句"而不是"只读方式打开库"
 *
 * 引擎只有 `wcdb_open_account(path, hex_key, out_handle)` 一个打开入口
 * （见 `wcdbCore.ts` 里的 FFI 签名）—— 它不暴露 SQLite 的 `SQLITE_OPEN_READONLY`
 * 标志，也没有 `immutable=1` 的开关位，因此**无法从打开参数上把连接降级为只读**。
 * 剩下的路有两条，我们选择后者并说明理由：
 *
 * 1. 把 `session.db` 换成只读副本（拷贝或 immutable URI）再打开。
 *    代价：几十 GB 的库每次都要拷贝或额外落盘，且与"微信正在运行"的
 *    `-wal` 合并语义纠缠（见下方 §-wal 说明），失败面更大。
 * 2. **单一收口 + 语句拒绝表**：所有库访问（只读查询 / 游标 / 写操作）都必须经过
 *    `wcdbCore` 里的那一个 `WcdbReadOnlyGuard`。默认模式是 `read-only`；
 *    只有显式声明过模式的写路径（防撤回触发器、SNS 删除、一键已读、改消息/删消息）
 *    才允许写语句通过。写语句出现在只读上下文里 → 直接拒绝，不发送到引擎。
 *
 * 选择 2 的直接好处：拒绝点只有一个，能写测试（见 `readOnlyGuard.test.ts`），
 * 而且不改变现有性能特征。它守的是"应用自己的代码路径不会去写用户的库" ——
 * 这是 §10.3 的验收目标（阅读/导出/分析期间 `-wal`/`-shm` 不被应用修改）。
 * 它不承诺挡住 DLL 内部自己的写入（那是引擎行为，不是 Weport 能改的）。
 *
 * ## -wal 的处理（§10.3 要求明确选择并记录理由）
 *
 * 结论：**保留 `-wal`、以只读方式读它，绝不改写/删除/重建 `-wal` 与 `-shm`。**
 *
 * - SQLite 在 WAL 模式下，最新提交的数据就在 `-wal` 里；忽略 `-wal` 会读到过期快照，
 *   导出的消息会"少最近的几条"。所以 `-wal` 必须参与读取。
 * - 只读读者读 WAL 是安全的：读事务结束时 SQLite 只是把读标记写在 `-shm` 的
 *   锁字节里（不构成数据修改），且当 `-wal` 被主进程回收（truncate/checkpoint）时，
 *   持有旧快照的读者会拿到 `SQLITE_BUSY_SNAPSHOT` 并重试，而不是读到坏页。
 * - 反过来，任何"替微信做检查点"的想法（`PRAGMA wal_checkpoint`）都是写操作：
 *   它要拿写锁、要动 `-wal`。微信正在运行时这既可能失败也可能与微信的
 *   checkpoint 竞争。我们**不做**，并把 `PRAGMA wal_checkpoint(...)` 归到写语句表里拒绝。
 * - `-shm` 是共享内存文件：应用打开连接时 SQLite 自己会创建/映射它，这一步不改变
 *   数据库内容（`-shm` 本身就是易失的），因此不算"修改用户数据"。`-wal`/`-shm`
 *   的字节内容若被应用直接改写（拷贝时截断、删除、单独替换），才会造成损坏 ——
 *   本模块的 `captureWalSignature`（见 `walSnapshot.ts`）就是给测试用来断言"我们没动它"的。
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import type { DbAccessMode } from './walSnapshot'
export type { DbAccessMode } from './walSnapshot'

export interface DbStatementDecision {
  allowed: boolean
  /** 允许：识别出的语句种类；拒绝：拒绝原因。 */
  kind: string
  reason?: string
  /** 被判定为写的语句文本（截断到 200 字符，用于日志/测试断言）。 */
  offender?: string
}

const READ_ONLY_KEYWORDS = new Set([
  'select', 'with', 'values', 'explain',
  'pragma', 'table_info', 'index_info', 'index_list', 'foreign_key_list', 'database_list',
])

const WRITE_KEYWORDS = new Set([
  'insert', 'update', 'delete', 'replace', 'upsert', 'merge',
  'create', 'drop', 'alter', 'truncate', 'rename',
  'vacuum', 'reindex', 'analyze', 'attach', 'detach',
  'begin', 'commit', 'rollback', 'savepoint', 'release', 'end',
  'grant', 'revoke', 'set',
])

/** 这些 PRAGMA 即使在只读上下文里也是写操作（会改库/写 WAL）。 */
const WRITE_PRAGMAS = new Set([
  'wal_checkpoint', 'journal_mode', 'synchronous', 'user_version', 'schema_version',
  'application_id', 'auto_vacuum', 'page_size', 'incremental_vacuum', 'secure_delete',
  'wal_autocheckpoint', 'locking_mode', 'writable_schema', 'foreign_keys', 'encoding',
  'cache_size', 'temp_store', 'mmap_size', 'shrink_memory', 'optimize', 'analysis_limit',
])

/** PRAGMAs used as read-only queries by the app. Unknown PRAGMAs fail closed. */
const READ_ONLY_PRAGMAS = new Set([
  'table_info', 'table_xinfo', 'index_info', 'index_xinfo', 'index_list',
  'foreign_key_list', 'database_list', 'compile_options', 'foreign_key_check',
  'integrity_check', 'quick_check', 'collation_list', 'function_list', 'module_list',
  'pragma_list', 'data_version',
])

/** 去掉 SQL 注释，保留字符串字面量（避免 `--` 把后面整行吃掉后误判）。 */
export function stripSqlComments(sql: string): string {
  let out = ''
  let i = 0
  const text = String(sql || '')
  while (i < text.length) {
    const ch = text[i]
    const next = text[i + 1]
    if (ch === '-' && next === '-') {
      while (i < text.length && text[i] !== '\n') i += 1
      out += '\n'
      continue
    }
    if (ch === '/' && next === '*') {
      i += 2
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i += 1
      i += 2
      out += ' '
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch
      out += ch
      i += 1
      while (i < text.length) {
        out += text[i]
        if (text[i] === quote) {
          if (text[i + 1] === quote) {
            out += text[i + 1]
            i += 2
            continue
          }
          i += 1
          break
        }
        i += 1
      }
      continue
    }
    out += ch
    i += 1
  }
  return out
}

/** 按分号切多条语句（引号内的分号不算分隔符）。 */
export function splitSqlStatements(sql: string): string[] {
  const text = stripSqlComments(sql)
  const parts: string[] = []
  let current = ''
  let i = 0
  while (i < text.length) {
    const ch = text[i]
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch
      current += ch
      i += 1
      while (i < text.length) {
        current += text[i]
        if (text[i] === quote) {
          if (text[i + 1] === quote) {
            current += text[i + 1]
            i += 2
            continue
          }
          i += 1
          break
        }
        i += 1
      }
      continue
    }
    if (ch === ';') {
      parts.push(current)
      current = ''
      i += 1
      continue
    }
    current += ch
    i += 1
  }
  parts.push(current)
  return parts.map((part) => part.trim()).filter(Boolean)
}

function firstKeyword(statement: string): { keyword: string; rest: string } {
  // 先做一次"去注释后重新 trim"：`/* c */ SELECT 1` 去注释后前缀变成空白，
  // 不重新 trim 就会落到 "无法识别" 分支（把只读语句误判成拒绝）。
  const cleaned = stripSqlComments(statement).trim()
  const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\b([\s\S]*)$/.exec(cleaned)
  if (!match) return { keyword: '', rest: '' }
  return { keyword: match[1].toLowerCase(), rest: match[2] || '' }
}

function readSqlIdentifier(text: string, start: number): { value: string; end: number } | null {
  let index = start
  while (/\s/.test(text[index] || '')) index += 1
  const quote = text[index]
  if (quote === '"' || quote === '`') {
    let value = ''
    index += 1
    while (index < text.length) {
      if (text[index] === quote) {
        if (text[index + 1] === quote) {
          value += quote
          index += 2
          continue
        }
        return { value: value.toLowerCase(), end: index + 1 }
      }
      value += text[index]
      index += 1
    }
    return null
  }
  if (quote === '[') {
    const close = text.indexOf(']', index + 1)
    if (close < 0) return null
    return { value: text.slice(index + 1, close).toLowerCase(), end: close + 1 }
  }
  const match = /^[A-Za-z_][A-Za-z0-9_$]*/.exec(text.slice(index))
  return match ? { value: match[0].toLowerCase(), end: index + match[0].length } : null
}

function parsePragma(rest: string): { name: string; tail: string } | null {
  const text = stripSqlComments(rest)
  const first = readSqlIdentifier(text, 0)
  if (!first) return null
  let index = first.end
  while (/\s/.test(text[index] || '')) index += 1
  if (text[index] !== '.') return { name: first.value, tail: text.slice(index) }

  const second = readSqlIdentifier(text, index + 1)
  if (!second) return null
  index = second.end
  while (/\s/.test(text[index] || '')) index += 1
  return { name: second.value, tail: text.slice(index) }
}

function isReadOnlyPragmaForm(tail: string): boolean {
  const text = tail.trim()
  if (!text) return true
  if (text[0] === '=' || text[0] !== '(') return false

  let depth = 0
  let quote: string | null = null
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    if (quote) {
      if (ch === quote) {
        if (text[i + 1] === quote) i += 1
        else quote = null
      }
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch
      continue
    }
    if (ch === '[') {
      const close = text.indexOf(']', i)
      if (close < 0) return false
      i = close
      continue
    }
    if (ch === '(') depth += 1
    else if (ch === ')') {
      depth -= 1
      if (depth < 0) return false
      if (depth === 0) return text.slice(i + 1).trim().length === 0
    }
  }
  return false
}

/**
 * `WITH` body 里的**顶层**写动词（数据修改 CTE）。
 *
 * 逐字符走，跳过括号内的内容与引号里的文本：`WITH x AS (SELECT …) DELETE FROM …` 里的 DELETE
 * 在深度 0，必须抓到；而 `WITH x AS (SELECT 'delete from t') SELECT …` 里的同一个词是字符串，
 * 不能误伤。用词边界匹配，于是 `deleted`（常见别名）不会当成 DELETE。
 */
function findTopLevelWriteKeyword(body: string): string {
  const cleaned = stripSqlComments(body)
  let depth = 0
  let quote: string | null = null
  for (let i = 0; i < cleaned.length; i += 1) {
    const ch = cleaned[i]
    if (quote) {
      if (ch === quote) {
        // SQL 里 '' 表示一个引号
        if (cleaned[i + 1] === quote) i += 1
        else quote = null
      }
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch
      continue
    }
    if (ch === '[') {
      // SQLite 的 [方括号标识符]
      const close = cleaned.indexOf(']', i)
      i = close >= 0 ? close : cleaned.length
      continue
    }
    if (ch === '(') {
      depth += 1
      continue
    }
    if (ch === ')') {
      depth = Math.max(0, depth - 1)
      continue
    }
    if (depth !== 0) continue
    for (const verb of ['insert', 'update', 'delete', 'replace']) {
      if (!startsWithWord(cleaned, i, verb)) continue
      // 紧跟标识符的动词在 SQL 里是别名/字段名，不是语句动词
      const after = cleaned[i + verb.length]
      if (after && /[A-Za-z0-9_]/.test(after)) continue
      return verb
    }
  }
  return ''
}

function startsWithWord(text: string, at: number, word: string): boolean {
  if (at > 0 && /[A-Za-z0-9_]/.test(text[at - 1])) return false
  return text.slice(at, at + word.length).toLowerCase() === word
}

/**
 * 判定一条语句在**只读上下文**里是否被允许。
 * 规则：显式只读关键字表（SELECT/WITH/VALUES/EXPLAIN/PRAGMA 白名单）之外一律拒绝；
 * 写关键字表命中直接拒绝，并给出人类可读的原因。
 */
export function classifyStatement(statement: string): DbStatementDecision {
  const text = String(statement || '').trim()
  if (!text) return { allowed: true, kind: 'empty' }
  const { keyword, rest } = firstKeyword(text)
  if (!keyword) {
    return { allowed: false, kind: 'unknown', reason: '无法识别的语句（只读上下文拒绝）', offender: text.slice(0, 200) }
  }
  if (keyword === 'pragma') {
    // SQLite accepts [schema.]pragma-name. Normalize quoted names and the
    // optional schema before deciding; only known read-only PRAGMAs pass.
    const parsed = parsePragma(rest)
    if (!parsed) {
      return {
        allowed: false,
        kind: 'pragma-unknown',
        reason: '无法识别的 PRAGMA（只读上下文默认拒绝）',
        offender: text.slice(0, 200),
      }
    }
    if (WRITE_PRAGMAS.has(parsed.name) || !READ_ONLY_PRAGMAS.has(parsed.name) || !isReadOnlyPragmaForm(parsed.tail)) {
      const knownWrite = WRITE_PRAGMAS.has(parsed.name)
      return {
        allowed: false,
        kind: knownWrite ? 'pragma-write' : 'pragma-unknown',
        reason: knownWrite
          ? `PRAGMA ${parsed.name} 会修改库/写 WAL，只读上下文拒绝`
          : `PRAGMA ${parsed.name} 未列入只读白名单或包含 setter 语法，只读上下文拒绝`,
        offender: text.slice(0, 200),
      }
    }
    return { allowed: true, kind: 'pragma' }
  }
  if (READ_ONLY_KEYWORDS.has(keyword)) {
    // `WITH` 本身是只读的，但 **数据修改 CTE** 的真正动词在 body 里：
    // `WITH x AS (SELECT …) DELETE FROM message` / `INSERT INTO …` 一样会改库。
    // 以前只看首关键字，于是这类语句从只读门缝里过去了 —— 而这道门守的是用户的微信库。
    if (keyword === 'with' && findTopLevelWriteKeyword(rest)) {
      return {
        allowed: false,
        kind: 'write:cte',
        reason: '只读上下文拒绝带写操作的 CTE（WITH … INSERT/UPDATE/DELETE/REPLACE）',
        offender: text.slice(0, 200),
      }
    }
    return { allowed: true, kind: 'read' }
  }
  if (WRITE_KEYWORDS.has(keyword)) {
    return {
      allowed: false,
      kind: `write:${keyword}`,
      reason: `只读上下文拒绝写语句 ${keyword.toUpperCase()}`,
      offender: text.slice(0, 200),
    }
  }
  return {
    allowed: false,
    kind: 'unknown',
    reason: `未列入只读白名单的语句 ${keyword.toUpperCase()}（默认拒绝）`,
    offender: text.slice(0, 200),
  }
}

/** 判定整段 SQL（可含多条语句）：任何一条被判定为写就整体拒绝。 */
export function classifySql(sql: string): DbStatementDecision {
  const statements = splitSqlStatements(sql)
  if (statements.length === 0) return { allowed: true, kind: 'empty' }
  for (const statement of statements) {
    const decision = classifyStatement(statement)
    if (!decision.allowed) return decision
  }
  return { allowed: true, kind: 'read' }
}

export interface DbGuardRecord {
  at: number
  mode: DbAccessMode
  operation: string
  kind?: string
  table?: string | null
  path?: string | null
  sqlLength: number
  allowed: boolean
  reason?: string
}

export interface DbGuardAudit {
  /** 每次库访问请求都会被记一条（只记长度与判定，不记 SQL 原文）。 */
  records: DbGuardRecord[]
  rejections: DbGuardRecord[]
  modeChanges: Array<{ at: number; mode: DbAccessMode; reason: string }>
}

const AUDIT_LIMIT = 500

function isAuthorizedWriteStatement(decision: DbStatementDecision): boolean {
  if (decision.kind === 'write:cte') return true
  if (!decision.kind.startsWith('write:')) return false
  return WRITE_KEYWORDS.has(decision.kind.slice('write:'.length))
}

/**
 * 库访问的唯一收口。
 * - `assertSqlAllowed(...)`：只读模式下的语句拒绝表；
 * - `runWrite(...)`：显式进入写模式执行一段写操作（并在审计里留痕）。
 */
export class WcdbReadOnlyGuard {
  private readonly writeAuthorization = new AsyncLocalStorage<{ reason: string; operation: string } | undefined>()
  private readonly audit: DbGuardAudit = { records: [], rejections: [], modeChanges: [] }
  private rejectHandler: ((record: DbGuardRecord) => void) | null = null

  getMode(): DbAccessMode {
    return this.writeAuthorization.getStore() ? 'write' : 'read-only'
  }

  /** 设置拒绝回调（宿主/主进程用来落日志；默认只有内存审计）。 */
  setRejectHandler(handler: ((record: DbGuardRecord) => void) | null): void {
    this.rejectHandler = handler
  }

  getAudit(): DbGuardAudit {
    return {
      records: [...this.audit.records],
      rejections: [...this.audit.rejections],
      modeChanges: [...this.audit.modeChanges],
    }
  }

  clearAudit(): void {
    this.audit.records.length = 0
    this.audit.rejections.length = 0
    this.audit.modeChanges.length = 0
  }

  private record(record: DbGuardRecord): void {
    this.audit.records.push(record)
    if (this.audit.records.length > AUDIT_LIMIT) this.audit.records.shift()
    if (!record.allowed) {
      this.audit.rejections.push(record)
      if (this.audit.rejections.length > AUDIT_LIMIT) this.audit.rejections.shift()
      try { this.rejectHandler?.(record) } catch { /* 记录失败不影响拒绝本身 */ }
    }
  }

  private recordModeChange(mode: DbAccessMode, reason: string): void {
    this.audit.modeChanges.push({ at: Date.now(), mode, reason })
    if (this.audit.modeChanges.length > AUDIT_LIMIT) this.audit.modeChanges.shift()
  }

  /**
   * 只读操作的打卡点（游标、流式读等没有 SQL 的读取路径）。
   *
   * 它**不拒绝**任何东西 —— 只做两件事：把"这次访问是只读的"记进审计；
   * 如果当前居然处在写模式（说明上一个 `runWrite` 没有正确收尾），
   * 在这里大声说出来，避免"写模式漏给只读路径"这种静默错误。
   */
  assertReadOnlyOperation(operation: string, context: { sessionId?: string; cursor?: number } = {}): void {
    const mode = this.getMode()
    this.record({
      at: Date.now(),
      mode,
      operation,
      kind: 'read',
      table: context.sessionId ?? (context.cursor !== undefined ? `cursor:${context.cursor}` : null),
      path: null,
      sqlLength: 0,
      allowed: mode === 'read-only',
      reason: mode === 'read-only' ? undefined : `写模式未收尾时执行了只读操作 ${operation}`,
    })
    if (mode !== 'read-only') {
      console.warn(`[readonly-guard] 只读操作 ${operation} 落在写模式里（上一个写操作可能没有正常收尾）`)
    }
  }

  /**
   * 只读上下文里的语句闸门。
   * 返回 `{ allowed:false }` 时调用方**必须**直接返回错误，不能把语句发给引擎。
   */
  assertSqlAllowed(sql: string, context: { operation: string; table?: string | null; path?: string | null } = { operation: 'execQuery' }): DbStatementDecision {
    const authorization = this.writeAuthorization.getStore()
    const inWriteContext = authorization !== undefined
    const decisions = splitSqlStatements(sql).map(classifyStatement)
    const firstRejected = decisions.find((decision) => !decision.allowed)
    const unauthorized = decisions.find((decision) =>
      !decision.allowed && !(inWriteContext && isAuthorizedWriteStatement(decision)))
    const decision = unauthorized || firstRejected || {
      allowed: true,
      kind: decisions.length > 0 ? 'read' : 'empty',
    }
    // Permission follows only the async call tree opened by runWrite, and even
    // there permits only recognized SQL write statements. PRAGMA setters and
    // unknown syntax stay denied. Unrelated IPC work remains read-only.
    const allowed = unauthorized === undefined
    this.record({
      at: Date.now(),
      mode: inWriteContext ? 'write' : 'read-only',
      operation: context.operation,
      kind: decision.kind,
      table: context.table ?? null,
      path: context.path ?? null,
      sqlLength: String(sql || '').length,
      allowed,
      reason: allowed ? undefined : decision.reason,
    })
    return { ...decision, allowed }
  }

  /**
   * 显式写操作：先起快照（由调用方在本方法外层完成，见 snapshotService.withAutoSnapshot），
   * 再切到写模式执行，结束后一定切回只读 —— 写模式绝不能"漏"给后面的只读路径。
   */
  async runWrite<T>(reason: string, operation: string, fn: () => Promise<T>): Promise<T> {
    const parent = this.writeAuthorization.getStore()
    this.recordModeChange('write', reason)
    return this.writeAuthorization.run({ reason, operation }, async () => {
      try {
        return await fn()
      } finally {
        this.recordModeChange(parent ? 'write' : 'read-only', `写操作结束：${operation}`)
      }
    })
  }

  /** 供测试/诊断：强制回到只读模式。 */
  resetToReadOnly(): void {
    this.writeAuthorization.enterWith(undefined)
    this.recordModeChange('read-only', 'manual reset')
  }
}

/** 进程级单例：`wcdbCore` 与宿主进程共用同一个收口。 */
export const wcdbReadOnlyGuard = new WcdbReadOnlyGuard()
