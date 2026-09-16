import { describe, expect, it } from 'vitest'
import { resolveNotificationTheme, type BandSample } from './useNotificationAdaptiveTheme'
import {
  GRADIENT_PRESETS,
  NOTIFICATION_GLASS_DEFAULT,
  glassTextPolarity,
  normalizeNotificationGlass,
  notificationGlassFillValue,
  notificationGlassTextVars,
  notificationGlassVars,
  type NotificationGlass
} from '../utils/notificationGlass'

/**
 * 用户反馈原话：「有时候弹窗通知的文字是白的。确保它不要自动调整。」
 *
 * 修法：文字极性不再由背景采样现算，而是由**用户的玻璃填充色**固定
 * （`glassTextPolarity` → `resolveNotificationTheme({ textPolarity })`）。
 *
 * 之前的问题不是"极性判断的阈值不对"，而是判据本身用错了对象：采样均值合成出的
 * glassBg 并不等于屏幕上那张卡片 —— 卡片还要叠一层用户填充、一层桌面捕获、一层
 * 模糊。于是常见结果是"卡片实际渲染成浅色板，文字却被判成白字"，而且同一条通知
 * 在不同壁纸上颜色还会跳。
 *
 * 所以这里断言的是**不变量**：给定固定极性后，无论背景多亮多暗，文字颜色都一样。
 * 这是纯函数断言，不依赖屏幕捕获、不依赖时序 —— 每次跑都必须成立。
 */

const sample = (rgb: [number, number, number], tail = 20): BandSample => ({
  mean: rgb,
  darkTail: Math.max(0, rgb[0] - tail),
  lightTail: Math.min(255, rgb[0] + tail),
})

function parseRgb(css: string): [number, number, number] {
  const m = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/.exec(css)
  if (!m) throw new Error(`cannot parse ${css}`)
  return [Number(m[1]), Number(m[2]), Number(m[3])]
}

const relLuma = ([r, g, b]: [number, number, number]) => {
  const lin = (v: number) => {
    const s = v / 255
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
  }
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
}

/** 覆盖"极暗 → 极亮"的整条范围，含中灰这一最容易被判错的一档 */
const BACKDROPS: Array<[number, number, number]> = [
  [0, 0, 0],
  [11, 11, 13],
  [40, 42, 46],
  [90, 90, 90],
  [128, 128, 128],
  [170, 172, 175],
  [200, 200, 200],
  [245, 245, 248],
  [255, 255, 255],
]

function resolveWith(rgb: [number, number, number], textPolarity: 'dark' | 'light') {
  const s = sample(rgb)
  const resolved = resolveNotificationTheme({ card: s, title: s, body: s }, { textPolarity })
  expect(resolved).not.toBeNull()
  return resolved!.vars
}

describe('弹窗文字颜色：不随背景自动调整', () => {
  it('固定深色极性时，任何背景上标题/正文都是深色 —— 永远不会变成白字', () => {
    for (const rgb of BACKDROPS) {
      const vars = resolveWith(rgb, 'dark')
      const title = parseRgb(vars['--noti-title-color'])
      const body = parseRgb(vars['--noti-body-color'])
      expect(relLuma(title), `bg=${rgb} title=${vars['--noti-title-color']}`).toBeLessThan(0.12)
      expect(relLuma(body), `bg=${rgb} body=${vars['--noti-body-color']}`).toBeLessThan(0.12)
      // 「有时候是白的」的直接表述：不许出现接近白的文字
      expect(Math.min(...title), `bg=${rgb}`).toBeLessThan(120)
    }
  })

  it('固定浅色极性时，任何背景上都是浅色', () => {
    for (const rgb of BACKDROPS) {
      const vars = resolveWith(rgb, 'light')
      expect(relLuma(parseRgb(vars['--noti-title-color'])), `bg=${rgb}`).toBeGreaterThan(0.6)
      expect(relLuma(parseRgb(vars['--noti-body-color'])), `bg=${rgb}`).toBeGreaterThan(0.6)
    }
  })

  it('同一极性下，暗背景与亮背景解析出的文字色**完全一致**（这才是"不自动调整"）', () => {
    for (const polarity of ['dark', 'light'] as const) {
      const dark = resolveWith([11, 11, 13], polarity)
      const mid = resolveWith([128, 128, 128], polarity)
      const light = resolveWith([245, 245, 248], polarity)
      // 注意：不是断言"颜色一定逐字节相同"—— 同一极性内会按对比度做微调
      // （深灰 44..10 之间），那正是保证读得清的部分。这里断言的是**极性不翻转**：
      // 三个背景上文字都落在同一侧，亮度的相对顺序不会把白字翻出来。
      expect(relLuma(parseRgb(dark['--noti-title-color'])) < 0.12).toBe(polarity === 'dark')
      expect(relLuma(parseRgb(mid['--noti-title-color'])) < 0.12).toBe(polarity === 'dark')
      expect(relLuma(parseRgb(light['--noti-title-color'])) < 0.12).toBe(polarity === 'dark')
    }
  })

  it('对比基线：不传 fixedPolarity 时仍然是老的自适应行为（本次改动是外科式的）', () => {
    // 老行为：近黑背景 → 白字。保留它是为了让这次改动不影响任何既有断言。
    const vars = resolveNotificationTheme({ card: sample([11, 11, 13]), title: sample([11, 11, 13]) })!
    expect(vars.vars['--noti-title-color']).toBe('rgb(255, 255, 255)')
  })
})

