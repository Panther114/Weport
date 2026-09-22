/**
 * 浮层定位 —— 纯函数，便于单测。
 *
 * ## 为什么要有这个文件（真实 bug 的复盘）
 *
 * 应用里的弹层（`@` 选择器、取色器、快捷动作菜单）原本都是**在文档流里**
 * `position: absolute` 挂在触发元素旁边。这在一个滚动容器里是错的：
 * `.webot` 是 `overflow-y: auto`，弹层向上展开时只要越过容器上边缘，就被整块裁掉 ——
 * 用户报的正是"在 WeBot 里按 @，弹窗在顶部被切掉，因为它不在最上层"。
 *
 * 有一类修法是在每个祖先上把 `overflow` 改成 `visible`，那是错的方向：
 * 那些 `overflow` 是布局本身需要的（列表要滚、卡片要圆角裁切），
 * 为了一个弹层把它们全部放开，等于把整个页面的滚动语义拆掉。
 *
 * 正确的做法是把弹层**渲染到 body 下的浮层容器**，再用视口坐标定位，
 * 并且在没有空间时翻转到另一侧、贴边时夹回视口内。这些算术全在这里，
 * 组件只负责测量与监听。
 */

export type FloatingPlacement = 'top-start' | 'top-end' | 'bottom-start' | 'bottom-end'

export interface FloatingRect {
  top: number
  left: number
  right: number
  bottom: number
  width: number
  height: number
}

export interface FloatingInput {
  anchor: FloatingRect
  /** 浮层自身尺寸（测量值；宽度给定时按给定宽度算） */
  layer: { width: number; height: number }
  viewport: { width: number; height: number }
  /** 期望方向；空间不足时自动翻到另一侧 */
  placement: FloatingPlacement
  /** 与触发元素的间距 */
  gap?: number
  /** 与视口边缘的最小间距 */
  margin?: number
  /**
   * 浮层自身的最小可用高度。
   *
   * 两侧都放不下时不再翻转，而是压到"可用空间"并让浮层内部滚动 ——
   * 一个能滚的 200px 列表，比一个跑到屏幕外的完整列表有用。
   */
  minHeight?: number
}

export interface FloatingResult {
  top: number
  left: number
  /** 实际采用的方向（可能因空间不足翻转） */
  side: 'top' | 'bottom'
  align: 'start' | 'end'
  /**
   * 浮层的最大高度；`null` 表示**不设上限**。
   *
   * 返回 null 而不是"自然高度"是有原因的：把 `max-height` 钉成当前高度会**锁死**
   * 布局 —— 内容（例如候选列表从空变成 60 条）想长高时根节点的 max-height 不让，
   * 根节点尺寸因此完全不变，ResizeObserver 不触发，于是浮层永远停在按旧高度算出的
   * 位置上。空间够用时索性不下发上限，让浮层自己长，尺寸变化才会被观察到。
   */
  maxHeight: number | null
}

const DEFAULT_GAP = 8
const DEFAULT_MARGIN = 8
const DEFAULT_MIN_HEIGHT = 140

function clamp(value: number, min: number, max: number): number {
  if (max < min) return min
  return Math.min(max, Math.max(min, value))
}

/**
 * 计算浮层的视口坐标。
 *
 * 翻转规则是"哪边更大就用哪边"，而不是"放不下才翻"：在窗口底部打开一个向上弹的
 * 浮层时，上方可能只剩 90px，下方也只有 120px —— 后者更可用。
 */
export function computeFloatingPosition(input: FloatingInput): FloatingResult {
  const gap = input.gap ?? DEFAULT_GAP
  const margin = input.margin ?? DEFAULT_MARGIN
  const minHeight = Math.max(0, input.minHeight ?? DEFAULT_MIN_HEIGHT)
  const { anchor, layer, viewport } = input

  const prefSide: 'top' | 'bottom' = input.placement.startsWith('top') ? 'top' : 'bottom'
  const align: 'start' | 'end' = input.placement.endsWith('end') ? 'end' : 'start'

  const spaceBelow = viewport.height - anchor.bottom - gap - margin
  const spaceAbove = anchor.top - gap - margin

  let side = prefSide
  const wanted = layer.height
  if (side === 'bottom' && spaceBelow < wanted && spaceAbove > spaceBelow) side = 'top'
  else if (side === 'top' && spaceAbove < wanted && spaceBelow > spaceAbove) side = 'bottom'

  const available = Math.max(0, side === 'bottom' ? spaceBelow : spaceAbove)

  /**
   * 只在**真的放不下**时才下发上限。
   *
   * `maxHeight` 的语义是"压到可用空间，内部滚动"；空间够用时它是多余的，而且有害
   * （见 FloatingResult.maxHeight 的说明）。真的放不下时留一个下限：一个 20px 高的
   * 列表和不存在没有区别，宁可溢出一点也要留住可读性。
   */
  const maxHeight = wanted <= available ? null : Math.max(minHeight, available)

  /**
   * **定位必须用"浮层实际会有多高"。**
   *
   * 早期版本拿 maxHeight 去算 top，于是在 minHeight 大于浮层自然高度的常见情况下，
   * 浮层被凭空往下推 —— 实测 WeportAI 的 `@` 选择器（自然高 101、minHeight 180、
   * 锚点在 y=588 的 650 高视口里）被放到了 top=402，整块跑到视口外面。
   */
  const effectiveHeight = wanted

  let top = side === 'bottom' ? anchor.bottom + gap : anchor.top - gap - effectiveHeight
  // 最后一道保险：无论怎么算都不许跑出视口。真的比视口还高时以顶边为准。
  const tallest = maxHeight ?? effectiveHeight
  top = clamp(top, margin, Math.max(margin, viewport.height - tallest - margin))

  const left =
    align === 'end'
      ? anchor.right - layer.width
      : anchor.left

  return {
    top: Math.round(top),
    left: Math.round(clamp(left, margin, viewport.width - layer.width - margin)),
    side,
    align,
    maxHeight: maxHeight === null ? null : Math.round(maxHeight),
  }
}
