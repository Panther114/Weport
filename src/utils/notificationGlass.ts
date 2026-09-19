/**
 * 通知玻璃的可配置项（v1.0.1）。
 *
 * 背景：弹窗玻璃此前是一组**写死的观感** —— 1.5px 的白色描边 + 0.5px 白内阴影
 * （LiquidGlass 里的 borderLayerBase 与 borderGradient 全是字面 rgba(255,255,255,·)），
 * 填充浓度由自适应引擎按背景对比度解出来，用户一处也改不了。用户的原话是
 * "玻璃不一致、不可配置、不好看"。v1.0.0 先把填充/描边/文字色/圆角/折射开放出来，
 * v1.0.1 补上三件用户点名要的东西：
 *
 *   1. **宽度**（`width` + 自适应增长）—— 昵称很长时右上角的时间会撞上去，
 *      只靠截断是错的：卡片本身该让出空间；
 *   2. **玻璃模糊**（`frost`）—— 原来的"折射强度"同时管弯曲和模糊，用户要的是
 *      一个独立的磨砂档；
 *   3. **0-100 的填充**（以前滑块只到 60）与**能用的取色器**（以前只有系统色板）。
 *
 * 默认值 = 用户本机那一套（`%APPDATA%\Weport\Weport-config.json` 的
 * `notificationGlass*`）：蓝紫渐变 60% 填充 + 纯黑文字 + 圆角 28 + 无描边 /
 * 无投影 / 无折射。用户明确要求"我现在的配置就是默认值，所有选项都是"，
 * 因此这里不再保留"16% 白 + 0.5px 发丝边"那套更保守的默认。
 *
 * 实现方式：这组配置只负责**生成 CSS 变量**，观感全部由变量驱动
 * （LiquidGlass 的描边/阴影/折射、NotificationToast 的填充与文字色）。
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
     * 不做角度控件是有意的：通知卡片很扁，任何非水平角度在这么扁的矩形上都会退化成
     * "一条斜线切过去"，看起来像渲染错误而不是设计。
     */
    fillMode: FillMode
    /** 纯色填充色（#rrggbb）。默认白：白玻璃 + 深字是最稳的组合。 */
    fillColor: string
    /** 渐变起点（左）。 */
    fillGradientFrom: string
    /** 渐变终点（右）。 */
    fillGradientTo: string
    /** 填充不透明度 0-100（v1.0.1 起放开到 100，以前滑块只到 60）。 */
    fillOpacity: number
    /** 文字色（#rrggbb）。空串＝按填充色极性定。 */
    textColor: string
    /** 描边宽度 px（0-3）。0 = 完全没有边。 */
    borderWidth: number
    /** 描边色（#rrggbb）。 */
    borderColor: string
    /** 描边不透明度 0-100。 */
    borderOpacity: number
    /** 圆角 px（0-40）。 */
    radius: number
    /** 折射强度 0-100（0＝平板玻璃，100＝厚透镜）。只管弯曲/色散。 */
    blur: number
    /** 玻璃模糊（磨砂）0-100 —— 独立于折射，0 = 背后完全不糊。 */
    frost: number
    /** 投影强度 0-100（0＝完全不要投影）。 */
    shadow: number
    /** 卡片基础宽度 px（300-560）。昵称过长时会在它之上自适应加宽。 */
    width: number
    /** 正文最多显示几行（1-6）。超出才截断，卡片高度随之增长。 */
    maxLines: number
}

export type FillMode = 'solid' | 'gradient'

// ---------------------------------------------------------------------------
// 自适应尺寸
// ---------------------------------------------------------------------------

/** 窗口/卡片宽度的下限与上限（含自适应增长后的值）。 */
export const NOTIFICATION_CARD_MIN_WIDTH = 300
export const NOTIFICATION_CARD_MAX_WIDTH = 640
/**
 * 自适应加宽的上限（在用户设定的基础宽度之上最多再加这么多）。
 *
 * 为什么不设成"能放下多少就多宽"：通知是**盖在桌面上的**，一条 900px 宽的卡片
 * 会挡住半屏内容，比截断一个昵称更烦人。220px 足够放下一个 30 字以内的昵称，
 * 再长的昵称本来就该靠省略号收尾。
 */
