/**
 * 搜索条件 <-> 查询串 <-> URL 片段之间的**唯一**转换层（v1.2 §6）。
 *
 * 这一层刻意做成纯函数：过滤器面板、结果页、保存搜索、可分享链接四条链路都读写
 * 同一个形状。如果各写各的字符串拼接，"界面上显示的条件"和"实际发给引擎的条件"
 * 迟早会分歧 —— 而这种分歧不会报错，只会给出奇怪的结果。
 *
 * 查询串语法（人可读、可分享、可粘贴）：
 *
 *   标签:重要 会话:张三 发送者:wxid_ab12 从:2026-01-01 到:2026-03-31 类型:图片 合同
 *
 * - 未知前缀（含中文冒号）原样算普通文字，不吞用户输入；
 * - 带空格的值用双引号包住（`会话:"产品 群"`）；
 * - 反向序列化时只在确实需要时才加引号。
 */

/** 一个条件参数（作用域）。日期以**本地日期串**存，便于 URL 往返。 */
export interface ScopeParams {
  /** 标签（本机注解，不是引擎作用域字段；页面前过滤用） */
  tags: string[]
  /** 会话 id 集合 */
  sessionIds: string[]
  senders: string[]
  /** 本地日期 YYYY-MM-DD（含当日 00:00:00） */
  from: string
  /** 本地日期 YYYY-MM-DD（含当日 23:59:59.999） */
  to: string
  kinds: string[]
}

export interface QueryParams {
  /** 全文关键词（不含任何前缀） */
  text: string
  scope: ScopeParams
}

export const EMPTY_SCOPE: ScopeParams = { tags: [], sessionIds: [], senders: [], from: '', to: '', kinds: [] }

export const EMPTY_QUERY: QueryParams = { text: '', scope: EMPTY_SCOPE }

/**
 * 消息类型（与引擎 scope.kinds 的取值一一对应）。
 *
 * 取值是**契约**，不是界面文案 —— 界面文案单独一张表，改文案不该改查询。
 */
export const KIND_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'text', label: '文字' },
  { value: 'image', label: '图片' },
  { value: 'voice', label: '语音' },
  { value: 'video', label: '视频' },
  { value: 'file', label: '文件' },
  { value: 'emoji', label: '表情' },
  { value: 'link', label: '链接' },
  { value: 'system', label: '系统' },
]

const KIND_LABELS = new Map(KIND_OPTIONS.map((k) => [k.value, k.label]))

/**
 * 把用户写的东西认成一个消息类型。
 *
 * 两种写法都要收：`类型:图片`（界面自己序列化出来的形式，因为给人读的查询串
 * 不该出现 `image`）和 `类型:image`（手打 / 从别处粘）。返回的是**引擎取值**。
 */
function kindValueOf(input: string): string | undefined {
  const raw = input.trim()
  const lower = raw.toLowerCase()
  const byValue = KIND_OPTIONS.find((option) => option.value === lower)
  if (byValue) return byValue.value
  const byLabel = KIND_OPTIONS.find((option) => option.label === raw)
  return byLabel?.value
}

export function kindLabel(kind: string): string {
  return KIND_LABELS.get(kind) || kind
}

/** 前缀 -> 作用域字段。值是「进哪个 scope 数组」。 */
const PREFIXES: Record<string, keyof Pick<ScopeParams, 'tags' | 'sessionIds' | 'senders' | 'from' | 'to' | 'kinds'>> = {
  标签: 'tags',
  tag: 'tags',
  会话: 'sessionIds',
  session: 'sessionIds',
  发送者: 'senders',
  来自: 'senders',
  sender: 'senders',
  类型: 'kinds',
  kind: 'kinds',
  type: 'kinds',
}

const DATE_PREFIXES: Record<string, 'from' | 'to'> = { 从: 'from', 到: 'to', from: 'from', to: 'to' }

/** 一个 token：普通文字，或 `前缀:值`。 */
export type QueryToken = { kind: 'text'; value: string } | { kind: 'cond'; prefix: string; value: string }

/**
 * 词法分析。
 *
 * 逐字符走而不是正则切分，因为值可以带引号且引号内允许空格与冒号：
 * `会话:"产品 群"` 必须是一个值，而不是三个。
 */
