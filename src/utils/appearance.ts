import { useEffect, useState } from 'react'

/**
 * 外观自定义（v1.0）：背景、明暗、强调色、密度。
 *
 * 与 `colorMode` 走同一套通道（`config:get` / `config:set`），**不新增 IPC**：
 * 这样就不必动 `appMain.ts` / `preload.ts` / `vite-env.d.ts` 这三个共享文件，
 * 也就不会和别处的改动互相踩。
 *
 * 背景直接存绝对路径、用既有的 `weport-media://` 协议渲染 —— 该协议按绝对路径
 * 提供本地文件（见 `appMain.ts` 的 `protocol.handle('weport-media')`），因此不
 * 需要把文件复制进 userData，也不需要把 base64 塞进配置文件。代价是用户移动/
 * 删除原文件后背景会失效，这一点由 `probeBackground()` 兜底。
 *
 * v1.0.1：主题从两个系统合成一个 —— 见 `styles/theme.scss` 顶部说明。旧的
 * `colorMode`（colorful / mono）在启动时迁移为强调色 blue / graphite。
 */

export type AccentId = 'blue' | 'violet' | 'teal' | 'rose' | 'amber' | 'graphite'
export type Density = 'comfortable' | 'compact'
export type Mode = 'dark' | 'light'
export type BackgroundKind = 'none' | 'image' | 'video'

export interface Appearance {
  /** 绝对路径；空字符串＝纯色背景。图片或视频由扩展名决定。 */
  backgroundPath: string
  /** 遮罩强度 0-100：越高文字越清晰、背景越淡。 */
  backgroundDim: number
  /** 背景是否模糊（-1 关闭，0-40 为 blur 半径）。 */
  backgroundBlur: number
  accent: AccentId
  mode: Mode
  density: Density
}

export const APPEARANCE_DEFAULT: Appearance = {
  backgroundPath: '',
  backgroundDim: 72,
  backgroundBlur: 0,
  accent: 'blue',
  mode: 'dark',
  density: 'comfortable',
}

export const ACCENT_OPTIONS: Array<{ id: AccentId; label: string; swatch: string }> = [
  { id: 'blue', label: '冷蓝', swatch: '#5b8eff' },
  { id: 'violet', label: '紫罗兰', swatch: '#9b7bff' },
  { id: 'teal', label: '青绿', swatch: '#2fb8a6' },
  { id: 'rose', label: '玫红', swatch: '#f2678f' },
  { id: 'amber', label: '琥珀', swatch: '#e0a03c' },
  { id: 'graphite', label: '石墨（黑白）', swatch: '#9a9aa4' },
]

export const MODE_OPTIONS: Array<{ id: Mode; label: string; hint: string }> = [
  { id: 'dark', label: '深色', hint: '默认，长时间阅读更省眼' },
  { id: 'light', label: '浅色', hint: '白天 / 强光环境下更清晰' },
]

export const DENSITY_OPTIONS: Array<{ id: Density; label: string }> = [
  { id: 'comfortable', label: '宽松' },
  { id: 'compact', label: '紧凑' },
]

/** 视频背景支持的扩展名（Chromium 能直接播的容器）。 */
const VIDEO_EXTENSIONS = ['mp4', 'webm', 'ogv', 'm4v', 'mov']

export function backgroundKindOf(filePath: string): BackgroundKind {
  const path = String(filePath || '').trim()
  if (!path) return 'none'
  const ext = path.split('.').pop()?.toLowerCase() || ''
  return VIDEO_EXTENSIONS.includes(ext) ? 'video' : 'image'
}

const KEYS = {
  backgroundPath: 'appearanceBackgroundPath',
  backgroundDim: 'appearanceBackgroundDim',
  backgroundBlur: 'appearanceBackgroundBlur',
  accent: 'appearanceAccent',
  mode: 'appearanceMode',
  density: 'appearanceDensity',
} as const

let current: Appearance = { ...APPEARANCE_DEFAULT }
const listeners = new Set<() => void>()

const isAccent = (value: unknown): value is AccentId => ACCENT_OPTIONS.some((option) => option.id === value)
const isMode = (value: unknown): value is Mode => value === 'dark' || value === 'light'
const isDensity = (value: unknown): value is Density => value === 'comfortable' || value === 'compact'

/** 把绝对路径转成渲染层可用的协议 URL（盘符必须编码进 pathname，不能放 host）。 */
export function backgroundProtocolUrl(filePath: string): string {
  const normalized = String(filePath || '').replace(/\\/g, '/')
  return `weport-media://local/${encodeURIComponent(normalized)}`
}