export const NOTIFICATION_CARD_MAX_EXTRA_WIDTH = 220

/** 卡片（含自适应增长）的最高像素。超过就把正文压到 maxLines 行截断。 */
export const NOTIFICATION_CARD_MAX_HEIGHT = 320

/**
 * 标题一行放不下时，卡片该加宽多少 —— 纯函数，便于单测。
 *
 * 判据是"标题的自然宽度"与"它此刻拿到的宽度"之差：标题是 `flex:1` 的子项，
 * 卡片宽 1px、标题就多 1px，因此一次测量即可收敛（不需要迭代）。
 * 负值（放得下）归零，超过上限截到上限。
 */
export function notificationCardExtraWidth(titleScrollWidth: number, titleClientWidth: number): number {
    const needed = Number(titleScrollWidth) - Number(titleClientWidth)
    if (!Number.isFinite(needed) || needed <= 0) return 0
    return Math.min(NOTIFICATION_CARD_MAX_EXTRA_WIDTH, Math.ceil(needed))
}

/** 基础宽度 + 自适应增量 → 卡片最终宽度（同时受全局上限约束）。 */
export function notificationCardWidth(baseWidth: number, extraWidth: number): number {
    const base = clampWidth(baseWidth)
    const extra = Math.max(0, Math.min(NOTIFICATION_CARD_MAX_EXTRA_WIDTH, Math.ceil(Number(extraWidth) || 0)))
    return Math.max(NOTIFICATION_CARD_MIN_WIDTH, Math.min(NOTIFICATION_CARD_MAX_WIDTH, base + extra))
}

// ---------------------------------------------------------------------------
// 预设
// ---------------------------------------------------------------------------

/**
 * 预设渐变（v1.0.1 重做：**换成真实设计库里挑出来的颜色**，并且更狠、更多）。
 *
 * 用户的反馈是两句话：**"变化太细微了"** 和 **"多给一些预设"**。
 *
 * 旧列表是手写的，9 条里 7 条是"浅灰 → 稍浅的灰"级别的差别 —— 最平的一条
 * (#cfd9ff → #ffc2e8) 两端相对亮度只差 **0.044**，60% 铺上去就是一块纯色，
 * 用户会以为预设没生效。手写色stop 的毛病就在这里：凭感觉挑，很容易落在同一条
 * 亮度带上。
 *
 * 所以这一版**不再自己调色**，而是从公开的、被大量产品用过的渐变库里挑：
 *   - uiGradients（ghosh/uiGradients，社区策展的 300+ 组命名渐变）
 *   - WebGradients（180 组命名渐变）
 *   - Tailwind CSS 默认色阶（现代 SaaS 的事实标准）
 * 每组后面的注释写明出处名。挑的时候守两条规矩：
 *
 *   1. **每一对两端的相对亮度差 ≥ 0.20**（GRADIENT_PRESET_MIN_LUMA_DELTA）。
 *      0.20 是可辨识度的下限，不是审美偏好 —— 原始库里那些两端同亮度的"高级灰"
 *      渐变（Clouds / Dull / Delicate 之类）**故意被排除在外**，它们在这张卡片上
 *      只会读成一块纯色。少数几个经典搭配（Deep Blue、Bloody Mary、JShine …）
 *      本身亮度差不够，就把较暗那一端再压深一档，保留它的色相性格。
 *   2. **中点必须明确落在某一侧**，glassTextPolarity 才能给出不含糊的文字极性；
 *      单测逐条对账 xpect，新增预设不可能悄悄判错。
 *
 * 第一条**就是默认值**。用户 v1.0.1 点名要把默认从「蓝紫」换成「晴空」：
 * 一条干净的天空渐变（近白的晴空蓝 → 饱和的天青），ΔL = 0.44，和"蓝紫"那套
 * 两端都压在浅色区的旧默认完全不是一回事。
 *
 * 命名用中文（和 UI 其余部分一致），id 用英文短名并保持唯一 —— 设置页拿 id
 * 当 React key。
 */
