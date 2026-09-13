import { useEffect, useState } from 'react'

/**
 * 外观自定义（v1.0）：背景图、强调色、密度。
 *
 * 与 `colorMode` 走同一套通道（`config:get` / `config:set`），**不新增 IPC**：
 * 这样就不必动 `appMain.ts` / `preload.ts` / `vite-env.d.ts` 这三个共享文件，
 * 也就不会和别处的改动互相踩。
 *
 * 背景图直接存绝对路径、用既有的 `weport-media://` 协议渲染 —— 该协议按
 * 绝对路径提供本地文件（见 `appMain.ts` 的 `protocol.handle('weport-media')`），
 * 因此不需要把图片复制进 userData，也不需要把 base64 塞进配置文件。
 * 代价是用户移动/删除原图后背景会失效，这一点由 `probeBackground()` 兜底。
 */

export type AccentId = 'blue' | 'violet' | 'teal' | 'rose'
export type Density = 'comfortable' | 'compact'

export interface Appearance {
  backgroundPath: string
  /** 遮罩强度 0-100：越高文字越清晰、背景越淡。 */
  backgroundDim: number
  accent: AccentId
  density: Density
}

export const APPEARANCE_DEFAULT: Appearance = {
  backgroundPath: '',
  backgroundDim: 72,
  accent: 'blue',
  density: 'comfortable',
}

export const ACCENT_OPTIONS: Array<{ id: AccentId; label: string; swatch: string }> = [
  { id: 'blue', label: '冷蓝', swatch: '#5b8eff' },
  { id: 'violet', label: '紫罗兰', swatch: '#9b7bff' },
  { id: 'teal', label: '青绿', swatch: '#3fbfae' },
  { id: 'rose', label: '玫红', swatch: '#f2678f' },
]

export const DENSITY_OPTIONS: Array<{ id: Density; label: string }> = [
  { id: 'comfortable', label: '宽松' },
  { id: 'compact', label: '紧凑' },
]

const KEYS = {
  backgroundPath: 'appearanceBackgroundPath',
  backgroundDim: 'appearanceBackgroundDim',
  accent: 'appearanceAccent',
  density: 'appearanceDensity',
} as const

let current: Appearance = { ...APPEARANCE_DEFAULT }
const listeners = new Set<() => void>()

const isAccent = (value: unknown): value is AccentId =>
  value === 'blue' || value === 'violet' || value === 'teal' || value === 'rose'

const isDensity = (value: unknown): value is Density => value === 'comfortable' || value === 'compact'

/** 把绝对路径转成渲染层可用的协议 URL（盘符必须编码进 pathname，不能放 host）。 */
export function backgroundProtocolUrl(filePath: string): string {
  const normalized = String(filePath || '').replace(/\\/g, '/')
  return `weport-media://local/${encodeURIComponent(normalized)}`
}

function applyDom(appearance: Appearance): void {
  const root = document.documentElement
  const hasBackground = appearance.backgroundPath.trim().length > 0

  root.style.setProperty('--app-bg-url', hasBackground ? `url("${backgroundProtocolUrl(appearance.backgroundPath)}")` : 'none')
  // 没有背景图时遮罩强度必须是 0：否则纯色界面会被叠上一层 72% 的黑，默认
  // 观感会被这个功能悄悄改掉。
  root.style.setProperty('--app-bg-dim', hasBackground ? String(Math.min(0.95, Math.max(0, appearance.backgroundDim / 100))) : '0')
  root.dataset.hasBg = hasBackground ? 'true' : 'false'
  root.dataset.accent = appearance.accent
  root.dataset.density = appearance.density
}

export const getAppearance = (): Appearance => current

function commit(patch: Partial<Appearance>, persist: (key: string, value: unknown) => void): void {
  const next: Appearance = { ...current, ...patch }
  if (
    next.backgroundPath === current.backgroundPath &&
    next.backgroundDim === current.backgroundDim &&
    next.accent === current.accent &&
    next.density === current.density
  ) {
    return
  }
  current = next
  applyDom(next)
  for (const [field, key] of Object.entries(KEYS) as Array<[keyof Appearance, string]>) {
    if (patch[field] === undefined) continue
    persist(key, next[field])
  }
  listeners.forEach((listener) => listener())
}

/** 设置背景图。传空字符串即恢复纯色背景。 */
export const setBackgroundPath = (path: string): void =>
  commit({ backgroundPath: String(path || '').trim() }, (key, value) => void window.electronAPI.config.set(key, value))

export const setBackgroundDim = (dim: number): void =>
  commit({ backgroundDim: Math.min(100, Math.max(0, Math.round(dim || 0))) }, (key, value) => void window.electronAPI.config.set(key, value))

export const setAccent = (accent: AccentId): void =>
  commit({ accent: isAccent(accent) ? accent : 'blue' }, (key, value) => void window.electronAPI.config.set(key, value))

export const setDensity = (density: Density): void =>
  commit({ density: isDensity(density) ? density : 'comfortable' }, (key, value) => void window.electronAPI.config.set(key, value))

/**
 * 背景图存在性探测。
 *
 * 配置里存的是绝对路径，用户随时可能把原图移走或删掉。渲染层无法直接查文件，
 * 因此这里用一次 `Image` 加载来验证：失败就自动清空背景并回退到纯色，避免留
 * 下一块加载失败的难看占位。
 */
export function probeBackground(onMissing: (path: string) => void): void {
  const path = current.backgroundPath
  if (!path) return
  const image = new Image()
  image.onerror = () => {
    if (current.backgroundPath !== path) return
    onMissing(path)
    commit({ backgroundPath: '' }, (key, value) => void window.electronAPI.config.set(key, value))
  }
  image.src = backgroundProtocolUrl(path)
}

/** 应用启动时（App 挂载后）调用一次，从配置恢复外观。 */
export async function initAppearance(): Promise<Appearance> {
  const api = window.electronAPI
  const read = async (key: string): Promise<unknown> => {
    try {
      return await api.config.get(key)
    } catch {
      return undefined
    }
  }

  const [backgroundPath, backgroundDim, accent, density] = await Promise.all([
    read(KEYS.backgroundPath),
    read(KEYS.backgroundDim),
    read(KEYS.accent),
    read(KEYS.density),
  ])

  const next: Appearance = {
    backgroundPath: typeof backgroundPath === 'string' ? backgroundPath.trim() : APPEARANCE_DEFAULT.backgroundPath,
    backgroundDim: Number.isFinite(Number(backgroundDim))
      ? Math.min(100, Math.max(0, Number(backgroundDim)))
      : APPEARANCE_DEFAULT.backgroundDim,
    accent: isAccent(accent) ? accent : APPEARANCE_DEFAULT.accent,
    density: isDensity(density) ? density : APPEARANCE_DEFAULT.density,
  }

  current = next
  applyDom(next)
  listeners.forEach((listener) => listener())
  return next
}

/** React hook：外观变化时重渲染（设置面板需要同步控件状态）。 */
export function useAppearance(): Appearance {
  const [value, setValue] = useState<Appearance>(current)
  useEffect(() => subscribeAppearance(() => setValue(current)), [])
  return value
}

export const subscribeAppearance = (listener: () => void): (() => void) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
