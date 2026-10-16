/**
 * 自动打码的匹配器（v1.2 §4，D15/D16 的隐私条款）。
 *
 * ## 为什么是一个纯模块
 *
 * 打码错了**不会报错**：它要么把不该露的号码留在导出的图里，要么把一句正常的
 * 话涂成马赛克。两种都只会在用户把图发出去之后才被发现，所以这段逻辑必须能被
 * 单测钉住（正例 + **反例**，见 `posterRedaction.test.ts`）。
 *
 * ## 匹配的两类
 *
 * 1. **正则型**：手机号 / wxid / 身份证 / 银行卡 / 邮箱 / 地址 / 验证码；
 * 2. **词表型**：昵称（会话名、群昵称、发送者名）—— 这些字符串本身没有形状，
 *    只能拿本次选中内容里的已知名字去命中。
 *
 * ## 重叠怎么裁决
 *
 * 候选区间先按 `起点的先到者优先 → 队列优先级 → 长者优先` 排序，再贪心取不重叠的。
 * 优先级是**写死的**而不是"谁先匹配谁赢"：`11010519491231002X` 同时像身份证和
 * 银行卡，`13812345678` 同时像手机号和（不足 16 位的）卡号 —— 靠正则的书写顺序
 * 决定结果会在某次"顺手调整"里悄悄反转。
 *
 * ## 打码结果长什么样
 *
 * `redactText` 返回**打码后的整段文本 + 命中区间**。渲染层用它切出
 * `<mark class="pp-mask">` 片段 —— 于是预览里看到的马赛克就是导出的马赛克里
 * 的那些字符，不存在"导出时才补打码"的第二条路径。
 */
import type { RedactionKind, RedactionStrength, PosterRedactionOptions } from './posterTypes.ts'
import { DEFAULT_REDACTION_KINDS } from './posterTypes.ts'

export interface RedactionOptions {
    kinds?: RedactionKind[]
    strength?: RedactionStrength
    /** 词表（昵称等）。短于 2 个字符的会被忽略 —— 单字命中率太高 */
    dictionary?: string[]
}

export interface RedactionMatch {
    kind: RedactionKind
    /** 在**原文**里的下标，左闭右开 */
    start: number
    end: number
    raw: string
    masked: string
}

export interface RedactResult {
    text: string
    matches: RedactionMatch[]
}

/** 队列优先级：数字小的先占位。 */
const KIND_PRIORITY: Record<RedactionKind, number> = {
    idcard: 1,
    bankcard: 2,
    phone: 3,
    code: 4,
    email: 5,
    wxid: 6,
    address: 7,
    name: 8,
}

export const REDACTION_LABELS: Record<RedactionKind, string> = {
    phone: '手机号',
    wxid: '微信 ID',
    idcard: '身份证号',
    bankcard: '银行卡号',
    email: '邮箱',
    address: '地址',
    code: '验证码',
    name: '昵称',
}

const MASK_CHAR = '*'
const STRONG_CHAR = '●'

/** 中国大陆手机号：`1[3-9]` 起头，允许 4 位分组与 `+86` 前缀（空格 / 短横线）。 */
const PHONE_RE = /(?<![\d])(?:\+?86[-\s]?)?1[3-9]\d(?:[-\s]?\d{4}){2}(?!\d)/g
/** wxid：`wxid_` 起头，后接 4~22 位字母数字下划线/连字符。 */
const WXID_RE = /(?<![0-9A-Za-z_])wxid_[0-9A-Za-z_-]{4,22}(?![0-9A-Za-z_-])/g
/** 18 位身份证（末位可为 X），校验月份与日期范围。 */
const ID18_RE = /(?<![\d])(?:[1-9]\d{5})(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx](?![\dXx])/g
/** 15 位旧身份证（无校验位）。 */
const ID15_RE = /(?<![\d])(?:[1-9]\d{5})\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}(?![\dXx])/g
/** 银行卡：16~19 位连续数字，或 4 位分组（空格 / 短横线） */
const BANK_RE = /(?<![\d])\d{4}(?:[-\s]?\d{4}){3,4}(?![\d])/g
/** 邮箱 */
const EMAIL_RE = /[\w.+-]+@[\w-]+(?:\.[\w-]{2,})+/g
/** 验证码：关键词后 6 个字符内的 4~8 位数字 */
const CODE_RE = /(?:验证码|校验码|动态码|短信码|verification\s*code|one[-\s]?time\s*code|otp)[^\d\n]{0,6}(\d{4,8})/gi
/**
 * 地址：两级。
 *
 * 强式 = 省/市 前缀 + 区/县/街道 + **门牌尾**；中式 = 2~8 个汉字 + 路/街/巷/弄 + 数字 + 号。
 *
 * 尾巴上**只允许门牌**（数字 + 号/栋/单元/室/楼）。早期版本用 `[\u4e00-\u9fa5]{0,12}`
 * 收尾，于是"…中关村大街1号**就行**。"里的"就行"一起被涂掉了 —— 这是夹具抓图里
 * 肉眼发现的（`posterRedaction.test.ts` 现在钉住了这个区间）。
 *
 * 已知的**过度命中**（有意保留）：句子里紧跟动词时，形容词部分也会被涂，例如
 * "寄到**北京**市…" 会把"寄到"一起涂。方向是安全的（多涂 vs 漏涂），
 * 所以不为了美观加词法分析。
 */