export const GRADIENT_PRESETS: ReadonlyArray<{
    id: string
    label: string
    from: string
    to: string
    expect: 'dark' | 'light'
}> = [
    { id: 'sky', label: '晴空', from: '#d8ecff', to: '#6aa9ea', expect: 'dark' },
    { id: 'blueviolet', label: '蓝紫', from: '#7accff', to: '#9a6ae8', expect: 'dark' },
    { id: 'facebook', label: '信使蓝', from: '#00c6ff', to: '#0072ff', expect: 'dark' },
    { id: 'hyperblue', label: '极蓝', from: '#59cde9', to: '#0a2a88', expect: 'light' },
    { id: 'veryblue', label: '午夜蓝', from: '#3b9bff', to: '#021b79', expect: 'light' },
    { id: 'grandeur', label: '深空蓝', from: '#000046', to: '#1cb5e0', expect: 'light' },
    { id: 'stripe', label: '条纹', from: '#1fa2ff', to: '#a6ffcb', expect: 'dark' },
    { id: 'scooter', label: '水蓝', from: '#36d1dc', to: '#5b86e5', expect: 'dark' },
    { id: 'steel', label: '钢蓝', from: '#dfe9f5', to: '#4a6b8a', expect: 'dark' },
    { id: 'aquamarine', label: '海水', from: '#1a2980', to: '#26d0ce', expect: 'light' },
    { id: 'moss', label: '苔藓', from: '#134e5e', to: '#71b280', expect: 'light' },
    { id: 'lush', label: '青草', from: '#a8e063', to: '#56ab2f', expect: 'dark' },
    { id: 'quePal', label: '薄荷绿', from: '#11998e', to: '#38ef7d', expect: 'dark' },
    { id: 'emeraldsea', label: '翡翠', from: '#05386b', to: '#5cdb95', expect: 'dark' },
    { id: 'pacific', label: '太平洋', from: '#34e89e', to: '#0f3443', expect: 'dark' },
    { id: 'lagoon', label: '泻湖', from: '#43c6ac', to: '#191654', expect: 'light' },
    { id: 'forest', label: '森林', from: '#cdeecb', to: '#2f7d4f', expect: 'dark' },
    { id: 'flare', label: '火焰', from: '#f12711', to: '#f5af19', expect: 'dark' },
    { id: 'citrus', label: '柑橘', from: '#fdc830', to: '#f37335', expect: 'dark' },
    { id: 'horizon', label: '地平线', from: '#fceabb', to: '#f8b500', expect: 'dark' },
    { id: 'ember', label: '暖阳', from: '#fff0c9', to: '#ff9b4a', expect: 'dark' },
    { id: 'amber', label: '琥珀', from: '#ffe9b0', to: '#d98324', expect: 'dark' },
    { id: 'coffee', label: '咖啡金', from: '#554023', to: '#c99846', expect: 'light' },
    { id: 'latte', label: '拿铁', from: '#f5e6d3', to: '#9c6b4a', expect: 'dark' },
    { id: 'peach', label: '蜜桃', from: '#ffe3d3', to: '#ff8fa3', expect: 'dark' },
    { id: 'sakura', label: '樱花', from: '#fbd3e9', to: '#bb377d', expect: 'dark' },
    { id: 'cotton', label: '棉花糖', from: '#dbe6ff', to: '#ff9ecb', expect: 'dark' },
    { id: 'neuromancer', label: '赛博粉', from: '#ff7adb', to: '#8e1157', expect: 'dark' },
    { id: 'grapefruit', label: '西柚日落', from: '#ff7a50', to: '#7b3f8f', expect: 'dark' },
    { id: 'bloodymary', label: '血腥玛丽', from: '#ff7a45', to: '#c2185b', expect: 'dark' },
    { id: 'wiretap', label: '霓虹紫橙', from: '#8a2387', to: '#f27121', expect: 'light' },
    { id: 'instagram', label: '社交', from: '#833ab4', to: '#fcb045', expect: 'dark' },
    { id: 'jshine', label: '极光', from: '#7fe3ff', to: '#f64f59', expect: 'dark' },
    { id: 'megatron', label: '糖果', from: '#c6ffdd', to: '#f7797d', expect: 'dark' },
    { id: 'relay', label: '晚霞', from: '#3a1c71', to: '#ffaf7b', expect: 'light' },
    { id: 'sublime', label: '霓虹粉蓝', from: '#ff7ea8', to: '#2b3fd8', expect: 'light' },
    { id: 'ultraviolet', label: '紫外', from: '#654ea3', to: '#eaafc8', expect: 'dark' },
    { id: 'celestial', label: '星空', from: '#e8608f', to: '#1d2671', expect: 'light' },
    { id: 'witching', label: '午夜紫', from: '#ff5c7a', to: '#1a0729', expect: 'light' },
    { id: 'predawn', label: '黎明前', from: '#ffa17f', to: '#00223e', expect: 'light' },
    { id: 'dawn', label: '晨曦', from: '#f3904f', to: '#3b4371', expect: 'light' },
    { id: 'redsunset', label: '落日', from: '#1f3a52', to: '#d07c93', expect: 'light' },
    { id: 'slate', label: '石板', from: '#b5b9ff', to: '#2b2c49', expect: 'light' },
    { id: 'orchid', label: '兰紫', from: '#f0d9ff', to: '#7d4fd6', expect: 'dark' },
    { id: 'cyber', label: '赛博', from: '#64f0ff', to: '#b14cff', expect: 'dark' },
    { id: 'neon', label: '霓虹', from: '#c6ff6e', to: '#6a3cff', expect: 'dark' },
    { id: 'frost', label: '霜夜', from: '#000428', to: '#1e8fe0', expect: 'light' },
    { id: 'openOcean', label: '深海', from: '#3f8ae0', to: '#0b2a5c', expect: 'light' },
    { id: 'wine', label: '酒红', from: '#c98ba0', to: '#4a1020', expect: 'light' },
    { id: 'graphite', label: '石墨', from: '#8b93a3', to: '#14161c', expect: 'light' },
    { id: 'midnight', label: '极夜', from: '#5f86f0', to: '#05070f', expect: 'light' },
]