export function parseQueryTokens(input: string): QueryToken[] {
  const tokens: QueryToken[] = []
  const src = String(input ?? '')
  let i = 0

  const readValue = (): string => {
    if (src[i] === '"') {
      i += 1
      let buf = ''
      while (i < src.length && src[i] !== '"') {
        buf += src[i]
        i += 1
      }
      if (src[i] === '"') i += 1
      return buf
    }
    let buf = ''
    while (i < src.length && !/\s/.test(src[i])) {
      buf += src[i]
      i += 1
    }
    return buf
  }

  while (i < src.length) {
    if (/\s/.test(src[i])) {
      i += 1
      continue
    }
    // 找这一段里的第一个冒号；找到且前缀已登记 -> 条件，否则整段算普通文字
    let colon = -1
    let quote = false
    let j = i
    while (j < src.length) {
      const ch = src[j]
      if (ch === '"') quote = !quote
      if (!quote && ch === ':') {
        colon = j
        break
      }
      if (!quote && /\s/.test(ch)) break
      j += 1
    }
    const prefix = colon > i ? src.slice(i, colon) : ''
    if (prefix && (PREFIXES[prefix] || DATE_PREFIXES[prefix])) {
      i = colon + 1
      const value = readValue()
      if (value) tokens.push({ kind: 'cond', prefix, value })
      continue
    }
    tokens.push({ kind: 'text', value: readValue() })
  }
  return tokens
}

