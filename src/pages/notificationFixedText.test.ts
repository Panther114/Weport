import { describe, expect, it } from 'vitest'
import { resolveNotificationTheme, type BandSample } from './useNotificationAdaptiveTheme'
import {
  GRADIENT_PRESETS,
  GRADIENT_PRESET_MIN_LUMA_DELTA,
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

describe('glassTextPolarity：极性由「填充 × 不透明度」合成后的实际观感决定', () => {
  const withGlass = (patch: Partial<NotificationGlass>): NotificationGlass => ({ ...NOTIFICATION_GLASS_DEFAULT, ...patch })

  it('默认（浅色渐变 60%）→ 深色文字', () => {
    expect(glassTextPolarity(NOTIFICATION_GLASS_DEFAULT)).toBe('dark')
  })

  it('不透明的亮色填充 → 深色文字', () => {
    for (const fillColor of ['#ffffff', '#f5f5f5', '#e0e0e0', '#c8c8c8', '#80c0ff']) {
      expect(glassTextPolarity(withGlass({ fillMode: 'solid', fillColor, fillOpacity: 100 }), 0.5), fillColor).toBe('dark')
    }
  })

  it('不透明的暗色填充 → 浅色文字', () => {
    for (const fillColor of ['#000000', '#161412', '#333333', '#2b2b3a']) {
      expect(glassTextPolarity(withGlass({ fillMode: 'solid', fillColor, fillOpacity: 100 }), 0.5), fillColor).toBe('light')
    }
  })

  it('关掉填充 → 深色文字（玻璃全透明，背后就是桌面）', () => {
    expect(glassTextPolarity(withGlass({ fill: false }))).toBe('dark')
  })

  it('填充色非法时退回默认白 → 深色文字，不抛错', () => {
    expect(glassTextPolarity(withGlass({ fillMode: 'solid', fillColor: 'not-a-color' }))).toBe('dark')
    expect(glassTextPolarity(withGlass({ fillMode: 'solid', fillColor: '' }))).toBe('dark')
  })

  /**
   * 用户报的第二个问题：
   *
   *  「文字色的自适应只看了渐变/填充色，没考虑这些颜色乘上**不透明度**之后的实际效果。」
   *
   * 旧实现只看填充色本身，于是"20% 的黑"（实际上几乎是透明的）被当成"暗色填充"配白字，
   * 落在亮桌面上就是浅底白字。这里的四组断言把两件事分别钉住：
   *  · 低不透明度时结论**跟着背景走**（因为背景才是画面里的大头）；
   *  · 同一个填充色在满不透明度下结论**相反** —— 证明确实是"合成"在起作用，
   *    而不是又退回"看填充色"。
   */
  it('低不透明度时按合成结果判：浅底配深字、暗底配浅字', () => {
    const translucentBlack = withGlass({ fillMode: 'solid', fillColor: '#000000', fillOpacity: 20 })
    // 20% 黑落在亮桌面（0.82）→ 合成 ≈ 0.66 → 深字
    expect(glassTextPolarity(translucentBlack, 0.82)).toBe('dark')
    // 10% 白落在近黑桌面（0.02）→ 合成 ≈ 0.12 → 浅字
    expect(glassTextPolarity(withGlass({ fillMode: 'solid', fillColor: '#ffffff', fillOpacity: 10 }), 0.02)).toBe('light')

    // 同样两个颜色，满不透明度下结论翻转（证明确实是"合成"在起作用）
    expect(glassTextPolarity(withGlass({ fillMode: 'solid', fillColor: '#000000', fillOpacity: 100 }), 0.82)).toBe('light')
    expect(glassTextPolarity(withGlass({ fillMode: 'solid', fillColor: '#ffffff', fillOpacity: 100 }), 0.06)).toBe('dark')
  })

  it('渐变按代表色合成：整张卡只有一个极性，不让一端翻车', () => {
    // #ffffff → #000000（代表色≈中灰 0.216），60% 不透明度
    const glass = withGlass({ fillMode: 'gradient', fillGradientFrom: '#ffffff', fillGradientTo: '#000000', fillOpacity: 60 })
    // 中灰背景（0.5）：合成 ≈ 0.33 → 深字
    expect(glassTextPolarity(glass, 0.5)).toBe('dark')
    // 近黑背景（0.0）：合成 ≈ 0.13 → 浅字
    expect(glassTextPolarity(glass, 0.0)).toBe('light')
  })

  it('没有背景采样时按中灰（0.5）估：不确定的假设不把任一端判死', () => {
    const glass = withGlass({ fillMode: 'solid', fillColor: '#808080', fillOpacity: 60 })
    // 合成 = 0.6*0.216 + 0.4*0.5 = 0.33 → 深字（对比度 6.4 vs 2.9）
    expect(glassTextPolarity(glass, 0.5)).toBe('dark')
  })

  it('渐变填充取两端中点判极性：每一对预设都与它声明的极性一致', () => {
    // 预设自带 `expect`（这一对**应该**配什么颜色的文字）。这里拿函数对它账，
    // 而不是反过来写死"除了石墨都是深字" —— 那样新增一个暗色预设就会静默判错。
    // 用 100% 不透明度：预设的 expect 描述的是"这套配色本身"，与背景无关。
    for (const preset of GRADIENT_PRESETS) {
      expect(
        glassTextPolarity(
          withGlass({ fillMode: 'gradient', fillGradientFrom: preset.from, fillGradientTo: preset.to, fillOpacity: 100 }),
          0.5
        ),
        preset.id
      ).toBe(preset.expect)
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

    it('暗色填充（不透明）→ 预览文字变浅色（说明控件真的动了）', () => {
      const vars = notificationGlassTextVars(
        withGlass({ fillMode: 'gradient', fillGradientFrom: '#3a3d45', fillGradientTo: '#1c1e23', fillOpacity: 100 })
      )
      expect(luma(vars['--noti-title-color'])).toBeGreaterThan(0.6)
    })

    it('预览也按"填充 × 不透明度"合成：极淡的暗色填充落在亮底上仍配深字', () => {
      // 10% 的黑几乎透明 —— 预览（中灰底）里它依然是浅色板，配深字
      const vars = notificationGlassTextVars(
        withGlass({ fillMode: 'solid', fillColor: '#000000', fillOpacity: 10 }),
        0.5
      )
      expect(luma(vars['--noti-title-color'])).toBeLessThan(0.12)
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
    const value = notificationGlassFillValue(
      withGlass({ fillMode: 'solid', fillColor: '#ffffff', fillOpacity: 16 })
    )
    expect(value).toBe('rgba(255, 255, 255, 0.16)')
    expect(notificationGlassVars(withGlass({ fillMode: 'solid', fillColor: '#ffffff', fillOpacity: 16 }))['--glass-fill']).toBe(value)
  })

  /**
   * 默认值 = 用户那套配置，**v1.0.1 逐项对齐了他本机的 Weport-config.json**。
   *
   * 用户的要求是"我的当前设置就是默认值，一按恢复默认不该有任何变化"。所以这条
   * 断言钉的不是审美，而是**他的那串值**：60% 晴空渐变、文字色自动（空串，
   * 不是手动黑）、圆角 **25**、无描边/投影/折射/磨砂、宽度 344、4 行。
   * 以后要改默认值，必须在这里留痕 —— 那等于替用户改观感。
   */
  it('默认值 = 晴空渐变 60% + 自动文字色 + 圆角 25 + 宽度 344', () => {
    const d = NOTIFICATION_GLASS_DEFAULT
    expect(d.fill).toBe(true)
    expect(d.fillMode).toBe('gradient')
    expect(d.fillGradientFrom).toBe('#d8ecff')
    expect(d.fillGradientTo).toBe('#6aa9ea')
    expect(d.fillOpacity).toBe(60)
    // 空串 = 按填充色极性自动（用户配置里 notificationGlassTextColor 就是空串）
    expect(d.textColor).toBe('')
    expect(d.radius).toBe(25)
    expect(d.borderWidth).toBe(0)
    expect(d.borderOpacity).toBe(0)
    expect(d.blur).toBe(0)
    expect(d.frost).toBe(0)
    expect(d.shadow).toBe(0)
    expect(d.width).toBe(344)
    expect(d.maxLines).toBe(4)
    expect(notificationGlassFillValue(d)).toBe('linear-gradient(90deg, rgba(216, 236, 255, 0.6), rgba(106, 169, 234, 0.6))')
  })

  const presetLuma = (hex: string) => {
    const n = parseInt(hex.slice(1), 16)
    const lin = (v: number) => {
      const s = v / 255
      return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
    }
    return 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255)
  }

  /**
   * 用户原话（v1.0.1）：**"变化太细微了"**。
   *
   * 旧列表里最平的一条两端相对亮度只差 0.044 —— 60% 铺上去读起来就是一块纯色，
   * 用户会以为预设没生效。这条断言把"每一对都要看得出变化"变成硬约束：以后
   * 不可能再把一条几乎同色的浅灰混进预设列表。
   */
  it('每一条预设两端都真的看得出变化（相对亮度差 ≥ 0.20）', () => {
    for (const preset of GRADIENT_PRESETS) {
      const delta = Math.abs(presetLuma(preset.from) - presetLuma(preset.to))
      expect(delta, `${preset.id}（${preset.label}）ΔL=${delta.toFixed(3)}`).toBeGreaterThanOrEqual(
        GRADIENT_PRESET_MIN_LUMA_DELTA
      )
    }
  })

  /** 默认那一条自己也要够狠 —— 它就是用户每天看到的那张卡片。 */
  it('默认渐变两端差别够大（相对亮度差 ≥ 0.20）', () => {
    const d = NOTIFICATION_GLASS_DEFAULT
    expect(Math.abs(presetLuma(d.fillGradientFrom) - presetLuma(d.fillGradientTo))).toBeGreaterThanOrEqual(
      GRADIENT_PRESET_MIN_LUMA_DELTA
    )
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
    expect(g.fillMode).toBe(NOTIFICATION_GLASS_DEFAULT.fillMode)
    expect(g.fillGradientFrom).toBe(NOTIFICATION_GLASS_DEFAULT.fillGradientFrom)
    expect(g.fillGradientTo).toBe(NOTIFICATION_GLASS_DEFAULT.fillGradientTo)
    expect(g.fillOpacity).toBe(100)
  })

  it('预设色板本身合法：色值都是 #rrggbb、两端不相同、极性声明齐全', () => {
    // v1.0.1 起预设大幅扩容（旧列表 9 条且大半几乎同色）。下限抬到 20 条，
    // 让"多给一些预设"这件事也有个可对账的数。
    expect(GRADIENT_PRESETS.length).toBeGreaterThanOrEqual(20)
    for (const preset of GRADIENT_PRESETS) {
      expect(preset.from, preset.id).toMatch(/^#[0-9a-f]{6}$/)
      expect(preset.to, preset.id).toMatch(/^#[0-9a-f]{6}$/)
      // 两端相同就不是渐变了，会让用户以为没生效
      expect(preset.from, preset.id).not.toBe(preset.to)
      expect(['dark', 'light'], preset.id).toContain(preset.expect)
    }
    // 预设 id 唯一：设置页用 id 当 React key，重名会让点击选错色
    expect(new Set(GRADIENT_PRESETS.map((p) => p.id)).size).toBe(GRADIENT_PRESETS.length)
    // 第一项就是默认值：预设列表的第一个必须能"一键回到默认的观感"
    expect(GRADIENT_PRESETS[0].from).toBe(NOTIFICATION_GLASS_DEFAULT.fillGradientFrom)
    expect(GRADIENT_PRESETS[0].to).toBe(NOTIFICATION_GLASS_DEFAULT.fillGradientTo)
    expect(GRADIENT_PRESETS[0].label).toBe('晴空')
  })
})
