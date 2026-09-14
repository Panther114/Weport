import { useEffect } from 'react'
import type { LiquidGlassBackdropImage } from '../components/LiquidGlass'

/**
 * 通知卡片的"无级自适应反色"：对比度驱动，替代旧的亮度阈值二值反色。
 *
 * 每次采样：
 * 1. 取整卡/标题行/正文三个区域的背景均值色与明暗分位数。采样来源二选一：
 *    - Chromium 桌面视频流（跨平台回退管线）：48×16 缩略图 drawImage 采样
 *    - 原生玻璃面板（Windows）：原生层重绘的同一帧从模糊纹理回读并推送
 *      （notification:luma 事件，上限 ~60Hz，桌面静止时不推送）
 * 2. 按液态玻璃的实际加工链（saturate 140% → 纱层 alpha 合成）推算玻璃内的真实背景色，
 *    保证判定依据与用户看到的像素一致（裸桌面色与玻璃内呈现色可能差一个档位）
 * 3. 材质先补偿：纱层方向优先贴合桌面明暗（浅底白纱、深底黑纱，滞回防抖），
 *    仅当贴合方向即使最大补偿也无法达标而反方向可行时才反转；
 *    纱层浓度取"宽松锚点文字色恰好达标"的最小 alpha——中间调背景下玻璃自动变浊换取可读性
 * 4. 文字后升级：在"宽松锚点（设计稿层级灰阶）↔ 极端锚点（近黑/纯白）"之间连续插值，
 *    取达到目标对比度的最浅一档；背景充裕时保持原色，不足时无级加深/提亮
 * 5. 光晕兜底：按最不利分位数背景的对比度缺口连续调节 text-shadow 强度，
 *    覆盖同一区域内明暗混杂、均值失真的场景
 *
 * 结果写入 <html> 内联的 --noti-* 变量，由 NotificationToast.scss 消费
 */

type RGB = readonly [number, number, number]

interface TextAnchor {
    /** 对比度充裕时使用的设计稿原色（保留视觉层级） */
    relaxed: RGB
    /** 对比度不足时插值逼近的极端色 */
    strong: RGB
}

export interface BandSample {
    mean: RGB
    /** 区域内 luma 的 p15 / p85（gamma 域 0-255），用于评估明暗混杂时的最不利背景 */
    darkTail: number
    lightTail: number
}

const SAMPLE_W = 48
const SAMPLE_H = 16
/**
 * 相邻两次采样的最小间隔。
 *
 * `readBand` 里有一次 `ctx.getImageData()` —— 那是把像素从 GPU 读回 CPU 的**同步**
 * 操作，会把渲染线程卡住。之前 33ms（≈30Hz）意味着每秒 30 次同步回读；对一个
 * 只用来决定"文字用什么颜色"的采样来说完全没必要，而且正是弹窗"发飘/跟不上"
 * 的一部分原因。降到 ~10Hz：文字颜色的变化本来就该是缓的，背景变化时也看不
 * 出这 70ms 的差别，但主线程压力只有原来的 1/3。
 */
const MIN_SAMPLE_GAP_MS = 100
/** 兜底轮询间隔：桌面静止（视频不出帧）但通知自身布局变化时仍能刷新 */
const FALLBACK_INTERVAL_MS = 500
/** 与 NotificationToast 传给 LiquidGlass 的 saturation=175 保持一致 */
const GLASS_SATURATION = 1.75
/** WCAG AA 小字号文本的目标对比度 */
const TARGET_CONTRAST = 4.5
/**
 * 整卡纱层单独要负责的对比度预算。
 *
 * 刻意远低于 4.5：纱层只要把观感定调（浅底白纱 / 深底黑纱）就够了，真正的
 * 可读性由「文字色 + 文字后方 scrim + 光晕」负责。若让纱层独自扛 4.5，求解器
 * 会一路顶到上限，卡片又变回磨砂塑料 —— 这正是之前 0.42~0.58 的由来。
 */
