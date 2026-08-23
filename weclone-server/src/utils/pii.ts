/**
 * WeClone PII 过滤器 —— 服务端副本（v0.9.10）。
 *
 * 与 electron/services/weClonePiiFilter.ts 保持同步（规则表逐条一致）。
 * 用途：上传时对 mds + chunks 做服务端二次复核，防止客户端绕过脱敏。
 * - 严重类别命中计数 > WECLONE_PII_MAX_HITS（默认 5）→ 400 拒绝上传；
 * - 未超阈值 → 全文就地替换为 [已脱敏:*] 占位符后入库（纵深防御）。
 *
 * 本模块不得 import 任何框架 —— 保持纯净可单测。
 */

/** 单条 PII 规则 */
export interface PiiPattern {
  label: string
  re: RegExp
}

export const PII_PLACEHOLDER_PREFIX = '[已脱敏:'
export const PII_PLACEHOLDER_SUFFIX = ']'

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
// 规则表（与 electron/services/weClonePiiFilter.ts 完全一致）
// ---------------------------------------------------------------------------

const KEYWORD_WINDOW_RE =
  /(?<!(?:已脱敏|已过滤):)(?:家庭住址|家庭地址|居住地址|通讯地址|详细地址|收货地址|现住址|住址|门牌号|身份证号码|身份证号|身份证|银行卡号|银行账号|卡号|密码|口令|密钥|token|secret)[\s:：为是]*[^，。；！？\n,;!?\[\]\u0000]{0,60}/gi

const FULL_ADDRESS_RE =
  /[\u4e00-\u9fa5]{2,12}(?:省|市|自治区)[\u4e00-\u9fa5]{1,12}(?:市|区|县|镇|旗|街道)[\u4e00-\u9fa5\dA-Za-z]{0,20}(?:小区|大厦|广场|公寓|花园|街道|路|街|巷|村|弄)[\u4e00-\u9fa5\dA-Za-z]{0,16}(?:\d{1,5}号|\d{1,4}栋|\d{1,4}幢|\d{1,3}单元|\d{1,4}号楼|\d{1,5}室)?/g

export const PII_PATTERNS: PiiPattern[] = [
  {
    label: '密码',
    re: /(?<!(?:已脱敏|已过滤):)(?:密码|口令|passwd|password|pwd|密钥|secret|token|api[_-]?key)[\s:：=]{0,3}\S{6,}/gi,
  },
  { label: '邮箱', re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g },
  { label: '身份证', re: /\b\d{17}[\dXx]\b|\b\d{15}\b/g },
  { label: '手机号', re: /\b1[3-9]\d{9}\b/g },
  { label: '证件', re: /(?<![A-Za-z])[A-Z]{1,2}\d{5,6}(?![A-Za-z0-9])/g },
  { label: '精确位置', re: /-?\d{1,3}\.\d{4,}\s*[,，]\s*-?\d{1,3}\.\d{4,}/g },
  { label: '精确位置', re: /(?:经度|纬度)\s*[:：]?\s*\d{1,3}\.\d{3,}/g },
  { label: '住址', re: FULL_ADDRESS_RE },
]

export const PII_KEYWORD_WINDOW_PATTERN: PiiPattern = {
  label: '住址证件',
  re: KEYWORD_WINDOW_RE,
}

/**
 * "严重"PII 类别 —— 上传时命中计数超阈值即拒绝（400）。
 * 邮箱 / 车牌证件 属轻微类别：自动替换占位符后放行。
 */
export const SEVERE_PII_LABELS: ReadonlySet<string> = new Set([
  '身份证', '手机号', '银行卡', '密码', '住址', '精确位置',
])

const SEVERE_PATTERNS = PII_PATTERNS.filter((p) => SEVERE_PII_LABELS.has(p.label))

export interface PiiScanResult {
  text: string
  hits: string[]
  hitCount: number
}

function replaceLabel(label: string): string {
  return `${PII_PLACEHOLDER_PREFIX}${label}${PII_PLACEHOLDER_SUFFIX}`
}

/** 已有占位符（客户端或本模块产出）—— 幂等脱敏时先剥掉再检测 */
const EXISTING_PLACEHOLDER_RE = /\[(?:已脱敏|已过滤):[^\]]*\]/g

/**
 * 扫描并脱敏一段文本。纯函数；哨兵机制保证幂等
 * （redact(redact(x)) === redact(x)，不产生嵌套标签）。
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

  // 银行卡：16-19 位连续数字且通过 Luhn 校验才替换
  out = out.replace(/\b\d{16,19}\b/g, (match) => (luhnCheck(match) ? park('银行卡') : match))

  // 关键词窗口最后执行；窗口尾部紧邻哨兵/已有占位符时保留原文（防双重标记）
  out = out.replace(KEYWORD_WINDOW_RE, (match, offset: number) => {
    const rest = out.slice(offset + match.length)
    if (rest.startsWith('\u0000') || /^\[(?:已脱敏|已过滤):/.test(rest)) return match
    return park('住址证件')
  })

  out = out.replace(/\u0000(\d+)\u0000/g, (_, idx: string) => stash[Number(idx)] ?? '')
  return { text: out, hits, hitCount }
}

/** 是否含敏感信息（快速布尔判断；已有占位符不算命中） */
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

/** 仅脱敏（等价 scanSensitiveText().text） */
export function redactSensitiveText(text: string): string {
  return scanSensitiveText(text).text
}

// ---------------------------------------------------------------------------
// 严重 PII 审计（上传闸门用）
// ---------------------------------------------------------------------------

export interface SeverePiiAudit {
  /** 严重类别命中次数（跨规则累计，供阈值比较） */
  count: number
  /** 命中的严重类别（去重） */
  labels: string[]
}

/**
 * 统计一段文本的"严重"PII 命中次数与类别。
 * 已有 [已脱敏:*]/[已过滤:*] 占位符的内容先剥掉 —— 客户端正常产物不计命中。
 */
export function auditSeverePii(text: string): SeverePiiAudit {
  const source = String(text ?? '').replace(EXISTING_PLACEHOLDER_RE, '')
  if (!source) return { count: 0, labels: [] }
  const labels: string[] = []
  let count = 0

  for (const pattern of SEVERE_PATTERNS) {
    pattern.re.lastIndex = 0
    const matches = source.match(pattern.re)
    if (matches && matches.length > 0) {
      count += matches.length
      if (!labels.includes(pattern.label)) labels.push(pattern.label)
    }
  }

  // 银行卡需 Luhn 确认
  const bankRe = /\b\d{16,19}\b/g
  let bm: RegExpExecArray | null
  while ((bm = bankRe.exec(source))) {
    if (luhnCheck(bm[0])) {
      count += 1
      if (!labels.includes('银行卡')) labels.push('银行卡')
    }
  }

  // 关键词窗口（住址/证件上下文）
  KEYWORD_WINDOW_RE.lastIndex = 0
  const kw = source.match(KEYWORD_WINDOW_RE)
  if (kw && kw.length > 0) {
    count += kw.length
    if (!labels.includes('住址证件')) labels.push('住址证件')
  }

  return { count, labels }
}

/** 仅返回命中的严重类别（兼容辅助） */
export function findSeverePiiLabels(text: string): string[] {
  return auditSeverePii(text).labels
}
