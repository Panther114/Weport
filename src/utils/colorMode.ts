import { useEffect, useState } from 'react'
import { getAppearance, subscribeAppearance, useAppearance } from './appearance'

/**
 * 图表主题口径（兼容层）。
 *
 * v1.0 之前这里是一个独立系统：`colorMode` = colorful / mono，自己的 config
 * key、自己的订阅、自己的 DOM 属性（`data-theme`）。而设置页上还有另一个
 * 「强调色」，写的是 `data-accent` —— 没有任何 CSS 读它，两边各管各的。
 *
 * 现在主题只有一套（见 `styles/theme.scss`）：`data-mode`（明暗）×
 * `data-accent`（6 种强调色）。这个模块只保留一个**派生**口径，让已有的
 * ECharts 组件不必改写：
 *
 *   graphite 强调色  → 'mono'（灰阶图表）
 *   其余强调色        → 'colorful'
 */
export type ColorMode = 'colorful' | 'mono'

export const getColorMode = (): ColorMode => (getAppearance().accent === 'graphite' ? 'mono' : 'colorful')

/** React hook：主题变化时触发重渲染（ECharts 选项需重建）。 */
export const useColorMode = (): ColorMode => {
  const appearance = useAppearance()
  const [mode, setMode] = useState<ColorMode>(() => (getAppearance().accent === 'graphite' ? 'mono' : 'colorful'))
  useEffect(() => subscribeAppearance(() => setMode(getAppearance().accent === 'graphite' ? 'mono' : 'colorful')), [])
  return appearance.accent === 'graphite' ? 'mono' : mode
}