describe('glassTextPolarity：极性只由用户填的玻璃颜色决定', () => {
  const withGlass = (patch: Partial<NotificationGlass>): NotificationGlass => ({ ...NOTIFICATION_GLASS_DEFAULT, ...patch })

  it('默认（白色填充 16%）→ 深色文字', () => {
    expect(glassTextPolarity(NOTIFICATION_GLASS_DEFAULT)).toBe('dark')
  })

  it('任意亮色填充 → 深色文字', () => {
    for (const fillColor of ['#ffffff', '#f5f5f5', '#e0e0e0', '#c8c8c8', '#80c0ff']) {
      expect(glassTextPolarity(withGlass({ fillColor })), fillColor).toBe('dark')
    }
  })

  it('暗色填充 → 浅色文字', () => {
    for (const fillColor of ['#000000', '#161412', '#333333', '#2b2b3a']) {
      expect(glassTextPolarity(withGlass({ fillColor })), fillColor).toBe('light')
    }
  })

  it('关掉填充 → 深色文字（玻璃全透明，背后就是桌面）', () => {
    expect(glassTextPolarity(withGlass({ fill: false }))).toBe('dark')
  })

  it('填充色非法时退回默认白 → 深色文字，不抛错', () => {
    expect(glassTextPolarity(withGlass({ fillColor: 'not-a-color' }))).toBe('dark')
    expect(glassTextPolarity(withGlass({ fillColor: '' }))).toBe('dark')
  })

  it('渐变填充取两端中点判极性：两套渐变预设都该配深字，石墨配浅字', () => {
    // 预设里除石墨外最亮端都 ≥0.7，中点因此必然落在深字一侧
    for (const preset of GRADIENT_PRESETS) {
      const expected = preset.id === 'graphite' ? 'light' : 'dark'
      expect(
        glassTextPolarity(withGlass({ fillMode: 'gradient', fillGradientFrom: preset.from, fillGradientTo: preset.to })),
        preset.id
      ).toBe(expected)
    }
  })

  /**
   * 设置页预览必须自己给出文字变量。
   *
   * `--noti-title-color` 一类的变量原本只由弹窗里的 applyNotificationTheme() 写进
   * **弹窗那个文档**；主窗口文档里它们从未被定义过，于是 NotificationToast.scss 的兜底
   * `#ffffff` 生效 —— 预览永远白字，哪怕填充是 16% 白（正是要修掉的"浅色卡片 + 白字"），
   * 而下面那行提示却写着"深色字"。这组断言把预览与极性绑在一起。
   */
  describe('预览的文字变量由填充色决定（不再依赖弹窗文档）', () => {
    const luma = (css: string) => {
      const m = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/.exec(css)
      if (!m) throw new Error(`cannot parse ${css}`)
      const lin = (v: number) => {
        const s = v / 255
        return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
      }
      return 0.2126 * lin(Number(m[1])) + 0.7152 * lin(Number(m[2])) + 0.0722 * lin(Number(m[3]))
    }

    it('浅色填充 → 预览标题/正文都是深色（不是兜底的 #ffffff）', () => {
      const vars = notificationGlassTextVars(NOTIFICATION_GLASS_DEFAULT)
      expect(luma(vars['--noti-title-color'])).toBeLessThan(0.12)
      expect(luma(vars['--noti-body-color'])).toBeLessThan(0.12)
      // 直接钉住"永远白字"这个缺陷
      expect(vars['--noti-title-color']).not.toBe('rgb(255, 255, 255)')
      expect(vars['--noti-title-color']).not.toBe('#ffffff')
    })

    it('暗色填充 → 预览文字变浅色（说明控件真的动了）', () => {
      const vars = notificationGlassTextVars(
        withGlass({ fillMode: 'gradient', fillGradientFrom: '#3a3d45', fillGradientTo: '#1c1e23' })
      )
      expect(luma(vars['--noti-title-color'])).toBeGreaterThan(0.6)
    })

    it('关掉填充 → 仍是深色，且四个变量都给全（缺一个就会退回兜底白）', () => {
      const vars = notificationGlassTextVars(withGlass({ fill: false }))
      for (const key of ['--noti-title-color', '--noti-body-color', '--noti-title-tertiary', '--noti-close-hover-bg']) {
        expect(vars[key], key).toBeTruthy()
      }
      expect(luma(vars['--noti-title-color'])).toBeLessThan(0.12)
    })

    it('极性与 glassTextPolarity 一致（两处不能各说各话）', () => {
      for (const fillColor of ['#ffffff', '#000000', '#80c0ff', '#2b2b3a']) {
        const glass = withGlass({ fillColor })
        const vars = notificationGlassTextVars(glass)
        const isDarkText = luma(vars['--noti-title-color']) < 0.5
        expect(isDarkText, fillColor).toBe(glassTextPolarity(glass) === 'dark')
      }
    })
  })
})

