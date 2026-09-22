import { describe, expect, it } from 'vitest'
import {
    NOTIFICATION_CARD_BASE_PADDING,
    NOTIFICATION_CARD_MAX_EXTRA_WIDTH,
    NOTIFICATION_CARD_MAX_WIDTH,
    NOTIFICATION_CARD_MIN_WIDTH,
    NOTIFICATION_GLASS_DEFAULT,
    NOTIFICATION_SHADOW_MAX_MARGIN,
    applyNotificationGlassVars,
    normalizeNotificationGlass,
    notificationCardExtraWidth,
    notificationCardPadding,
    notificationCardWidth,
    notificationGlassRenderParams,
    notificationGlassVars,
    notificationShadowCss,
    notificationShadowLayers,
    notificationShadowMargin
} from './notificationGlass'

/**
 * 通知卡片的尺寸模型（v1.0.1）。
 *
 * 用户报的两件事：长昵称撞上右上角的时间、长消息只能看两行。修法是卡片自己
 * 让出空间 —— 宽度按标题的自然宽度加宽（有上限），高度按正文行数自然增长。
 * 这里钉住的是**纯函数部分**：加宽量怎么算、上限在哪、脏配置怎么整形。
 * 真实渲染由 `.ui-probe/verify-glass-settings.mjs` 与截图harness覆盖。
 */

describe('自适应宽度：昵称放不下就加宽，但有上限', () => {
    it('放得下 → 不加宽', () => {
        expect(notificationCardExtraWidth(120, 180)).toBe(0)
        expect(notificationCardExtraWidth(180, 180)).toBe(0)
    })

    it('放不下 → 差额就是要加宽的像素（向上取整）', () => {
        expect(notificationCardExtraWidth(200, 150)).toBe(50)
        expect(notificationCardExtraWidth(200.4, 150)).toBe(51)
    })

    it('再长也不会无限加宽：上限 +220px', () => {
        expect(notificationCardExtraWidth(4000, 200)).toBe(NOTIFICATION_CARD_MAX_EXTRA_WIDTH)
    })

    it('脏输入（NaN / 负值）不加宽，也不抛错', () => {
        expect(notificationCardExtraWidth(Number.NaN, 100)).toBe(0)
        expect(notificationCardExtraWidth(100, Number.NaN)).toBe(0)
        expect(notificationCardExtraWidth(50, 100)).toBe(0)
    })

    it('最终宽度 = 基础 + 增量，并夹在 300-640 之内', () => {
        expect(notificationCardWidth(344, 0)).toBe(344)
        expect(notificationCardWidth(344, 120)).toBe(464)
        expect(notificationCardWidth(344, 9999)).toBe(344 + NOTIFICATION_CARD_MAX_EXTRA_WIDTH)
        expect(notificationCardWidth(200, 0)).toBe(NOTIFICATION_CARD_MIN_WIDTH)
        expect(notificationCardWidth(640, 200)).toBe(NOTIFICATION_CARD_MAX_WIDTH)
    })

    it('窗口宽度上限 640 = 基础宽度上限，不再往右长', () => {
        expect(NOTIFICATION_CARD_MAX_WIDTH).toBe(640)
    })
})

