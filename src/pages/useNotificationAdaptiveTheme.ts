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
/**
 * 卡片与背景至少要差多少亮度（0-255）才算"看得见这张卡片"。
 *
 * 只有对比度预算是不够的：背景越暗，白字的对比度越宽裕，纱层就越薄，薄到 7% 时
 * 卡片与近黑背景糊成一片。
 *
 * 但**不能靠加浓度来解决** —— 用户要的是"玻璃几乎全透明"，一块实色面板同样不是
 * 玻璃。所以这个下限刻意压得很小（12 ≈ 屏幕亮度的 4.7%，只够让面板"若隐若现"），
 * 卡片真正被看见靠的是**边缘**：一圈 1px 的内描边 + 阴影（见 SHADOW_ON_*），
 * 那是"玻璃的边界"，而不是"玻璃的填充"。
 */
const MIN_CARD_DELTA_LUMA = 12
/**
 * 为了让卡片显形，浓度允许越过"薄纱"上界的倍数。
 *
 * 中灰背景（亮度 ~128）是个死角：深色纱层薄了压不出差、白了又提不出差，而"薄纱"
 * 区间（白 0.16 / 深 0.2）在那一档最多只能给出约 21 的亮度差 —— 差得不多但确实
 * 不够。与其把整个区间调厚（那会把最常见的情况一起变厚，回到"塑料卡片"），不如
 * 只在**这一条要求**上放宽 30%：常规情况仍落在原区间（求解会给出很小的 alpha），
 * 只有死角才吃到 0.26。
 */
const VEIL_VISIBILITY_STRETCH = 1.3

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

/**
 * 卡片边界（1px 内描边 + 阴影）。
 *
 * 这是"玻璃"能被看见的主要来源：填充几乎是全透明的，如果连边界都没有，一块 5%
 * 的纱层压在深色界面上就跟没有卡片一样（用户报的"弹窗背景全黑"就是这个观感）。
 * 描边颜色按**文字极性**取，与填充方向一致 —— 白字配白边、黑字配黑边，方向反了
 * 会在玻璃里画出一圈脏线。
 */
const CARD_ON_DARK_BACKDROP = 'inset 0 0 0 1px rgba(255, 255, 255, 0.18), 0 6px 18px rgba(0, 0, 0, 0.45)'
const CARD_ON_LIGHT_BACKDROP = 'inset 0 0 0 1px rgba(0, 0, 0, 0.12), 0 6px 18px rgba(0, 0, 0, 0.22)'

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
    /**
     * 方向不对就别硬顶到上界。
     *
     * 纱层是**朝文字反方向**推的：白纱配深色文字、深纱配浅色文字。当调用方拿反了
     * （例如"白纱 + 深色文字"压在纯黑背景上），加浓度只会让对比度越来越差 —— 此时
     * 二分永远不会命中，老实现会落到 `range[1]`，等于"把填充顶到最厚来满足一条根本
     * 满足不了的预算"。这正是填充被顶到 0.16/0.2 的原因之一。
     */
    const atFloor = contrastRatio(anchorColor, compositeVeil(veil, range[0], bg))
    const atCeil = contrastRatio(anchorColor, compositeVeil(veil, range[1], bg))
    if (atCeil < target && atCeil <= atFloor) return range[0]
    let lo = 0
    let hi = 1
    for (let i = 0; i < 8; i++) {
        const mid = (lo + hi) / 2
        if (contrastRatio(anchorColor, compositeVeil(veil, mid, bg)) >= target) hi = mid
        else lo = mid
    }
    return Math.min(range[1], Math.max(range[0], lo))
}

/**
 * 求解让**卡片看得出来**的纱层 alpha。
 *
 * 纱层原本只按"文字对比度预算"求解，结果是在深色背景上永远落在区间下界
 * （实测 `rgba(22,20,18,0.07)`）—— 一张 7% 的近黑卡片压在近黑的应用界面上，观感
 * 就是**一块纯黑**（用户报的"通知背景全黑"）。对比度达标并不等于卡片可见：压在
 * 深色底上的深色卡片既压不下去、也提不起来，只剩下"没有卡片"。
 *
 * 这里按"合成后的卡片亮度与背景至少差 targetDelta"反解 alpha，在给定区间内取值。
 * 返回该极性在这条要求下能做到的最优解（可能仍然不够，由调用方在两极之间选）。
 */