/**
 * 「更狠」的验收线：每一对预设两端的最小相对亮度差。
 *
 * 0.20 不是审美偏好，是**可辨识度**的下限 —— 旧列表里最平的一条只差 0.044。
 * 单测（notificationFixedText.test.ts）逐条对账，新增预设不可能再悄悄退化。
 */
export const GRADIENT_PRESET_MIN_LUMA_DELTA = 0.2

export const COLOR_PALETTE: ReadonlyArray<ReadonlyArray<string>> = [
    ['#ffffff', '#d8ecff', '#dbe6ff', '#e6ffb8', '#ffd9e2', '#ffe3d3', '#d6fbf0', '#eafcff'],
    ['#6aa9ea', '#7accff', '#64f0ff', '#7ef2d0', '#c6ff6e', '#ffd166', '#ff9b4a', '#ff8fa3'],
    ['#b98cf0', '#b14cff', '#7a5cf0', '#6a3cff', '#f2545b', '#c81d25', '#2f7d4f', '#0b2a5c'],
    ['#5c6472', '#3a3d45', '#2b2b3a', '#16171d', '#05070f', '#14161c', '#4a1020', '#000000'],
]

/**
 * 默认值 —— **就是用户本机此刻的那一套**（v1.0.1，逐项对过 `Weport-config.json`）。
 *
 * 用户的要求是"我的当前设置就是默认值，我一按恢复默认不该有任何变化"。所以这里
 * 不是"我们觉得好看的值"，而是他配置里那一串：晴空渐变 60%、文字色**自动**
 * （`notificationGlassTextColor` 是空串）、圆角 **25**（不是 28）、描边 0、
 * 折射 0、磨砂 0、投影 0、宽 344、4 行。
 *
 * 两个容易被"顺手改回去"的值：
 *   · `textColor: ''` —— 空串是**有意义**的状态（按填充色极性自动），不是"没配过"；
 *   · `radius: 25` —— 与 28 只差 3px，但用户按一次「恢复默认」就会看见卡片变圆，
 *     那正是他要避免的"按了恢复默认却变了"。
 *
 * 改动这一组值 = 改变用户的默认观感，必须有明确要求。
 */
