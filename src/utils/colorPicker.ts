/**
 * 取色器的颜色换算（v1.0.1）。
 *
 * 为什么自己写而不是继续用 `<input type="color">`：系统色板是一个**模态对话框**
 * （Windows 上是旧式调色板），没有 hex 输入、没有预设行、没有取色管，而且它在
 * 设置页里只是一个 30×24 的小方块 —— 用户的原话是"very cheap UI"。
 * 这里改成面板内的浮层，因此需要自己算 HSV ↔ hex。
 *
 * 全部是纯函数，单测直接钉住往返一致性（`src/utils/colorPicker.test.ts`）。
 */

import { normalizeGlassHex } from './notificationGlass'

export interface Hsv {
    /** 0-359（整数：色相条本身按 1° 走） */
    h: number
    /**
     * 0-100，**保留小数**。
     *
     * 取整看似无害，但它会让"hex → HSV → hex"不再恒等（实测 #b98cf0 会变成
     * #b88bf0）：用户拖完松手颜色就跳一格。显示时才取整，内部一律用浮点。
     */
    s: number
    /** 0-100，保留小数（同上） */
    v: number
}

export interface Rgb {
    r: number
    g: number
    b: number
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))

export function hexToRgb(hex: string): Rgb {
    const value = normalizeGlassHex(hex) || '#ffffff'
    const n = parseInt(value.slice(1), 16)
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 }
}

export function rgbToHex({ r, g, b }: Rgb): string {
    const to = (v: number) => clamp(Math.round(v), 0, 255).toString(16).padStart(2, '0')
    return `#${to(r)}${to(g)}${to(b)}`
}

export function hexToHsv(hex: string): Hsv {
    const { r, g, b } = hexToRgb(hex)
    const rn = r / 255
    const gn = g / 255
    const bn = b / 255
    const max = Math.max(rn, gn, bn)
    const min = Math.min(rn, gn, bn)
    const d = max - min
    let h = 0
    if (d !== 0) {
        if (max === rn) h = ((gn - bn) / d) % 6
        else if (max === gn) h = (bn - rn) / d + 2
        else h = (rn - gn) / d + 4
        h *= 60
        if (h < 0) h += 360
    }
    return {
        h: Math.round(h) % 360,
        // s / v 刻意**不取整**：往返恒等靠它们（见 Hsv 的说明）
        s: max === 0 ? 0 : (d / max) * 100,
        v: max * 100,
    }
}

export function hsvToRgb({ h, s, v }: Hsv): Rgb {
    const hn = ((h % 360) + 360) % 360
    const sn = clamp(s, 0, 100) / 100
    const vn = clamp(v, 0, 100) / 100
    const c = vn * sn
    const x = c * (1 - Math.abs(((hn / 60) % 2) - 1))
    const m = vn - c
    const seg = Math.floor(hn / 60) % 6
    const table: Array<[number, number, number]> = [
        [c, x, 0],
        [x, c, 0],
        [0, c, x],
        [0, x, c],
        [x, 0, c],
        [c, 0, x],
    ]
    const [r, g, b] = table[seg]
    return { r: (r + m) * 255, g: (g + m) * 255, b: (b + m) * 255 }
}

export function hsvToHex(hsv: Hsv): string {
    return rgbToHex(hsvToRgb(hsv))
}

/** 相对亮度（WCAG），用于给色块挑对比色文字。 */
export function relativeLuma(hex: string): number {
    const { r, g, b } = hexToRgb(hex)
    const lin = (v: number) => {
        const s = v / 255
        return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
    }
    return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
}

/** 色块上该用黑字还是白字（对比度更优的一侧）。 */
export function contrastTextOn(hex: string): '#000000' | '#ffffff' {
    const luma = relativeLuma(hex)
    const withDark = (luma + 0.05) / 0.0533
    const withLight = 1.05 / (luma + 0.05)
    return withDark >= withLight ? '#000000' : '#ffffff'
}