const VEIL_CONTRAST_BUDGET = 2.0
/** 极性切换所需的对比度优势（滞回），避免临界背景来回翻转 */
const POLARITY_MARGIN = 0.5
/** 小幅波动的指数平滑系数（0~1，越大跟随越快） */
const EMA_FACTOR = 0.6
/** 均值 luma 突变超过此值视为场景切换：跳过平滑直接采用新值 */
const SNAP_LUMA_DELTA = 24
/** 采样区域向外扩张：文字边缘的背景同样影响可读性 */
const RECT_BLEED = 4

const WHITE_VEIL: RGB = [255, 255, 255]
const DARK_VEIL: RGB = [22, 20, 18]
/**
 * 玻璃纱层 alpha 求解范围（下限 → 上限）。
 *
 * 这是整张卡片"有多透"的唯一旋钮。旧值 `[0.42, 0.58]`（深色 `[0.5, 0.65]`）
 * 实际上是**磨砂塑料**：卡背被压到半透明以上，桌面在玻璃里几乎看不见，用户
 * 反馈的"不够透明"就是这里。液态玻璃的观感来自「几乎不压暗的背景 + 只在文字
 * 后面薄薄一层纱」，所以下限压到 0.06/0.10。
 *
 * 可读性**不靠**提高这里的下限，而是靠 `--noti-*-scrim`（文字后方局部纱层，
 * 见 NotificationToast.scss）+ 文字色/光晕。把整卡压暗来换对比度是最省事但
 * 最毁观感的做法 —— 那等于把玻璃换成毛玻璃。
 */
const WHITE_VEIL_ALPHA: readonly [number, number] = [0.06, 0.24]
const DARK_VEIL_ALPHA: readonly [number, number] = [0.1, 0.3]

/**
 * 标题与正文共用同一组主文字锚点：灰色正文在蓝色等彩色背景上即使对比度达标，
 * 主观上也显得发虚，层级改由字重区分（标题 600 / 正文 400）。
 * 分区采样仍使两者随各自区域背景独立求解
 */
const PRIMARY_TEXT: { dark: TextAnchor; light: TextAnchor } = {
    dark: { relaxed: [44, 44, 44], strong: [10, 10, 10] },
    light: { relaxed: [240, 238, 233], strong: [255, 255, 255] }
}

/** 文字锚点：dark = 深色文字（浅背景用），light = 浅色文字（深背景用） */
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

// —— 颜色数学（输入输出均为 sRGB 0-255）——

const clamp01 = (v: number) => Math.min(1, Math.max(0, v))
const clamp255 = (v: number) => Math.min(255, Math.max(0, v))
const lerp = (a: number, b: number, t: number) => a + (b - a) * t
const lerpRgb = (a: RGB, b: RGB, t: number): RGB => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)]
const gammaLuma = (c: RGB) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]

const channelLinear = (v: number) => {
    const s = v / 255
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
}
/** WCAG 相对亮度（线性光域，区别于阈值判定用的 gamma luma） */
const relativeLuminance = (c: RGB) =>
    0.2126 * channelLinear(c[0]) + 0.7152 * channelLinear(c[1]) + 0.0722 * channelLinear(c[2])
/** WCAG 对比度（1~21） */
const contrastRatio = (a: RGB, b: RGB) => {
    const la = relativeLuminance(a)
    const lb = relativeLuminance(b)
    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}
