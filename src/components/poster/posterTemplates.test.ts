import { describe, expect, it } from 'vitest'
import {
    FONT_SCALE_MAX,
    FONT_SCALE_MIN,
    GRID_SLOT_COUNT,
    POSTER_BASE_FONT_PX,
    POSTER_TEMPLATES,
    applyTemplate,
    clampFontScale,
    contrastTextOn,
    getTemplate,
    hexToRgb,
    posterFontPx,
    posterRootStyle,
    posterThemeAttr,
    parseSavedPosterTemplates,
    serializeSavedPosterTemplates,
    relativeLuminance,
    templateItemLimit,
    templateSupportsCrop,
    templateSupportsReorder,
} from './posterTemplates.ts'
import { DEFAULT_POSTER_OPTIONS } from './posterTypes.ts'

/**
 * 模板与"选项 → 样式"的映射（v1.2 §4）。
 *
 * 这些映射是**预览与导出共用**的那一份尺寸/配色来源：算错了不会报错，只会让导出的
 * 图片字太小、强调色上的文字看不清（白底白字），或者"点了开关但预览没变"。
 */

describe('模板预设', () => {
    it('四套模板齐全（长图 / 引用卡 / 九宫格 / 小结卡）', () => {
        expect(POSTER_TEMPLATES.map((t) => t.id)).toEqual(['long', 'quote', 'grid9', 'summary'])
    })

    it('换模板只重置排版选项，保留打码与页脚', () => {
        const base = { ...DEFAULT_POSTER_OPTIONS, footer: '给妈妈的', redaction: { ...DEFAULT_POSTER_OPTIONS.redaction, enabled: false } }
        const next = applyTemplate(base, 'quote')
        expect(next.template).toBe('quote')
        expect(next.fontScale).toBe(getTemplate('quote').defaults.fontScale)
        expect(next.showBubble).toBe(false)
        expect(next.footer).toBe('给妈妈的')
        expect(next.redaction.enabled).toBe(false)
    })

    it('模板能力：只有长图与九宫格能排序，只有九宫格能裁剪', () => {
        expect(templateSupportsReorder('long')).toBe(true)
        expect(templateSupportsReorder('grid9')).toBe(true)
        expect(templateSupportsReorder('quote')).toBe(false)
        expect(templateSupportsCrop('grid9')).toBe(true)
        expect(templateSupportsCrop('long')).toBe(false)
    })

    it('取用条数：引用卡 1 条、九宫格 9 张、长图不设上限', () => {
        expect(templateItemLimit('quote')).toBe(1)
        expect(templateItemLimit('grid9')).toBe(GRID_SLOT_COUNT)
        expect(templateItemLimit('long')).toBe(Number.POSITIVE_INFINITY)
    })
})

describe('用户模板 JSON', () => {
    it('round trips complete options while keeping local template data validated', () => {
        const input = [{ id: 'mine-1', name: '浅色对话', createdAt: 100, options: { ...DEFAULT_POSTER_OPTIONS, theme: 'light' as const, title: '归档' } }]
        const imported = parseSavedPosterTemplates(JSON.parse(serializeSavedPosterTemplates(input)), 200)
        expect(imported).toHaveLength(1)
        expect(imported[0].options.theme).toBe('light')
        expect(imported[0].options.title).toBe('归档')
    })

    it('drops malformed entries and clamps imported dimensions/options', () => {
        const imported = parseSavedPosterTemplates([
            { id: '../unsafe', name: '坏 id', options: DEFAULT_POSTER_OPTIONS },
            { name: '   ', options: DEFAULT_POSTER_OPTIONS },
            { id: 'valid', name: '可用', options: { ...DEFAULT_POSTER_OPTIONS, fontScale: 50, pageMaxHeight: 2 } },
        ], 123)
        expect(imported).toHaveLength(2)
        expect(imported[0].id).toBe('import-123-0')
        expect(imported[1].options.fontScale).toBe(1.6)
        expect(imported[1].options.pageMaxHeight).toBe(4000)
    })
})