/** 需要加引号的值：含空白或含冒号（否则反解会歧义）。 */
function needsQuote(value: string): boolean {
  return /[\s"]/.test(value)
}

function encodeValue(value: string): string {
  return needsQuote(value) ? `"${value.replace(/"/g, '')}"` : value
}

/** 查询串 -> 结构化条件。同一个前缀出现多次按「或」累加（标签/会话/发送者/类型）。 */
export function paramsFromQuery(input: string): QueryParams {
  const tags: string[] = []
  const sessionIds: string[] = []
  const senders: string[] = []
  const kinds: string[] = []
  let from = ''
  let to = ''
  const texts: string[] = []
  for (const token of parseQueryTokens(input)) {
    if (token.kind === 'text') {
      texts.push(token.value)
      continue
    }
    const dateField = DATE_PREFIXES[token.prefix]
    if (dateField) {
      /**
       * 日期格式不对时**不能**写进 scope：`2026-13-99` 会让引擎收到一个非法的
       * 时间边界（有的实现会静默变成"全部"，有的会直接报错），而用户看到的是
       * "我明明筛了日期却没有效果"。所以回落到关键词 —— 搜得到就搜，搜不到也不是
       * 界面的错。
       *
       * 判据直接用 `dateToEpoch` 而不是只测正则：它同时管格式与真实日历
       * （`2026-02-31` 这种能被正则放过、却会被 `Date` 悄悄进位成 3 月 3 日
       * 的假日期也一并挡掉）。一处判定，两处用途。
       */
      if (dateToEpoch(token.value, dateField === 'from' ? 'start' : 'end') !== undefined) {
        if (dateField === 'from') from = token.value
        else to = token.value
      } else {
        texts.push(token.value)
      }
      continue
    }
    // 值的语义按前缀分派：数组类按原样收，类型类要归一成引擎取值
    const field = PREFIXES[token.prefix]
    if (field === 'tags') tags.push(token.value)
    else if (field === 'sessionIds') sessionIds.push(token.value)
    else if (field === 'senders') senders.push(token.value)
    else {
      const kind = kindValueOf(token.value)
      if (kind) kinds.push(kind)
      else texts.push(token.value)
    }
  }
  return {
    text: texts.join(' ').trim(),
    scope: {
      tags: [...new Set(tags)],
      sessionIds: [...new Set(sessionIds)],
      senders: [...new Set(senders)],
      from,
      to,
      kinds: [...new Set(kinds)],
    },
  }
}

/** 结构化条件 -> 查询串。空条件不产出任何 token（不会留下 `标签:` 这种半截串）。 */
export function queryFromParams(params: QueryParams): string {
  const out: string[] = []
  const { scope } = params
  for (const tag of scope.tags) out.push(`标签:${encodeValue(tag)}`)
  for (const id of scope.sessionIds) out.push(`会话:${encodeValue(id)}`)
  for (const sender of scope.senders) out.push(`发送者:${encodeValue(sender)}`)
  if (scope.from) out.push(`从:${scope.from}`)
  if (scope.to) out.push(`到:${scope.to}`)
  for (const kind of scope.kinds) out.push(`类型:${encodeValue(kindLabel(kind))}`)
  const text = params.text.trim()
  if (text) out.push(text)
  return out.join(' ')
}

/** 条件数量（用来显示「N 个筛选」和判断要不要给「清空」按钮）。 */
export function activeScopeCount(scope: ScopeParams): number {
  return (
    scope.tags.length +
    scope.sessionIds.length +
    scope.senders.length +
    scope.kinds.length +
    (scope.from ? 1 : 0) +
    (scope.to ? 1 : 0)
  )
}

// ---------------------------------------------------------------------------
// 时间
// ---------------------------------------------------------------------------

/**
 * 用 `[0-9]` 而**不是** `\d`：JS 的 `\d` 会匹配全角数字等 Unicode 数字字符（实测 `\d{2}` 认下了
 * `１３`），于是 `2026-１３-９９` 这种"看起来像日期"的东西会被放行。显式 ASCII 范围才是我们要的
 * ——（这条注释以前挂在一个没人调用的重复正则上，判据其实一直在下面这个 `DATE_ONLY` 里。）
 */
const DATE_ONLY = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/

/** `YYYY-MM-DD` + 当天的起点/终点（毫秒，本地时区）。非法输入回 undefined。 */
export function dateToEpoch(date: string, edge: 'start' | 'end'): number | undefined {
  if (!DATE_ONLY.test(date)) return undefined
  const [y, m, d] = date.split('-').map(Number)
  const at = new Date(y, m - 1, d, edge === 'start' ? 0 : 23, edge === 'start' ? 0 : 59, edge === 'start' ? 0 : 59, edge === 'start' ? 0 : 999)
  if (Number.isNaN(at.getTime())) return undefined
  // 校验：写错月份/日子（2026-02-31）Date 会自动进位，这里回退成非法
  if (at.getFullYear() !== y || at.getMonth() !== m - 1 || at.getDate() !== d) return undefined
  return at.getTime()
}

/** 毫秒 -> `YYYY-MM-DD`（本地时区，`<input type="date">` 的值格式）。 */
export function epochToDate(ms: number | undefined): string {
  if (!ms || !Number.isFinite(ms)) return ''
  const at = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`
}

/**
 * 时间戳 -> 秒。
 *
 * 微信侧的库时间戳是**秒**（参见 SnsPage 的 `ts * 1000`）；而本机注解（收藏 `at`）
 * 用的是毫秒。契约里 `ts` 的单位没写死，所以这里做一次自适应：
 * 大于 1e12 的按毫秒看（秒到 1e12 是公元 33658 年，不可能出现在微信号上）。
 * 猜错的代价只是时间显示差 1000 倍，不该由这个函数之外的地方各自猜一遍。
 */
export function tsToSeconds(ts: number | undefined | null): number {
  const n = Number(ts)
  if (!Number.isFinite(n) || n <= 0) return 0
  return n > 1e12 ? Math.floor(n / 1000) : Math.floor(n)
}

/** `MM-DD HH:mm`（同一年省略年份）；跨年才显示 `YYYY-MM-DD`。 */
export function formatHitTime(ts: number | undefined | null, now = Date.now()): string {
  const seconds = tsToSeconds(ts)
  if (!seconds) return ''
  const at = new Date(seconds * 1000)
  const pad = (n: number) => String(n).padStart(2, '0')
  const time = `${pad(at.getHours())}:${pad(at.getMinutes())}`
  if (at.getFullYear() === new Date(now).getFullYear()) return `${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${time}`
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${time}`
}

/** 相对时间（今天/昨天/N 天前），侧栏「最近搜索」「收藏」用它。 */
export function formatRelative(ts: number | undefined | null, now = Date.now()): string {
  const ms = Number(ts)
  if (!Number.isFinite(ms) || ms <= 0) return ''
  const value = ms > 1e12 ? ms : ms * 1000
  const days = Math.floor((now - value) / 86_400_000)
  if (days <= 0) return '今天'
  if (days === 1) return '昨天'
  if (days < 30) return `${days} 天前`
  return epochToDate(value)
}

// ---------------------------------------------------------------------------
// 引擎请求
// ---------------------------------------------------------------------------

export interface EngineQueryInput {
  text: string
  scope?: SearchScope
  limit?: number
  /** 翻页游标：不透明值，原样回传（与 vite-env.d.ts 里的 SearchQueryRequest 一致） */
  cursor?: string | number
}

/**
 * 结构化条件 -> 引擎请求。
 *
 * 返回 `null` 表示「这个条件不该发请求」：没有任何关键词、也没有任何作用域
 * 限制时，引擎侧会等价于"扫全库"，把几万条结果倒进界面。空手不搜是更诚实的
 * 行为（界面上对应"输入关键词开始搜索"的空状态）。
 */
export function buildEngineQuery(params: QueryParams, opts?: { limit?: number; cursor?: string | number }): EngineQueryInput | null {
  const hint = params.text.trim()
  const scope: SearchScope = {}
  if (params.scope.sessionIds.length) scope.sessionIds = [...params.scope.sessionIds]
  if (params.scope.senders.length) scope.senders = [...params.scope.senders]
  if (params.scope.kinds.length) scope.kinds = [...params.scope.kinds]
  const from = dateToEpoch(params.scope.from, 'start')
  const to = dateToEpoch(params.scope.to, 'end')
  if (from !== undefined) scope.from = from
  if (to !== undefined) scope.to = to

  const hasScope =
    scope.sessionIds !== undefined ||
    scope.senders !== undefined ||
    scope.kinds !== undefined ||
    scope.from !== undefined ||
    scope.to !== undefined
  if (!hint && !hasScope) return null

  const out: EngineQueryInput = { text: hint }
  if (hasScope) out.scope = scope
  if (opts?.limit) out.limit = opts.limit
  if (opts?.cursor) out.cursor = opts.cursor
  return out
}

/** 保存搜索用：只留作用域里的日期（标签等本机条件也一起存，便于复现）。 */
export function hasAnyCondition(params: QueryParams): boolean {
  return params.text.trim().length > 0 || activeScopeCount(params.scope) > 0
}

/**
 * 引擎作用域 -> 界面条件参数。
 *
 * 两边的日期单位不同（保存搜索里存的是引擎口径的毫秒时间戳，界面用本地日期串），
 * 所以合并时必须走一次转换；直接展开会被 TS 拦下（也会在运行时把 `1699999999999`
 * 渲染成日期输入框里的乱码）。
 */
export function scopeParamsFromSearchScope(scope: SearchScope | undefined | null): ScopeParams {
  if (!scope) return { ...EMPTY_SCOPE }
  return {
    tags: [],
    sessionIds: Array.isArray(scope.sessionIds) ? [...scope.sessionIds] : [],
    senders: Array.isArray(scope.senders) ? [...scope.senders] : [],
    from: typeof scope.from === 'number' ? epochToDate(scope.from) : '',
    to: typeof scope.to === 'number' ? epochToDate(scope.to) : '',
    kinds: Array.isArray(scope.kinds) ? [...scope.kinds] : [],
  }
}

/** 保存搜索 -> 当前条件（查询串提供关键词与本机标签，保存时的 scope 覆盖引擎侧收窄）。 */
export function paramsFromSavedSearch(query: string, scope?: SearchScope): QueryParams {
  const parsed = paramsFromQuery(query || '')
  const extra = scopeParamsFromSearchScope(scope)
  return {
    text: parsed.text,
    scope: {
      tags: parsed.scope.tags,
      sessionIds: [...new Set([...parsed.scope.sessionIds, ...extra.sessionIds])],
      senders: [...new Set([...parsed.scope.senders, ...extra.senders])],
      from: extra.from || parsed.scope.from,
      to: extra.to || parsed.scope.to,
      kinds: [...new Set([...parsed.scope.kinds, ...extra.kinds])],
    },
  }
}

// ---------------------------------------------------------------------------
// 片段高亮
// ---------------------------------------------------------------------------

export interface SnippetSegment {
  text: string
  hit: boolean
}

/**
 * 把 `highlights`（相对片段的字符区间）切成可渲染的分段。
 *
 * 为什么要这个函数：契约允许引擎给出**乱序、重叠、越界**的区间，而 React 的
 * `key` 必须唯一、片段必须连续。直接在 JSX 里 `snippet.slice(a, b)` 遇到重叠区间
 * 会出现重复文字（同一段渲染两遍），越界会静默截断。这里统一归一化：
 * 排序 -> 合并重叠 -> 夹到 [0, length] -> 补上中间的空隙。
 *
 * 输出保证：拼起来正好等于 `snippet`，一条不丢、一字不重。这是单测的主要断言。
 */
export function segmentsFromHighlights(snippet: string, highlights?: Array<[number, number]>): SnippetSegment[] {
  const text = String(snippet ?? '')
  if (!text) return []
  const length = text.length
  const ranges: Array<[number, number]> = []
  for (const raw of highlights || []) {
    if (!Array.isArray(raw) || raw.length < 2) continue
    let start = Number(raw[0])
    let end = Number(raw[1])
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue
    if (start > end) [start, end] = [end, start]
    start = Math.max(0, Math.min(length, Math.floor(start)))
    end = Math.max(0, Math.min(length, Math.ceil(end)))
    if (end > start) ranges.push([start, end])
  }
  if (ranges.length === 0) return [{ text, hit: false }]
  ranges.sort((a, b) => a[0] - b[0] || a[1] - b[1])

  const merged: Array<[number, number]> = []
  for (const range of ranges) {
    const last = merged[merged.length - 1]
    if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1])
    else merged.push([range[0], range[1]])
  }

  const segments: SnippetSegment[] = []
  let cursor = 0
  for (const [start, end] of merged) {
    if (start > cursor) segments.push({ text: text.slice(cursor, start), hit: false })
    segments.push({ text: text.slice(start, end), hit: true })
    cursor = end
  }
  if (cursor < length) segments.push({ text: text.slice(cursor), hit: false })
  return segments
}

