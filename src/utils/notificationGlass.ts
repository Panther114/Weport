/**
 * 通知玻璃的可配置项（v1.0.3）。
 *
 * 背景：弹窗玻璃此前是一组**写死的观感** —— 1.5px 的白色描边 + 0.5px 白内阴影
 * （LiquidGlass 里的 borderLayerBase 与 borderGradient 全是字面 rgba(255,255,255,·)），
 * 填充浓度由自适应引擎按背景对比度解出来，用户一处也改不了。用户的原话是
 * "玻璃不一致、不可配置、不好看"，并且明确要求：
 *
 *   - 默认**不要全透**，要有一层浅浅的玻璃底，好让深色文字有可依托的面；
 *   - 默认的那圈白边要么去掉、要么非常含蓄；
 *   - 填充、文字色、边框、圆角、模糊强度都要能调。
 *
 * 实现方式：这组配置只负责**生成 CSS 变量**，观感全部由变量驱动
 * （LiquidGlass 的描边/阴影、NotificationToast 的填充与文字色）。
 *
 * 为什么是变量而不是把值传成 props：
 *   1. 设置页需要**实时预览** —— 同一组变量挂到预览卡片的根节点上就得到同一套观感，
 *      不需要第二套渲染路径；
 *   2. 自适应引擎仍然负责"光晕"这类可读性兜底，变量只覆盖它该覆盖的那几项，
 *      用户没指定的项继续用引擎解出来的值（`var(--glass-x, var(--noti-x))`）。
 */

export interface NotificationGlass {
    /** 是否给卡片铺一层玻璃底。关掉＝完全透明（只剩文字与光晕）。 */
    fill: boolean
    /**
     * 填充形态：纯色 / 渐变。
     *
     * 渐变**只支持从左到右**（用户明确要求："it can only be from left to right"）。
     * 不做角度控件是有意的：通知卡片只有 344×114，任何非水平角度在这么扁的
     * 矩形上都会退化成"一条斜线切过去"，看起来像渲染错误而不是设计。
     */
    fillMode: FillMode
    /** 纯色填充色（#rrggbb）。默认白：白玻璃 + 深字是最稳的组合。 */
    fillColor: string
    /** 渐变起点（左）。 */
    fillGradientFrom: string
    /** 渐变终点（右）。 */
    fillGradientTo: string
    /** 填充不透明度 0-100。默认刻意很浅 —— 玻璃感来自基本不压暗背景。 */
    fillOpacity: number
    /** 文字色（#rrggbb）。空串＝按填充色极性定（默认）。 */
    textColor: string
    /** 描边宽度 px（0-3）。默认 0.5：几乎是发丝，替代原来那圈 1.5px 白边。 */
    borderWidth: number
    /** 描边色（#rrggbb）。 */
    borderColor: string
    /** 描边不透明度 0-100。默认 22 —— 看得出有边，但不抢戏。 */
    borderOpacity: number
    /** 圆角 px。 */
    radius: number
    /** 折射/模糊强度 0-100（0＝平板玻璃，100＝厚透镜）。 */
    blur: number
    /** 投影强度 0-100（0＝完全不要投影）。 */
    shadow: number
}

export type FillMode = 'solid' | 'gradient'

/**
 * 预设渐变：都是"低饱和、明度高、两端差别克制"的那一类。
 *
 * 为什么刻意不用高饱和/强对比的网红渐变：这层填充铺在**桌面截图之上**，
 * 不透明度只有 ~16%，两端差得太远会在卡片里显出一条明显的色带，而不是
 * 玻璃的光泽。除最后一个（石墨）外，这些预设的相对亮度都在 0.7 以上，文字极性因此
 * 是深色；石墨是**暗**填充，它的极性是浅色 —— 预设里刻意保留一个暗色，
 * 这样"深玻璃配浅字"这条规则在设置页里立刻能试出来。
 */
export const GRADIENT_PRESETS: ReadonlyArray<{
    id: string
    label: string
    from: string
    to: string
}> = [
    { id: 'frost', label: '霜白', from: '#ffffff', to: '#e8ecf2' },
    { id: 'dawn', label: '晨曦', from: '#fff4e6', to: '#ffd9c0' },
    { id: 'mint', label: '薄荷', from: '#e8fbf4', to: '#c9ecdf' },
    { id: 'sky', label: '晴空', from: '#eaf4ff', to: '#c9dcf7' },
    { id: 'lilac', label: '丁香', from: '#f3edff', to: '#ded0f5' },
    { id: 'rose', label: '薄暮', from: '#ffedf2', to: '#f7d2de' },
    { id: 'sand', label: '沙金', from: '#fdf6e3', to: '#efe0bd' },
    { id: 'graphite', label: '石墨', from: '#3a3d45', to: '#1c1e23' },
]