describe('配置整形：新键（模糊 / 宽度 / 行数）也要夹在合法区间', () => {
    /**
     * 用户的要求："我的当前设置就是默认值，一按恢复默认不该有任何变化"。
     *
     * 所以这条用例直接把**他盘上那一串**（`%APPDATA%\Weport\Weport-config.json`
     * 的 notificationGlass* 键，逐字抄下来）喂进 normalize，断言结果与
     * NOTIFICATION_GLASS_DEFAULT **逐键相等** —— 只要有一个键对不上，
     * 「恢复默认」就会改动他的观感，而这正是他要避免的。
     */
    it('用户当前那份配置整形之后逐键等于默认值（按「恢复默认」不会有任何变化）', () => {
        const fromDisk = normalizeNotificationGlass({
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
        })
        expect(fromDisk).toEqual(NOTIFICATION_GLASS_DEFAULT)
    })

    it('已保存的值永远优先于新默认：改默认值不会静默改写用户的配置', () => {
        const fromDisk = normalizeNotificationGlass({
            fillGradientFrom: '#7accff',
            fillGradientTo: '#ded0f5',
            textColor: '#000000',
            radius: 28,
        })
        expect(fromDisk.fillGradientFrom).toBe('#7accff')
        expect(fromDisk.fillGradientTo).toBe('#ded0f5')
        expect(fromDisk.textColor).toBe('#000000')
        expect(fromDisk.radius).toBe(28)
        // 他没配过的键才取默认
        expect(fromDisk.width).toBe(NOTIFICATION_GLASS_DEFAULT.width)
        expect(fromDisk.maxLines).toBe(NOTIFICATION_GLASS_DEFAULT.maxLines)
        expect(fromDisk.frost).toBe(0)
    })

    it('宽度 / 行数 / 模糊越界都被夹回区间', () => {
        expect(normalizeNotificationGlass({ width: 10 }).width).toBe(NOTIFICATION_CARD_MIN_WIDTH)
        expect(normalizeNotificationGlass({ width: 9999 }).width).toBe(NOTIFICATION_CARD_MAX_WIDTH)
        expect(normalizeNotificationGlass({ width: 'nope' }).width).toBe(NOTIFICATION_GLASS_DEFAULT.width)
        expect(normalizeNotificationGlass({ maxLines: 0 }).maxLines).toBe(1)
        expect(normalizeNotificationGlass({ maxLines: 99 }).maxLines).toBe(6)
        expect(normalizeNotificationGlass({ frost: -5 }).frost).toBe(0)
        expect(normalizeNotificationGlass({ frost: 500 }).frost).toBe(100)
        // 填充不透明度放到 100（旧版滑块只到 60，但配置层一直是 0-100）
        expect(normalizeNotificationGlass({ fillOpacity: 100 }).fillOpacity).toBe(100)
    })

    it('CSS 变量表带上宽度与行数，供弹窗和预览共用', () => {
        const vars = notificationGlassVars({ ...NOTIFICATION_GLASS_DEFAULT, width: 400, maxLines: 3 })
        expect(vars['--glass-card-width']).toBe('400')
        expect(vars['--glass-max-lines']).toBe('3')
    })

    /**
     * 文字色有**三种**状态，不能只用一个空串表示。
     *
     * v1.0.1 起默认值本身是 `''`（自动，= 用户配置里那一项），所以"没配过"与
     * "要自动"当前同义 —— 但**代码路径仍要分开**：默认值将来完全可能又变回一个
     * 具体色值，那时把 undefined 折成 '' 会静默丢掉用户的默认设置（这条注释原本
     * 记录的就是那次实测：探针里 --glass-text-color 变成空、卡片退回自适应文字色）。
     */
    it('文字色三态：未配置 → 默认（当前=自动）；显式空串 → 自动；合法值 → 用户指定', () => {
        expect(NOTIFICATION_GLASS_DEFAULT.textColor).toBe('')
        expect(normalizeNotificationGlass({}).textColor).toBe(NOTIFICATION_GLASS_DEFAULT.textColor)
        expect(normalizeNotificationGlass({ textColor: '' }).textColor).toBe('')
        expect(notificationGlassVars(normalizeNotificationGlass({ textColor: '' }))['--glass-text-color']).toBeNull()
        expect(normalizeNotificationGlass({ textColor: '#ff00aa' }).textColor).toBe('#ff00aa')
        // 脏值当作"没指定"处理：退回自动，而不是把 16 进制垃圾写进 CSS
        expect(normalizeNotificationGlass({ textColor: 'zzz' }).textColor).toBe('')
    })
})

describe('玻璃模糊是独立档：折射只管弯曲，模糊只管糊', () => {
    it('折射 0 + 模糊 0 = 旧的基线（2px）', () => {
        const render = notificationGlassRenderParams({ ...NOTIFICATION_GLASS_DEFAULT, blur: 0, frost: 0 })
        expect(render.blurPx).toBeCloseTo(2, 5)
        expect(render.displacementScale).toBe(0)
    })

    it('折射拉满只动弯曲，不再顺带把画面糊掉太多', () => {
        const render = notificationGlassRenderParams({ ...NOTIFICATION_GLASS_DEFAULT, blur: 100, frost: 0 })
        expect(render.displacementScale).toBe(222)
        expect(render.blurPx).toBeCloseTo(4.24, 2)
        expect(render.blurSigma).toBeCloseTo(13.3, 2)
    })

    it('模糊档线性拉起模糊，但不改变形（折射参数不动）', () => {
        const none = notificationGlassRenderParams({ ...NOTIFICATION_GLASS_DEFAULT, blur: 0, frost: 0 })
        const full = notificationGlassRenderParams({ ...NOTIFICATION_GLASS_DEFAULT, blur: 0, frost: 100 })
        expect(full.blurPx).toBeCloseTo(20, 5)
        expect(full.displacementScale).toBe(none.displacementScale)
        expect(full.aberrationIntensity).toBe(none.aberrationIntensity)
        const half = notificationGlassRenderParams({ ...NOTIFICATION_GLASS_DEFAULT, blur: 0, frost: 50 })
        expect(half.blurPx).toBeGreaterThan(none.blurPx)
        expect(half.blurPx).toBeLessThan(full.blurPx)
    })

    /**
     * 折射与磨砂在弹窗里能起作用的前提是**有一张背景像素可加工**：透明窗口里
     * `backdrop-filter` 不生效。两个滑块都是 0 时不要那张像素（默认观感与开销都不变），
     * 任一个离开 0 就得接上 —— 否则滑块又是"拖了没反应"。
     */
    it('needsBackdrop：两个滑块都为 0 时不接背景像素，任一非 0 就接', () => {
        expect(notificationGlassRenderParams({ ...NOTIFICATION_GLASS_DEFAULT, blur: 0, frost: 0 }).needsBackdrop).toBe(false)
        expect(notificationGlassRenderParams({ ...NOTIFICATION_GLASS_DEFAULT, blur: 100, frost: 0 }).needsBackdrop).toBe(true)
        expect(notificationGlassRenderParams({ ...NOTIFICATION_GLASS_DEFAULT, blur: 0, frost: 100 }).needsBackdrop).toBe(true)
        expect(notificationGlassRenderParams({ ...NOTIFICATION_GLASS_DEFAULT, blur: 1, frost: 1 }).needsBackdrop).toBe(true)
    })
})

