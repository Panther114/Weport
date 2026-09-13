/**
 * WeClone PII 过滤器（v0.9.10）—— 纯函数、可单测、零依赖。
 *
 * 双阶段脱敏的阶段 A（本地正则，必须全过）：
 * - 身份证（15/18 位）、手机号（1[3-9] 开头 11 位）
 * - 银行卡（16-19 位数字 + Luhn 校验，避免误伤普通长数字）
 * - 邮箱、车牌/证件号
 * - 关键词窗口（住址/身份证/银行卡/密码/token 等 + 后随内容整体替换）
 * - 精确位置（经纬度坐标、省市区+街道+门牌的完整地址链）
 *
 * 命中即替换为 `[已脱敏:类型]`，不删除上下文语义。
 * 本模块不得 import electron —— 保持纯净以便单元测试与复用。
 */

/** 单条 PII 规则 */
export interface PiiPattern {
  /** 类型标签，用于替换占位符 `[已脱敏:<label>]` */
  label: string
  re: RegExp
}

/** 替换占位符前缀 */
export const PII_PLACEHOLDER_PREFIX = '[已脱敏:'

/** Luhn 校验（银行卡号合法性），纯函数 */
export function luhnCheck(digits: string): boolean {
  const s = String(digits || '').replace(/[\s-]/g, '')
  if (!/^\d{2,}$/.test(s)) return false
  let sum = 0
  let doubleIt = false
  for (let i = s.length - 1; i >= 0; i -= 1) {
    let d = s.charCodeAt(i) - 48
    if (doubleIt) {
      d *= 2
      if (d > 9) d -= 9
    }
    sum += d
    doubleIt = !doubleIt
  }
  return sum % 10 === 0
}

// ---------------------------------------------------------------------------
// 规则表
// ---------------------------------------------------------------------------

/**
 * 关键词窗口：命中敏感关键词后，把关键词与其后 ≤60 字的“同句内容”整体替换。
 * 排除句读、方括号与哨兵符；负向后行断言保证不会匹配到已有
 * `[已脱敏:*]` / `[已过滤:*]` 占位符内部的标签文字（幂等关键）。
 */
const KEYWORD_WINDOW_RE =
  /(?<!(?:已脱敏|已过滤):)(?:家庭住址|家庭地址|居住地址|通讯地址|详细地址|收货地址|现住址|住址|门牌号|身份证号码|身份证号|身份证|银行卡号|银行账号|卡号|密码|口令|密钥|token|secret)[\s:：为是]*[^，。；！？\n,;!?\[\]\u0000]{0,60}/gi

/** 完整地址链：省/市级 + 区县级 + 街道级（三段齐全才算精确位置，城市名单独提及不脱敏） */
const FULL_ADDRESS_RE =
  /[\u4e00-\u9fa5]{2,12}(?:省|市|自治区)[\u4e00-\u9fa5]{1,12}(?:市|区|县|镇|旗|街道)[\u4e00-\u9fa5\dA-Za-z]{0,20}(?:小区|大厦|广场|公寓|花园|街道|路|街|巷|村|弄)[\u4e00-\u9fa5\dA-Za-z]{0,16}(?:\d{1,5}号|\d{1,4}栋|\d{1,4}幢|\d{1,3}单元|\d{1,4}号楼|\d{1,5}室)?/g

/**
 * PII 规则表（严格规则，不含关键词窗口）。顺序即执行顺序：
 * 密码赋值 → 邮箱 → 身份证 → 手机号 → 车牌 → 经纬度 → 完整地址链。
 * 银行卡（Luhn）与关键词窗口在 scanSensitiveText 中单独处理。
 */
export const PII_PATTERNS: PiiPattern[] = [
  {
    label: '密码',
    // 密码/token 赋值语句：值 ≥6 个非空白字符
    re: /(?<!(?:已脱敏|已过滤):)(?:密码|口令|passwd|password|pwd|密钥|secret|token|api[_-]?key)[\s:：=]{0,3}\S{6,}/gi,
  },
  {
    label: '邮箱',
    re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
  },
  {
    label: '身份证',
    // 18 位在前（末位可为 X），15 位在后；\b 防止长数字串被部分匹配
    re: /\b\d{17}[\dXx]\b|\b\d{15}\b/g,
  },
  {
    label: '手机号',
    re: /\b1[3-9]\d{9}\b/g,
  },
  {
    label: '证件',
    // 车牌/证件数字段（如 京A12345 的 A12345）；前后不能是字母数字，降低误伤
    re: /(?<![A-Za-z])[A-Z]{1,2}\d{5,6}(?![A-Za-z0-9])/g,
  },
  {
    label: '精确位置',
    // lat,lng 坐标对（小数点后 ≥4 位才视为 GPS 精度）
    re: /-?\d{1,3}\.\d{4,}\s*[,，]\s*-?\d{1,3}\.\d{4,}/g,
  },
  {
    label: '精确位置',
    re: /(?:经度|纬度)\s*[:：]?\s*\d{1,3}\.\d{3,}/g,
  },
  {
    label: '住址',
    re: FULL_ADDRESS_RE,
  },
]