export const NOTIFICATION_GLASS_DEFAULT: NotificationGlass = {
    fill: true,
    fillMode: 'solid',
    fillColor: '#ffffff',
    fillGradientFrom: GRADIENT_PRESETS[0].from,
    fillGradientTo: GRADIENT_PRESETS[0].to,
    fillOpacity: 16,
    textColor: '',
    borderWidth: 0.5,
    borderColor: '#ffffff',
    borderOpacity: 22,
    radius: 16,
    blur: 45,
    shadow: 55,
}

export const NOTIFICATION_GLASS_KEYS = {
    fill: 'notificationGlassFill',
    fillMode: 'notificationGlassFillMode',
    fillColor: 'notificationGlassFillColor',
    fillGradientFrom: 'notificationGlassFillGradientFrom',
    fillGradientTo: 'notificationGlassFillGradientTo',
    fillOpacity: 'notificationGlassFillOpacity',
    textColor: 'notificationGlassTextColor',
    borderWidth: 'notificationGlassBorderWidth',
    borderColor: 'notificationGlassBorderColor',
    borderOpacity: 'notificationGlassBorderOpacity',
    radius: 'notificationGlassRadius',
    blur: 'notificationGlassBlur',
    shadow: 'notificationGlassShadow',
} as const satisfies Record<keyof NotificationGlass, string>

/** #rgb / #rrggbb → #rrggbb；非法返回空串。 */
export function normalizeGlassHex(value: unknown): string {
    const raw = String(value ?? '').trim()
    const match = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(raw)
    if (!match) return ''
    const hex = match[1]
    return hex.length === 6
        ? `#${hex.toLowerCase()}`
        : `#${hex.split('').map((c) => c + c).join('').toLowerCase()}`
}

/**
 * 卡片文字该用深色还是浅色 —— **由用户的玻璃填充固定，不跟随背景采样**。
 *
 * 用户反馈"弹窗文字有时候是白的，确保它不要自动调整"。之前文字极性是拿背景采样
 * 现算的，但屏幕上那张卡片并不是采样值：它还要叠一层用户填充、一层桌面捕获、
 * 一层模糊，于是经常出现"卡片实际是浅色板、文字却是白字"，而且同一条通知在不同
 * 壁纸上颜色还会跳。
 *
 * 判据改成"填的是什么颜色的玻璃"：
 *   - 没开填充（完全透明）→ 深色：卡片背后就是桌面，而文字自带双极性光晕，
 *     深字在亮桌面上可读，暗桌面上由光晕兜底；
 *   - 填充是亮色（相对亮度 ≥ 0.5）→ 深字（"白玻璃 + 深字"是设计上的默认组合）；
 *   - 填充是暗色 → 浅字。
 *
 * 用户显式指定文字色时不走这里（`--glass-text-color` 优先级更高）。
 */
export function glassTextPolarity(glass: NotificationGlass): 'dark' | 'light' {
    if (!glass.fill) return 'dark'
    // 渐变取两端中点当代表色：极性必须是一个值，否则同一张卡片的左半边和
    // 右半边会得到相反的结论（见 notificationGlassRepresentativeRgb）。
    const [r, g, b] = notificationGlassRepresentativeRgb(glass)
    const lin = (v: number) => {
        const s = v / 255
        return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
    }
    const fillLuma = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
    /**
     * 用**对比度**而不是亮度阈值来判：亮度的 0.5 分界在饱和色上会判错 ——
     * 例如 #80c0ff（很浅的天蓝）相对亮度只有 0.495，卡在阈值下方，却明显该配深字。
     * 对比度是同一件事的正确口径，也是自适应引擎自己用的判据（`bestDark >= bestLight`）。
     *
     * 两个锚点取引擎里的取值（ANCHORS.*.strong）：
     *   深字 [10,10,10] → 相对亮度 0.0033   浅字 [255,255,255] → 1
     * 交叉点因此落在填充亮度 ≈ 0.18 处，而不是 0.5。
     */
    const DARK_TEXT_LUMA = 0.0033
    const LIGHT_TEXT_LUMA = 1
    const ratio = (a: number, b: number) => {
        const [hi, lo] = a >= b ? [a, b] : [b, a]
        return (hi + 0.05) / (lo + 0.05)
    }
    return ratio(fillLuma, DARK_TEXT_LUMA) >= ratio(fillLuma, LIGHT_TEXT_LUMA) ? 'dark' : 'light'
}

