import { describe, expect, it } from 'vitest'
import { computeFloatingPosition, type FloatingInput } from './floatingPosition'

/**
 * 浮层定位的回归测试。
 *
 * 这里的每一条都对应用户真正能看到的一种坏结果：被祖先裁掉、跑到屏幕外、
 * 盖住触发元素、或者在一个 90px 的缝里挤出一个 20px 高的列表。
 */

const anchorAt = (top: number, height = 32, left = 100, width = 260) => ({
  top,
  left,
  right: left + width,
  bottom: top + height,
  width,
  height,
})

function input(over: Partial<FloatingInput> = {}): FloatingInput {
  return {
    anchor: anchorAt(400),
    layer: { width: 380, height: 320 },
    viewport: { width: 1280, height: 800 },
    placement: 'top-start',
    gap: 6,
    ...over,
  }
}

describe('computeFloatingPosition', () => {
  it('空间充足时保持期望方向，贴着锚点', () => {
    const r = computeFloatingPosition(input({ placement: 'top-start' }))
    expect(r.side).toBe('top')
    // top = anchor.top - gap - 高度
    expect(r.top).toBe(400 - 6 - 320)
    expect(r.left).toBe(100)
  })

  it('上方放不下时翻到下方（这就是被裁掉的那一侧）', () => {
    // 锚点离顶部只有 40px，上方放不下 320 的浮层
    const r = computeFloatingPosition(input({ anchor: anchorAt(40), placement: 'top-start' }))
    expect(r.side).toBe('bottom')
    expect(r.top).toBe(40 + 32 + 6)
  })

  it('下方放不下时翻到上方', () => {
    const r = computeFloatingPosition(input({ anchor: anchorAt(740), placement: 'bottom-start' }))
    expect(r.side).toBe('top')
    expect(r.top).toBe(740 - 6 - 320)
  })

  it('两侧都放不下时贴在空间更大的那一侧，并压到可用高度（内部滚动）', () => {
    const r = computeFloatingPosition(
      input({ anchor: anchorAt(180), placement: 'top-start', viewport: { width: 1280, height: 360 } })
    )
    // 上方 166、下方 134 → 选上方，压到 166
    expect(r.side).toBe('top')
    expect(r.maxHeight).toBe(166)
    // 浮层底边贴在锚点上方，不会盖住触发元素
    expect(r.top + 166).toBeLessThanOrEqual(180 - 6)
  })

  it('可用高度有下限：一条 20px 高的列表等于不存在', () => {
    const r = computeFloatingPosition(
      input({ anchor: anchorAt(30), placement: 'top-start', viewport: { width: 1280, height: 120 }, minHeight: 140 })
    )
    expect(r.maxHeight).toBe(140)
  })

  /**
   * 真实回归：`max-height` 只是上限，**不是**浮层的高度。
   *
   * 早期版本拿 maxHeight 去算 top，于是在 minHeight 大于浮层自然高度的常见情况下，
   * 浮层被凭空往下推 —— 实测 WeportAI 的 `@` 选择器（自然高 101、minHeight 180、
   * 锚点在 y=588 的 650 高视口里）被放到了 top=402，整块跑到视口下面。
   */
  it('空间够用时不下发高度上限（否则钉死的高度会挡住内容长大）', () => {
    const r = computeFloatingPosition(
      input({
        anchor: anchorAt(588, 38, 508, 400),
        layer: { width: 380, height: 101 },
        placement: 'top-start',
        gap: 6,
        minHeight: 180,
        viewport: { width: 1280, height: 650 },
      })
    )
    expect(r.side).toBe('top')
    expect(r.maxHeight).toBeNull()
    // 浮层底边 = 锚点顶边 - gap（用 101 定位，不是 180）
    expect(r.top).toBe(588 - 6 - 101)
  })

  it('真的放不下时才下发上限，并保留 minHeight 下限', () => {
    const tight = computeFloatingPosition(
      input({
        anchor: anchorAt(300, 38),
        layer: { width: 380, height: 600 },
        placement: 'top-start',
        minHeight: 140,
        viewport: { width: 1280, height: 400 },
      })
    )
    // 上方 286、下方 54 → 选上方，压到 286
    expect(tight.side).toBe('top')
    expect(tight.maxHeight).toBe(286)
    expect(tight.top + 286).toBeLessThanOrEqual(300 - 6)

    const tiny = computeFloatingPosition(
      input({
        anchor: anchorAt(120, 38),
        layer: { width: 380, height: 600 },
        placement: 'bottom-start',
        minHeight: 140,
        viewport: { width: 1280, height: 200 },
      })
    )
    // 两侧都远小于 140 → 保留 140 的可读下限
    expect(tiny.maxHeight).toBe(140)
  })

  it('贴边保护：算出来的位置不许跑出视口', () => {
    const below = computeFloatingPosition(
      input({ anchor: anchorAt(600, 38), placement: 'bottom-start', layer: { width: 380, height: 200 }, minHeight: 40 })
    )
    expect(below.top + 200).toBeLessThanOrEqual(800 - 8 + 0.5)
    const above = computeFloatingPosition(
      input({ anchor: anchorAt(30, 38), placement: 'top-start', layer: { width: 380, height: 200 }, minHeight: 40 })
    )
    expect(above.top).toBeGreaterThanOrEqual(8)
  })

  it('左边超出视口时夹回视口内（带 8px 边距）', () => {
    const r = computeFloatingPosition(input({ anchor: anchorAt(400, 32, -20) }))
    expect(r.left).toBe(8)
  })

  it('右边超出视口时同样夹回来，浮层不会被切掉右半边', () => {
    const r = computeFloatingPosition(input({ anchor: anchorAt(400, 32, 1200) }))
    expect(r.left).toBe(1280 - 380 - 8)
  })

  it('end 对齐时右边缘与锚点对齐', () => {
    const r = computeFloatingPosition(input({ placement: 'top-end', anchor: anchorAt(400, 32, 600) }))
    expect(r.left).toBe(600 + 260 - 380)
  })

  it('视口比浮层还窄时不会算出负数坐标', () => {
    const r = computeFloatingPosition(input({ viewport: { width: 320, height: 800 }, layer: { width: 380, height: 200 } }))
    expect(r.left).toBe(8)
  })

  it('锚点为 0 尺寸时不崩（未布局的元素）', () => {
    const r = computeFloatingPosition(input({ anchor: { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 } }))
    expect(Number.isFinite(r.top)).toBe(true)
    expect(r.left).toBe(8)
  })

  it('幂等：同一个（锚点、自然高度、视口）永远得到同一个结果', () => {
    const anchor = anchorAt(180)
    const viewport = { width: 1280, height: 360 }
    const a = computeFloatingPosition(input({ anchor, viewport }))
    const b = computeFloatingPosition(input({ anchor, viewport }))
    expect(b).toEqual(a)
    /**
     * 反例，说明组件为什么**必须**传"内容自然高度"而不是被压过之后的盒子高度：
     * 用压出来的 166 再算一次，结论会翻成"空间够用、不用设上限" —— 浮层于是长回去、
     * 再被压下来，ResizeObserver 每轮都触发，弹层疯狂闪烁。
     */
    const wrong = computeFloatingPosition(input({ anchor, viewport, layer: { width: 380, height: a.maxHeight! } }))
    expect(wrong.maxHeight).not.toBe(a.maxHeight)
  })
})