/** 近似 CSS saturate()：以 luma 为轴拉伸色度 */
const saturateRgb = (c: RGB, s: number): RGB => {
    const l = gammaLuma(c)
    return [clamp255(l + (c[0] - l) * s), clamp255(l + (c[1] - l) * s), clamp255(l + (c[2] - l) * s)]
}
/** 纱层色以 alpha 覆盖在背景上的合成结果 */
const compositeVeil = (veil: RGB, alpha: number, bg: RGB): RGB => [
    lerp(bg[0], veil[0], alpha),
    lerp(bg[1], veil[1], alpha),
    lerp(bg[2], veil[2], alpha)
]
/** 保持色相整体缩放亮度：从均值色推算最不利分位数处的背景色 */
const scaleRgb = (c: RGB, factor: number): RGB => [clamp255(c[0] * factor), clamp255(c[1] * factor), clamp255(c[2] * factor)]
const cssRgb = (c: RGB) => `rgb(${Math.round(c[0])}, ${Math.round(c[1])}, ${Math.round(c[2])})`
const cssRgba = (c: RGB, alpha: number) =>
    `rgba(${Math.round(c[0])}, ${Math.round(c[1])}, ${Math.round(c[2])}, ${alpha.toFixed(2)})`

// —— 单调量二分求解 ——

/** 在宽松↔极端锚点间找达到目标对比度的最小插值系数 t（对比度随 t 单调上升） */
function solveTextTone(anchor: TextAnchor, bg: RGB, target: number): { color: RGB; t: number } {
    if (contrastRatio(anchor.relaxed, bg) >= target) return { color: anchor.relaxed, t: 0 }
    if (contrastRatio(anchor.strong, bg) < target) return { color: anchor.strong, t: 1 }
    let lo = 0
    let hi = 1
    for (let i = 0; i < 7; i++) {
        const mid = (lo + hi) / 2
        if (contrastRatio(lerpRgb(anchor.relaxed, anchor.strong, mid), bg) >= target) hi = mid
        else lo = mid
    }
    return { color: lerpRgb(anchor.relaxed, anchor.strong, hi), t: hi }
}

/** 找使宽松锚点文字色达标的最小纱层 alpha（对比度随 alpha 单调上升）；不可达时取上限，由文字升级接棒 */
function solveVeilAlpha(
    veil: RGB,
    range: readonly [number, number],
    bg: RGB,
    relaxedText: RGB,
    target: number
): number {
    const [min, max] = range
    if (contrastRatio(relaxedText, compositeVeil(veil, min, bg)) >= target) return min
    if (contrastRatio(relaxedText, compositeVeil(veil, max, bg)) < target) return max
    let lo = min
    let hi = max
    for (let i = 0; i < 7; i++) {
        const mid = (lo + hi) / 2
        if (contrastRatio(relaxedText, compositeVeil(veil, mid, bg)) >= target) hi = mid
        else lo = mid
    }
    return hi
}

interface BandTone {
    polarity: 'dark' | 'light'
    color: RGB
    /** 宽松→极端锚点的插值进度，供同区域次级文字（时间等）联动取色 */
    t: number
    /** 最不利分位数背景下的对比度缺口（0~1），驱动光晕强度 */
    deficit: number
    /** 纱层合成后的本区域背景色，供 scrim 求解 */
    glassBg: RGB
    /** 最不利分位数处的背景色（已含纱层），scrim 就按它求解 */
    adverseBg: RGB
}

/** 沿 offsetParent 链累计布局坐标：不受出入场 transform 影响，采样区域始终对准卡片落点 */
export function getLayoutRect(el: HTMLElement): { left: number; top: number; width: number; height: number } {
    let left = 0
    let top = 0
    let node: HTMLElement | null = el
    while (node) {
        left += node.offsetLeft
        top += node.offsetTop
        node = node.offsetParent as HTMLElement | null
    }
    return { left, top, width: el.offsetWidth, height: el.offsetHeight }
}

/**
 * 自适应反色引擎：吃三个区域的原始背景统计，产出 --noti-* CSS 变量。
 * 平滑（EMA/突变跳变）、极性滞回等状态都在引擎内维护，与采样来源无关
 */
