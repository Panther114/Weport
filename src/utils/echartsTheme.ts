/**
 * Weport 分析模块：ECharts 公共配置。
 *
 * 图表颜色从 **CSS 令牌读取**，不再写死浅蓝与深色背景色：
 *
 *  - 强调色家族（--accent / --accent-2..6 / --accent-deep）由 theme.scss 按
 *    用户选的强调色推导，因此换主题时图表跟着换色；
 *  - 文字/网格/提示框颜色读 --text-dim / --text-faint / --line / --elevated，
 *    否则浅色模式下会是"深色网格 + 深色文字"画在白底上，直接看不见。
 *
 * 读取方式是"启动时读一次 + 主题变化时重读"。ECharts 画在 canvas 上，不认
 * `var(--x)`，必须给它具体颜色值，所以这里不能直接写变量名。
 */
import type { ColorMode } from './colorMode'
import { getAppearance, subscribeAppearance } from './appearance'

const readToken = (name: string, fallback: string): string => {
  try {
    const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
    return value || fallback
  } catch {
    return fallback
  }
}

export let CHART_TEXT = '#b0b0b8'
export let CHART_TEXT_DIM = '#6b6b74'
export let CHART_LINE = '#26262c'
export let CHART_GRID = '#1c1c21'
export let CHART_WHITE = '#f4f4f5'

const COLORFUL_PALETTE = ['#6ea8ff', '#7fb4ff', '#93c2ff', '#5b93ff', '#84b7ff', '#a6cfff']
const MONO_PALETTE = ['#f4f4f5', '#d4d4da', '#b8b8c0', '#9a9aa4', '#7e7e88', '#63636d']

/** 强调色阶（深 → 浅），用于图表按数值动态取色 */
export const BLUE_STACK = ['#1e3f8a', '#2f5db0', '#3f76d6', '#5b8cff', '#7fb4ff', '#a6cfff']
export const MONO_STACK = ['#8b8b94', '#a6a6af', '#c2c2ca', '#dcdce2', '#ececf0', '#f4f4f5']

let accentStack: string[] = [...BLUE_STACK]
let accentPalette: string[] = [...COLORFUL_PALETTE]

/**
 * 按 0..1 比例取强调色阶颜色（t=0 深，t=1 浅）。
 *
 * `mode` 参数保留是为了不改动既有调用点；实际颜色来自当前强调色令牌，
 * graphite（黑白）自然会是一列灰阶。
 */
export const blueRamp = (t: number, _mode: ColorMode = 'colorful'): string => {
  const stack = accentStack
  const clamped = Math.max(0, Math.min(1, t))
  const idx = Math.min(stack.length - 1, Math.floor(clamped * stack.length))
  return stack[idx] || stack[0]
}

/** 垂直渐变（图表面积/线条用） */
export const blueVerticalGradient = (_mode: ColorMode = 'colorful') => {
  const top = accentStack[3] || '#5b8cff'
  const mid = accentStack[2] || '#3f76d6'
  const bottom = accentStack[0] || '#1e3f8a'
  return {
    type: 'linear' as const,
    x: 0,
    y: 0,
    x2: 0,
    y2: 1,
    colorStops: [
      { offset: 0, color: withAlpha(top, 0.5) },
      { offset: 0.55, color: withAlpha(mid, 0.18) },
      { offset: 1, color: withAlpha(bottom, 0.02) },
    ],
  }
}

export const getChartPalette = (_mode: ColorMode = 'colorful'): string[] => accentPalette

export const baseChartTheme = (_mode: ColorMode = 'colorful') => ({
  textStyle: { color: CHART_TEXT, fontFamily: 'inherit' },
  color: getChartPalette(),
  backgroundColor: 'transparent',
})

export const axisCommon = {
  axisLine: { lineStyle: { color: CHART_LINE } },
  axisTick: { show: false },
  axisLabel: { color: CHART_TEXT_DIM, fontSize: 11 },
  splitLine: { lineStyle: { color: CHART_GRID, type: 'dashed' as const } },
}

export const tooltipCommon = {
  backgroundColor: 'rgba(21,21,26,0.96)',
  borderColor: '#2c2c33',
  textStyle: { color: '#f4f4f5', fontSize: 12 },
  extraCssText: 'border-radius:8px;box-shadow:0 8px 24px rgba(0,0,0,0.5);',
}

export const animationCommon = {
  animationDuration: 700,
  animationDurationUpdate: 400,
  animationEasing: 'cubicOut' as const,
}

