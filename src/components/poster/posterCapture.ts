/**
 * 抓取与落盘（v1.2 §4）。
 *
 * ## 复用年度报告的抓取路线
 *
 * 年度报告（`AnnualReportView.exportImages`）已经在用 `html2canvas` +
 * `scale: 2` + `useCORS` 把 DOM 段落抓成 PNG，并交给主进程写盘。这里沿用同一套
 * （同一份依赖、同样的 2× 设备像素比、同样是"抓多个节点、逐个存"），差别只有两点：
 *
 * 1. **`html2canvas` 改成动态 import**：它在年度报告里是同步 import，于是整个渲染
 *    进程为它付了一份 V8 编译与解析代价（`App.tsx` 顶部注释里点名了这件事）。
 *    海报页在切页预算里（`over50 == 0` / `longTasks == 0`），不能让"打开海报页"
 *    顺带加载一个 200KB 的抓取库 —— 只有真正点导出时才 import。
 * 2. **落盘通道是 `poster:saveImage`**（引擎侧新接一个通道），缺失时回退到真实的
 *    `<a download>`，并**在界面上说明用的是回退路径**：绝不能报告一次没发生的保存。
 *
 * ## 跨源图片：为什么先 inline
 *
 * `weport-media://`（本机解密产物）与 CDN 头像画进 canvas 会把 canvas 标成 tainted，
 * 随后 `toDataURL()` 抛 SecurityError（`appMain.ts:3399` 记过同一件事）。那个自定义
 * 协议注册了 `supportFetchAPI: true`，所以可以先 `fetch` 成 blob、转成 data URL 再画
 * —— 画的是同源数据，导出不会失败。
 */
import type { PosterItem, PosterOptions, PosterSummaryStats } from './posterTypes.ts'
import { POSTER_WIDTH } from './posterTypes.ts'
import { buildPosterBlocks, paginateBlocks, type PosterBlock, type PosterPage } from './posterLayout.ts'
import { posterPageNodes, renderPosterPages, type PosterRenderContext } from './posterDom.ts'

/** 导出倍率：默认 2×（D16/§4 的硬要求），用户可升到 3×。 */
export const DEFAULT_EXPORT_SCALE = 2

export interface CapturePageRequest {
    /** 页面根节点（`[data-poster-page]`） */
    node: HTMLElement
    /** 文件名（不含扩展名） */
    name: string
}

export interface CaptureResult {
    name: string
    dataUrl: string
    width: number
    height: number
    bytes: number
    elapsedMs: number
}

export interface CaptureFailure {
    name: string
    error: string
    /** canvas 被跨源图片污染（需要关掉头像/外链图） */
    tainted?: boolean
}

/** data URL 的字节数（base64 → 原始字节），用来在界面上如实显示体积。 */
export function dataUrlBytes(dataUrl: string): number {
    const comma = dataUrl.indexOf(',')
    if (comma < 0) return 0
    const body = dataUrl.slice(comma + 1)
    if (dataUrl.slice(0, comma).includes(';base64')) {
        const padding = body.endsWith('==') ? 2 : body.endsWith('=') ? 1 : 0
        return Math.max(0, Math.floor((body.length * 3) / 4) - padding)
    }
    return body.length
}

