/**
 * 海报排版（v1.2 §4）：条目 → 块 → 页，以及三个纯 reducer。
 *
 * ## 为什么排版是纯函数
 *
 * 三种模板对"一页能放多少"的答案不一样，长图还要**自动分页**（画布有尺寸上限，
 * 而且一张 3 万像素高的图在手机相册里也读不了）。如果分页逻辑长在组件里，它就只能
 * 靠"在浏览器里试一次"来验证；写成纯函数之后，`vitest` 能直接断言
 * 「200 条 → 几页 / 每页多高 / 有没有把一条消息劈成两半」。
 *
 * 高度有**两个来源**，用的是同一个分页函数：
 * - 布局阶段（这里）：按字号、字数、图片形状估算，给预览和 Node 测试用；
 * - 导出前（`posterMeasure`）：DOM 渲染完读 `offsetHeight` —— 真实高度。
 * 实测值回填到 `block.height` 后重新分页，于是"估算偏了"最多导致多切一页，
 * 不会把内容切出页面之外。
 *
 * ## 坐标
 *
 * 块高度/页面高度是 px（画布宽恒为 1080）；裁剪框、遮挡框是 0..1 归一化比例，
 * 与被裁图片的原始像素尺寸无关 —— 换图解不了码也不会让裁剪框漂移。
 */
import type { PosterItem, PosterOptions, PosterSummaryStats, PosterCrop, PosterTemplateId } from './posterTypes.ts'
import { POSTER_WIDTH } from './posterTypes.ts'
import { GRID_GAP, GRID_PAD, GRID_SLOT_COUNT, clampFontScale, posterFontPx, templateItemLimit } from './posterTemplates.ts'

export type PosterBlockKind = 'header' | 'message' | 'media' | 'stat' | 'footer'

export interface PosterBlock {
    key: string
    kind: PosterBlockKind
    /** 该块属于哪个条目（页脚/标题为空）—— 分页时保证一条消息不被劈开 */
    itemKey?: string
    text?: string
    /** 发送者显示名（会被打码词表命中） */
    sender?: string
    isSend?: boolean
    ts?: number
    /** 图片块 */
    image?: { src?: string; unavailable?: boolean; alt: string; crop?: PosterCrop; maskBox?: PosterCrop | null; slot: number }
    /** 统计块（小结卡） */
    stat?: { label: string; value: string; hint?: string }
    /** 高度（px）。导出前用实测值覆盖 */
    height: number
}

export interface PosterPage {
    index: number
    blocks: PosterBlock[]
    /** 画布高度（px） */
    height: number
    /** 这一页包含的条目 key（拖动排序的"当前页"提示用） */
    itemKeys: string[]
}

export interface PosterMetrics {
    fontPx: number
    lineHeight: number
    metaPx: number
    /** 气泡可用的内容宽度 */
    contentWidth: number
    pad: number
    gap: number
    avatar: number
}

export function posterMetrics(options: PosterOptions): PosterMetrics {
    const fontPx = posterFontPx(options.fontScale)
    const pad = Math.round(48 * Math.min(1.2, clampFontScale(options.fontScale)))
    const avatar = options.showAvatar ? 76 : 0
    return {
        fontPx,
        lineHeight: Math.round(fontPx * 1.6),
        metaPx: Math.round(fontPx * 0.68),
        contentWidth: POSTER_WIDTH - pad * 2 - avatar - 28,
        pad,
        gap: Math.round(26 * Math.min(1.25, Math.max(0.85, clampFontScale(options.fontScale)))),
        avatar,
    }
}

/** 一个汉字约占 1 个字号宽；ASCII 约占 0.55 —— 估行数够用了。 */
export function estimateTextWidth(text: string, fontPx: number): number {
    let width = 0
    for (const ch of text) {
        width += /[\u3000-\u9fff\uff00-\uffef]/.test(ch) ? fontPx : fontPx * 0.55
    }
    return width
}

export function estimateTextLines(text: string, metrics: PosterMetrics): number {
    if (!text) return 0
    let total = 0
    for (const paragraph of text.split('\n')) {
        total += Math.max(1, Math.ceil(estimateTextWidth(paragraph, metrics.fontPx) / metrics.contentWidth))
    }
    return total
}

