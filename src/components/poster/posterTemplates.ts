/**
 * 模板与"选项 → 样式"的唯一映射（v1.2 §4）。
 *
 * 四套模板（长图 / 引用卡 / 九宫格拼贴 / 小结卡）在这份文件里各自是一组**预设值**，
 * 而不是四套渲染代码：`posterDom` 只认 `PosterOptions`，模板的差别全部体现在
 * 选项上。于是"模板编辑器里改一个开关"和"换模板"走的是同一条路 —— 也就不会出现
 * "引用卡里的字号改了但预览没变"这种分支不一致。
 *
 * `posterRootStyle` 是纯函数：选项进、CSS 变量出。它是**预览与导出共用的**那一份
 * 尺寸/配色来源，单测直接断言映射结果（`posterTemplates.test.ts`）。
 */
import type { PosterOptions, PosterTemplateId, PosterTheme, RedactionKind, RedactionStrength } from './posterTypes.ts'
import { DEFAULT_POSTER_OPTIONS, DEFAULT_REDACTION_KINDS, POSTER_WIDTH } from './posterTypes.ts'

export interface PosterTemplateDef {
    id: PosterTemplateId
    name: string
    hint: string
    /** 缩略图（模板选择器里画的示意图形状） */
    preview: 'long' | 'quote' | 'grid' | 'summary'
    /** 该模板下**有意义**的开关：界面据此禁用无意义的项，避免"点了没反应" */
    relevant: {
        bubble: boolean
        avatar: boolean
        timestamp: boolean
        crop: boolean
        reorder: boolean
        media: boolean
    }
    defaults: Partial<PosterOptions>
}

export const POSTER_TEMPLATES: PosterTemplateDef[] = [
    {
        id: 'long',
        name: '长图',
        hint: '整段对话竖排拼接，可读性优先；超过画布上限自动分页',
        preview: 'long',
        relevant: { bubble: true, avatar: true, timestamp: true, crop: false, reorder: true, media: true },
        defaults: {
            template: 'long',
            fontScale: 1,
            showBubble: true,
            showAvatar: true,
            showTimestamp: true,
            showWatermark: true,
            theme: 'dark',
        },
    },
    {
        id: 'quote',
        name: '引用卡',
        hint: '单条消息大字排版，适合语录；只取第一条可见消息',
        preview: 'quote',
        relevant: { bubble: false, avatar: false, timestamp: false, crop: false, reorder: false, media: true },
        defaults: {
            template: 'quote',
            fontScale: 1.45,
            showBubble: false,
            showAvatar: false,
            showTimestamp: false,
            showWatermark: true,
            theme: 'light',
        },
    },
    {
        id: 'grid9',
        name: '九宫格拼贴',
        hint: '最多 9 张图，3×3 拼贴；每格可裁剪与遮挡',
        preview: 'grid',
        relevant: { bubble: false, avatar: false, timestamp: false, crop: true, reorder: true, media: true },
        defaults: {
            template: 'grid9',
            fontScale: 0.95,
            showBubble: false,
            showAvatar: false,
            showTimestamp: false,
            showWatermark: true,
            theme: 'dark',
        },
    },
    {
        id: 'summary',
        name: '小结卡',
        hint: '复用分析页的统计形状：总量 / 收发 / 活跃天数',
        preview: 'summary',
        relevant: { bubble: false, avatar: true, timestamp: false, crop: false, reorder: false, media: false },
        defaults: {
            template: 'summary',
            fontScale: 1.05,
            showBubble: false,
            showAvatar: true,
            showTimestamp: false,
            showWatermark: true,
            theme: 'dark',
        },
    },
]

export function getTemplate(id: PosterTemplateId): PosterTemplateDef {
    return POSTER_TEMPLATES.find((t) => t.id === id) ?? POSTER_TEMPLATES[0]
}

/** 套用模板：保留用户已改的打码/页脚/标题，其余取模板预设。 */
export function applyTemplate(base: PosterOptions, id: PosterTemplateId): PosterOptions {
    const def = getTemplate(id)
    return { ...base, ...def.defaults, template: id }
}

/** 九宫格内容上限（3×3）。 */
export const GRID_SLOT_COUNT = 9
/** 九宫格里一格的正方形边长（px，画布 1080 宽下的内边距取值）。 */
export const GRID_GAP = 18
export const GRID_PAD = 36

export function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
    const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim())
    if (!m) return null
    let body = m[1]
    if (body.length === 3) body = body[0] + body[0] + body[1] + body[1] + body[2] + body[2]
    const n = Number.parseInt(body, 16)
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 }
}