function hexToRgbTriple(hex: string, fallback: string): string {
    const value = normalizeGlassHex(hex) || normalizeGlassHex(fallback) || '#ffffff'
    const n = parseInt(value.slice(1), 16)
    return `${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}`
}

const clamp = (value: unknown, min: number, max: number, fallback: number): number => {
    const n = Number(value)
    if (!Number.isFinite(n)) return fallback
    return Math.min(max, Math.max(min, n))
}

/** 把（可能来自磁盘的、任意脏的）配置整形成合法值。 */
export function normalizeNotificationGlass(raw: Partial<Record<keyof NotificationGlass, unknown>>): NotificationGlass {
    const d = NOTIFICATION_GLASS_DEFAULT
    return {
        fill: raw.fill === undefined ? d.fill : raw.fill === true || raw.fill === 'true',
        fillMode: raw.fillMode === 'gradient' ? 'gradient' : raw.fillMode === 'solid' ? 'solid' : d.fillMode,
        fillColor: normalizeGlassHex(raw.fillColor) || d.fillColor,
        fillGradientFrom: normalizeGlassHex(raw.fillGradientFrom) || d.fillGradientFrom,
        fillGradientTo: normalizeGlassHex(raw.fillGradientTo) || d.fillGradientTo,
        fillOpacity: clamp(raw.fillOpacity, 0, 100, d.fillOpacity),
        textColor: normalizeGlassHex(raw.textColor),
        borderWidth: clamp(raw.borderWidth, 0, 3, d.borderWidth),
        borderColor: normalizeGlassHex(raw.borderColor) || d.borderColor,
        borderOpacity: clamp(raw.borderOpacity, 0, 100, d.borderOpacity),
        radius: clamp(raw.radius, 0, 40, d.radius),
        blur: clamp(raw.blur, 0, 100, d.blur),
        shadow: clamp(raw.shadow, 0, 100, d.shadow),
    }
}

/**
 * 填充的 CSS 值（`--glass-fill`）。
 *
 * 存在 `--liquid-glass-tint` 里，而色调层用的是 `background:` **速记**属性
 * （LiquidGlass/index.tsx），所以渐变可以直接作为值传下去，不需要新变量、
 * 也不需要第二层元素 —— 这正好也守住了"填充只能铺满整卡、不能只在文字后面"
 * 那条规则（渐变和纯色走的是同一个层）。
 */
export function notificationGlassFillValue(glass: NotificationGlass): string {
    const alpha = glass.fill ? Math.round((glass.fillOpacity / 100) * 1000) / 1000 : 0
    if (glass.fillMode === 'gradient' && alpha > 0) {
        // 只做从左到右：90deg 在 CSS 里就是"从左到右"。
        const from = hexToRgbTriple(glass.fillGradientFrom, '#ffffff')
        const to = hexToRgbTriple(glass.fillGradientTo, '#ffffff')
        return `linear-gradient(90deg, rgba(${from}, ${alpha}), rgba(${to}, ${alpha}))`
    }
    return `rgba(${hexToRgbTriple(glass.fillColor, '#ffffff')}, ${alpha})`
}

/**
 * 填充的"代表色" —— 渐变取两端中点。
 *
 * 给两个**只接受单一颜色**的消费方用：
 *   1. 文字极性判定（`glassTextPolarity`）—— 极性必须是一个值，否则同一张卡片
 *      左半边和右半边会得到相反的结论；
 *   2. 任何需要"这层填充大概是什么颜色"的单一色消费方（原生玻璃面板的参数本身
 *      只有几何/折射，不含填充色，所以目前实际只有第 1 项在用）。
 * 需要精确渐变的地方一律走 `notificationGlassFillValue()` 的 CSS 渐变。
 */
export function notificationGlassRepresentativeRgb(glass: NotificationGlass): [number, number, number] {
    const parse = (hex: string, fallback: string): [number, number, number] => {
        const value = normalizeGlassHex(hex) || normalizeGlassHex(fallback) || '#ffffff'
        const n = parseInt(value.slice(1), 16)
        return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
    }
    if (glass.fillMode !== 'gradient') return parse(glass.fillColor, '#ffffff')
    const a = parse(glass.fillGradientFrom, '#ffffff')
    const b = parse(glass.fillGradientTo, '#ffffff')
    return [Math.round((a[0] + b[0]) / 2), Math.round((a[1] + b[1]) / 2), Math.round((a[2] + b[2]) / 2)]
}

