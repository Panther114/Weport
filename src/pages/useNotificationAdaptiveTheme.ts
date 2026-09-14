/**
 * 通知弹窗的文字色 / 玻璃材质解析器（v1.0 **一次成型**版本）。
 *
 * ## 为什么从"逐帧自适应"改成"一次成型"
 *
 * 旧实现是一条持续运行的管线：桌面每出一帧 → 采样三块区域 → 求纱层浓度与文字
 * 色 → 写十几个 CSS 变量。它有两个无法回避的问题：
 *
 * 1. **每写一个变量都会让整窗重算样式。** 实测（.ui-probe/measure-var-writes.mjs）
 *    在定帧回退路径下稳定 6 次/秒；原生面板空闲时 0 次/秒、桌面一动就往上走。
 *    通知卡片只有 344px 宽、显示 3 秒，为它跑一条持续管线不值。
 * 2. **观感上"不跟手"。** 采样率被玻璃帧率绑住（回退路径实测 1.5Hz），文字色跟着
 *    一顿一顿地变，比"定好就不动"更显廉价。
 *
 * 现在的模型：**取一次样，把所有变量一次算定，然后完全静止。** 只有在卡片几何
 * 发生实质变化（窗口移动 / DPI 变化）或首次拿到可用样本时才重算 —— 一次通知
 * 生命周期里通常只算 1 次。
 *
 * ## 可读性靠什么保证
 *
 * 整卡纱层（`--noti-tint`）+ 文字自身颜色/光晕 + 文字后一层**实色** scrim。
 * 三者都由"最不利分位数背景"求解，而不是由均值 —— 均值的卡片在明暗交界处必然
 * 出现半行看不清。
 *
 * 原来的 scrim 是沿宽度衰减的渐变，会在玻璃上留下一条可见的浅色方块（用户报的
 * "文字后面有奇怪的白边"）。现在是一块贴合文字块的实色圆角底：边界由圆角承担，
 * 不需要渐变去藏，也不会出现色带。
 */

import { useEffect, useRef } from 'react'

const clamp255 = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : v)
const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v)

export type RGB = [number, number, number]
export interface BandSample {
    mean: RGB
    darkTail: number
    lightTail: number
}

/** 与 NotificationToast 传给 LiquidGlass 的 saturation=175 保持一致 */
const GLASS_SATURATION = 1.75
/** WCAG AA 小字号文本的目标对比度 */
const TARGET_CONTRAST = 4.5
/** 小幅波动的指数平滑系数（只在几何重算时用，不再逐帧） */
const EMA_FACTOR = 1

const WHITE_VEIL: RGB = [255, 255, 255]
const DARK_VEIL: RGB = [22, 20, 18]
/**
 * 玻璃纱层 alpha 求解范围（下限 → 上限）。
 *
 * 这是整张卡片"有多透"的唯一旋钮。旧值 `[0.42, 0.58]` 实际上是磨砂塑料。
 * 液态玻璃的观感来自「几乎不压暗的背景 + 只在文字后面薄薄一层底」。
 */
const WHITE_VEIL_ALPHA: readonly [number, number] = [0.04, 0.16]
const DARK_VEIL_ALPHA: readonly [number, number] = [0.07, 0.2]
/**
 * 纱层单独要负责的对比度预算。刻意远低于 4.5：纱层只要把观感定调就够了，
 * 真正的可读性由「文字色 + 文字后方 scrim + 光晕」负责。
 */
const VEIL_CONTRAST_BUDGET = 2.0

const PRIMARY_TEXT: { dark: TextAnchor; light: TextAnchor } = {
    dark: { relaxed: [44, 44, 44], strong: [10, 10, 10] },
    light: { relaxed: [240, 238, 233], strong: [255, 255, 255] }
}
interface TextAnchor {
    relaxed: RGB
    strong: RGB
}
const ANCHORS: Record<'title' | 'body' | 'tertiary', { dark: TextAnchor; light: TextAnchor }> = {
    title: PRIMARY_TEXT,
    body: PRIMARY_TEXT,
    tertiary: {
        dark: { relaxed: [122, 122, 122], strong: [61, 61, 61] },
        light: { relaxed: [176, 172, 166], strong: [216, 213, 207] }
    }
}