/**
 * 媒体构成（饼图/列表）固定色板：六类主媒体用可一眼区分的色相，
 * 避免同类蓝色系导致比例误读。graphite 主题退化为灰阶。
 * 类型号：1=文本 3=图片 34=语音 43=视频 47=表情包 49=链接/文件 -1=其他
 */
const MEDIA_TYPE_COLORS: Record<number, string> = {
  1: '#4a9eff',
  3: '#34d399',
  34: '#f472b6',
  43: '#a78bfa',
  47: '#fbbf24',
  49: '#22d3ee',
  [-1]: '#94a3b8',
}
const MEDIA_TYPE_COLORS_MONO: Record<number, string> = {
  1: '#ececf0',
  3: '#d4d4da',
  34: '#b8b8c0',
  43: '#9a9aa4',
  47: '#7e7e88',
  49: '#63636d',
  [-1]: '#4b4b52',
}
export const mediaTypeColor = (type: number, _mode: ColorMode = 'colorful'): string => {
  const mono = getAppearance().accent === 'graphite'
  return (mono ? MEDIA_TYPE_COLORS_MONO : MEDIA_TYPE_COLORS)[type] || accentPalette[0] || '#6ea8ff'
}

/** #rrggbb → rgba()，用于渐变里的半透明档。 */
function withAlpha(hex: string, alpha: number): string {
  const value = hex.trim()
  if (value.startsWith('rgb')) {
    const nums = value.replace(/[^0-9.,]/g, '').split(',').slice(0, 3).join(',')
    return `rgba(${nums},${alpha})`
  }
  const m = /^#?([0-9a-f]{6})$/i.exec(value)
  if (!m) return `rgba(91,140,255,${alpha})`
  const int = Number.parseInt(m[1], 16)
  return `rgba(${(int >> 16) & 255},${(int >> 8) & 255},${int & 255},${alpha})`
}

/**
 * 重新读取主题令牌。
 *
 * `CHART_TEXT` 等是 `export let`，ESM 的实时绑定让各组件在下次渲染时读到新
 * 值；`axisCommon` / `tooltipCommon` 是对象，**原地改属性**，这样任何在模块
 * 作用域里引用过它们的图表配置也会一起更新。
 */
export function refreshChartTheme(): void {
  CHART_TEXT = readToken('--text-dim', '#b0b0b8')
  CHART_TEXT_DIM = readToken('--text-faint', '#6b6b74')
  CHART_LINE = readToken('--line-strong', '#26262c')
  CHART_GRID = readToken('--line', '#1c1c21')
  CHART_WHITE = readToken('--text', '#f4f4f5')

  const graphite = getAppearance().accent === 'graphite'
  accentStack = graphite
    ? [
        readToken('--accent-4', MONO_STACK[0]),
        readToken('--accent-4', MONO_STACK[1]),
        readToken('--accent', MONO_STACK[2]),
        readToken('--accent-2', MONO_STACK[3]),
        readToken('--accent-3', MONO_STACK[4]),
        readToken('--accent-6', MONO_STACK[5]),
      ]
    : [
        readToken('--accent-deep', BLUE_STACK[0]),
        readToken('--accent-4', BLUE_STACK[1]),
        readToken('--accent', BLUE_STACK[2]),
        readToken('--accent-2', BLUE_STACK[3]),
        readToken('--accent-3', BLUE_STACK[4]),
        readToken('--accent-6', BLUE_STACK[5]),
      ]
  accentPalette = graphite
    ? [accentStack[5], accentStack[4], accentStack[3], accentStack[2], accentStack[1], accentStack[0]]
    : [accentStack[4], accentStack[5], accentStack[3], accentStack[2], accentStack[1], accentStack[0]]

  axisCommon.axisLine.lineStyle.color = CHART_LINE
  axisCommon.axisLabel.color = CHART_TEXT_DIM
  axisCommon.splitLine.lineStyle.color = CHART_GRID
  tooltipCommon.backgroundColor = readToken('--elevated', 'rgba(21,21,26,0.96)')
  tooltipCommon.borderColor = readToken('--line-strong', '#2c2c33')
  tooltipCommon.textStyle.color = CHART_WHITE
  tooltipCommon.extraCssText = `border-radius:8px;box-shadow:${readToken('--shadow-pop', '0 8px 24px rgba(0,0,0,0.5)')};`
}

refreshChartTheme()
subscribeAppearance(refreshChartTheme)