/**
 * 投影（`--glass-shadow`）—— 这条链路上原本有两个独立的坏点，缺一个都"没有反应"：
 *   1. `notificationGlassVars` 写的 `--glass-shadow` **没有任何 CSS 读它**
 *      （NotificationToast.scss 里读的是 `--noti-shadow`）；
 *   2. 就算读了，窗口尺寸 = 卡片 + 2×8px 留白，投影甩出去的部分会被窗口裁掉。
 * 所以这里同时钉住"画得出来"和"留了地方"。
 */
describe('投影：变量真的会被消费，且窗口留了画它的空间', () => {
    it('shadow = 0 时**移除**变量，让引擎的边界环接管（不是写 none）', () => {
        const vars = notificationGlassVars({ ...NOTIFICATION_GLASS_DEFAULT, shadow: 0 })
        expect(vars['--glass-shadow']).toBeNull()
        expect(notificationShadowCss(0)).toBeNull()
    })

    it('shadow > 0 时给出真实的投影，并保留引擎的边界环作为第一层', () => {
        const css = notificationShadowCss(100)
        expect(css).toContain('var(--noti-shadow')
        expect(css).toMatch(/0 9px 20px rgba\(0, 0, 0, 0\.36\)/)
        expect(notificationGlassVars({ ...NOTIFICATION_GLASS_DEFAULT, shadow: 100 })['--glass-shadow']).toBe(css)
    })

    it('把 shadow=0 的变量从卡片上清掉（而不是留一个上一轮的残留）', () => {
        // 用户在设置页把投影拉回 0：变量必须被 removeProperty，卡片才会回到
        // 引擎的边界环。留下的旧值会让"关掉投影"看起来没有生效。
        // 这里用最小样式桩而不是 DOM：单测跑在 node 环境（无 document），
        // 而被测函数只用到 style.setProperty / removeProperty 两个方法。
        const store = new Map<string, string>()
        const el = {
            style: {
                setProperty: (name: string, value: string) => void store.set(name, value),
                removeProperty: (name: string) => void store.delete(name),
            },
        } as unknown as HTMLElement
        applyNotificationGlassVars({ ...NOTIFICATION_GLASS_DEFAULT, shadow: 80 }, el)
        expect(store.get('--glass-shadow')).toBeTruthy()
        applyNotificationGlassVars({ ...NOTIFICATION_GLASS_DEFAULT, shadow: 0 }, el)
        expect(store.has('--glass-shadow')).toBe(false)
    })

    it('留白随投影增长，且**至少**盖得住可见的投影轮廓', () => {
        expect(notificationShadowMargin(0)).toBe(0)
        const margins = [1, 25, 50, 75, 100].map((s) => notificationShadowMargin(s))
        for (let i = 1; i < margins.length; i += 1) {
            expect(margins[i]).toBeGreaterThanOrEqual(margins[i - 1])
        }
        for (const shadow of [1, 25, 50, 75, 100]) {
            const { offsetY, blur } = notificationShadowLayers(shadow)
            const margin = notificationShadowMargin(shadow)
            // 可见轮廓（Y 偏移 + 模糊半径）必须落在留白之内，否则投影被窗口切头
            expect(margin).toBeGreaterThanOrEqual(Math.ceil(offsetY + blur))
            // 但也不能无限长：窗口每宽 1px 就多 1px 拦截桌面点击的区域
            expect(margin).toBeLessThanOrEqual(NOTIFICATION_SHADOW_MAX_MARGIN)
        }
    })

    it('满档投影给窗口带来的额外宽度是有限的（≤ 80px）', () => {
        const extra = (notificationCardPadding(100) - notificationCardPadding(0)) * 2
        expect(extra).toBeLessThanOrEqual(80)
    })

    it('默认值的几何一个像素都没变（padding 仍是基础的 8px）', () => {
        expect(NOTIFICATION_CARD_BASE_PADDING).toBe(8)
        expect(notificationCardPadding(NOTIFICATION_GLASS_DEFAULT.shadow)).toBe(8)
        expect(notificationCardPadding(100)).toBe(8 + notificationShadowMargin(100))
    })
})