function solveVeilAlphaForDelta(
    veil: RGB,
    range: readonly [number, number],
    bg: RGB,
    targetDelta: number
): number {
    const bgLuma = gammaLuma(bg)
    const deltaAt = (alpha: number) => Math.abs(gammaLuma(compositeVeil(veil, alpha, bg)) - bgLuma)
    if (deltaAt(range[0]) >= targetDelta) return range[0]
    if (deltaAt(range[1]) <= targetDelta) return range[1]
    let lo = range[0]
    let hi = range[1]
    for (let i = 0; i < 10; i++) {
        const mid = (lo + hi) / 2
        if (deltaAt(mid) >= targetDelta) hi = mid
        else lo = mid
    }
    return hi
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
 *
 * `opts.textPolarity` 一旦给出，文字极性就**固定**成它，不再由背景采样决定
 * （见 resolveBand 里的说明）。纱层（--noti-tint）与光晕仍然自适应。
 */
export function resolveNotificationTheme(
    raw: {
        card: BandSample | null
        title?: BandSample | null
        body?: BandSample | null
    },
    opts?: { textPolarity?: 'dark' | 'light' }
): ResolvedTheme | null {
    const fixedTextPolarity = opts?.textPolarity
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
    let veil =
        veilPolarity === 'white'
            ? {
                  color: WHITE_VEIL,
                  alpha: solveVeilAlpha(WHITE_VEIL, WHITE_VEIL_ALPHA, cardBg, ANCHORS.body.dark.relaxed, VEIL_CONTRAST_BUDGET)
              }
            : {
                  color: DARK_VEIL,
                  alpha: solveVeilAlpha(DARK_VEIL, DARK_VEIL_ALPHA, cardBg, ANCHORS.body.light.relaxed, VEIL_CONTRAST_BUDGET)
              }

    /**
     * 可见性下限：卡片必须与背景**看得出差别**。
     *
     * 对比度预算只管"文字读不读得清"，不管"卡片在不在"。深色背景上选深色纱层时，
     * 两者会分道扬镳：文字已经够白了（对比度早就超过预算），于是纱层停在下界
     * 0.07，卡片与背景糊成一块 —— 用户看到的"通知背景全黑"就是这个。
     *
     * 规则：当前极性能靠加浓度达到 `MIN_CARD_DELTA_LUMA` 就加浓度；做不到（近黑背景
     * 上继续加深只会更黑）就换相反极性 —— 白色纱层在近黑背景上是唯一能"提亮一点点、
     * 让面板显形"的方向。取更能显形的那一个，浓度上限仍然很克制（白 0.16 / 深 0.2，
     * 远不到当年那种"塑料卡片"的 0.42-0.58）。
     */
    const deltaOf = (candidate: { color: RGB; alpha: number }) =>
        Math.abs(gammaLuma(compositeVeil(candidate.color, candidate.alpha, cardBg)) - gammaLuma(cardBg))
    const resolveVisible = (polarity: 'white' | 'dark', opts?: { contrastBudget?: boolean }) => {
        const color = polarity === 'white' ? WHITE_VEIL : DARK_VEIL
        const range = polarity === 'white' ? WHITE_VEIL_ALPHA : DARK_VEIL_ALPHA
        const anchor = polarity === 'white' ? ANCHORS.body.dark.relaxed : ANCHORS.body.light.relaxed
        const stretched: readonly [number, number] = [range[0], range[1] * VEIL_VISIBILITY_STRETCH]
        const forVisible = solveVeilAlphaForDelta(color, stretched, cardBg, MIN_CARD_DELTA_LUMA)
        /**
         * 翻转极性时**只看可见性**，不再叠加对比度预算。
         *
         * 因为翻转本身就是为了"让卡片显形"：如果同时让对比度预算参与取大值，它会按
         * 另一套文字锚点把浓度一路顶上去（实测中灰背景上被顶到 0.145，卡片直接变成
         * 浅色板 + 深色字 —— 与"玻璃近乎全透明"正好相反）。文字色会随后按**合成后的
         * 卡片**重新求解，所以不叠加预算也不会牺牲可读性。
         */
        const alpha = opts?.contrastBudget === false
            ? forVisible
            : Math.max(solveVeilAlpha(color, range, cardBg, anchor, VEIL_CONTRAST_BUDGET), forVisible)
        return { color, alpha }
    }
    if (deltaOf(veil) < MIN_CARD_DELTA_LUMA) {
        // 先在同一极性内加浓度；加不动（背景与纱层同向，越加越糊）才换极性
        const same = resolveVisible(veilPolarity)
        const flipped = resolveVisible(veilPolarity === 'white' ? 'dark' : 'white', { contrastBudget: false })
        const best = deltaOf(same) >= deltaOf(flipped) ? same : flipped
        if (deltaOf(best) > deltaOf(veil)) veil = best
    }

    /* ---- 单块区域的文字色 + scrim ---- */
    const resolveBand = (key: 'title' | 'body', sample: BandSample): { tone: BandTone; scrim: { alpha: number; css: string } } => {
        const glassBg = compositeVeil(veil.color, veil.alpha, saturateRgb(sample.mean, GLASS_SATURATION))
        const anchors = ANCHORS[key]
        const bestDark = contrastRatio(anchors.dark.strong, glassBg)
        const bestLight = contrastRatio(anchors.light.strong, glassBg)
        /**
         * 文字极性：**默认由用户的玻璃填充色固定，不再跟着背景采样摆动**。
         *
         * 用户反馈"弹窗文字有时候是白的，确保它不要自动调整"。原来的写法是拿
         * 采样均值合成出的 glassBg 去比 bestDark / bestLight —— 但屏幕上那张卡片
         * 并不是 glassBg：它还要叠一层用户填充、一层桌面捕获、一层模糊。于是常见
         * 的结果是"卡片实际渲染成浅色板，文字却被判成白字"，同一条通知在不同壁纸
         * 上颜色还会跳。
         *
         * 判据换成"用户填的是什么颜色的玻璃"：白玻璃配深字、深玻璃配浅字。
         * 同一条通知在任何壁纸上的文字色都一样，也就不会再"有时候是白的"。
         * 用户显式指定文字色时走 --glass-text-color，与本分支无关。
         */
        const polarity: 'dark' | 'light' = fixedTextPolarity ?? (bestDark >= bestLight ? 'dark' : 'light')
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

    /**
     * 光晕**恒定双极性**：亮核 + 暗边，极性只决定哪一层更强。
     *
     * 因为玻璃是完全透明的（卡片填充 ≤0.1），文字背后没有实色可以垫 —— 可读性只能由
     * 文字自己承担。单极性光晕有个致命前提：极性判断必须对。而采样是有可能错的/过期的
     * （实测：弹窗复用时沿用了上一条通知的采样，深色背景下仍是深色字），那时单极性光晕
     * 一点忙都帮不上，屏幕上就是"黑底黑字"。
     *
     * 两层同时加以后，极性判断错了也只是"更难看一点"，不会变成读不出来。
     */
    const haloFor = (tone: BandTone) =>
        tone.polarity === 'dark'
            ? `0 0 2px rgba(255, 255, 255, ${(0.35 + 0.55 * tone.deficit).toFixed(2)}), 0 1px 3px rgba(0, 0, 0, 0.55)`
            : `0 1px 3px rgba(0, 0, 0, ${(0.4 + 0.4 * tone.deficit).toFixed(2)}), 0 0 2px rgba(255, 255, 255, 0.45)`

    const tertiaryAnchor = ANCHORS.tertiary[title.tone.polarity]

    /* ---- 文字块不再有独立 scrim ----
     * 这里原本解一层"文字背后的实色底"（--noti-text-scrim，取标题/正文里更浓的那份）。
     * 用户明确要求：填充要么铺满整张卡片，要么不存在，**永远不能只在文字后面**加底。
     * 现在可读性由「整卡填充 + 文字自身的双极性光晕」承担，因此这层解算连同它的
     * 变量一起删掉了 —— 顺带也去掉了自适应里最贵的一条属性（每次采样都要重绘）。 */

    const vars: Record<string, string> = {
        '--noti-tint': cssRgba(veil.color, veil.alpha),
        '--noti-shadow': veil.color === WHITE_VEIL ? CARD_ON_DARK_BACKDROP : CARD_ON_LIGHT_BACKDROP,
        '--noti-title-color': cssRgb(title.tone.color),
        '--noti-title-halo': haloFor(title.tone),
        '--noti-title-tertiary': cssRgb(lerpRgb(tertiaryAnchor.relaxed, tertiaryAnchor.strong, title.tone.t)),
        '--noti-close-hover-bg': title.tone.polarity === 'dark' ? 'rgba(0, 0, 0, 0.1)' : 'rgba(255, 255, 255, 0.14)',
        '--noti-body-color': cssRgb(body.tone.color),
        '--noti-body-halo': haloFor(body.tone)
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
         * @param opts     textPolarity：固定文字极性（来自用户的玻璃填充色）。
         *                 进指纹 —— 否则用户改了填充色时指纹不变，会被短路掉。
         * @returns 是否真的写了 DOM
         */
        settle(
            raw: { card: BandSample | null; title?: BandSample | null; body?: BandSample | null },
            layout: CardLayoutRect[],
            dpr: number,
            opts?: { textPolarity?: 'dark' | 'light' }
        ): boolean {
            const fingerprint = `${layoutFingerprint(layout, dpr)}|txt:${opts?.textPolarity ?? 'auto'}`
            if (fingerprint === lastLayout && lastResolved) return false
            const resolved = resolveNotificationTheme(raw, opts)
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
export function useNotificationNativeAdaptiveTheme(
    enabled: boolean,
    layout: () => CardLayoutRect[],
    /** 固定文字极性（来自用户的玻璃填充色）。见 resolveNotificationTheme 的说明。 */
    textPolarity?: 'dark' | 'light'
) {
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
                window.devicePixelRatio || 1,
                { textPolarity }
            )
        })
    }, [enabled, layout, textPolarity])
}