describe('字号换算', () => {
    it('倍率被夹在 0.8~1.6，且四舍五入到两位', () => {
        expect(clampFontScale(0.1)).toBe(FONT_SCALE_MIN)
        expect(clampFontScale(9)).toBe(FONT_SCALE_MAX)
        expect(clampFontScale(1.234)).toBe(1.23)
        expect(clampFontScale(Number.NaN)).toBe(1)
    })

    it('字号 = 基线 × 倍率（1080 画布下基线 30px）', () => {
        expect(posterFontPx(1)).toBe(POSTER_BASE_FONT_PX)
        expect(posterFontPx(1.5)).toBe(Math.round(POSTER_BASE_FONT_PX * 1.5))
    })
})

describe('颜色', () => {
    it('hex 解析支持 3 位缩写与 # 前缀', () => {
        expect(hexToRgb('#fff')).toEqual({ r: 255, g: 255, b: 255 })
        expect(hexToRgb('5b8eff')).toEqual({ r: 91, g: 142, b: 255 })
        expect(hexToRgb('not-a-color')).toBeNull()
    })

    it('强调色上的文字按亮度取黑或白（深蓝 → 白字，浅黄 → 黑字）', () => {
        expect(contrastTextOn('#5b8eff')).toBe('#ffffff')
        expect(contrastTextOn('#ffe680')).toBe('#0b0b10')
        expect(relativeLuminance('#000000')).toBe(0)
        expect(relativeLuminance('#ffffff')).toBeCloseTo(1, 5)
    })
})

describe('posterRootStyle（选项 → CSS 变量）', () => {
    it('字号 / 行高 / 元信息字号随倍率线性变化', () => {
        const base = posterRootStyle({ ...DEFAULT_POSTER_OPTIONS, fontScale: 1 })
        const big = posterRootStyle({ ...DEFAULT_POSTER_OPTIONS, fontScale: 1.5 })
        expect(base['--pp-font']).toBe('30px')
        expect(big['--pp-font']).toBe('45px')
        expect(base['--pp-line']).toBe(`${Math.round(30 * 1.6)}px`)
        expect(big['--pp-line']).toBe(`${Math.round(45 * 1.6)}px`)
    })

    it('气泡开关决定圆角半径（关掉气泡不是"圆角小一点"，而是另一种形状）', () => {
        const on = posterRootStyle({ ...DEFAULT_POSTER_OPTIONS, showBubble: true })
        const off = posterRootStyle({ ...DEFAULT_POSTER_OPTIONS, showBubble: false })
        expect(on['--pp-radius']).toBe('22px')
        expect(off['--pp-radius']).toBe('12px')
        expect(on['--pp-bubble-radius']).toContain('6px')
    })

    it('头像开关决定头像尺寸变量（0px = 不占位）', () => {
        expect(posterRootStyle({ ...DEFAULT_POSTER_OPTIONS, showAvatar: true })['--pp-avatar']).toBe('76px')
        expect(posterRootStyle({ ...DEFAULT_POSTER_OPTIONS, showAvatar: false })['--pp-avatar']).toBe('0px')
    })

    it('强调色写进变量并带上软色（非法值回落到默认，不会写一条坏 CSS）', () => {
        const style = posterRootStyle({ ...DEFAULT_POSTER_OPTIONS, accent: '#ff0000' })
        expect(style['--pp-accent']).toBe('#ff0000')
        expect(style['--pp-accent-soft']).toBe('rgba(255, 0, 0, 0.16)')
        expect(style['--pp-accent-ink']).toBe('#ffffff')
        const broken = posterRootStyle({ ...DEFAULT_POSTER_OPTIONS, accent: 'red' })
        expect(broken['--pp-accent']).toBe(DEFAULT_POSTER_OPTIONS.accent)
    })

    it('画布宽恒为 1080', () => {
        expect(posterRootStyle(DEFAULT_POSTER_OPTIONS)['--pp-width']).toBe('1080px')
    })

    it('主题属性只有 light/dark 两种输出', () => {
        expect(posterThemeAttr('light')).toBe('light')
        expect(posterThemeAttr('dark')).toBe('dark')
    })
})