const ADDRESS_STRONG_RE =
    /(?<![\u4e00-\u9fa5])(?:[\u4e00-\u9fa5]{2,8}(?:省|自治区|特别行政区))?[\u4e00-\u9fa5]{2,8}(?:市|自治州)[\u4e00-\u9fa5]{2,10}(?:区|县|新区)[\u4e00-\u9fa5A-Za-z0-9]{0,14}(?:路|街|道|巷|弄|大街|小区|公寓|大厦|花园|广场|村|镇)(?:\d{1,5}(?:号|弄|栋|幢|单元|室|楼|号院))?/g
const ADDRESS_CN_RE = /(?<![\u4e00-\u9fa5])[\u4e00-\u9fa5]{2,8}(?:路|街|巷|弄|大道|大街)\d{1,4}号/g

/** Luhn 校验：银行卡的真值判据（纯数字长串里只有卡号过得了）。 */
export function luhnOk(digits: string): boolean {
    if (!/^\d+$/.test(digits)) return false
    let sum = 0
    let double = false
    for (let i = digits.length - 1; i >= 0; i--) {
        let d = digits.charCodeAt(i) - 48
        if (double) {
            d *= 2
            if (d > 9) d -= 9
        }
        sum += d
        double = !double
    }
    return sum % 10 === 0
}

function isKindEnabled(kinds: RedactionKind[], kind: RedactionKind): boolean {
    return kinds.includes(kind)
}

/**
 * 打码一个值。
 *
 * 保留"长度"是有意的：等长占位能让版式在预览/导出之间完全一致；而保留的头尾
 * 位数由强度决定，用户可以用 `light` 核对"两处是不是同一个号码"，再用 `strong`
 * 交付。验证码是唯一**任何强度都不留边角**的种类。
 */
export function maskValue(raw: string, kind: RedactionKind, strength: RedactionStrength = 'normal'): string {
    const len = [...raw].length
    if (len === 0) return raw
    if (kind === 'code') return STRONG_CHAR.repeat(Math.max(4, len))
    const char = strength === 'strong' ? STRONG_CHAR : MASK_CHAR
    if (strength === 'strong') return char.repeat(len)

    const chars = [...raw]
    if (kind === 'name') {
        const head = Math.min(1, len - 1)
        return chars.slice(0, head).join('') + char.repeat(Math.max(1, len - head))
    }
    const head = strength === 'light' ? Math.min(3, len - 1) : Math.min(1, len - 1)
    const tail = strength === 'light' ? Math.min(2, Math.max(0, len - head - 1)) : len - head > 1 ? 1 : 0
    return chars.slice(0, head).join('') + char.repeat(Math.max(1, len - head - tail)) + chars.slice(len - tail).join('')
}

interface Candidate {
    kind: RedactionKind
    start: number
    end: number
    raw: string
}

function pushMatch(re: RegExp, text: string, kind: RedactionKind, out: Candidate[], pick?: (m: RegExpExecArray) => [number, number] | null) {
    re.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = re.exec(text)) !== null) {
        const span = pick ? pick(m) : ([m.index, m.index + m[0].length] as [number, number])
        if (!span) {
            if (m.index === re.lastIndex) re.lastIndex++
            continue
        }
        const [start, end] = span
        if (end > start) out.push({ kind, start, end, raw: text.slice(start, end) })
        // 零宽匹配保护：正则不允许空匹配，但 pick 可能返回空区间
        if (m.index === re.lastIndex) re.lastIndex++
    }
}

function digitOnly(value: string): string {
    return value.replace(/[^\dXx]/g, '')
}