const SHADOW_ON_LIGHT = '0 0 0 1px rgba(0, 0, 0, 0.04), 0 4px 12px rgba(0, 0, 0, 0.22)'
const SHADOW_ON_DARK = '0 0 0 1px rgba(255, 255, 255, 0.06), 0 4px 12px rgba(0, 0, 0, 0.4)'

const lerp = (a: number, b: number, t: number) => a + (b - a) * t
const lerpRgb = (a: RGB, b: RGB, t: number): RGB => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)]
const gammaLuma = (c: RGB) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]

const channelLinear = (v: number) => {
    const s = v / 255
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
}
const relativeLuminance = (c: RGB) =>
    0.2126 * channelLinear(c[0]) + 0.7152 * channelLinear(c[1]) + 0.0722 * channelLinear(c[2])
const contrastRatio = (a: RGB, b: RGB) => {
    const la = relativeLuminance(a)
    const lb = relativeLuminance(b)
    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}

const saturateRgb = (c: RGB, s: number): RGB => {
    const lum = gammaLuma(c)
    return [clamp255(lum + (c[0] - lum) * s), clamp255(lum + (c[1] - lum) * s), clamp255(lum + (c[2] - lum) * s)]
}
const compositeVeil = (veil: RGB, alpha: number, bg: RGB): RGB => [
    veil[0] * alpha + bg[0] * (1 - alpha),
    veil[1] * alpha + bg[1] * (1 - alpha),
    veil[2] * alpha + bg[2] * (1 - alpha)
]
const scaleRgb = (c: RGB, factor: number): RGB => [clamp255(c[0] * factor), clamp255(c[1] * factor), clamp255(c[2] * factor)]
const cssRgb = (c: RGB) => `rgb(${Math.round(c[0])}, ${Math.round(c[1])}, ${Math.round(c[2])})`
const cssRgba = (c: RGB, alpha: number) =>
    `rgba(${Math.round(c[0])}, ${Math.round(c[1])}, ${Math.round(c[2])}, ${Number(alpha.toFixed(3))})`

/** 在锚点色之间求解一个恰好达到目标对比度的文字色 */
function solveTextTone(anchor: TextAnchor, bg: RGB, target: number): { color: RGB; t: number } {
    const strong = anchor.strong
    if (contrastRatio(strong, bg) >= target) return { color: strong, t: 1 }
    const relaxed = anchor.relaxed
    if (contrastRatio(relaxed, bg) <= target) return { color: relaxed, t: 0 }
    let lo = 0
    let hi = 1
    for (let i = 0; i < 8; i++) {
        const mid = (lo + hi) / 2
        if (contrastRatio(lerpRgb(relaxed, strong, mid), bg) >= target) hi = mid
        else lo = mid
    }
    return { color: lerpRgb(relaxed, strong, hi), t: hi }
}

/** 求解让文字恰好达标的纱层 alpha */
function solveVeilAlpha(
    veil: RGB,
    range: readonly [number, number],
    bg: RGB,
    anchorColor: RGB,
    target: number
): number {
    if (contrastRatio(anchorColor, bg) >= target) return range[0]
    let lo = 0
    let hi = 1
    for (let i = 0; i < 8; i++) {
        const mid = (lo + hi) / 2
        if (contrastRatio(anchorColor, compositeVeil(veil, mid, bg)) >= target) hi = mid
        else lo = mid
    }
    return Math.min(range[1], Math.max(range[0], lo))
}

export interface BandTone {
    polarity: 'dark' | 'light'
    color: RGB
    t: number
    deficit: number
    glassBg: RGB
    adverseBg: RGB
}

/**
 * 解析一次采样的结果。所有输出都是**字符串常量**，可以直接写进 CSS 变量；
 * 相同输入必然产生相同输出，因此调用方可以用哈希短路。
 */