/** 归一化服务端返回：坏形状一律降级成空页，绝不让界面渲染 undefined 变体的行。 */
export function normalizeResultPage(raw: unknown): SearchResultPage {
  const page = (raw || {}) as Partial<SearchResultPage>
  const hits: SearchHit[] = Array.isArray(page.hits)
    ? page.hits.filter((hit): hit is SearchHit => !!hit && typeof hit === 'object' && typeof (hit as SearchHit).sessionId === 'string')
    : []
  /**
   * 游标只归一化**形态**，不改语义：数字（引擎那边是 `number` 分页）转成字符串，
   * 空值算没有下一页。这里如果不认数字游标，翻页会在第一页之后静默停住 ——
   * 用户看到的是"结果只有 50 条"，而不是任何错误。
   */
  const rawCursor = page.cursor
  const cursor = rawCursor === null || rawCursor === undefined || rawCursor === '' ? null : String(rawCursor)
  return {
    hits,
    total: Number.isFinite(Number(page.total)) ? Number(page.total) : hits.length,
    cursor,
    elapsedMs: Number.isFinite(Number(page.elapsedMs)) ? Number(page.elapsedMs) : 0,
    truncated: page.truncated === true,
    // 引擎侧的 per-page 错误（"索引不可用：…"、游标对不上）必须带出来。以前这里不认这个字段，
    // 于是它被原样丢掉，界面把"索引坏了"显示成"0 条结果 / 没有找到" —— 用户会去调关键词。
    error: typeof page.error === 'string' && page.error.trim() ? page.error : undefined,
  }
}

/** 结果行 / 收藏条目的稳定 key：同一会话里的消息用 localId 区分。 */
export function entryKey(entry: AnnotationMessageIdentity): string {
  return annotationIdentityKey(entry)
}

/** 标签配色：同一个标签在任何页面都是同一种颜色（按名字哈希，稳定）。 */
export function tagTone(tag: string): 1 | 2 | 3 | 4 | 5 | 6 {
  let hash = 0
  for (let i = 0; i < tag.length; i += 1) hash = (hash * 31 + tag.charCodeAt(i)) | 0
  return (Math.abs(hash) % 6 + 1) as 1 | 2 | 3 | 4 | 5 | 6
}
import { annotationIdentityKey, type AnnotationMessageIdentity } from '../../utils/annotationIdentity'