export const NOTIFICATION_GLASS_DEFAULT: NotificationGlass = {
    fill: true,
    fillMode: 'gradient',
    fillColor: '#ffffff',
    fillGradientFrom: '#d8ecff',
    fillGradientTo: '#6aa9ea',
    fillOpacity: 60,
    textColor: '',
    borderWidth: 0,
    borderColor: '#ffffff',
    borderOpacity: 0,
    radius: 25,
    blur: 0,
    frost: 0,
    shadow: 0,
    width: 344,
    maxLines: 4,
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
    frost: 'notificationGlassFrost',
    shadow: 'notificationGlassShadow',
    width: 'notificationGlassWidth',
    maxLines: 'notificationGlassMaxLines',
} as const satisfies Record<keyof NotificationGlass, string>

// ---------------------------------------------------------------------------
// 颜色工具
// ---------------------------------------------------------------------------

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

const clamp = (value: unknown, min: number, max: number, fallback: number): number => {
    const n = Number(value)
    if (!Number.isFinite(n)) return fallback
    return Math.min(max, Math.max(min, n))
}

const clampWidth = (value: unknown): number =>
    Math.round(clamp(value, NOTIFICATION_CARD_MIN_WIDTH, NOTIFICATION_CARD_MAX_WIDTH, NOTIFICATION_GLASS_DEFAULT.width))

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
        /**
         * 文字色有**三种**状态，不能只用一个空串表示：
         *   undefined（没配过）→ 默认值（用户本机那套是手动纯黑）
         *   ''（显式清空）      → 交给填充色极性自动决定
         *   合法 hex            → 用户指定
         * 早期版本默认值是 ''，所以"没配过"和"要自动"碰巧同义；默认值改成 #000000
         * 之后，把 undefined 也折成 '' 会**静默丢掉用户的默认设置**（实测：探针里
         * --glass-text-color 变成空，卡片退回自适应文字色）。
         */
        textColor: raw.textColor === undefined ? d.textColor : normalizeGlassHex(raw.textColor),
        borderWidth: clamp(raw.borderWidth, 0, 3, d.borderWidth),
        borderColor: normalizeGlassHex(raw.borderColor) || d.borderColor,
        borderOpacity: clamp(raw.borderOpacity, 0, 100, d.borderOpacity),
        radius: clamp(raw.radius, 0, 40, d.radius),
        blur: clamp(raw.blur, 0, 100, d.blur),
        frost: clamp(raw.frost, 0, 100, d.frost),
        shadow: clamp(raw.shadow, 0, 100, d.shadow),
        width: clampWidth(raw.width),
        maxLines: Math.round(clamp(raw.maxLines, 1, 6, d.maxLines)),
    }
}

/**
 * 卡片四周的基础留白。
 *
 * 这个值不是装饰：它同时是**卡片投影的空间**。窗口尺寸 = 卡片宽度 + 2×留白，
 * 所以留白决定了"投影能不能被画出来"。旧实现在 CSS 里写死 8px，而用户可调的
 * 投影最大要甩出 30 多像素 —— 于是那 8px 之外的部分被窗口边界整块切掉，
 * 用户看到的就是"投影这个滑块完全没反应"。见 `notificationShadowMargin`。
 */
export const NOTIFICATION_CARD_BASE_PADDING = 8