export interface ResolvedTheme {
    vars: Record<string, string>
    /** 用于短路重算的指纹 */
    hash: string
}

/**
 * 把三块区域的采样一次性解析成完整的 --noti-* 变量集。
 *
 * 纯函数：不读写 DOM，方便单独测「给定背景 → 文字色是否达标」。
 */
export function resolveNotificationTheme(raw: {
    card: BandSample | null
    title?: BandSample | null
    body?: BandSample | null
}): ResolvedTheme | null {
    if (!raw.card) return null
    const cardSample = raw.card

    /* ---- 整卡纱层方向与浓度 ---- */
    const cardBg = saturateRgb(cardSample.mean, GLASS_SATURATION)
    const luma = gammaLuma(cardBg)
    let veilPolarity: 'white' | 'dark' = luma >= 110 ? 'white' : 'dark'
    const bestWithWhite = contrastRatio(ANCHORS.body.dark.strong, compositeVeil(WHITE_VEIL, WHITE_VEIL_ALPHA[1], cardBg))
    const bestWithDark = contrastRatio(ANCHORS.body.light.strong, compositeVeil(DARK_VEIL, DARK_VEIL_ALPHA[1], cardBg))
    if (veilPolarity === 'white' && bestWithWhite < TARGET_CONTRAST && bestWithDark > bestWithWhite + 0.5) {
        veilPolarity = 'dark'
    }
    if (veilPolarity === 'dark' && bestWithDark < TARGET_CONTRAST && bestWithWhite > bestWithDark + 0.5) {
        veilPolarity = 'white'
    }
    const veil =
        veilPolarity === 'white'
            ? {
                  color: WHITE_VEIL,
                  alpha: solveVeilAlpha(WHITE_VEIL, WHITE_VEIL_ALPHA, cardBg, ANCHORS.body.dark.relaxed, VEIL_CONTRAST_BUDGET)
              }
            : {
                  color: DARK_VEIL,
                  alpha: solveVeilAlpha(DARK_VEIL, DARK_VEIL_ALPHA, cardBg, ANCHORS.body.light.relaxed, VEIL_CONTRAST_BUDGET)
              }

    /* ---- 单块区域的文字色 + scrim ---- */
    const resolveBand = (key: 'title' | 'body', sample: BandSample): { tone: BandTone; scrim: { alpha: number; css: string } } => {
        const glassBg = compositeVeil(veil.color, veil.alpha, saturateRgb(sample.mean, GLASS_SATURATION))
        const anchors = ANCHORS[key]
        const bestDark = contrastRatio(anchors.dark.strong, glassBg)
        const bestLight = contrastRatio(anchors.light.strong, glassBg)
        const polarity: 'dark' | 'light' = bestDark >= bestLight ? 'dark' : 'light'
        const tone = solveTextTone(anchors[polarity], glassBg, TARGET_CONTRAST)

        // 深色文字最怕暗斑、浅色文字最怕亮斑：按不利分位数亮度缩放均值色近似最不利背景
        const meanLuma = Math.max(1, gammaLuma(sample.mean))
        const adverseLuma = polarity === 'dark' ? sample.darkTail : sample.lightTail
        const adverseBg = compositeVeil(
            veil.color,
            veil.alpha,
            saturateRgb(scaleRgb(sample.mean, adverseLuma / meanLuma), GLASS_SATURATION)
        )
        const deficit = clamp01((TARGET_CONTRAST - contrastRatio(tone.color, adverseBg)) / TARGET_CONTRAST)

        // scrim：与文字极性相反方向的一层实色底，只在真正需要时才出现
        const base = polarity === 'dark' ? WHITE_VEIL : DARK_VEIL
        let alpha = 0
        if (contrastRatio(tone.color, adverseBg) < TARGET_CONTRAST) {
            const floor = polarity === 'dark' ? 0.06 : 0.1
            let lo = 0
            let hi = 1
            for (let i = 0; i < 7; i++) {
                const mid = (lo + hi) / 2
                if (contrastRatio(tone.color, compositeVeil(base, mid, adverseBg)) >= TARGET_CONTRAST) hi = mid
                else lo = mid
            }
            alpha = Math.max(floor, Math.min(0.72, hi * 1.05))
        }
        return {
            tone: { polarity, color: tone.color, t: tone.t, deficit, glassBg, adverseBg },
            scrim: { alpha, css: alpha > 0 ? cssRgba(base, alpha) : 'transparent' }
        }
    }

    const titleSample = raw.title ?? cardSample
    const bodySample = raw.body ?? cardSample
    const title = resolveBand('title', titleSample)
    const body = resolveBand('body', bodySample)

    const haloFor = (tone: BandTone) =>
        tone.polarity === 'dark'
            ? `0 0 2px rgba(255, 255, 255, ${(0.35 + 0.55 * tone.deficit).toFixed(2)})`
            : `0 1px 3px rgba(0, 0, 0, ${(0.4 + 0.4 * tone.deficit).toFixed(2)})`

    const tertiaryAnchor = ANCHORS.tertiary[title.tone.polarity]

    /* ---- 文字块共用一层 scrim：取标题/正文里更浓的那份 ---- */
    const mask = body.scrim.alpha >= title.scrim.alpha ? body.scrim : title.scrim
    const scrimBase = body.tone.polarity === 'dark' ? WHITE_VEIL : DARK_VEIL

    const vars: Record<string, string> = {
        '--noti-tint': cssRgba(veil.color, veil.alpha),
        '--noti-shadow': veil.color === WHITE_VEIL ? SHADOW_ON_LIGHT : SHADOW_ON_DARK,
        '--noti-title-color': cssRgb(title.tone.color),
        '--noti-title-halo': haloFor(title.tone),
        '--noti-title-tertiary': cssRgb(lerpRgb(tertiaryAnchor.relaxed, tertiaryAnchor.strong, title.tone.t)),
        '--noti-close-hover-bg': title.tone.polarity === 'dark' ? 'rgba(0, 0, 0, 0.1)' : 'rgba(255, 255, 255, 0.14)',
        '--noti-body-color': cssRgb(body.tone.color),
        '--noti-body-halo': haloFor(body.tone),
        // 单层实色 scrim（不再是渐变）：边界由圆角承担，玻璃上不会出现浅色方块
        '--noti-text-scrim': mask.alpha > 0 ? cssRgba(scrimBase, mask.alpha) : 'transparent'
    }

    // 指纹只认**实际输出**：同样的变量集不重复写 DOM
    const hash = Object.entries(vars)
        .map(([k, v]) => `${k}:${v}`)
        .join('|')
    return { vars, hash }
}