/** 关键词窗口规则 —— 永远最后执行（消费严格规则剩下的上下文） */
export const PII_KEYWORD_WINDOW_PATTERN: PiiPattern = {
  label: '住址证件',
  re: KEYWORD_WINDOW_RE,
}

export interface PiiScanResult {
  /** 脱敏后的文本 */
  text: string
  /** 命中的类型列表（去重，按出现顺序） */
  hits: string[]
  /** 命中总次数 */
  hitCount: number
}

function replaceLabel(label: string): string {
  return `${PII_PLACEHOLDER_PREFIX}${label}]`
}

/** 已有占位符（本模块或 LLM 阶段产出）——幂等脱敏时先剥掉再检测 */
const EXISTING_PLACEHOLDER_RE = /\[(?:已脱敏|已过滤):[^\]]*\]/g

/**
 * 扫描并脱敏一段文本（阶段 A 核心）。纯函数：不修改入参，返回新字符串。
 *
 * 实现：非窗口规则先把命中替换为 `\u0000<idx>\u0000` 哨兵，最后统一还原。
 * 这样关键词窗口规则永远不会匹配到先前规则产出的 `[已脱敏:*]` 标签内部，
 * 保证 redact(redact(x)) === redact(x) 幂等且不产生嵌套标签。
 */
export function scanSensitiveText(text: string): PiiScanResult {
  const source = String(text ?? '')
  if (!source) return { text: '', hits: [], hitCount: 0 }
  const hits: string[] = []
  let hitCount = 0
  const stash: string[] = []
  const park = (label: string): string => {
    hitCount += 1
    if (!hits.includes(label)) hits.push(label)
    stash.push(replaceLabel(label))
    return `\u0000${stash.length - 1}\u0000`
  }

  let out = source
  for (const pattern of PII_PATTERNS) {
    pattern.re.lastIndex = 0
    out = out.replace(pattern.re, () => park(pattern.label))
  }

  // 银行卡：16-19 位连续数字且通过 Luhn 校验才替换（普通订单号/快递单号不误伤）
  out = out.replace(/\b\d{16,19}\b/g, (match) => (luhnCheck(match) ? park('银行卡') : match))

  // 关键词窗口最后执行；若窗口尾部紧邻已打标的哨兵或已有占位符
  // （值已被精确规则处理），保留原文不再叠加通用标签，避免双重标记噪音
  out = out.replace(KEYWORD_WINDOW_RE, (match, offset: number) => {
    const rest = out.slice(offset + match.length)
    if (rest.startsWith('\u0000') || /^\[(?:已脱敏|已过滤):/.test(rest)) return match
    return park('住址证件')
  })

  // 还原哨兵 → 最终占位符
  out = out.replace(/\u0000(\d+)\u0000/g, (_, idx: string) => stash[Number(idx)] ?? '')
  return { text: out, hits, hitCount }
}

/** 是否含敏感信息（快速布尔判断，不做替换；已有占位符不算命中） */
export function hasSensitiveInfo(text: string): boolean {
  const source = String(text ?? '').replace(EXISTING_PLACEHOLDER_RE, '')
  if (!source) return false
  for (const pattern of [...PII_PATTERNS, PII_KEYWORD_WINDOW_PATTERN]) {
    pattern.re.lastIndex = 0
    if (pattern.re.test(source)) return true
  }
  if (/\b\d{16,19}\b/.test(source)) {
    const match = /\b\d{16,19}\b/.exec(source)
    if (match && luhnCheck(match[0])) return true
  }
  return false
}

/** 仅脱敏（常用别名，等价 scanSensitiveText().text） */
export function redactSensitiveText(text: string): string {
  return scanSensitiveText(text).text
}

// ---------------------------------------------------------------------------
// 结构化 payload 脱敏（深遍历，纯函数）
// ---------------------------------------------------------------------------

export interface SanitizePayloadOptions {
  /** 只脱敏字段名匹配该正则的字符串值；省略时脱敏所有字符串 */
  onlyFields?: RegExp
  /** 数组/对象最大遍历深度（默认 8），防止循环引用爆栈 */
  maxDepth?: number
}

/**
 * 深度脱敏一个任意 JSON 结构：所有字符串值经过 redactSensitiveText。
 * 纯函数 —— 返回新对象，不修改入参。循环引用以 undefined 截断。
 */
export function sanitizePayload<T>(payload: T, options?: SanitizePayloadOptions): T {
  const maxDepth = Math.max(1, Math.floor(options?.maxDepth ?? 8))
  const onlyFields = options?.onlyFields

  const walk = (value: unknown, keyName: string, depth: number): unknown => {
    if (value === null || value === undefined) return value
    const type = typeof value
    if (type === 'string') {
      if (onlyFields && !onlyFields.test(keyName)) return value
      return redactSensitiveText(value as string)
    }
    if (type !== 'object') return value
    if (depth >= maxDepth) return undefined
    if (Array.isArray(value)) {
      return value.map((item) => walk(item, keyName, depth + 1))
    }
    const source = value as Record<string, unknown>
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(source)) {
      out[k] = walk(v, k, depth + 1)
    }
    return out
  }

  return walk(payload, '', 0) as T
}

