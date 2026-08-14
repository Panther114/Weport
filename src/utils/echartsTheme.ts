/**
 * Weport v0.9 分析模块：ECharts 公共配置。
 * 支持双主题：colorful（默认，六色现代调色板）/ mono（黑白灰阶），
 * 与 src/utils/colorMode.ts 联动，切换主题时组件重建图表选项。
 */
import type { ColorMode } from './colorMode'

export const CHART_TEXT = '#b0b0b8'
export const CHART_TEXT_DIM = '#6b6b74'
export const CHART_LINE = '#26262c'
export const CHART_GRID = '#1c1c21'
export const CHART_WHITE = '#f4f4f5'

const COLORFUL_PALETTE = ['#6ea8ff', '#7fb4ff', '#93c2ff', '#5b93ff', '#84b7ff', '#a6cfff']
const MONO_PALETTE = ['#f4f4f5', '#d4d4da', '#b8b8c0', '#9a9aa4', '#7e7e88', '#63636d']

/** 蓝色阶（深 → 浅），用于图表按数值动态取色 */
export const BLUE_STACK = ['#1e3f8a', '#2f5db0', '#3f76d6', '#5b8cff', '#7fb4ff', '#a6cfff']
export const MONO_STACK = ['#8b8b94', '#a6a6af', '#c2c2ca', '#dcdce2', '#ececf0', '#f4f4f5']

/**
 * 按 0..1 比例取蓝色阶颜色（t=0 深蓝，t=1 浅蓝）
 */
export const blueRamp = (t: number, mode: ColorMode = 'colorful'): string => {
  const stack = mode === 'mono' ? MONO_STACK : BLUE_STACK
  const clamped = Math.max(0, Math.min(1, t))
  const idx = Math.min(stack.length - 1, Math.floor(clamped * stack.length))
  return stack[idx]
}

/** 垂直蓝色渐变（图表面积/线条用） */
export const blueVerticalGradient = (mode: ColorMode = 'colorful') =>
  mode === 'mono'
    ? {
        type: 'linear' as const,
        x: 0,
        y: 0,
        x2: 0,
        y2: 1,
        colorStops: [
          { offset: 0, color: 'rgba(244,244,245,0.28)' },
          { offset: 1, color: 'rgba(244,244,245,0.03)' },
        ],
      }
    : {
        type: 'linear' as const,
        x: 0,
        y: 0,
        x2: 0,
        y2: 1,
        colorStops: [
          { offset: 0, color: 'rgba(166,207,255,0.5)' },
          { offset: 0.55, color: 'rgba(91,140,255,0.18)' },
          { offset: 1, color: 'rgba(30,63,138,0.02)' },
        ],
      }

export const getChartPalette = (mode: ColorMode = 'colorful'): string[] =>
  mode === 'mono' ? MONO_PALETTE : COLORFUL_PALETTE

export const baseChartTheme = (mode: ColorMode = 'colorful') => ({
  textStyle: { color: CHART_TEXT, fontFamily: 'inherit' },
  color: getChartPalette(mode),
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
 * 避免同类蓝色系导致比例误读。mono 主题退化为灰阶。
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
export const mediaTypeColor = (type: number, mode: ColorMode = 'colorful'): string =>
  (mode === 'mono' ? MEDIA_TYPE_COLORS_MONO : MEDIA_TYPE_COLORS)[type] || '#6ea8ff'