/**
 * 把解析结果写进 <html>。
 *
 * 全部变量一次写入，并用上一次的指纹短路相同的集合 —— 这是"一次成型"能保持
 * 便宜的原因：几何不变时后续调用完全不碰 DOM。
 */
export function applyNotificationTheme(resolved: ResolvedTheme): void {
    const root = document.documentElement
    if (root.dataset.notiThemeHash === resolved.hash) return
    root.dataset.notiThemeHash = resolved.hash
    for (const [name, value] of Object.entries(resolved.vars)) {
        if (root.style.getPropertyValue(name) === value) continue
        root.style.setProperty(name, value)
    }
}

/** 通知窗口内卡片的布局矩形（窗口局部 CSS 像素） */
export interface CardLayoutRect {
    left: number
    top: number
    width: number
    height: number
}

/**
 * 元素相对窗口的布局矩形（窗口局部 CSS 像素）。
 *
 * 不能用 `getBoundingClientRect()`：它给的是相对视口的坐标，而原生面板需要的是
 * 相对窗口原点的位置。沿 `offsetParent` 链累加 `offsetLeft/offsetTop` 才对应
 * 主进程 `getPosition()` 的原点。
 */
export function getLayoutRect(el: HTMLElement): CardLayoutRect {
    let x = 0
    let y = 0
    let node: HTMLElement | null = el
    while (node) {
        x += node.offsetLeft
        y += node.offsetTop
        node = node.offsetParent as HTMLElement | null
    }
    return { left: x, top: y, width: el.offsetWidth, height: el.offsetHeight }
}