/** 相对亮度（WCAG 近似），用于决定强调色上的文字用黑还是白。 */
export function relativeLuminance(hex: string): number {
    const rgb = hexToRgb(hex)
    if (!rgb) return 0
    const channel = (v: number) => {
        const s = v / 255
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
    }
    return 0.2126 * channel(rgb.r) + 0.7152 * channel(rgb.g) + 0.0722 * channel(rgb.b)
}

export function contrastTextOn(hex: string): string {
    return relativeLuminance(hex) > 0.42 ? '#0b0b10' : '#ffffff'
}

function withAlpha(hex: string, alpha: number): string {
    const rgb = hexToRgb(hex)
    if (!rgb) return `rgba(91, 142, 255, ${alpha})`
    return `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${alpha})`
}

/** 字号倍率的可用区间（界面的滑块与这里的夹取必须一致）。 */
export const FONT_SCALE_MIN = 0.8
export const FONT_SCALE_MAX = 1.6

export function clampFontScale(value: number): number {
    if (!Number.isFinite(value)) return 1
    return Math.min(FONT_SCALE_MAX, Math.max(FONT_SCALE_MIN, Math.round(value * 100) / 100))
}

/** 正文字号：画布 1080 宽下的基线 30px × 倍率。 */
export const POSTER_BASE_FONT_PX = 30

export function posterFontPx(scale: number): number {
    return Math.round(POSTER_BASE_FONT_PX * clampFontScale(scale))
}

/**
 * 选项 → 根元素内联样式（CSS 变量 + data-* 属性）。
 *
 * 这些变量是海报里所有尺寸与颜色的来源：气泡圆角跟着 `showBubble` 走、强调色
 * 跟着取色器走、行高跟着字号倍率走。**导出时的 DOM 与预览的 DOM 是同一份**，
 * 所以这里不需要第二套"导出样式"。
 */
export function posterRootStyle(options: PosterOptions): Record<string, string> {
    const scale = clampFontScale(options.fontScale)
    const accent = /^#[0-9a-f]{6}$/i.test(options.accent) ? options.accent : DEFAULT_POSTER_OPTIONS.accent
    const fontPx = posterFontPx(scale)
    return {
        '--pp-width': `${POSTER_WIDTH}px`,
        '--pp-accent': accent,
        '--pp-accent-ink': contrastTextOn(accent),
        '--pp-accent-soft': withAlpha(accent, 0.16),
        '--pp-accent-line': withAlpha(accent, 0.42),
        '--pp-font': `${fontPx}px`,
        '--pp-line': `${Math.round(fontPx * 1.6)}px`,
        '--pp-meta': `${Math.round(fontPx * 0.68)}px`,
        '--pp-title': `${Math.round(fontPx * 1.5)}px`,
        '--pp-pad': `${Math.round(48 * Math.min(1.2, scale))}px`,
        '--pp-gap': `${Math.round(26 * Math.min(1.25, Math.max(0.85, scale)))}px`,
        '--pp-radius': options.showBubble ? '22px' : '12px',
        '--pp-bubble-radius': options.showBubble ? '20px 20px 6px 20px' : '12px',
        '--pp-bubble-radius-in': options.showBubble ? '20px 20px 20px 6px' : '12px',
        '--pp-avatar': options.showAvatar ? '76px' : '0px',
    }
}

/** 海报主题（`data-poster-theme`）—— 与 App 的明暗**无关**，导出图要能独立存在。 */
export function posterThemeAttr(theme: PosterTheme): string {
    return theme === 'light' ? 'light' : 'dark'
}

export interface SavedPosterTemplate {
    id: string
    name: string
    options: PosterOptions
    createdAt: number
}

const VALID_TEMPLATE_IDS = new Set<PosterTemplateId>(['long', 'quote', 'grid9', 'summary'])
const VALID_THEMES = new Set<PosterTheme>(['light', 'dark'])
const VALID_STRENGTHS = new Set<RedactionStrength>(['light', 'normal', 'strong'])
const VALID_REDACTION_KINDS = new Set<RedactionKind>(['phone', 'wxid', 'idcard', 'bankcard', 'email', 'address', 'code', 'name'])