function estimateMessageHeight(item: PosterItem, options: PosterOptions, metrics: PosterMetrics): number {
    const meta = options.showTimestamp || (options.showBubble && item.senderName) ? metrics.metaPx + 10 : 0
    const quoteLines = item.quote ? estimateTextLines(item.quote.text, metrics) + 1 : 0
    const bodyLines = Math.max(item.kind === 'text' ? 1 : 1, estimateTextLines(item.text, metrics))
    const bubblePad = options.showBubble ? 34 : 12
    return Math.round(meta + (quoteLines + bodyLines) * metrics.lineHeight + bubblePad + metrics.gap)
}

/** 块高估算。导出前由实测高度覆盖（`posterMeasure.measureBlocks`）。 */
export function estimateBlockHeight(block: PosterBlock, options: PosterOptions, metrics: PosterMetrics): number {
    switch (block.kind) {
        case 'header':
            return block.text ? Math.round(metrics.fontPx * 1.5 + metrics.metaPx * 1.6 + metrics.pad * 1.6) : 0
        case 'footer':
            return block.text ? Math.round(metrics.metaPx * 2 + metrics.pad * 1.4) : 0
        case 'stat':
            return Math.round(metrics.fontPx * 3.4 + 28)
        case 'media':
            // 单图按 4:3 估（图片真实形状在导出前由实测高度纠正）；九宫格是正方形格子
            return block.image?.slot !== undefined && options.template === 'grid9'
                ? Math.round((POSTER_WIDTH - GRID_PAD * 2 - GRID_GAP * 2) / 3) + metrics.gap
                : Math.round(metrics.contentWidth * 0.72 + metrics.gap)
        case 'message':
        default:
            return estimateMessageHeight(
                {
                    key: block.key,
                    sessionId: '',
                    senderName: block.sender ?? '',
                    isSend: block.isSend ?? false,
                    ts: block.ts ?? 0,
                    kind: 'text',
                    text: block.text ?? '',
                    visible: true,
                },
                options,
                metrics
            )
    }
}