/** 计算卡片几何指纹：只有它变了才值得重算（窗口移动 / DPI 变化） */
export function layoutFingerprint(rects: CardLayoutRect[], dpr: number): string {
    return `${dpr.toFixed(2)}|${rects.map((r) => `${r.left.toFixed(1)},${r.top.toFixed(1)},${r.width.toFixed(1)},${r.height.toFixed(1)}`).join(';')}`
}

/**
 * 一次性采样：拿当前背板（原生 luma 或快照图）算一次，写一次，然后静止。
 *
 * 调用方只需在「拿到首批样本」或「几何指纹变化」时触发；不要放进 rAF 或
 * 逐帧回调 —— 那正是要摆脱的东西。
 */
export function createOneShotThemeResolver() {
    let lastLayout = ''
    let lastResolved: ResolvedTheme | null = null

    return {
        /** 布局变化时重置指纹，迫使下一次 settle 重新解析 */
        invalidateLayout() {
            lastLayout = ''
        },
        /**
         * @param raw      当前采样
         * @param layout   卡片几何（用于指纹）
         * @param dpr      设备像素比
         * @returns 是否真的写了 DOM
         */
        settle(raw: { card: BandSample | null; title?: BandSample | null; body?: BandSample | null }, layout: CardLayoutRect[], dpr: number): boolean {
            const fingerprint = layoutFingerprint(layout, dpr)
            if (fingerprint === lastLayout && lastResolved) return false
            const resolved = resolveNotificationTheme(raw)
            if (!resolved) return false
            lastLayout = fingerprint
            lastResolved = resolved
            applyNotificationTheme(resolved)
            return true
        }
    }
}

/** 采样画布尺寸：只用来算三块区域的统计量，不需要分辨率 */
export const SAMPLE_W = 48
export const SAMPLE_H = 16

/**
 * 从一张背板图里读出一块区域的统计量。
 *
 * 只在"一次性采样"里被调用若干次（原生 luma 可用时甚至完全不调用），因此这里
 * 的 `getImageData` 同步回读不再是热点。
 */
export function readBandFromImage(
    ctx: CanvasRenderingContext2D,
    source: CanvasImageSource,
    sourceW: number,
    sourceH: number,
    backdrop: { width: number; height: number; screenX: number; screenY: number },
    left: number,
    top: number,
    width: number,
    height: number
): BandSample | null {
    if (width < 1 || height < 1) return null
    const ratioX = sourceW / backdrop.width
    const ratioY = sourceH / backdrop.height
    try {
        ctx.drawImage(
            source,
            (backdrop.screenX + left) * ratioX,
            (backdrop.screenY + top) * ratioY,
            Math.max(1, width * ratioX),
            Math.max(1, height * ratioY),
            0,
            0,
            SAMPLE_W,
            SAMPLE_H
        )
        const { data } = ctx.getImageData(0, 0, SAMPLE_W, SAMPLE_H)
        let r = 0
        let g = 0
        let b = 0
        const lumas: number[] = []
        for (let i = 0; i < data.length; i += 4) {
            r += data[i]
            g += data[i + 1]
            b += data[i + 2]
            lumas.push(0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2])
        }
        const count = lumas.length
        lumas.sort((x, y) => x - y)
        return {
            mean: [r / count, g / count, b / count],
            darkTail: lumas[Math.floor(count * 0.15)],
            lightTail: lumas[Math.floor(count * 0.85)]
        }
    } catch {
        return null
    }
}

/** 原生玻璃面板的亮度带 id 约定（与主进程 notification:glassRect 的 bands 对应） */
export const NATIVE_BAND_IDS = { card: 0, title: 1, body: 2 } as const