export function formatBytes(bytes: number): string {
    if (bytes <= 0) return '0 B'
    if (bytes < 1024) return `${bytes} B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
    return `${(bytes / 1024 / 1024).toFixed(2)} MB`
}

/** 建议文件名（带时间戳，一次导出多页不会互相覆盖）。 */
export function suggestFileName(options: PosterOptions, at = new Date(), index?: number): string {
    const pad = (n: number) => String(n).padStart(2, '0')
    const stamp = `${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(at.getDate())}-${pad(at.getHours())}${pad(at.getMinutes())}${pad(at.getSeconds())}`
    const templateName = options.template
    const suffix = index === undefined ? '' : `-${index + 1}`
    return `Weport-海报-${templateName}-${stamp}${suffix}.png`
}

// ---------------------------------------------------------------------------
// 图片 inline
// ---------------------------------------------------------------------------

/**
 * inline 结果的记忆（`src` → data URL 或 null）。
 *
 * **按总字节封顶，不按条数**：每条都是一个 data URL，base64 之后一张手机照片轻易就是几 MB；
 * 按条数封顶等于没有上限（换几个会话导出几轮，渲染进程的堆就单调地长）。记账用
 * `string.length`（base64 字符数 ≈ 字节数×4/3，量级对），超了就按插入顺序淘汰最老的。
 * 上限 24MB：够一屏海报复用，也小到不会把内存吃穿。
 */
const INLINED_CACHE_MAX_CHARS = 24 * 1024 * 1024
const inlinedCache = new Map<string, string | null>()
let inlinedCacheChars = 0

function rememberInlined(src: string, value: string | null): void {
    if (inlinedCache.has(src)) return
    inlinedCache.set(src, value)
    inlinedCacheChars += value ? value.length : 64 // null 也占一点记账，免得大量失败条目无限增长
    while (inlinedCacheChars > INLINED_CACHE_MAX_CHARS && inlinedCache.size > 1) {
        const oldest = inlinedCache.keys().next().value
        if (typeof oldest !== 'string') break
        const dropped = inlinedCache.get(oldest)
        inlinedCache.delete(oldest)
        inlinedCacheChars -= dropped ? dropped.length : 64
    }
}

/** 换一批内容时把上一批的 inline 结果丢掉（页面卸载 / 条目整体替换）。 */
export function clearInlinedCache(): void {
    inlinedCache.clear()
    inlinedCacheChars = 0
}

/** 把一个可能是自定义协议 / 远程的地址读成 data URL；读不到就返回 null（不装作成功）。 */
export async function inlineImageSource(src: string): Promise<string | null> {
    if (!src) return null
    if (src.startsWith('data:')) return src
    if (inlinedCache.has(src)) return inlinedCache.get(src) ?? null
    let result: string | null = null
    try {
        const response = await fetch(src)
        if (response.ok) {
            const blob = await response.blob()
            result = await new Promise<string | null>((resolve) => {
                const reader = new FileReader()
                reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : null)
                reader.onerror = () => resolve(null)
                reader.readAsDataURL(blob)
            })
        }
    } catch {
        result = null
    }
    rememberInlined(src, result)
    return result
}

/** 批量 inline（渲染前的准备工作）。返回新的条目数组，**不改原数组**。 */
export async function inlineItemImages(items: PosterItem[]): Promise<PosterItem[]> {
    const out: PosterItem[] = []
    for (const item of items) {
        if (!item.imageSrc || item.imageSrc.startsWith('data:')) {
            out.push(item)
            continue
        }
        const inlined = await inlineImageSource(item.imageSrc)
        out.push(inlined ? { ...item, imageSrc: inlined } : { ...item, imageSrc: undefined, imageUnavailable: true })
    }
    return out
}

export function clearInlineCache(): void {
    inlinedCache.clear()
}

// ---------------------------------------------------------------------------
// 抓取
// ---------------------------------------------------------------------------

async function loadHtml2Canvas() {
    const mod = await import('html2canvas')
    return (mod as unknown as { default: typeof import('html2canvas').default }).default ?? (mod as unknown as typeof import('html2canvas').default)
}

/** 等字体与图片就绪：字体没加载完时 html2canvas 会抓成 fallback 字形（年度报告也踩过）。 */
export async function waitForAssets(root: HTMLElement): Promise<void> {
    try {
        await (document as Document & { fonts?: { ready?: Promise<unknown> } }).fonts?.ready
    } catch {
        /* 字体 API 不可用不是错误 */
    }
    const images = Array.from(root.querySelectorAll('img'))
    await Promise.all(
        images.map(
            (img) =>
                new Promise<void>((resolve) => {
                    if (img.complete) {
                        resolve()
                        return
                    }
                    const done = () => resolve()
                    img.addEventListener('load', done, { once: true })
                    img.addEventListener('error', done, { once: true })
                    // 兜底：3s 内没等到就继续，宁可缺一张图也不要卡死导出
                    window.setTimeout(done, 3000)
                })
        )
    )
}

export interface CaptureOptions {
    scale?: number
    backgroundColor?: string | null
    onProgress?: (done: number, total: number) => void
}

/**
 * 抓一页（或任意节点）成 PNG。
 *
 * `scale` 就是设备像素比：2 → 1080 宽的页面输出 2160 px 宽的位图。
 */
export async function captureNode(node: HTMLElement, options: CaptureOptions = {}): Promise<{ dataUrl: string; width: number; height: number; bytes: number }> {
    const html2canvas = await loadHtml2Canvas()
    const scale = options.scale ?? DEFAULT_EXPORT_SCALE
    // html2canvas defaults to the fractional getBoundingClientRect() size. On a
    // 1080px page that can be 1079px after font/layout rounding, producing 2158px
    // at 2×. Use the integer CSS border box so a 1080px poster is exactly 2160px.
    const width = node.offsetWidth
    const height = node.offsetHeight
    if (width <= 0 || height <= 0) throw new Error('导出节点没有可抓取的布局尺寸')
    const canvas = await html2canvas(node, {
        backgroundColor: options.backgroundColor ?? null,
        width,
        height,
        scale,
        useCORS: true,
        // 不允许"脏"图片：宁可少画一张，也不要一张导出时才炸的 canvas
        allowTaint: false,
        logging: false,
        windowWidth: node.scrollWidth,
        windowHeight: node.scrollHeight,
    })
    const expectedWidth = Math.floor(width * scale)
    if (canvas.width !== expectedWidth) throw new Error(`导出宽度异常：预期 ${expectedWidth}px，实际 ${canvas.width}px`)
    let dataUrl: string
    try {
        dataUrl = canvas.toDataURL('image/png')
    } catch (e) {
        throw new Error(`canvas 被外部图片污染，无法导出（${String(e)}）—— 请关闭「真实头像」或换成已解密图片后重试`)
    }
    return { dataUrl, width: canvas.width, height: canvas.height, bytes: dataUrlBytes(dataUrl) }
}

/** 逐页抓取。任何一页失败都会被记下来，**不会被静默跳过**。 */
export async function capturePages(
    requests: CapturePageRequest[],
    options: CaptureOptions = {}
): Promise<{ pages: CaptureResult[]; failures: CaptureFailure[] }> {
    const pages: CaptureResult[] = []
    const failures: CaptureFailure[] = []
    for (let i = 0; i < requests.length; i++) {
        const request = requests[i]
        const startedAt = performance.now()
        try {
            await waitForAssets(request.node)
            const shot = await captureNode(request.node, options)
            pages.push({ name: request.name, ...shot, elapsedMs: Math.round(performance.now() - startedAt) })
        } catch (e) {
            const message = String(e)
            failures.push({ name: request.name, error: message, tainted: /污染|tainted|SecurityError/i.test(message) })
        }
        options.onProgress?.(i + 1, requests.length)
    }
    return { pages, failures }
}

// ---------------------------------------------------------------------------
// 落盘
// ---------------------------------------------------------------------------

export interface SaveOutcome {
    success: boolean
    path?: string
    error?: string
    /** true = 走的是浏览器 `<a download>` 回退（界面上必须说明） */
    fallback?: boolean
}

/**
 * 保存通道的**窄接口**（不从 `vite-env.d.ts` 上读）。
 *
 * 那个文件被多个 agent 同时追加过，声明被覆盖掉一次（本页的 `poster` 块整段消失）。
 * 类型声明可以丢，功能不能丢：这里自带形状 + 运行时 `typeof` 判断，
 * 无论声明在不在，都能编译、都能正确回退。
 * （`vite-env.d.ts` 里仍保留同一份声明，供渲染层别处与 lead 接线时对照。）
 */
type PosterSaveBridge = {
    saveImage: (payload: { dataUrl: string; fileName: string; directory?: string }) => Promise<{
        success: boolean
        path?: string
        error?: string
    }>
}

function posterBridge(): { saveImage?: PosterSaveBridge['saveImage'] } {
    const api = typeof window === 'undefined' ? undefined : window.electronAPI
    return (api as unknown as { poster?: PosterSaveBridge } | undefined)?.poster ?? {}
}

/**
 * 保存一张 PNG。
 *
 * 两条路，**都在界面上如实标注**：
 * - `poster:saveImage`（引擎写入用户选定的目录，返回真实路径）；
 * - 通道缺失时用 `<a download>`：这是真的下载（Chromium 会写进下载目录），
 *   但**路径由浏览器决定**，所以回执里没有 path，界面也不许编一个。
 */
export async function saveImage(payload: { dataUrl: string; fileName: string; directory?: string }): Promise<SaveOutcome> {
    const channel = posterBridge().saveImage
    if (typeof channel === 'function') {
        try {
            const result = await channel(payload)
            if (result?.success) return { success: true, path: result.path }
            return { success: false, error: result?.error || '引擎未能写入文件' }
        } catch (e) {
            return { success: false, error: String(e) }
        }
    }
    return downloadFallback(payload.dataUrl, payload.fileName)
}

/** `<a download>` —— 真实的浏览器下载（不是"假装保存"）。 */
export function downloadFallback(dataUrl: string, fileName: string): SaveOutcome {
    try {
        const a = document.createElement('a')
        a.href = dataUrl
        a.download = fileName
        a.rel = 'noopener'
        a.style.display = 'none'
        document.body.appendChild(a)
        a.click()
        window.setTimeout(() => a.remove(), 0)
        return { success: true, fallback: true }
    } catch (e) {
        return { success: false, error: String(e) }
    }
}

/** 这个运行时到底有没有引擎侧的保存通道（界面据此显示"回退中"的提示）。 */
export function hasNativeSave(): boolean {
    return typeof posterBridge().saveImage === 'function'
}

// ---------------------------------------------------------------------------
// 剪贴板
// ---------------------------------------------------------------------------

export function dataUrlToBlob(dataUrl: string): Blob | null {
    try {
        const [head, body] = dataUrl.split(',')
        const mime = /:(.*?);/.exec(head)?.[1] ?? 'image/png'
        if (head.includes(';base64')) {
            const binary = atob(body)
            const bytes = new Uint8Array(binary.length)
            for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
            return new Blob([bytes], { type: mime })
        }
        return new Blob([decodeURIComponent(body)], { type: mime })
    } catch {
        return null
    }
}

/**
 * 复制到剪贴板。
 *
 * 走的是标准的异步剪贴板 API（`utils/clipboard.ts` 只支持文本，图片需要
 * `ClipboardItem`）。**只有真的写进去才返回成功** —— 非聚焦窗口、旧渲染上下文、
 * 缺少 `ClipboardItem` 都会走失败分支，界面如实说"复制失败，请用保存图片"。
 */
export async function copyImageToClipboard(dataUrl: string): Promise<{ success: boolean; error?: string }> {
    const ClipboardItemCtor = (window as unknown as { ClipboardItem?: typeof ClipboardItem }).ClipboardItem
    if (!ClipboardItemCtor || !navigator.clipboard?.write) {
        return { success: false, error: '当前环境不支持写入图片剪贴板' }
    }
    const blob = dataUrlToBlob(dataUrl)
    if (!blob) return { success: false, error: '图片数据读取失败' }
    try {
        await navigator.clipboard.write([new ClipboardItemCtor({ [blob.type || 'image/png']: blob })])
        return { success: true }
    } catch (e) {
        return { success: false, error: String(e) }
    }
}

// ---------------------------------------------------------------------------
// 一整套导出：估算分页 → 实测高度 → 重排 → 抓取
// ---------------------------------------------------------------------------

export interface PosterExportInput {
    /** **离屏**容器（`position: fixed; left: -20000px`，宽度 1080） */
    host: HTMLElement
    items: PosterItem[]
    options: PosterOptions
    extras?: { summary?: PosterSummaryStats; sessionName?: string }
    ctx: PosterRenderContext
    scale?: number
    onStage?: (stage: string, done: number, total: number) => void
}

export interface PosterExportResult {
    pages: CaptureResult[]
    failures: CaptureFailure[]
    /** 最终页数（实测高度之后的） */
    pageCount: number
    /** 实测总像素高（单页或多页之和） */
    totalHeight: number
    masked: number
    /** 分页是否因为实测高度与估算不同而变了（界面上可以如实说一句） */
    repaginated: boolean
    elapsedMs: number
    /**
     * 需要用户知道的限制（例如 2× 之后超出了 canvas 的安全边长）。
     * 界面上**必须显示**，不能吞掉 —— 超限时不同 GPU/驱动会给出不同结果
     * （有的直接给一张被裁掉的图），那是"看起来导出成功但其实缺了半页"。
     */
    warnings: string[]
}

/**
 * canvas 安全边界的判据（**实测标定**，不是抄来的数字）。
 *
 * 本机夹具（Chromium headless，`scripts/poster-capture-fixture.mjs`）在 1080px 宽 /
 * 2× 下抓出过 `2160 × 23944` 与 `2160 × 23758` 的 canvas 并成功编码 PNG
 * （分别 5.2MB），所以"16000px 就该警告"是**过度保守**的：那样连默认的
 * 12000px 分页上限（2× → 24000px）都会每次弹警告，警告就没用了。
 *
 * 真实约束是两条（Chromium 的 canvas 上限：单边 65535，总面积 268435456 px）：
 * - 单边 > 32767（保守取值：部分 GPU/驱动路径的实际上限低于规范值）；
 * - 总面积 > 2.5 亿 px。
 * 两条都按**实测页高 × 缩放**判断。
 */
export const SAFE_CANVAS_EDGE = 32767
export const SAFE_CANVAS_AREA = 250_000_000

/**
 * 导出全套。
 *
 * 顺序不能变：**先按估算分页画一遍 → 读回真实高度 → 用真实高度重新分页 →
 * 再画一遍 → 才抓取**。理由写在 `posterLayout` 顶部：估算偏了最多多切一页，
 * 但如果不回填实测高度就去抓，"块比预算高"的内容会被画到页面之外（导出的图
 * 底部被裁掉，而预览里看不出来）。
 */
export async function capturePoster(input: PosterExportInput): Promise<PosterExportResult> {
    const startedAt = performance.now()
    const scale = input.scale ?? DEFAULT_EXPORT_SCALE
    const repeatHeader = input.options.template === 'long'

    const blocks = buildPosterBlocks(input.items, input.options, input.extras)
    let pages = paginateBlocks(blocks, input.options, { repeatHeader })
    input.onStage?.('layout', 0, pages.length)
    const first = renderPosterPages(input.host, pages, input.ctx)

    const measured: PosterBlock[] = blocks.map((block) => {
        const height = first.heights.get(block.key)
        return height && height > 0 ? { ...block, height } : block
    })
    const remeasured = paginateBlocks(measured, input.options, { repeatHeader })
    const repaginated = remeasured.length !== pages.length || remeasured.some((page, i) => page.blocks.length !== pages[i]?.blocks.length)
    let masked = first.masked

    if (repaginated) {
        pages = remeasured
        input.onStage?.('relayout', 0, pages.length)
        masked = renderPosterPages(input.host, pages, input.ctx).masked
    } else {
        pages = remeasured
    }

    const nodes = posterPageNodes(input.host)
    const at = new Date()
    const requests = nodes.map((node, index) => ({
        node,
        name: suggestFileName(input.options, at, nodes.length > 1 ? index : undefined),
    }))

    /** 超限预警：按**实测**页高 × 缩放算，而不是按用户设的上限算。 */
    const warnings: string[] = []
    for (const page of pages) {
        const scaledHeight = Math.round(page.height * scale)
        const scaledWidth = Math.round(POSTER_WIDTH * scale)
        const area = scaledHeight * scaledWidth
        if (scaledHeight > SAFE_CANVAS_EDGE || area > SAFE_CANVAS_AREA) {
            warnings.push(
                `第 ${page.index + 1} 页在 ${scale}× 下是 ${scaledWidth}×${scaledHeight}（${(area / 1_000_000).toFixed(0)} Mpx），超过 canvas 安全边界（单边 ${SAFE_CANVAS_EDGE}px / 面积 ${SAFE_CANVAS_AREA / 1_000_000}Mpx）：部分显卡驱动会给出被裁掉底部的图。把「分页上限」调小（建议 ≤ ${Math.floor(SAFE_CANVAS_EDGE / scale)}）或把导出倍率降到 1× 再试。`
            )
        }
    }

    const { pages: shots, failures } = await capturePages(requests, {
        scale,
        onProgress: (done, total) => input.onStage?.('capture', done, total),
    })

    return {
        pages: shots,
        failures,
        pageCount: pages.length,
        totalHeight: pages.reduce((sum, page) => sum + page.height, 0),
        masked,
        repaginated,
        elapsedMs: Math.round(performance.now() - startedAt),
        warnings,
    }
}

// ---------------------------------------------------------------------------
// 二维码检测（尽力而为，且如实报告能力）
// ---------------------------------------------------------------------------

export interface QrDetectionResult {
    supported: boolean
    boxes: Array<{ x: number; y: number; w: number; h: number }>
    error?: string
}

interface BarcodeDetectorLike {
    detect: (source: CanvasImageSource) => Promise<Array<{ boundingBox: { x: number; y: number; width: number; height: number }; rawValue?: string }>>
}

function barcodeDetectorCtor(): (new (options: { formats: string[] }) => BarcodeDetectorLike) | null {
    const ctor = (window as unknown as { BarcodeDetector?: new (options: { formats: string[] }) => BarcodeDetectorLike }).BarcodeDetector
    return typeof ctor === 'function' ? ctor : null
}

/**
 * 检测图片里的二维码 / 条形码。
 *
 * 用平台的 `BarcodeDetector`（Chromium 在部分平台提供）。**没有它就说没有** ——
 * 界面会明确提示"本机没有条码识别能力，二维码遮挡请手动框选"，而不是让用户以为
 * 已经自动挡住了。返回的框是相对图片的归一化矩形，直接能当 `maskBox` 用。
 */
export async function detectQrBoxes(imageSrc: string): Promise<QrDetectionResult> {
    const Ctor = barcodeDetectorCtor()
    if (!Ctor) return { supported: false, boxes: [], error: 'BarcodeDetector 不可用' }
    try {
        const supported = await (Ctor as unknown as { getSupportedFormats?: () => Promise<string[]> }).getSupportedFormats?.()
        if (Array.isArray(supported) && !supported.includes('qr_code')) {
            return { supported: false, boxes: [], error: `条码格式不可用：${supported.join(',') || '无'}` }
        }
        const image = new Image()
        image.crossOrigin = 'anonymous'
        image.src = imageSrc
        await image.decode()
        const detector = new Ctor({ formats: ['qr_code'] })
        const found = await detector.detect(image)
        const boxes = found.map((item) => ({
            x: item.boundingBox.x / image.naturalWidth,
            y: item.boundingBox.y / image.naturalHeight,
            w: item.boundingBox.width / image.naturalWidth,
            h: item.boundingBox.height / image.naturalHeight,
        }))
        return { supported: true, boxes }
    } catch (e) {
        return { supported: false, boxes: [], error: String(e) }
    }
}