/** 找出所有命中区间（已按不重叠规则裁决，按 start 升序）。 */
export function findRedactions(text: string, options: RedactionOptions = {}): RedactionMatch[] {
    if (!text) return []
    const kinds = options.kinds ?? DEFAULT_REDACTION_KINDS
    const strength = options.strength ?? 'normal'
    const candidates: Candidate[] = []

    if (isKindEnabled(kinds, 'idcard')) {
        pushMatch(ID18_RE, text, 'idcard', candidates)
        pushMatch(ID15_RE, text, 'idcard', candidates)
    }
    if (isKindEnabled(kinds, 'phone')) pushMatch(PHONE_RE, text, 'phone', candidates)
    if (isKindEnabled(kinds, 'bankcard')) {
        pushMatch(BANK_RE, text, 'bankcard', candidates, (m) => {
            const digits = digitOnly(m[0])
            if (digits.length < 16 || digits.length > 19) return null
            const grouped = /[-\s]/.test(m[0])
            // 分组书写本身就是"这是卡号"的强信号；连续数字则需要过 Luhn，
            // 否则一串 16 位的时间戳/流水号会被误涂（反例见单测）。
            return luhnOk(digits) || grouped ? [m.index, m.index + m[0].length] : null
        })
    }
    if (isKindEnabled(kinds, 'email')) pushMatch(EMAIL_RE, text, 'email', candidates)
    if (isKindEnabled(kinds, 'wxid')) pushMatch(WXID_RE, text, 'wxid', candidates)
    if (isKindEnabled(kinds, 'address')) {
        pushMatch(ADDRESS_STRONG_RE, text, 'address', candidates)
        pushMatch(ADDRESS_CN_RE, text, 'address', candidates)
    }
    if (isKindEnabled(kinds, 'code')) {
        pushMatch(CODE_RE, text, 'code', candidates, (m) => {
            const digits = m[1]
            if (!digits) return null
            const at = m.index + m[0].lastIndexOf(digits)
            return [at, at + digits.length]
        })
    }
    if (isKindEnabled(kinds, 'name') && options.dictionary?.length) {
        for (const rawName of options.dictionary) {
            const name = rawName.trim()
            if ([...name].length < 2) continue
            let from = 0
            for (;;) {
                const at = text.indexOf(name, from)
                if (at < 0) break
                candidates.push({ kind: 'name', start: at, end: at + name.length, raw: name })
                from = at + name.length
            }
        }
    }

    candidates.sort((a, b) => a.start - b.start || KIND_PRIORITY[a.kind] - KIND_PRIORITY[b.kind] || b.end - a.end)

    const taken: Candidate[] = []
    let cursor = -1
    for (const c of candidates) {
        if (c.start < cursor) continue
        taken.push(c)
        cursor = c.end
    }
    // 同名同区间的重复候选（例如昵称恰好等于一段手机号）只留优先级最高的一条
    const seen = new Set<string>()
    return taken
        .filter((c) => {
            const id = `${c.start}:${c.end}`
            if (seen.has(id)) return false
            seen.add(id)
            return true
        })
        .map((c) => ({ kind: c.kind, start: c.start, end: c.end, raw: c.raw, masked: maskValue(c.raw, c.kind, strength) }))
}

/** 打码整段文本。返回的是**预览与导出共用的那一份字符串**。 */
export function redactText(text: string, options: RedactionOptions = {}): RedactResult {
    const matches = findRedactions(text, options)
    if (matches.length === 0) return { text, matches }
    let out = ''
    let cursor = 0
    for (const m of matches) {
        out += text.slice(cursor, m.start) + m.masked
        cursor = m.end
    }
    out += text.slice(cursor)
    return { text: out, matches }
}

/** 把 `redactText` 的结果切成交替片段，供渲染层拼 `<mark>`；纯函数，可测。 */
export function redactSegments(text: string, options: RedactionOptions = {}): Array<{ text: string; kind?: RedactionKind }> {
    const { matches } = redactText(text, options)
    if (matches.length === 0) return text ? [{ text }] : []
    const segments: Array<{ text: string; kind?: RedactionKind }> = []
    let cursor = 0
    for (const m of matches) {
        if (m.start > cursor) segments.push({ text: text.slice(cursor, m.start) })
        segments.push({ text: m.masked, kind: m.kind })
        cursor = m.end
    }
    if (cursor < text.length) segments.push({ text: text.slice(cursor) })
    return segments
}

/** 按种类汇总命中数（页面上"已打码 N 处"的说明条、以及单测断言都用它）。 */
export function summarizeMatches(matches: RedactionMatch[]): Array<{ kind: RedactionKind; label: string; count: number }> {
    const counts = new Map<RedactionKind, number>()
    for (const m of matches) counts.set(m.kind, (counts.get(m.kind) ?? 0) + 1)
    return [...counts.entries()]
        .sort((a, b) => KIND_PRIORITY[a[0]] - KIND_PRIORITY[b[0]])
        .map(([kind, count]) => ({ kind, label: REDACTION_LABELS[kind], count }))
}

/** 打码开关是否真的会做事（关掉了就一条规则都不跑）。 */
export function effectiveRedactionOptions(options: PosterRedactionOptions, dictionary: string[] = []): RedactionOptions {
    if (!options.enabled) return { kinds: [], strength: options.strength, dictionary: [] }
    return { kinds: options.kinds, strength: options.strength, dictionary }
}