export interface NativeBandStat {
    r: number
    g: number
    b: number
    darkTail: number
    lightTail: number
}

/**
 * 原生采样路径：**只在首批样本到达时解析一次**。
 *
 * 原生面板会持续推送 luma（桌面动就有），但这里刻意只消费开头若干个样本：
 * 够拿到稳定值即可。后续推送直接忽略 —— 那正是"逐帧改样式"的来源。
 * 采用"连续两组样本一致"作为稳定判据，避免把首帧的过渡值固化下来。
 */
export function useNotificationNativeAdaptiveTheme(enabled: boolean, layout: () => CardLayoutRect[]) {
    const resolverRef = useRef<ReturnType<typeof createOneShotThemeResolver> | null>(null)
    if (!resolverRef.current) resolverRef.current = createOneShotThemeResolver()

    useEffect(() => {
        if (!enabled || !window.electronAPI?.notification?.onLuma) return
        const resolver = resolverRef.current!
        let settledKey = ''
        let pendingKey = ''
        let samples = 0
        const MAX_SAMPLES = 12

        const toSample = (s?: NativeBandStat): BandSample | null =>
            s ? { mean: [s.r, s.g, s.b], darkTail: s.darkTail, lightTail: s.lightTail } : null

        return window.electronAPI.notification.onLuma((bands) => {
            if (samples >= MAX_SAMPLES) return
            samples += 1
            const card = toSample(bands[String(NATIVE_BAND_IDS.card)])
            if (!card) return
            const key = `${card.mean.map((v) => Math.round(v / 4)).join(',')}|${Math.round(card.darkTail / 4)}|${Math.round(card.lightTail / 4)}`
            if (key !== pendingKey) {
                pendingKey = key
                return
            }
            if (key === settledKey) return
            settledKey = key
            resolver.settle(
                {
                    card,
                    title: toSample(bands[String(NATIVE_BAND_IDS.title)]),
                    body: toSample(bands[String(NATIVE_BAND_IDS.body)])
                },
                layout(),
                window.devicePixelRatio || 1
            )
        })
    }, [enabled, layout])
}

/**
 * 定帧回退路径：加载完成后采样一次（等两拍让布局落定），然后彻底停下。
 *
 * 回退路径的背板本身只有 ~1.5Hz（`desktopCapturer.getSources` 的耗时由枚举决定，
 * 与缩放无关），跟着它做"自适应"只会让文字色一顿一顿地变。取一次就够。
 */
export function useNotificationSnapshotTheme(
    backdrop: { width: number; height: number; screenX: number; screenY: number; dataUrl?: string | null } | undefined,
    layout: () => CardLayoutRect[]
) {
    const resolverRef = useRef<ReturnType<typeof createOneShotThemeResolver> | null>(null)
    if (!resolverRef.current) resolverRef.current = createOneShotThemeResolver()

    useEffect(() => {
        if (!backdrop?.dataUrl) return
        const resolver = resolverRef.current!
        let disposed = false
        const canvas = document.createElement('canvas')
        canvas.width = SAMPLE_W
        canvas.height = SAMPLE_H
        const ctx = canvas.getContext('2d', { willReadFrequently: true })
        const img = new Image()
        img.onload = () => {
            if (disposed || !ctx) return
            const sourceW = img.naturalWidth || backdrop.width
            const sourceH = img.naturalHeight || backdrop.height
            const read = (r: CardLayoutRect) =>
                readBandFromImage(ctx, img, sourceW, sourceH, backdrop, r.left, r.top, r.width, r.height)
            const rects = layout()
            const raw = {
                card: rects[0] ? read(rects[0]) : null,
                title: rects[1] ? read(rects[1]) : null,
                body: rects[2] ? read(rects[2]) : null
            }
            resolver.settle(raw, rects, window.devicePixelRatio || 1)
        }
        img.src = backdrop.dataUrl
        return () => {
            disposed = true
            img.onload = null
        }
    }, [backdrop, layout])
}