function formatTime(ts: number): string {
    if (!ts) return ''
    const d = new Date(ts)
    const pad = (n: number) => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** 块高估算阶段的收口：能对上真实条目的（消息）用真实条目算，其余用块自身的估算。 */
function finalizeHeights(
    blocks: PosterBlock[],
    options: PosterOptions,
    metrics: PosterMetrics,
    items: PosterItem[] = []
): void {
    const byKey = new Map(items.map((item) => [item.key, item]))
    for (const block of blocks) {
        const item = block.itemKey ? byKey.get(block.itemKey) : undefined
        block.height =
            block.kind === 'message' && item
                ? estimateMessageHeight(item, options, metrics)
                : estimateBlockHeight(block, options, metrics)
    }
}

/** 条目 → 块。模板限制在这里生效（引用卡只取第一条、九宫格只取 9 张图）。 */
export function buildPosterBlocks(
    items: PosterItem[],
    options: PosterOptions,
    extras: { summary?: PosterSummaryStats; sessionName?: string } = {}
): PosterBlock[] {
    const metrics = posterMetrics(options)
    const visible = items.filter((item) => item.visible)
    const blocks: PosterBlock[] = []

    const headerText = options.title.trim() || extras.sessionName?.trim() || ''
    if (headerText) {
        const sub = visible.length > 0 ? `${visible.length} 条 · ${formatTime(visible[0]?.ts ?? 0)}` : ''
        blocks.push({
            key: 'header',
            kind: 'header',
            text: headerText,
            height: 0,
        })
        if (sub && options.showTimestamp) {
            blocks.push({ key: 'header-sub', kind: 'header', text: sub, height: 0 })
        }
    }

    if (options.template === 'summary') {
        const stats = extras.summary
        if (stats) {
            const rows: Array<[string, string, string]> = [
                ['消息总数', stats.totalMessages.toLocaleString('zh-CN'), `其中文本 ${stats.textMessages.toLocaleString('zh-CN')}`],
                ['发送 / 接收', `${stats.sentMessages.toLocaleString('zh-CN')} / ${stats.receivedMessages.toLocaleString('zh-CN')}`, '我发出的占比'],
                ['图片 / 语音', `${stats.imageMessages.toLocaleString('zh-CN')} / ${stats.voiceMessages.toLocaleString('zh-CN')}`, ''],
                ['活跃天数', String(stats.activeDays), stats.firstMessageTime ? `自 ${formatTime(stats.firstMessageTime).slice(0, 10)}` : ''],
            ]
            for (const [label, value, hint] of rows) {
                blocks.push({ key: `stat-${label}`, kind: 'stat', stat: { label, value, hint }, height: 0 })
            }
        }
        finalizeHeights(blocks, options, metrics)
        pushFooter(blocks, options, metrics)
        return blocks
    }
    if (options.template === 'grid9') {
        const images = visible.filter((item) => item.kind === 'image').slice(0, GRID_SLOT_COUNT)
        let slot = 0
        for (const item of images) {
            blocks.push({
                key: `grid-${item.key}`,
                kind: 'media',
                itemKey: item.key,
                text: item.text,
                image: {
                    src: item.imageSrc,
                    unavailable: item.imageUnavailable === true || !item.imageSrc,
                    alt: item.imageAlt || '图片',
                    crop: item.crop,
                    maskBox: item.maskBox ?? null,
                    slot,
                },
                height: 0,
            })
            slot += 1
        }
        finalizeHeights(blocks, options, metrics, images)
        pushFooter(blocks, options, metrics)
        return blocks
    }

    const limit = templateItemLimit(options.template)
    const taken = visible.filter((item) => item.kind !== 'system').slice(0, limit)
    for (const item of taken) {
        if (item.kind === 'image') {
            blocks.push({
                key: `media-${item.key}`,
                kind: 'media',
                itemKey: item.key,
                text: item.text,
                image: {
                    src: item.imageSrc,
                    unavailable: item.imageUnavailable === true || !item.imageSrc,
                    alt: item.imageAlt || '图片',
                    crop: item.crop,
                    maskBox: item.maskBox ?? null,
                    slot: 0,
                },
                height: 0,
            })
            continue
        }
        const body = item.quote ? `${item.quote.text}\n${item.text}` : item.text
        blocks.push({
            key: `msg-${item.key}`,
            kind: 'message',
            itemKey: item.key,
            text: body,
            sender: item.senderName,
            isSend: item.isSend,
            ts: item.ts,
            height: 0,
        })
    }
    finalizeHeights(blocks, options, metrics, taken)
    pushFooter(blocks, options, metrics)
    return blocks
}

function pushFooter(blocks: PosterBlock[], options: PosterOptions, metrics: PosterMetrics) {
    const text = [options.footer.trim(), options.showWatermark ? 'Weport' : ''].filter(Boolean).join(' · ')
    if (!text) return
    blocks.push({ key: 'footer', kind: 'footer', text, height: Math.round(metrics.metaPx * 2 + metrics.pad * 1.4) })
}

/** 顶部留白 + 底部留白（页面高度 = 块高之和 + 块间距 + 上下内边距）。 */
export function pagePadding(options: PosterOptions): { top: number; bottom: number } {
    const pad = posterMetrics(options).pad
    // 与 `poster.css` 的 `.pp-page { padding: var(--pp-pad) }` 一致（上下同值）
    return { top: pad, bottom: pad }
}

/**
 * 分页：**一条消息不会被劈成两半**（以块为单位装箱）。
 *
 * 预算里必须把**块间距**算进去：真实页面的高度是 `Σ块高 + 间距×(块数-1) + 上下留白`，
 * 只按块高装箱会让每页超出预算 `间距 × 块数`。200 条长图的实测就撞上了这件事 ——
 * 预算 12000px 的页面实测 13691px（68 个块 × 26px 间距 ≈ 1768px 的差值）。
 *
 * `repeatHeader` 打开时长图的每一页都会重画标题块 —— 用户保存的是若干张图而不是
 * 一张 3 万像素的图，第二页以后没有标题就不知道这是什么对话了。
 */
export function paginateBlocks(
    blocks: PosterBlock[],
    options: PosterOptions,
    opts: { repeatHeader?: boolean } = {}
): PosterPage[] {
    const { top, bottom } = pagePadding(options)
    const gap = posterMetrics(options).gap
    const budget = Math.max(600, options.pageMaxHeight - top - bottom)
    const header = blocks.find((b) => b.key === 'header')
    const rest = blocks.filter((b) => b.key !== 'header')
    const pages: PosterPage[] = []
    let current: PosterBlock[] = []
    let used = 0

    const pageHeight = (list: PosterBlock[]) =>
        Math.round(top + list.reduce((sum, block) => sum + block.height, 0) + Math.max(0, list.length - 1) * gap + bottom)

    const flush = () => {
        if (current.length === 0) return
        const withHeader = opts.repeatHeader && pages.length > 0 && header ? [header, ...current] : current
        pages.push({
            index: pages.length,
            blocks: withHeader,
            height: pageHeight(withHeader),
            itemKeys: withHeader.map((b) => b.itemKey).filter((k): k is string => Boolean(k)),
        })
        current = []
        used = 0
    }

    if (header) {
        current.push(header)
        used += header.height
    }
    for (const block of rest) {
        const needed = block.height + (current.length > 0 ? gap : 0)
        // 第 2 页起会重画标题：它占的高度也要从预算里扣掉，否则"预算 12000"的页面
        // 实测 12058 —— 超限这件事不能靠运气（canvas 边界就是这么撞上去的）。
        const reserve = opts.repeatHeader && pages.length > 0 && header ? header.height + gap : 0
        if (used + needed + reserve > budget && current.some((b) => b.itemKey)) flush()
        current.push(block)
        used += block.height + (current.length > 1 ? gap : 0)
    }
    flush()
    if (pages.length === 0) {
        pages.push({ index: 0, blocks: [], height: top + bottom, itemKeys: [] })
    }
    return pages
}

/** 便捷入口：条目 → 页（估算高度版；导出前用实测高度重跑 `paginateBlocks`）。 */
export function buildPosterPages(
    items: PosterItem[],
    options: PosterOptions,
    extras: { summary?: PosterSummaryStats; sessionName?: string } = {}
): PosterPage[] {
    const blocks = buildPosterBlocks(items, options, extras)
    return paginateBlocks(blocks, options, { repeatHeader: options.template === 'long' })
}

// ---------------------------------------------------------------------------
// reducer（拖动排序 / 显示开关 / 裁剪 / 遮挡）
// ---------------------------------------------------------------------------

/**
 * 拖动排序。
 *
 * `to` 用"落在哪一个下标之前"来表达（`arrayMove` 语义）：界面上拖到第 3 条和第 4 条
 * 之间是一个**位置**，不是"第 4 条"。越界一律夹回区间内 —— 拖到列表外面时不要
 * 让条目消失（数组越界 push 会让它静默跑到最后）。
 */
export function applyReorder(items: PosterItem[], from: number, to: number): PosterItem[] {
    if (from < 0 || from >= items.length) return items
    const target = Math.max(0, Math.min(items.length - 1, to))
    if (target === from) return items
    const next = items.slice()
    const [moved] = next.splice(from, 1)
    next.splice(target, 0, moved)
    return next
}

/** 单条显示/隐藏。 */
export function applyVisibility(items: PosterItem[], key: string, visible: boolean): PosterItem[] {
    return items.map((item) => (item.key === key && item.visible !== visible ? { ...item, visible } : item))
}

/** 全选 / 全不选。 */
export function applyVisibilityAll(items: PosterItem[], visible: boolean): PosterItem[] {
    return items.map((item) => (item.visible === visible ? item : { ...item, visible }))
}

/** 只保留这些 key 可见（"仅选中"）。 */
export function isolateKeys(items: PosterItem[], keys: string[]): PosterItem[] {
    const set = new Set(keys)
    return items.map((item) => ({ ...item, visible: set.has(item.key) }))
}

export function applyCrop(items: PosterItem[], key: string, crop: PosterCrop): PosterItem[] {
    return items.map((item) => (item.key === key ? { ...item, crop: clampCrop(crop) } : item))
}

export function applyMaskBox(items: PosterItem[], key: string, box: PosterCrop | null): PosterItem[] {
    return items.map((item) => (item.key === key ? { ...item, maskBox: box ? clampCrop(box) : null } : item))
}

export function clampCrop(crop: PosterCrop): PosterCrop {
    const x = Math.min(0.95, Math.max(0, crop.x))
    const y = Math.min(0.95, Math.max(0, crop.y))
    const w = Math.min(1 - x, Math.max(0.05, crop.w))
    const h = Math.min(1 - y, Math.max(0.05, crop.h))
    return { x: round3(x), y: round3(y), w: round3(w), h: round3(h) }
}

function round3(v: number): number {
    return Math.round(v * 1000) / 1000
}

export function visibleItems(items: PosterItem[]): PosterItem[] {
    return items.filter((item) => item.visible)
}

/** 九宫格的 9 个归一化槽位（0..1，相对拼贴区）。 */
export function gridSlots(count = GRID_SLOT_COUNT): Array<{ x: number; y: number; w: number; h: number }> {
    const slots: Array<{ x: number; y: number; w: number; h: number }> = []
    const size = 1 / 3
    for (let i = 0; i < Math.min(GRID_SLOT_COUNT, Math.max(0, count)); i++) {
        slots.push({ x: (i % 3) * size, y: Math.floor(i / 3) * size, w: size, h: size })
    }
    return slots
}

/**
 * 裁剪框 → 图片样式（`object-fit: cover` + `object-position` + 放大）。
 *
 * 推导：容器宽 W_c、图宽 W_i = W_c / w 时，`object-position: X%` 会把图左移
 * `X% · (W_i − W_c)`，而我们要左移 `x · W_i`，于是 `X = x / (1 − w)`。
 * `w → 1` 时无位移可谈，取 50% 兜底。这个式子有单测（这正是"换了图裁剪框就漂"
 * 的成因 —— 它只跟归一化比值有关，与像素尺寸无关）。
 */
export function cropImageStyle(crop?: PosterCrop): { width: string; height: string; objectPosition: string } | null {
    if (!crop) return null
    const w = Math.min(1, Math.max(0.05, crop.w))
    const h = Math.min(1, Math.max(0.05, crop.h))
    const px = w >= 1 ? 50 : (crop.x / (1 - w)) * 100
    const py = h >= 1 ? 50 : (crop.y / (1 - h)) * 100
    return {
        width: `${(100 / w).toFixed(2)}%`,
        height: `${(100 / h).toFixed(2)}%`,
        objectPosition: `${px.toFixed(2)}% ${py.toFixed(2)}%`,
    }
}

/** 打码词表：把选中内容里出现过的名字都收进来（昵称没有形状，只能靠词表命中）。 */
export function collectRedactionDictionary(items: PosterItem[], extra: string[] = []): string[] {
    const names = new Set<string>()
    for (const name of extra) {
        const trimmed = name.trim()
        if (trimmed.length >= 2) names.add(trimmed)
    }
    for (const item of items) {
        const sender = item.senderName.trim()
        if (sender.length >= 2) names.add(sender)
    }
    return [...names]
}

/**
 * 长图抓取代价估算 —— 标定自本机**实测**（`scripts/poster-capture-fixture.mjs`，
 * Chromium headless，长图模板，200 条，分页上限 12000px）：
 *
 * | 运行 | 页数 | 总耗时 | 每页耗时 |
 * |---|---|---|---|
 * | 2×（4 页，2160×23944 / 23758 / 23758 / 7094） | 4 | 2802 ms（另一次 3587 ms） | 753 / 762 / 737 / 514 ms |
 * | 1×（4 页，1080 宽） | 4 | 3120 ms | 1094 / 583 / 859 / 424 ms |
 *
 * 两条结论（都跟直觉相反，所以写在代码里）：
 * 1. **耗时按页数走，不按像素走**：1× 的像素只有 2× 的四分之一，总耗时反而更长；
 *    同一份数据里 51.7 Mpx 的页（753ms）只比 15.3 Mpx 的页（514ms）慢 240ms。
 *    每页有约 **0.4~0.7 秒的固定开销**（html2canvas 的文档克隆 / SVG 布局 +
 *    PNG 编码 + GC），像素只是一个小项。
 * 2. 因此"把分页上限调小"会让导出**更慢**；要压时间只能压**页数**或压**倍率**，
 *    而倍率的效果有限（见上表）。界面上的提示与"超 2 秒怎么办"的取舍都以此为准。
 *
 * 模型：`estMs ≈ 页数 × 700ms + CSS 像素(Mpx) × 7ms + 图片数 × 22ms`。
 * 这是量级判断，不是精度承诺（噪声 ±25%，实测两次 200 条分别是 2.8s / 3.6s）。
 */
export function estimateCaptureCost(
    items: PosterItem[],
    options: PosterOptions,
    extras: { summary?: PosterSummaryStats; sessionName?: string } = {}
): { pages: number; blocks: number; pixels: number; megapixels: number; estMs: number; over2s: boolean } {
    const pages = buildPosterPages(items, options, extras)
    const blocks = pages.reduce((sum, page) => sum + page.blocks.length, 0)
    const pixels = pages.reduce((sum, page) => sum + POSTER_WIDTH * page.height, 0)
    const megapixels = pixels / 1_000_000
    const imageCount = items.filter((item) => item.visible && item.kind === 'image').length
    const estMs = Math.round(pages.length * 700 + megapixels * 7 + imageCount * 22)
    return { pages: pages.length, blocks, pixels, megapixels: Math.round(megapixels * 100) / 100, estMs, over2s: estMs > 2000 }
}