export function createAdaptiveThemeEngine() {
    const ema: Partial<Record<'card' | 'title' | 'body', BandSample>> = {}
    const textPolarity: Partial<Record<'title' | 'body', 'dark' | 'light'>> = {}
    let veilPolarity: 'white' | 'dark' | null = null
    const appliedVars: Record<string, string> = {}

    const setVar = (name: string, value: string) => {
        if (appliedVars[name] === value) return
        appliedVars[name] = value
        document.documentElement.style.setProperty(name, value)
    }

    /** 自适应平滑：场景切换（luma 突变）立即跳变保证响应速度，小幅波动才指数平滑抑噪 */
    const smooth = (key: 'card' | 'title' | 'body', raw: BandSample | null): BandSample | null => {
        if (!raw) return ema[key] ?? null
        const prev = ema[key]
        const next: BandSample = prev && Math.abs(gammaLuma(raw.mean) - gammaLuma(prev.mean)) <= SNAP_LUMA_DELTA
            ? {
                mean: lerpRgb(prev.mean, raw.mean, EMA_FACTOR),
                darkTail: lerp(prev.darkTail, raw.darkTail, EMA_FACTOR),
                lightTail: lerp(prev.lightTail, raw.lightTail, EMA_FACTOR)
            }
            : raw
        ema[key] = next
        return next
    }

    /**
     * 材质方向 + 纱层浓度。方向优先贴合桌面明暗（亮底白纱、暗底黑纱），
     * 亮度滞回沿用旧算法验证过的 102/118 阈值；若贴合方向即使最大补偿也达不到
     * 目标对比度而反方向可以，才反转方向（不用"两族取优"：黑纱补偿上限更高，
     * 会在双方都可达标的中间调上抢走本应保持浅色观感的场景）。
     * 浓度取"宽松锚点文字色恰好达标"的最小 alpha
     */
    const resolveVeil = (cardMean: RGB): { color: RGB; alpha: number } => {
        const bg = saturateRgb(cardMean, GLASS_SATURATION)
        const luma = gammaLuma(bg)
        let next: 'white' | 'dark'
        if (veilPolarity === 'white') next = luma < 102 ? 'dark' : 'white'
        else if (veilPolarity === 'dark') next = luma > 118 ? 'white' : 'dark'
        else next = luma >= 110 ? 'white' : 'dark'

        const bestWithWhite = contrastRatio(ANCHORS.body.dark.strong, compositeVeil(WHITE_VEIL, WHITE_VEIL_ALPHA[1], bg))
        const bestWithDark = contrastRatio(ANCHORS.body.light.strong, compositeVeil(DARK_VEIL, DARK_VEIL_ALPHA[1], bg))
        // 极性切换仍按"能不能真正读清"（4.5）判断，只有浓度求解用低预算
        if (next === 'white' && bestWithWhite < TARGET_CONTRAST && bestWithDark > bestWithWhite + POLARITY_MARGIN) next = 'dark'
        if (next === 'dark' && bestWithDark < TARGET_CONTRAST && bestWithWhite > bestWithDark + POLARITY_MARGIN) next = 'white'
        veilPolarity = next
        return next === 'white'
            ? { color: WHITE_VEIL, alpha: solveVeilAlpha(WHITE_VEIL, WHITE_VEIL_ALPHA, bg, ANCHORS.body.dark.relaxed, VEIL_CONTRAST_BUDGET) }
            : { color: DARK_VEIL, alpha: solveVeilAlpha(DARK_VEIL, DARK_VEIL_ALPHA, bg, ANCHORS.body.light.relaxed, VEIL_CONTRAST_BUDGET) }
    }

    const resolveBand = (key: 'title' | 'body', sample: BandSample, veil: { color: RGB; alpha: number }): BandTone => {
        const glassBg = compositeVeil(veil.color, veil.alpha, saturateRgb(sample.mean, GLASS_SATURATION))
        const anchors = ANCHORS[key]
        const bestDark = contrastRatio(anchors.dark.strong, glassBg)
        const bestLight = contrastRatio(anchors.light.strong, glassBg)
        const current = textPolarity[key]
        let next: 'dark' | 'light' = current ?? (bestDark >= bestLight ? 'dark' : 'light')
        if (current === 'dark' && bestLight > bestDark + POLARITY_MARGIN) next = 'light'
        if (current === 'light' && bestDark > bestLight + POLARITY_MARGIN) next = 'dark'
        textPolarity[key] = next

        const tone = solveTextTone(anchors[next], glassBg, TARGET_CONTRAST)

        // 深色文字最怕暗斑、浅色文字最怕亮斑：按不利分位数亮度缩放均值色近似最不利背景
        const meanLuma = Math.max(1, gammaLuma(sample.mean))
        const adverseLuma = next === 'dark' ? sample.darkTail : sample.lightTail
        const adverseBg = compositeVeil(
            veil.color,
            veil.alpha,
            saturateRgb(scaleRgb(sample.mean, adverseLuma / meanLuma), GLASS_SATURATION)
        )
        const deficit = clamp01((TARGET_CONTRAST - contrastRatio(tone.color, adverseBg)) / TARGET_CONTRAST)
        return { polarity: next, color: tone.color, t: tone.t, deficit, glassBg, adverseBg }
    }

    /** 反向微光晕：深字配白晕、浅字配黑影，强度随对比度缺口无级增强 */
    const haloFor = (tone: BandTone) =>
        tone.polarity === 'dark'
            ? `0 0 2px rgba(255, 255, 255, ${(0.35 + 0.55 * tone.deficit).toFixed(2)})`
            : `0 1px 3px rgba(0, 0, 0, ${(0.4 + 0.4 * tone.deficit).toFixed(2)})`

    /**
     * 文字后方的可读性纱层（scrim）：与文字极性相反方向的一层局部底色。
     *
     * 这是把整卡纱层压薄的**前提**。整卡保持几乎透明（液态玻璃观感），可读性
     * 集中到文字这一小块 —— 先用文字色尽可能达标，不够的缺口由 scrim 的 alpha
     * 精确补上（对最不利分位数背景求解）。这样 scrim 只在真正需要时才变浓，
     * 而不是给所有卡片糊一层厚底。
     */
    const scrimFor = (tone: BandTone): { alpha: number; css: string } => {
        const base = tone.polarity === 'dark' ? WHITE_VEIL : DARK_VEIL
        const bg = tone.adverseBg
        if (contrastRatio(tone.color, bg) >= TARGET_CONTRAST) {
            // 已经达标：仍留一层极淡的 scrim，让文字在背景快速变化时不闪烁
            const floor = tone.polarity === 'dark' ? 0.06 : 0.1
            return { alpha: floor, css: cssRgba(base, floor) }
        }
        let lo = 0
        let hi = 1
        for (let i = 0; i < 7; i++) {
            const mid = (lo + hi) / 2
            if (contrastRatio(tone.color, compositeVeil(base, mid, bg)) >= TARGET_CONTRAST) hi = mid
            else lo = mid
        }
        const alpha = Math.min(0.72, hi * 1.05) // 5% 余量抵消采样噪声
        return { alpha, css: cssRgba(base, alpha) }
    }

    return {
        /** 输入三区域原始统计（title/body 缺省时退回整卡），刷新全部 --noti-* 变量 */
        apply(raw: { card: BandSample | null; title?: BandSample | null; body?: BandSample | null }) {
            const cardSample = smooth('card', raw.card)
            if (!cardSample) return

            const veil = resolveVeil(cardSample.mean)
            setVar('--noti-tint', cssRgba(veil.color, veil.alpha))
            setVar('--noti-shadow', veil.color === WHITE_VEIL ? SHADOW_ON_LIGHT : SHADOW_ON_DARK)

            const titleSample = smooth('title', raw.title ?? null) ?? cardSample
            const bodySample = smooth('body', raw.body ?? null) ?? cardSample

            const title = resolveBand('title', titleSample, veil)
            const titleScrim = scrimFor(title)
            setVar('--noti-title-color', cssRgb(title.color))
            setVar('--noti-title-halo', haloFor(title))
            setVar('--noti-title-scrim', titleScrim.css)
            const tertiaryAnchor = ANCHORS.tertiary[title.polarity]
            setVar('--noti-title-tertiary', cssRgb(lerpRgb(tertiaryAnchor.relaxed, tertiaryAnchor.strong, title.t)))
            setVar('--noti-close-hover-bg', title.polarity === 'dark' ? 'rgba(0, 0, 0, 0.1)' : 'rgba(255, 255, 255, 0.14)')

            const body = resolveBand('body', bodySample, veil)
            const bodyScrim = scrimFor(body)
            setVar('--noti-body-color', cssRgb(body.color))
            setVar('--noti-body-halo', haloFor(body))
            setVar('--noti-body-scrim', bodyScrim.css)

            // 文字块在 DOM 上是一个容器（标题 + 正文共用一层纱），所以取两者中
            // 更浓的那份：宁可多补一点，也不要让正文落在没有底的像素上；正文
            // 字号更小、更难读，本来就该是更保守的那一侧。
            const mask = bodyScrim.alpha >= titleScrim.alpha ? bodyScrim : titleScrim
            // 纱层颜色跟随正文的极性（跨到标题通常只有几像素，不值得再分两层）
            const scrimBase = body.polarity === 'dark' ? WHITE_VEIL : DARK_VEIL
            setVar('--noti-text-scrim', cssRgba(scrimBase, mask.alpha))
            // 渐变起点：加浓 18% 补偿沿宽度的线性衰减（上限仍受 scrim 的 0.72 约束）
            setVar('--noti-text-scrim-strong', cssRgba(scrimBase, Math.min(0.78, mask.alpha * 1.18)))
        }
    }
}