function applyDom(appearance: Appearance): void {
  const root = document.documentElement
  const kind = backgroundKindOf(appearance.backgroundPath)

  // 图片与视频用两个变量：视频背景的 <video> 元素是 React 渲染的，CSS 只需要
  // 知道"有没有背景、要不要压暗"，不需要 url()。
  root.style.setProperty('--app-bg-url', kind === 'image' ? `url("${backgroundProtocolUrl(appearance.backgroundPath)}")` : 'none')
  // 没有背景时遮罩强度必须是 0：否则纯色界面会被叠上一层 72% 的黑，默认观感
  // 会被这个功能悄悄改掉。
  root.style.setProperty('--app-bg-dim', kind === 'none' ? '0' : String(Math.min(0.95, Math.max(0, appearance.backgroundDim / 100))))
  root.style.setProperty('--app-bg-blur', kind === 'none' ? '0px' : `${Math.max(0, Math.min(40, appearance.backgroundBlur))}px`)
  root.dataset.hasBg = kind === 'none' ? 'false' : 'true'
  root.dataset.bgKind = kind
  root.dataset.accent = appearance.accent
  root.dataset.mode = appearance.mode
  root.dataset.density = appearance.density
  // 旧字段：仍有少量 CSS（以及 ECharts 主题）按 data-theme 判断灰阶。
  root.dataset.theme = appearance.accent === 'graphite' ? 'mono' : 'colorful'
}

export const getAppearance = (): Appearance => current

function commit(patch: Partial<Appearance>, persist: (key: string, value: unknown) => void): void {
  const next: Appearance = { ...current, ...patch }
  const unchanged = (Object.keys(KEYS) as Array<keyof Appearance>).every((field) => next[field] === current[field])
  if (unchanged) return
  current = next
  applyDom(next)
  for (const [field, key] of Object.entries(KEYS) as Array<[keyof Appearance, string]>) {
    if (patch[field] === undefined) continue
    persist(key, next[field])
  }
  listeners.forEach((listener) => listener())
}

/** 设置背景。传空字符串即恢复纯色背景。图片与视频都走这里。 */
export const setBackgroundPath = (path: string): void =>
  commit({ backgroundPath: String(path || '').trim() }, (key, value) => void window.electronAPI.config.set(key, value))

export const setBackgroundDim = (dim: number): void =>
  commit({ backgroundDim: Math.min(100, Math.max(0, Math.round(dim || 0))) }, (key, value) => void window.electronAPI.config.set(key, value))

export const setBackgroundBlur = (blur: number): void =>
  commit({ backgroundBlur: Math.min(40, Math.max(0, Math.round(blur || 0))) }, (key, value) => void window.electronAPI.config.set(key, value))

export const setAccent = (accent: AccentId): void =>
  commit({ accent: isAccent(accent) ? accent : 'blue' }, (key, value) => void window.electronAPI.config.set(key, value))

export const setMode = (mode: Mode): void =>
  commit({ mode: isMode(mode) ? mode : 'dark' }, (key, value) => void window.electronAPI.config.set(key, value))

export const setDensity = (density: Density): void =>
  commit({ density: isDensity(density) ? density : 'comfortable' }, (key, value) => void window.electronAPI.config.set(key, value))

/**
 * 背景存在性探测。
 *
 * 配置里存的是绝对路径，用户随时可能把原文件移走或删掉。渲染层无法直接查文件，
 * 因此这里用一次媒体加载来验证：失败就自动清空背景并回退到纯色，避免留下一块
 * 加载失败的难看占位。视频用 <video> 探测，图片用 <img>。
 */
export function probeBackground(onMissing: (path: string) => void): void {
  const path = current.backgroundPath
  if (!path) return
  const kind = backgroundKindOf(path)
  const fail = () => {
    if (current.backgroundPath !== path) return
    onMissing(path)
    commit({ backgroundPath: '' }, (key, value) => void window.electronAPI.config.set(key, value))
  }
  const url = backgroundProtocolUrl(path)
  if (kind === 'video') {
    const video = document.createElement('video')
    video.onerror = fail
    video.src = url
    return
  }
  const image = new Image()
  image.onerror = fail
  image.src = url
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

  const [backgroundPath, backgroundDim, backgroundBlur, accent, mode, density, legacyColorMode] = await Promise.all([
    read(KEYS.backgroundPath),
    read(KEYS.backgroundDim),
    read(KEYS.backgroundBlur),
    read(KEYS.accent),
    read(KEYS.mode),
    read(KEYS.density),
    // v1.0 之前的「色彩主题」：colorful / mono。它现在只是强调色的一种，
    // 因此在没有新的 accent 配置时把它迁移过来，而不是丢下不管。
    read('colorMode'),
  ])

  const legacyAccent: AccentId | undefined = legacyColorMode === 'mono' ? 'graphite' : legacyColorMode === 'colorful' ? 'blue' : undefined

  const next: Appearance = {
    backgroundPath: typeof backgroundPath === 'string' ? backgroundPath.trim() : APPEARANCE_DEFAULT.backgroundPath,
    backgroundDim: Number.isFinite(Number(backgroundDim))
      ? Math.min(100, Math.max(0, Number(backgroundDim)))
      : APPEARANCE_DEFAULT.backgroundDim,
    backgroundBlur: Number.isFinite(Number(backgroundBlur))
      ? Math.min(40, Math.max(0, Number(backgroundBlur)))
      : APPEARANCE_DEFAULT.backgroundBlur,
    accent: isAccent(accent) ? accent : legacyAccent || APPEARANCE_DEFAULT.accent,
    mode: isMode(mode) ? mode : APPEARANCE_DEFAULT.mode,
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
