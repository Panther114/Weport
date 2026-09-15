import { describe, expect, it } from 'vitest'
import { resolveNotificationTheme, type BandSample } from './useNotificationAdaptiveTheme'

/**
 * 通知玻璃的两条要求，出自两条用户反馈，必须同时成立：
 *
 *   1. 「弹窗背景全黑」—— 填充不能黑到看不见卡片；
 *   2. 「玻璃近乎全透明」—— 也不能靠一块实色面板来"显形"。
 *
 * 所以断言的形状是"两侧都收窄"：合成后的卡片与背景的亮度差要**在**一个区间里
 * （够看出有面板、又远不到实色），而"卡片在不在"主要由 1px 内描边承担 —— 描边方向
 * 必须与文字极性一致，文字色仍要满足 4.5 对比度。
 */

const sample = (rgb: [number, number, number], tail = 20): BandSample => ({
  mean: rgb,
  darkTail: Math.max(0, rgb[0] - tail),
  lightTail: Math.min(255, rgb[0] + tail),
})

const luma = ([r, g, b]: [number, number, number]) => 0.2126 * r + 0.7152 * g + 0.0722 * b

function parseRgba(css: string): { rgb: [number, number, number]; alpha: number } {
  const m = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+))?\s*\)/.exec(css)
  if (!m) throw new Error(`cannot parse ${css}`)
  return {
    rgb: [Number(m[1]), Number(m[2]), Number(m[3])],
    alpha: m[4] === undefined ? 1 : Number(m[4]),
  }
}

const resolve = (rgb: [number, number, number]) => {
  const s = sample(rgb)
  const resolved = resolveNotificationTheme({ card: s, title: s, body: s })
  expect(resolved).not.toBeNull()
  const tint = parseRgba(resolved!.vars['--noti-tint'])
  const bg = s.mean
  const composited: [number, number, number] = [0, 1, 2].map((i) => bg[i] + tint.alpha * (tint.rgb[i] - bg[i])) as [number, number, number]
  return {
    tint,
    composited,
    delta: Math.abs(luma(composited) - luma(bg)),
    vars: resolved!.vars,
    shadow: resolved!.vars['--noti-shadow'],
  }
}

const BACKDROPS: Array<[number, number, number]> = [
  [0, 0, 0],
  [11, 11, 13],
  [60, 60, 64],
  [128, 128, 128],
  [200, 200, 200],
  [245, 245, 248],
  [255, 255, 255],
]

describe('通知玻璃：既显形，又近乎全透明', () => {
  it('任何背景上卡片都看得出来（不是"全黑"）', () => {
    for (const rgb of BACKDROPS) {
      const { delta, tint } = resolve(rgb)
      expect(delta, `bg=${rgb} tint=${JSON.stringify(tint)}`).toBeGreaterThanOrEqual(11)
    }
  })

  it('任何背景上填充都仍然近乎全透明', () => {
    for (const rgb of BACKDROPS) {
      const { tint } = resolve(rgb)
      expect(tint.alpha, `bg=${rgb}`).toBeLessThanOrEqual(0.17)
      // 极端背景（纯黑/纯白）上只能靠"往可见方向推一点点"，不能变成实色
      expect(tint.alpha, `bg=${rgb}`).toBeLessThanOrEqual(0.13)
    }
  })

  it('近黑背景上填充选白色方向（深色纱层在近黑上只会更黑）', () => {
    const { tint } = resolve([11, 11, 13])
    expect(tint.rgb[0]).toBeGreaterThan(200)
  })

  it('描边方向跟着极性：白字配亮描边、黑字配暗描边', () => {
    const darkBackdrop = resolve([11, 11, 13])
    expect(darkBackdrop.shadow).toContain('255, 255, 255')
    expect(darkBackdrop.vars['--noti-title-color']).toBe('rgb(255, 255, 255)')

    const lightBackdrop = resolve([245, 245, 248])
    expect(lightBackdrop.shadow).toContain('inset 0 0 0 1px rgba(0, 0, 0')
    expect(parseRgba(lightBackdrop.vars['--noti-title-color']).rgb[0]).toBeLessThan(60)
  })

  it('文字仍然达到 4.5 对比度', () => {
    const contrast = (a: number[], b: number[]) => {
      const rel = (c: number[]) => {
        const ch = c.map((v) => {
          const s = v / 255
          return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
        })
        return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2]
      }
      const [l1, l2] = [rel(a), rel(b)].sort((x, y) => y - x)
      return (l1 + 0.05) / (l2 + 0.05)
    }
    for (const rgb of [[11, 11, 13], [90, 90, 90], [200, 200, 200]] as Array<[number, number, number]>) {
      const { vars, composited } = resolve(rgb)
      const title = parseRgba(vars['--noti-title-color']).rgb
      expect(contrast(title, composited), `bg=${rgb}`).toBeGreaterThanOrEqual(4.5)
    }
  })
})