/**
 * 配置 → CSS 变量表。
 *
 * 变量契约（LiquidGlass / NotificationToast.scss 消费）：
 *   --glass-fill            整卡填充（关闭时 transparent，**不存在"只垫文字"的第二层**）
 *   --glass-text-color      文字色；未指定时**移除**该变量，让 --noti-* 生效
 *   --glass-border-rgb      描边色（逗号分隔，供 rgba(var(--x), a) 使用）
 *   --glass-border-alpha    描边整体强度 0-1
 *   --glass-border-width    描边宽度（px 数值，CSS 侧 calc(*1px)）
 *   --glass-ring            边缘高光整体强度（替代 --liquid-glass-ring 的默认 1）
 *   --glass-shadow          卡片投影
 */
export function notificationGlassVars(glass: NotificationGlass): Record<string, string | null> {
    const borderAlpha = Math.round((glass.borderOpacity / 100) * 1000) / 1000
    const shadowAlpha = Math.round((glass.shadow / 100) * 100) / 100
    return {
        '--glass-fill': notificationGlassFillValue(glass),
        '--glass-text-color': glass.textColor || null,
        '--glass-border-rgb': hexToRgbTriple(glass.borderColor, '#ffffff'),
        '--glass-border-alpha': String(borderAlpha),
        '--glass-border-width': String(glass.borderWidth),
        '--glass-ring': String(borderAlpha),
        '--glass-radius': `${glass.radius}px`,
        '--glass-shadow':
            glass.shadow > 0
                ? `0 0 0 1px rgba(${hexToRgbTriple(glass.borderColor, '#ffffff')}, ${borderAlpha * 0.35}), 0 ${Math.round(4 + shadowAlpha * 10)}px ${Math.round(14 + shadowAlpha * 22)}px rgba(0, 0, 0, ${0.12 + shadowAlpha * 0.24})`
                : 'none',
    }
}

/** 把变量写到某个元素上（默认整页）；值为 null 表示"移除该变量，用回退值"。 */
export function applyNotificationGlassVars(
    glass: NotificationGlass,
    target?: HTMLElement | null
): void {
    const el = target || (typeof document !== 'undefined' ? document.documentElement : null)
    if (!el) return
    for (const [name, value] of Object.entries(notificationGlassVars(glass))) {
        if (value === null) el.style.removeProperty(name)
        else el.style.setProperty(name, value)
    }
}

/**
 * 文字相关的 `--noti-*` 变量 —— 由**填充色**定极性，供"不在弹窗文档里"的场合使用。
 *
 * 为什么需要它：`--noti-title-color` / `--noti-body-color` / `--noti-title-tertiary`
 * 原本只由 `applyNotificationTheme()` 写进**弹窗**的 `<html>`。设置页的预览跑在主窗口
 * 文档里，那里这三个变量从未被定义过，于是 `NotificationToast.scss` 的兜底
 * `#ffffff` 生效 —— 预览永远是白字，哪怕填充是 16% 白（正是本轮要修掉的
 * "浅色卡片 + 白字"）。用户改了填充色、下面那行提示改口说"深色字"，预览却纹丝不动，
 * 这个控件看起来就是坏的。
 *
 * 取值是引擎里 `ANCHORS` 的 **strong** 端（最大对比度），也就是弹窗在典型背景上
 * 会解到的那个值；弹窗自己仍会按实际背景在极性内部微调（44 vs 10 这类），
 * 预览不跟随 —— 预览要的是"这套配置长什么样"，不是"此刻这张壁纸什么颜色"。
 * 改这里的数值要同步 `src/pages/useNotificationAdaptiveTheme.ts` 的 `ANCHORS`。
 */
export function notificationGlassTextVars(glass: NotificationGlass): Record<string, string> {
    const dark = glassTextPolarity(glass) === 'dark'
    const title = dark ? 'rgb(10, 10, 10)' : 'rgb(255, 255, 255)'
    const tertiary = dark ? 'rgb(61, 61, 61)' : 'rgb(216, 213, 207)'
    return {
        '--noti-title-color': title,
        '--noti-body-color': title,
        '--noti-title-tertiary': tertiary,
        '--noti-close-hover-bg': dark ? 'rgba(0, 0, 0, 0.1)' : 'rgba(255, 255, 255, 0.14)',
    }
}

/** 折射/模糊强度 → LiquidGlass 的渲染参数（默认值刻意等于改动前的那一套）。 */
export function notificationGlassRenderParams(glass: NotificationGlass) {
    const t = Math.min(100, Math.max(0, glass.blur)) / 100
    return {
        // blur px = 4 + blurAmount*32 → 默认档 ~6px，与原实现一致
        blurAmount: t * 0.14,
        displacementScale: Math.round(t * 222),
        // 原生面板用 sigma，原实现是 6
        blurSigma: t * 13.3,
        saturation: 175,
        aberrationIntensity: 2,
    }
}
