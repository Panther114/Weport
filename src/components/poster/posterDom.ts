/**
 * 海报 DOM 的**唯一**绘制实现（v1.2 §4）。
 *
 * ## 为什么是"命令式 DOM"而不是 JSX
 *
 * 预览用的 DOM 与导出时被 `html2canvas` 抓取的 DOM **必须是同一份**。如果预览走
 * React 组件树、导出走另一套（哪怕是"看起来一样"的）构建代码，两者的差异只会在
 * 导出的图里出现 —— 而那时用户已经发出去了。这里把绘制收在一个函数里，React 的
 * `<PosterCanvas>` 只负责把容器交给它（`useLayoutEffect` 里调用），导出也调用同一个
 * 函数，于是"预览里打码看得见、导出的图里也有马赛克"是结构上的保证，不是靠自觉。
 *
 * 文字一律走 `textContent` + `createTextNode`，**没有任何 innerHTML**：内容来自
 * 聊天记录，把它拼进 HTML 字符串就等于给自己开了一个注入口。
 *
 * 高度有两遍：第一遍按 `block.height`（估算）画出来，`measureBlockHeights` 读回真实
 * 高度后由调用方重新分页并重画。所以页面高度是"实测的"，不是"算出来的"。
 */
import type { PosterOptions, PosterCrop } from './posterTypes.ts'
import type { PosterBlock, PosterPage } from './posterLayout.ts'
import { cropImageStyle } from './posterLayout.ts'
import { REDACTION_LABELS, redactSegments, type RedactionOptions } from './posterRedaction.ts'
import { posterRootStyle, posterThemeAttr } from './posterTemplates.ts'

/** 画一个块所需要的全部上下文。 */
export interface PosterRenderContext {
    options: PosterOptions
    /** 已按"开关是否打开"折算过的打码规则（`effectiveRedactionOptions`） */
    redaction: RedactionOptions
    /** 昵称词表（会话名 / 发送者名） */
    dictionary: string[]
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
    const node = document.createElement(tag)
    if (className) node.className = className
    if (text !== undefined) node.textContent = text
    return node
}

/** 打码片段 → 文本节点 + `<mark>`：预览里看到的马赛克就是导出的马赛克。 */
function appendRedacted(parent: HTMLElement, text: string, ctx: PosterRenderContext): number {
    let masked = 0
    for (const segment of redactSegments(text, ctx.redaction)) {
        if (!segment.kind) {
            parent.appendChild(document.createTextNode(segment.text))
            continue
        }
        const mark = el('mark', 'pp-mask', segment.text)
        mark.dataset.kind = segment.kind
        // 悬停能看出"为什么被涂"——这是给人核对用的，不会画进 canvas（html2canvas 不渲染 title）
        mark.title = `已打码：${REDACTION_LABELS[segment.kind]}`
        parent.appendChild(mark)
        masked += 1
    }
    return masked
}