function normalizePosterOptions(value: unknown): PosterOptions | null {
    if (!value || typeof value !== 'object') return null
    const input = value as Partial<PosterOptions>
    const redaction = input.redaction && typeof input.redaction === 'object' ? input.redaction : DEFAULT_POSTER_OPTIONS.redaction
    const kinds = Array.isArray(redaction.kinds)
        ? redaction.kinds.filter((kind): kind is RedactionKind => typeof kind === 'string' && VALID_REDACTION_KINDS.has(kind as RedactionKind))
        : [...DEFAULT_REDACTION_KINDS]
    const numeric = (raw: unknown, fallback: number, min: number, max: number) => {
        const value = Number(raw)
        return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback
    }
    return {
        ...DEFAULT_POSTER_OPTIONS,
        template: VALID_TEMPLATE_IDS.has(input.template as PosterTemplateId) ? input.template as PosterTemplateId : DEFAULT_POSTER_OPTIONS.template,
        theme: VALID_THEMES.has(input.theme as PosterTheme) ? input.theme as PosterTheme : DEFAULT_POSTER_OPTIONS.theme,
        accent: typeof input.accent === 'string' && /^#[0-9a-f]{6}$/i.test(input.accent) ? input.accent : DEFAULT_POSTER_OPTIONS.accent,
        fontScale: numeric(input.fontScale, DEFAULT_POSTER_OPTIONS.fontScale, 0.8, 1.6),
        showAvatar: typeof input.showAvatar === 'boolean' ? input.showAvatar : DEFAULT_POSTER_OPTIONS.showAvatar,
        showBubble: typeof input.showBubble === 'boolean' ? input.showBubble : DEFAULT_POSTER_OPTIONS.showBubble,
        showWatermark: typeof input.showWatermark === 'boolean' ? input.showWatermark : DEFAULT_POSTER_OPTIONS.showWatermark,
        showTimestamp: typeof input.showTimestamp === 'boolean' ? input.showTimestamp : DEFAULT_POSTER_OPTIONS.showTimestamp,
        footer: typeof input.footer === 'string' ? input.footer.slice(0, 500) : DEFAULT_POSTER_OPTIONS.footer,
        title: typeof input.title === 'string' ? input.title.slice(0, 120) : DEFAULT_POSTER_OPTIONS.title,
        redaction: {
            enabled: typeof redaction.enabled === 'boolean' ? redaction.enabled : true,
            strength: VALID_STRENGTHS.has(redaction.strength as RedactionStrength) ? redaction.strength as RedactionStrength : DEFAULT_POSTER_OPTIONS.redaction.strength,
            kinds: kinds.length ? [...new Set(kinds)] : [...DEFAULT_REDACTION_KINDS],
        },
        pageMaxHeight: Math.round(numeric(input.pageMaxHeight, DEFAULT_POSTER_OPTIONS.pageMaxHeight, 4000, 20000)),
        zoom: numeric(input.zoom, DEFAULT_POSTER_OPTIONS.zoom, 0.2, 1),
    }
}

/** Validate user-imported JSON before it reaches rendering or local storage. */
export function parseSavedPosterTemplates(value: unknown, now = Date.now()): SavedPosterTemplate[] {
    const rows = Array.isArray(value)
        ? value
        : value && typeof value === 'object' && Array.isArray((value as { templates?: unknown }).templates)
            ? (value as { templates: unknown[] }).templates
            : []
    const result: SavedPosterTemplate[] = []
    for (let index = 0; index < rows.length; index += 1) {
        const row = rows[index]
        if (!row || typeof row !== 'object') continue
        const item = row as Partial<SavedPosterTemplate>
        const name = typeof item.name === 'string' ? item.name.trim().slice(0, 60) : ''
        const options = normalizePosterOptions(item.options)
        if (!name || !options) continue
        const id = typeof item.id === 'string' && /^[\w.-]{1,100}$/.test(item.id) ? item.id : `import-${now}-${index}`
        const createdAt = Number(item.createdAt)
        result.push({ id, name, options, createdAt: Number.isFinite(createdAt) && createdAt > 0 ? createdAt : now })
    }
    return result
}

export function serializeSavedPosterTemplates(templates: SavedPosterTemplate[]): string {
    return `${JSON.stringify({ version: 1, templates: parseSavedPosterTemplates(templates) }, null, 2)}\n`
}

/** 模板是否允许拖动排序（引用卡/小结卡只有一条主体，排序没有意义）。 */
export function templateSupportsReorder(id: PosterTemplateId): boolean {
    return getTemplate(id).relevant.reorder
}

export function templateSupportsCrop(id: PosterTemplateId): boolean {
    return getTemplate(id).relevant.crop
}

/**
 * 模板取内容的方式：
 * - `long`    全部可见条目
 * - `quote`   第一条可见的文本条目（引用卡的语义是"一条"）
 * - `grid9`   前 9 张可见图片
 * - `summary` 不走条目，走统计
 */
export function templateItemLimit(id: PosterTemplateId): number {
    switch (id) {
        case 'quote':
            return 1
        case 'grid9':
            return GRID_SLOT_COUNT
        default:
            return Number.POSITIVE_INFINITY
    }
}