/**
 * 投影的几何（0-100 → 偏移/模糊/透明度）。
 *
 * 参数刻意收得比一般 UI 更紧：卡片只有 ~114px 高，投影太散就变成一圈雾，
 * 而且散得越开、窗口为了容纳它就要长得越宽。取 3..9px 偏移 / 8..20px 模糊 /
 * 0.10..0.36 透明度 —— 满档是一条紧实、现代的投影。
 *
 * 返回值同时被 `notificationShadowCss`（画）和 `notificationShadowMargin`（留地方）
 * 使用 —— 两处必须来自同一组数，否则又会出现"画得出来但被切掉"。
 */
export function notificationShadowLayers(shadow: number): { offsetY: number; blur: number; alpha: number } {
    const t = Math.min(100, Math.max(0, Number(shadow) || 0)) / 100
    return {
        offsetY: Math.round(3 + t * 6),
        blur: Math.round(8 + t * 12),
        alpha: Math.round((0.1 + t * 0.26) * 100) / 100,
    }
}

/**
 * 投影的留白上限（px）。
 *
 * 留白会变成窗口的一部分，而窗口在可见期间是**吃鼠标事件**的：每多 1px，卡片
 * 周围就多 1px 区域会拦下桌面点击。所以这里给一个硬上限，宁可让最外侧那圈
 * 几乎透明的尾部被窗口裁掉，也不把可点击区域无限扩大。
 */
export const NOTIFICATION_SHADOW_MAX_MARGIN = 36

/**
 * 投影要占用的额外留白。
 *
 * 取"Y 偏移 + 1.0×模糊半径"作为可见轮廓：Skia 的方框模糊 sigma = 半径/2，
 * 到 1.0×半径处剩余强度已经很低，再往外基本看不见。加 2px 余量兜住取整。
 * `shadow = 0` 时返回 0 —— 默认配置的窗口尺寸与几何**一个像素都不变**。
 */
export function notificationShadowMargin(shadow: number): number {
    if (!(Number(shadow) > 0)) return 0
    const { offsetY, blur } = notificationShadowLayers(shadow)
    return Math.min(NOTIFICATION_SHADOW_MAX_MARGIN, Math.ceil(offsetY + blur) + 2)
}

/** 卡片容器的内边距 = 基础留白 + 投影留白。 */
export function notificationCardPadding(shadow: number): number {
    return NOTIFICATION_CARD_BASE_PADDING + notificationShadowMargin(shadow)
}

/**
 * 投影的 CSS 值；`shadow = 0` 时返回 `null`（**移除变量**，让引擎的边界环生效）。
 *
 * 为什么要带上 `var(--noti-shadow, …)`：`--noti-shadow` 是自适应引擎按背景解出的
 * 一圈 1px 边界光晕，它是"卡片在亮桌面上还看得见"的兜底。用户开了投影之后如果
 * 直接把这圈替换掉，关掉填充的用户会得到一张既没有边、也没有底的卡片。
 * 自定义属性的值允许是 token 串，订阅时再展开，所以这里可以合成。
 */
