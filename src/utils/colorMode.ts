import { useEffect, useState } from 'react'

export type ColorMode = 'colorful' | 'mono'

const CONFIG_KEY = 'colorMode'

let currentMode: ColorMode = 'colorful'
const listeners = new Set<() => void>()

const applyDom = (mode: ColorMode) => {
  document.documentElement.dataset.theme = mode
}

export const getColorMode = (): ColorMode => currentMode

export const setColorMode = (mode: ColorMode): void => {
  const normalized: ColorMode = mode === 'mono' ? 'mono' : 'colorful'
  if (normalized === currentMode) return
  currentMode = normalized
  applyDom(normalized)
  void window.electronAPI.config.set(CONFIG_KEY, normalized)
  listeners.forEach((l) => l())
}

export const subscribeColorMode = (listener: () => void): (() => void) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** 应用启动时从配置恢复主题（App 挂载时调用一次） */
export const initColorMode = async (): Promise<ColorMode> => {
  let savedMode: ColorMode | undefined
  try {
    const saved = await window.electronAPI.config.get(CONFIG_KEY)
    if (saved === 'mono' || saved === 'colorful') {
      savedMode = saved
    }
  } catch {
    /* noop */
  }

  const changed = savedMode !== undefined && savedMode !== currentMode
  if (savedMode !== undefined) {
    currentMode = savedMode
  }
  applyDom(currentMode)
  // config.get is asynchronous. Notify subscribers after it resolves so the
  // first render cannot leave the settings card stuck on the default theme.
  // Without this, clicking the already-persisted mode is a no-op because the
  // module state has changed while the React hook still holds "colorful".
  if (changed) {
    listeners.forEach((listener) => listener())
  }
  return currentMode
}

/** React hook：主题变化时触发重渲染（ECharts 选项需重建） */
export const useColorMode = (): ColorMode => {
  const [mode, setMode] = useState<ColorMode>(currentMode)
  useEffect(() => subscribeColorMode(() => setMode(currentMode)), [])
  return mode
}