/**
 * 把"卡片所在的矩形"挪到弹窗**外面**去采样。
 *
 * 为什么必须挪：桌面抓帧抓的是**整屏**，而弹窗自己就在屏幕上 —— 抓到的帧里
 * 卡片那一片是**弹窗自己**。拿它去解主题就成了自指：卡片亮 → 采样到亮 → 选深色文字
 * → 卡片继续保持亮……第一次采到什么颜色就锁死在什么颜色上（实测把背景从亮换成暗、
 * 甚至关掉弹窗重新弹，主题依然停在最初那一次；导出的抓帧图里能直接看到卡片那一块被
 * 自己画了出来）。
 *
 * 弹窗是**完全透明**的，所以它周围那片桌面与它底下那片基本是同一个背景，用它来决定
 * 文字极性既准确又不会自指。窗口左右都放不下时退回窗口下方，再不行就用原位（宁可
 * 偶尔不准，也不能越界导致读不出任何像素）。
 */
function offsetSampleOutsideWindow(
    rect: CardLayoutRect,
    backdrop: { width: number; height: number; screenX: number; screenY: number; winW?: number; winH?: number }
): CardLayoutRect {
    const winW = Number(backdrop.winW) || 0
    const winH = Number(backdrop.winH) || 0
    if (!winW || !winH) return rect
    const gap = 12
    const screenRight = backdrop.screenX + winW
    // 右侧放得下就放右边：弹窗默认贴在右上角，右边通常是屏外，所以先试左边
    if (backdrop.screenX - gap - rect.width >= 0) {
        return { ...rect, left: -gap - rect.width }
    }
    if (screenRight + gap + rect.width <= backdrop.width) {
        return { ...rect, left: winW + gap }
    }
    if (backdrop.screenY + winH + gap + rect.height <= backdrop.height) {
        return { ...rect, top: winH + gap }
    }
    if (backdrop.screenY - gap - rect.height >= 0) {
        return { ...rect, top: -gap - rect.height }
    }
    return rect
}