/**
 * 自适应主题采样：优先实时桌面视频流（跨平台回退管线），
 * 无流时退化为对主进程下发的静态桌面快照做一次性采样。
 * 采样节奏：视频每出新帧即采样（33ms 节流，~30Hz）+ 250ms 兜底轮询；
 * 静态快照模式在加载完成后采样数次（覆盖布局落定），之后零开销。
 */
export function useNotificationAdaptiveTheme(
    stream: MediaStream | null,
    backdrop: LiquidGlassBackdropImage | undefined
) {
    useEffect(() => {
        if (!backdrop) return
        if (!stream && !backdrop.dataUrl) return

        const canvas = document.createElement('canvas')
        canvas.width = SAMPLE_W
        canvas.height = SAMPLE_H
        const ctx = canvas.getContext('2d', { willReadFrequently: true })
        const engine = createAdaptiveThemeEngine()
        let disposed = false

        /** 当前采样源（视频元素或快照图片） */
        let sourceEl: CanvasImageSource | null = null
        let sourceW = 0
        let sourceH = 0

        /** 窗口内 CSS 矩形 → 采样源像素区域的均值色与明暗分位数（按比例映射） */
        const readBand = (left: number, top: number, width: number, height: number): BandSample | null => {
            if (!ctx || !sourceEl || width < 1 || height < 1) return null
            const ratioX = sourceW / backdrop.width
            const ratioY = sourceH / backdrop.height
            try {
                ctx.drawImage(
                    sourceEl,
                    (backdrop.screenX + left) * ratioX,
                    (backdrop.screenY + top) * ratioY,
                    Math.max(1, width * ratioX),
                    Math.max(1, height * ratioY),
                    0, 0, SAMPLE_W, SAMPLE_H
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

        const readRect = (rect: { left: number; top: number; width: number; height: number }) =>
            readBand(rect.left - RECT_BLEED, rect.top - RECT_BLEED, rect.width + RECT_BLEED * 2, rect.height + RECT_BLEED * 2)

        const sampleAll = () => {
            if (!sourceEl) return
            const host: ParentNode = document.getElementById('notification-current') ?? document
            const glassEl = host.querySelector<HTMLElement>('.liquid-glass')
            const headerEl = host.querySelector<HTMLElement>('.notification-header')
            const bodyEl = host.querySelector<HTMLElement>('.notification-body')
            engine.apply({
                card: readRect(
                    glassEl ? getLayoutRect(glassEl) : { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight }
                ),
                title: headerEl ? readRect(getLayoutRect(headerEl)) : null,
                body: bodyEl ? readRect(getLayoutRect(bodyEl)) : null
            })
        }

        let cleanup: (() => void) | null = null

        if (stream) {
            // 实时流路径：事件驱动采样（视频每出新帧立即响应，节流 33ms），
            // 桌面静止时零采样开销；兜底轮询覆盖布局变化
            const video = document.createElement('video')
            video.muted = true
            video.srcObject = stream
            sourceEl = video
            let lastSampleAt = 0
            let frameHandle = 0
            const onFrame = () => {
                if (disposed) return
                if (video.videoWidth) {
                    sourceW = video.videoWidth
                    sourceH = video.videoHeight
                }
                const now = performance.now()
                if (now - lastSampleAt >= MIN_SAMPLE_GAP_MS) {
                    lastSampleAt = now
                    sampleAll()
                }
                frameHandle = video.requestVideoFrameCallback(onFrame)
            }
            frameHandle = video.requestVideoFrameCallback(onFrame)
            const fallbackTimer = setInterval(sampleAll, FALLBACK_INTERVAL_MS)
            video.play().catch(() => { /* 采样失败保持当前材质 */ })
            cleanup = () => {
                clearInterval(fallbackTimer)
                video.cancelVideoFrameCallback(frameHandle)
                video.srcObject = null
            }
        } else if (backdrop.dataUrl) {
            // 静态快照路径：加载完成后采样数次（首帧布局可能未完成），零常驻开销
            const img = new Image()
            img.onload = () => {
                if (disposed) return
                sourceEl = img
                sourceW = img.naturalWidth || backdrop.width
                sourceH = img.naturalHeight || backdrop.height
                sampleAll()
                let n = 0
                const timer = setInterval(() => {
                    if (disposed) {
                        clearInterval(timer)
                        return
                    }
                    sampleAll()
                    n += 1
                    if (n >= 4) clearInterval(timer)
                }, 200)
            }
            img.src = backdrop.dataUrl
            cleanup = () => { /* img 由 GC 回收 */ }
        }

        return () => {
            disposed = true
            cleanup?.()
        }
    }, [stream, backdrop])
}

/** 原生玻璃面板的亮度带 id 约定（与主进程 notification:glassRect 的 bands 对应） */
export const NATIVE_BAND_IDS = { card: 0, title: 1, body: 2 } as const

/**
 * 原生采样路径（Windows 原生玻璃）：面板在原生层重绘的同一帧从玻璃模糊纹理
 * 回读三区域统计，经主进程以 notification:luma 事件转发（上限 ~60Hz，
 * 桌面静止时不推送），反色判定与玻璃画面帧级同步
 */
export function useNotificationNativeAdaptiveTheme(enabled: boolean) {
    useEffect(() => {
        if (!enabled || !window.electronAPI?.notification?.onLuma) return
        const engine = createAdaptiveThemeEngine()
        const toSample = (s?: { r: number; g: number; b: number; darkTail: number; lightTail: number }): BandSample | null =>
            s ? { mean: [s.r, s.g, s.b], darkTail: s.darkTail, lightTail: s.lightTail } : null
        return window.electronAPI.notification.onLuma(bands => {
            engine.apply({
                card: toSample(bands[String(NATIVE_BAND_IDS.card)]),
                title: toSample(bands[String(NATIVE_BAND_IDS.title)]),
                body: toSample(bands[String(NATIVE_BAND_IDS.body)])
            })
        })
    }, [enabled])
}