function formatClock(ts: number): string {
    if (!ts) return ''
    const d = new Date(ts)
    const pad = (n: number) => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function maskBoxStyle(box: PosterCrop): Record<string, string> {
    return {
        left: `${(box.x * 100).toFixed(2)}%`,
        top: `${(box.y * 100).toFixed(2)}%`,
        width: `${(box.w * 100).toFixed(2)}%`,
        height: `${(box.h * 100).toFixed(2)}%`,
    }
}

function renderMessage(block: PosterBlock, ctx: PosterRenderContext): { node: HTMLElement; masked: number } {
    const { options } = ctx
    const row = el('div', 'pp-msg')
    row.dataset.send = block.isSend ? '1' : '0'
    row.dataset.key = block.key
    let masked = 0

    if (options.showAvatar) {
        const avatar = el('div', 'pp-avatar')
        avatar.setAttribute('aria-hidden', 'true')
        // 没有头像地址时画一个字：用**打码后**的名字，否则占位字本身就把昵称露了
        const nameSegments = redactSegments(block.sender || '?', ctx.redaction)
        const initial = nameSegments.map((s) => s.text).join('').trim().slice(0, 1) || '?'
        avatar.textContent = initial
        row.appendChild(avatar)
    }

    const col = el('div', 'pp-col')
    const metaBits: HTMLElement[] = []
    if (options.showBubble && block.sender) {
        const senderEl = el('span', 'pp-sender')
        masked += appendRedacted(senderEl, block.sender, ctx)
        metaBits.push(senderEl)
    }
    if (options.showTimestamp && block.ts) metaBits.push(el('span', 'pp-time', formatClock(block.ts)))
    if (metaBits.length > 0) {
        const meta = el('div', 'pp-meta')
        for (const bit of metaBits) meta.appendChild(bit)
        col.appendChild(meta)
    }

    const bubble = el('div', options.showBubble ? 'pp-bubble' : 'pp-plain')
    masked += appendRedacted(bubble, block.text ?? '', ctx)
    col.appendChild(bubble)
    row.appendChild(col)
    return { node: row, masked }
}

function renderMedia(block: PosterBlock, ctx: PosterRenderContext): { node: HTMLElement; masked: number } {
    const wrap = el('div', 'pp-media')
    wrap.dataset.key = block.key
    const image = block.image
    if (!image) return { node: wrap, masked: 0 }

    const frame = el('div', 'pp-media-frame')
    frame.dataset.slot = String(image.slot)
    if (!image.unavailable && image.src) {
        const img = el('img', 'pp-img')
        img.src = image.src
        img.alt = image.alt
        img.loading = 'eager'
        const cropStyle = cropImageStyle(image.crop)
        if (cropStyle) {
            img.style.width = cropStyle.width
            img.style.height = cropStyle.height
            img.style.objectPosition = cropStyle.objectPosition
        }
        // 加载不出来就换成占位块：宁可让用户看到"图片没能画进海报"，
        // 也不要让 html2canvas 静默画出一块空白（那看起来像排版 bug）。
        img.addEventListener('error', () => {
            frame.classList.add('pp-media-frame-failed')
            img.remove()
            frame.appendChild(el('div', 'pp-media-ph', `图片未能加载：${image.alt}`))
        })
        frame.appendChild(img)
    } else {
        frame.appendChild(el('div', 'pp-media-ph', `图片未解密 · ${image.alt}`))
    }
    if (image.maskBox) {
        const box = el('div', 'pp-imagemask')
        box.dataset.role = 'manual'
        box.title = '手动遮挡区'
        Object.assign(box.style, maskBoxStyle(image.maskBox))
        frame.appendChild(box)
    }
    wrap.appendChild(frame)
    return { node: wrap, masked: 0 }
}

function renderStat(block: PosterBlock): HTMLElement {
    const row = el('div', 'pp-stat')
    row.dataset.key = block.key
    row.appendChild(el('span', 'pp-stat-label', block.stat?.label ?? ''))
    row.appendChild(el('span', 'pp-stat-value', block.stat?.value ?? ''))
    if (block.stat?.hint) row.appendChild(el('span', 'pp-stat-hint', block.stat.hint))
    return row
}

export interface PosterRenderResult {
    /** 打码命中数（预览上的说明条用它） */
    masked: number
    /** 逐块的真实高度（key → px） */
    heights: Map<string, number>
}

/** 页面根节点的内联样式（选项 → CSS 变量）。导出时这张根节点就是被抓的对象。 */
export function applyPosterRootStyle(node: HTMLElement, options: PosterOptions): void {
    const style = posterRootStyle(options)
    for (const [key, value] of Object.entries(style)) node.style.setProperty(key, value)
    node.dataset.posterTheme = posterThemeAttr(options.theme)
    node.dataset.posterTemplate = options.template
    node.setAttribute('data-poster-page', 'true')
}

/**
 * 画一页。
 *
 * 九宫格模板把连续的图片块合成一个 3×3 的 `.pp-grid`：格子数决定行数，
 * 少于 9 张时后面的格子留空（不是拉伸已有图片 —— 拉伸会让画面比例失真）。
 */
export function renderPosterPage(container: HTMLElement, page: PosterPage, ctx: PosterRenderContext): PosterRenderResult {
    container.textContent = ''
    const pageEl = el('div', 'pp-page')
    pageEl.dataset.pageIndex = String(page.index)
    applyPosterRootStyle(pageEl, ctx.options)

    const body = el('div', 'pp-body')
    let masked = 0
    const heights = new Map<string, number>()
    const grid = ctx.options.template === 'grid9'
    let gridRow: HTMLElement | null = null
    let gridCount = 0

    const flushGrid = () => {
        gridRow = null
        gridCount = 0
    }

    for (const block of page.blocks) {
        if (block.kind === 'header') {
            flushGrid()
            const head = el('div', block.key === 'header' ? 'pp-head' : 'pp-subhead')
            head.dataset.blockKey = block.key
            const target = block.key === 'header' ? el('h1', 'pp-title') : el('p', 'pp-sub')
            /**
             * 标题/页脚用**不带词表**的规则。
             *
             * 词表命中的是"昵称"，而标题与页脚是用户自己敲进去的（"家庭群"、
             * "2026 春节 · 家庭群"）—— 把自己输入的文字涂成马赛克看起来像 bug，
             * 也让标题失去意义。正则规则（手机号/身份证/卡号…）仍然生效：
             * 手滑把号码写进页脚也该被遮住。
             */
            masked += appendRedacted(target, block.text ?? '', { ...ctx, redaction: { ...ctx.redaction, dictionary: [] } })
            head.appendChild(target)
            body.appendChild(head)
            continue
        }
        if (block.kind === 'footer') {
            flushGrid()
            const foot = el('div', 'pp-footer')
            foot.dataset.blockKey = block.key
            masked += appendRedacted(foot, block.text ?? '', { ...ctx, redaction: { ...ctx.redaction, dictionary: [] } })
            body.appendChild(foot)
            continue
        }
        if (block.kind === 'stat') {
            flushGrid()
            const node = renderStat(block)
            body.appendChild(node)
            continue
        }
        if (block.kind === 'media') {
            const { node } = renderMedia(block, ctx)
            if (grid) {
                if (!gridRow || gridCount >= 3) {
                    gridRow = el('div', 'pp-grid-row')
                    body.appendChild(gridRow)
                    gridCount = 0
                }
                gridRow.appendChild(node)
                gridCount += 1
            } else {
                flushGrid()
                body.appendChild(node)
            }
            continue
        }
        flushGrid()
        const { node, masked: hit } = renderMessage(block, ctx)
        masked += hit
        body.appendChild(node)
    }

    pageEl.appendChild(body)
    container.appendChild(pageEl)

    // 高度实测：翻页/分页都要用它，所以第一遍画完就读一次（同一次布局内，无抖动）
    for (const node of Array.from(pageEl.querySelectorAll<HTMLElement>('[data-key]'))) {
        const key = node.dataset.key
        if (key) heights.set(key, node.offsetHeight)
    }
    for (const node of Array.from(pageEl.querySelectorAll<HTMLElement>('[data-block-key]'))) {
        const key = node.dataset.blockKey
        if (key) heights.set(key, node.offsetHeight)
    }
    return { masked, heights }
}

/** 多页（长图分页 / 批量导出）：并列画在一个容器里，导出时逐页抓。 */
export function renderPosterPages(
    container: HTMLElement,
    pages: PosterPage[],
    ctx: PosterRenderContext
): { masked: number; heights: Map<string, number> } {
    container.textContent = ''
    let masked = 0
    const heights = new Map<string, number>()
    for (const page of pages) {
        const host = el('div', 'pp-page-host')
        host.dataset.pageIndex = String(page.index)
        container.appendChild(host)
        const result = renderPosterPage(host, page, ctx)
        masked += result.masked
        for (const [key, value] of result.heights) heights.set(key, value)
    }
    return { masked, heights }
}

/**
 * 用实测高度回填块。
 *
 * 页面高度最后一定来自这里：估算只决定"第一遍怎么切"，真实高度决定"最终几页"。
 * 找不到实测值的块保留估算（图片还没加载完时就是这种情况）。
 */
export function applyMeasuredHeights(page: PosterPage, heights: Map<string, number>): PosterPage {
    const blocks = page.blocks.map((block) => {
        const measured = heights.get(block.key)
        return measured && measured > 0 ? { ...block, height: measured } : block
    })
    const total = blocks.reduce((sum, block) => sum + block.height, 0)
    return { ...page, blocks, height: Math.max(page.height, total) }
}

/** 每个页面根节点的抓取目标（导出时按顺序抓这些节点）。 */
export function posterPageNodes(container: HTMLElement): HTMLElement[] {
    return Array.from(container.querySelectorAll<HTMLElement>('[data-poster-page="true"]'))
}