/**
 * 定帧回退路径：加载完成后采样一次（等两拍让布局落定），然后彻底停下。
 *
 * 回退路径的背板本身只有 ~1.5Hz（`desktopCapturer.getSources` 的耗时由枚举决定，
 * 与缩放无关），跟着它做"自适应"只会让文字色一顿一顿地变。取一次就够。
 */
export function useNotificationSnapshotTheme(
    backdrop: { width: number; height: number; screenX: number; screenY: number; winW?: number; winH?: number; dataUrl?: string | null } | undefined,
    layout: () => CardLayoutRect[],
    /** 固定文字极性（来自用户的玻璃填充色）。见 resolveNotificationTheme 的说明。 */
    textPolarity?: 'dark' | 'light'
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
            const read = (r: CardLayoutRect) => {
                const sample = offsetSampleOutsideWindow(r, backdrop)
                return readBandFromImage(ctx, img, sourceW, sourceH, backdrop, sample.left, sample.top, sample.width, sample.height)
            }
            const rects = layout()
            const raw = {
                card: rects[0] ? read(rects[0]) : null,
                title: rects[1] ? read(rects[1]) : null,
                body: rects[2] ? read(rects[2]) : null
            }
            resolver.settle(raw, rects.map((r) => ({ ...r })), window.devicePixelRatio || 1, { textPolarity })
        }
        img.src = backdrop.dataUrl
        return () => {
            disposed = true
            img.onload = null
        }
    }, [backdrop, layout, textPolarity])
}