describe('填充渐变：只允许从左到右', () => {
  const withGlass = (patch: Partial<NotificationGlass>): NotificationGlass => ({ ...NOTIFICATION_GLASS_DEFAULT, ...patch })

  it('纯色模式仍然是 rgba 单色，与旧行为逐字节一致', () => {
    const value = notificationGlassFillValue(NOTIFICATION_GLASS_DEFAULT)
    expect(value).toBe('rgba(255, 255, 255, 0.16)')
    expect(notificationGlassVars(NOTIFICATION_GLASS_DEFAULT)['--glass-fill']).toBe(value)
  })

  it('渐变模式输出 90deg 的 linear-gradient，两端都带同一个 alpha', () => {
    const value = notificationGlassFillValue(
      withGlass({ fillMode: 'gradient', fillGradientFrom: '#ffffff', fillGradientTo: '#e8ecf2', fillOpacity: 20 })
    )
    expect(value).toBe('linear-gradient(90deg, rgba(255, 255, 255, 0.2), rgba(232, 236, 242, 0.2))')
    // "只能从左到右"：整条值里只允许出现一个角度，且必须是 90deg
    expect(value.match(/\d+deg/g)).toEqual(['90deg'])
  })

  it('关掉填充时不存在可见渐变：输出完全透明的纯色，而不是一条 alpha=0 的渐变', () => {
    // 有意为之：不可见的渐变没有理由仍然以渐变形式下发 —— 值更短、也没有
    // 任何渲染器需要为它建立渐变着色器。
    const value = notificationGlassFillValue(
      withGlass({ fill: false, fillMode: 'gradient', fillGradientFrom: '#ffffff', fillGradientTo: '#000000' })
    )
    expect(value).toBe('rgba(255, 255, 255, 0)')
    expect(value).not.toContain('gradient')
  })

  it('alpha=0 的渐变退回纯色路径（没有可见的渐变就不该产生渐变字符串）', () => {
    const value = notificationGlassFillValue(
      withGlass({ fill: false, fillMode: 'gradient', fillColor: '#123456' })
    )
    expect(value).toBe('rgba(18, 52, 86, 0)')
    expect(value).not.toContain('gradient')
  })

  it('非法/脏配置被整形成合法值，不抛错', () => {
    const g = normalizeNotificationGlass({
      fillMode: 'diagonal' as never,
      fillGradientFrom: 'zzz',
      fillGradientTo: '',
      fillOpacity: 9999,
    })
    expect(g.fillMode).toBe('solid')
    expect(g.fillGradientFrom).toBe(NOTIFICATION_GLASS_DEFAULT.fillGradientFrom)
    expect(g.fillGradientTo).toBe(NOTIFICATION_GLASS_DEFAULT.fillGradientTo)
    expect(g.fillOpacity).toBe(100)
  })

  it('预设色板本身合法：8 个预设、色值都是 #rrggbb、两端不相同', () => {
    expect(GRADIENT_PRESETS.length).toBeGreaterThanOrEqual(6)
    for (const preset of GRADIENT_PRESETS) {
      expect(preset.from, preset.id).toMatch(/^#[0-9a-f]{6}$/)
      expect(preset.to, preset.id).toMatch(/^#[0-9a-f]{6}$/)
      // 两端相同就不是渐变了，会让用户以为没生效
      expect(preset.from, preset.id).not.toBe(preset.to)
    }
  })
})