export function notificationShadowCss(shadow: number): string | null {
    if (!(Number(shadow) > 0)) return null
    const { offsetY, blur, alpha } = notificationShadowLayers(shadow)
    return `var(--noti-shadow, 0 0 0 1px rgba(0, 0, 0, 0.04)), 0 ${offsetY}px ${blur}px rgba(0, 0, 0, ${alpha})`
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
 *   - 填充是亮色 → 深字（"白玻璃 + 深字"是设计上的默认组合）；
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
 * 填充的代表色 + 实际 alpha（v1.0.1）。
 *
 * 给"需要自己画一小块填充"的地方用（设置页的「当前判断」小牌子）：那里必须用
 * 单一颜色而不是 CSS 渐变 —— 对比度审计（`capture-ui.ps1` → `contrast-audit.json`）
 * 只读 `background-color`，内联渐变会把 background-color 重置成透明，于是黑字被
 * 判成"压在面板深色底上"（实测 1.11，硬失败）。用 rgba 单色既能让审计正确合成，
 * 又和渐变的观感一致（两端中点）。
 */
export function notificationGlassRepresentativeRgba(glass: NotificationGlass): [number, number, number, number] {
    const [r, g, b] = notificationGlassRepresentativeRgb(glass)
    const a = glass.fill ? Math.round((glass.fillOpacity / 100) * 1000) / 1000 : 0
    return [r, g, b, a]
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
 *   --glass-card-width      卡片基础宽度（CSS px 数值）—— 自适应加宽在此基础上叠加
 *   --glass-max-lines       正文行数上限（-webkit-line-clamp 用）
 */
export function notificationGlassVars(glass: NotificationGlass): Record<string, string | null> {
    const borderAlpha = Math.round((glass.borderOpacity / 100) * 1000) / 1000
    return {
        '--glass-fill': notificationGlassFillValue(glass),
        '--glass-text-color': glass.textColor || null,
        '--glass-border-rgb': hexToRgbTriple(glass.borderColor, '#ffffff'),
        '--glass-border-alpha': String(borderAlpha),
        '--glass-border-width': String(glass.borderWidth),
        '--glass-ring': String(borderAlpha),
        '--glass-radius': `${glass.radius}px`,
        '--glass-card-width': String(glass.width),
        '--glass-max-lines': String(glass.maxLines),
        // 0 时**移除**变量：`--liquid-glass-shadow` 的兜底链因此落回引擎的边界环。
        // 旧实现写的是 'none'，而那个变量当时根本没人读 —— 投影滑块整条是死的。
        '--glass-shadow': notificationShadowCss(glass.shadow),
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
 * `#ffffff` 生效 —— 预览永远是白字，哪怕填充是浅色（正是要修掉的"浅色卡片 + 白字"）。
 * 用户改了填充色、下面那行提示改口说"深色字"，预览却纹丝不动，这个控件看起来就是坏的。
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

/**
 * 玻璃的渲染参数（渲染层与原生面板共用同一套换算）。
 *
 * v1.0.1 把"模糊"从折射里拆出来：
 *   - 折射强度 `blur`     → displacementScale / aberration（弯曲与色散），外加一点点
 *                          基线模糊（厚玻璃本身就不锐利）；
 *   - 玻璃模糊 `frost`    → 纯模糊，不改变形。0 = 背后完全清晰。
 * `blurPx` 是**最终**的 CSS 模糊像素，`blurSigma` 是原生面板的高斯 sigma（同尺度）。
 */
export function notificationGlassRenderParams(glass: NotificationGlass) {
    const t = Math.min(100, Math.max(0, glass.blur)) / 100
    const frostPx = (Math.min(100, Math.max(0, glass.frost)) / 100) * 18
    // 折射自带的基线模糊：0 → 2px，100 → 4.24px（与改动前逐值一致）
    const refractionBlurPx = 2 + t * 2.24
    const blurPx = refractionBlurPx + frostPx
    return {
        blurAmount: t * 0.14,
        /** 回退管线（快照/视频）用的 CSS 模糊像素 */
        blurPx,
        /** 原生面板（Windows）用的高斯 sigma */
        blurSigma: t * 13.3 + frostPx,
        displacementScale: Math.round(t * 222),
        saturation: 175,
        aberrationIntensity: 2,
        /**
         * 这两个滑块真的会改变观感吗 —— 也就是说**玻璃需不需要一张背景像素**。
         *
         * 弹窗是一个 `transparent: true` 的 Electron 窗口，Chromium 在那里不生效
         * `backdrop-filter`（LiquidGlass 顶部的注释写了这条限制）。所以折射与磨砂
         * 唯一能作用的对象，是主进程推上来的桌面帧（快照 / WGC 视频流）。
         * 只要用户把这两个滑块里任意一个拨离 0，渲染层就把它接进玻璃；
         * 两个都是 0（= 用户的默认配置）时**不接**：既省一次整屏合成，
         * 也让默认观感与改动前逐像素一致。
         */
        needsBackdrop: glass.blur > 0 || glass.frost > 0,
    }
}
