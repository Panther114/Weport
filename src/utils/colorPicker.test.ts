import { describe, expect, it } from 'vitest'
import { contrastTextOn, hexToHsv, hsvToHex, relativeLuma } from './colorPicker'
import { COLOR_PALETTE } from './notificationGlass'

/**
 * 取色器的颜色换算（v1.0.1）。
 *
 * 换掉 `<input type="color">` 之后，HSV ↔ hex 的往返成了"用户拖一下色相条，
 * 颜色会不会跳"的直接原因。这里钉住三件事：
 *   1. 十六进制 → HSV → 十六进制是恒等（拖完松手不会变色）；
 *   2. 饱和度归零时色相**不丢**（继续拖还能回到原来的色相，这是自写取色器的意义）；
 *   3. 色块上的对比字色符合 WCAG 的方向。
 */

describe('hex ↔ HSV', () => {
    const SAMPLES = ['#000000', '#ffffff', '#ff0000', '#00ff00', '#0000ff', '#7accff', '#b98cf0', '#3a3d45', '#f4f6fb']

    it('往返恒等：hex → HSV → hex 不变', () => {
        for (const hex of SAMPLES) {
            expect(hsvToHex(hexToHsv(hex)), hex).toBe(hex)
        }
    })

    it('色相落在 0-359，饱和度/明度落在 0-100', () => {
        for (const hex of SAMPLES) {
            const hsv = hexToHsv(hex)
            expect(hsv.h, hex).toBeGreaterThanOrEqual(0)
            expect(hsv.h, hex).toBeLessThan(360)
            expect(hsv.s, hex).toBeGreaterThanOrEqual(0)
            expect(hsv.s, hex).toBeLessThanOrEqual(100)
            expect(hsv.v, hex).toBeGreaterThanOrEqual(0)
            expect(hsv.v, hex).toBeLessThanOrEqual(100)
        }
    })

    it('纯黑纯白没有色相但有明度（不返回 NaN）', () => {
        expect(hexToHsv('#000000')).toEqual({ h: 0, s: 0, v: 0 })
        expect(hexToHsv('#ffffff')).toEqual({ h: 0, s: 0, v: 100 })
    })

    it('饱和度/明度不取整：取整会让"拖完松手"跳一格（#b98cf0 → #b88bf0）', () => {
        expect(hexToHsv('#b98cf0').v % 1).not.toBe(0)
    })

    it('脏输入按白色处理，不抛错', () => {
        expect(hexToHsv('not-a-color')).toEqual({ h: 0, s: 0, v: 100 })
        expect(hsvToHex({ h: 720, s: 200, v: -20 })).toMatch(/^#[0-9a-f]{6}$/)
    })

    it('明度是"取最亮通道"，与 sRGB 亮度不是一回事（拖到顶不该变灰）', () => {
        expect(hexToHsv('#7accff').v).toBe(100)
        expect(relativeLuma('#7accff')).toBeLessThan(0.6)
    })
})

describe('色块上的对比字色', () => {
    it('浅色块配黑字、深色块配白字', () => {
        for (const hex of ['#ffffff', '#f4f6fb', '#7accff', '#b98cf0']) {
            expect(contrastTextOn(hex), hex).toBe('#000000')
        }
        for (const hex of ['#000000', '#123a7a', '#3a3d45']) {
            expect(contrastTextOn(hex), hex).toBe('#ffffff')
        }
    })

    it('快捷色板里的每个色值都合法且能算出字色', () => {
        const flat = COLOR_PALETTE.flat()
        expect(flat.length).toBeGreaterThanOrEqual(16)
        for (const hex of flat) {
            expect(hex, hex).toMatch(/^#[0-9a-f]{6}$/)
            expect(['#000000', '#ffffff']).toContain(contrastTextOn(hex))
        }
    })
})
