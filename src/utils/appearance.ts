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

export type AccentId = 'blue' | 'violet' | 'teal' | 'rose' | 'amber' | 'graphite' | 'custom'
export type Density = 'comfortable' | 'compact'
export type Mode = 'dark' | 'light'
export type BackgroundKind = 'none' | 'image' | 'video'
/** 强调色的用量：只影响色块浓度，不改色相。 */
export type AccentStrength = 'soft' | 'standard' | 'vivid'
/**
 * 背景视频的画质档位。定义在主进程的 backgroundVideoService 里（转码参数的
 * 唯一来源），这里镜像一份供界面使用 —— 两边必须同名。
 */
export type VideoQuality = 'native' | 'balanced' | 'compact'

/**
 * 模糊达到这个半径后，高于「平衡」的档位会被主进程自动压回「平衡」：
 * 模糊已经把细节抹掉了，多解码的像素在屏幕上不存在。**必须与
 * electron/services/backgroundVideoService.ts 的 BLUR_FORCES_BALANCED_PX 一致**，
 * 否则界面会给出与实际行为矛盾的说明。
 */
export const BLUR_FORCES_BALANCED_PX = 4

export const VIDEO_QUALITY_OPTIONS: ReadonlyArray<{
  id: VideoQuality
  label: string
  hint: string
}> = [
  {
    id: 'native',
    label: '原生',
    hint: '按屏幕分辨率解码、低压缩。观感最接近原片，解码量与显存占用最高',
  },
  {
    id: 'balanced',
    label: '平衡',
    hint: '默认。长边不超过屏幕宽度，压缩率较高，画质与开销折中',
  },
  {
    id: 'compact',
    label: '精简',
    hint: '长边约为屏幕的 2/3。最省，配合较大的背景模糊几乎看不出差别',
  },
]

export interface Appearance {
  /** 用户选择的绝对路径（界面显示、扩展名判断都用它）；空字符串＝纯色背景。 */
  backgroundPath: string
  /**
   * 实际该播的路径。主进程会把视频背景换成转码后的缓存文件（见
   * backgroundVideoService）；背景被拒（例如源文件超过 50MB）时这里是空串，
   * 于是不渲染背景层 —— 但 `backgroundPath` 仍保留用户的选择，设置页才能
   * 解释"为什么没生效"而不是显示成"没选过"。
   */
  backgroundPlaybackPath: string
  /** 背景被拒的原因（'' = 正常）。目前只有 'too-large'。 */
  backgroundRejected: string
  /** 遮罩强度 0-100：越高文字越清晰、背景越淡。 */
  backgroundDim: number
  /** 背景是否模糊（-1 关闭，0-40 为 blur 半径）。 */
  backgroundBlur: number
  /** 背景视频的画质档位（只对视频背景有意义）。 */
  videoQuality: VideoQuality
  /**
   * 主进程实际采用的档位。与 `videoQuality` 不同就说明被自动降级了
   * （目前唯一的原因：背景模糊 ≥ BLUR_FORCES_BALANCED_PX）。
   * 主进程没回答时等于 videoQuality，界面就不显示"已降级"的说明。
   */
  videoQualityEffective: VideoQuality
  /** true = 因为背景模糊被自动降级，设置页要说明原因 */
  videoQualityDemoted: boolean
  /** 实际目标缩放长边（0 = 未知）。用来告诉用户"真正解的是多大"。 */
  videoDecodeEdge: number
  accent: AccentId
  /** accent === 'custom' 时使用的自定义强调色（#rrggbb）。 */
  customAccent: string
  mode: Mode
  density: Density
  /** 强调色浓度：换色相之外的第二个自定义轴。 */
  accentStrength: AccentStrength
  /**
   * 明暗是否仍由背景自动决定（true = 用户没有手动指定过）。
   * 用户手动选一次明暗后置为 false，之后不再被背景覆盖。
   */
  modeAuto: boolean
}

export const APPEARANCE_DEFAULT: Appearance = {
  backgroundPath: '',
  backgroundPlaybackPath: '',
  backgroundRejected: '',
  backgroundDim: 72,
  // 默认 4px：既让背景退到后景、文字更干净，又不至于把画面糊成一片。
  // 同时它正好落在"模糊 ≥4px → 高分辨率档位自动降级"的阈值上。
  backgroundBlur: 4,
  videoQuality: 'balanced',
  videoQualityEffective: 'balanced',
  videoQualityDemoted: false,
  videoDecodeEdge: 0,
  accent: 'blue',
  customAccent: '#5b8eff',
  mode: 'dark',
  density: 'comfortable',
  accentStrength: 'standard',
  modeAuto: true,
}

export const ACCENT_STRENGTH_OPTIONS: Array<{ id: AccentStrength; label: string; hint: string }> = [
  { id: 'soft', label: '淡雅', hint: '只在选中态与图表上着色' },
  { id: 'standard', label: '标准', hint: '按钮、数值、图标都用强调色' },
  { id: 'vivid', label: '浓郁', hint: '面板与卡片也带强调色底' },
]

export const ACCENT_OPTIONS: Array<{ id: AccentId; label: string; swatch: string }> = [
  { id: 'blue', label: '冷蓝', swatch: '#5b8eff' },
  { id: 'violet', label: '紫罗兰', swatch: '#9b7bff' },
  { id: 'teal', label: '青绿', swatch: '#2fb8a6' },
  { id: 'rose', label: '玫红', swatch: '#f2678f' },
  { id: 'amber', label: '琥珀', swatch: '#e0a03c' },
  { id: 'graphite', label: '石墨', swatch: '#9a9aa4' },
]

/** 界面里可选的强调色（不含 custom，它的色值来自 customAccent）。 */
export const PRESET_ACCENTS = ACCENT_OPTIONS.filter((option) => option.id !== 'custom')

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
  videoQuality: 'appearanceBackgroundVideoQuality',
  accent: 'appearanceAccent',
  customAccent: 'appearanceCustomAccent',
  mode: 'appearanceMode',
  density: 'appearanceDensity',
  accentStrength: 'appearanceAccentStrength',
  modeAuto: 'appearanceModeAuto',
} as const

let current: Appearance = { ...APPEARANCE_DEFAULT }
const listeners = new Set<() => void>()

const isAccent = (value: unknown): value is AccentId =>
  value === 'custom' || ACCENT_OPTIONS.some((option) => option.id === value)
const isMode = (value: unknown): value is Mode => value === 'dark' || value === 'light'
const isDensity = (value: unknown): value is Density => value === 'comfortable' || value === 'compact'
const isStrength = (value: unknown): value is AccentStrength =>
  ACCENT_STRENGTH_OPTIONS.some((option) => option.id === value)
const isVideoQuality = (value: unknown): value is VideoQuality =>
  VIDEO_QUALITY_OPTIONS.some((option) => option.id === value)
/** #rrggbb / #rgb → #rrggbb；非法输入返回空串。 */
export function normalizeHexColor(value: unknown): string {
  const raw = String(value || '').trim()
  const match = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(raw)
  if (!match) return ''
  const hex = match[1]
  if (hex.length === 6) return `#${hex.toLowerCase()}`
  return `#${hex.split('').map((c) => c + c).join('').toLowerCase()}`
}

/**
 * 浅色模式下强调色需要压深（否则当文字用在浅底上对比度不足），预设色在
 * `theme.scss` 里写死，自定义色只能运行时算。
 *
 * 为什么 `--accent` 必须是字面色值、不能用 `color-mix()` 现算：Chromium 不支持
 * `color-mix()` 嵌套，而 `--accent` 会被塞进二十多处 `color-mix(in srgb, var(--accent) …)`；
 * 它一旦是 color-mix，那些声明在浅色下全部作废（主按钮没有底色 → 白字落在白面板上）。
 */
function darkenForLight(hex: string, factor = 0.72): string {
  const value = normalizeHexColor(hex)
  if (!value) return hex
  const channel = (start: number) =>
    Math.max(0, Math.min(255, Math.round(parseInt(value.slice(start, start + 2), 16) * factor)))
  return `#${[1, 3, 5].map((i) => channel(i).toString(16).padStart(2, '0')).join('')}`
}

/** 把绝对路径转成渲染层可用的协议 URL（盘符必须编码进 pathname，不能放 host）。 */
export function backgroundProtocolUrl(filePath: string): string {
  const normalized = String(filePath || '').replace(/\\/g, '/')
  return `weport-media://local/${encodeURIComponent(normalized)}`
}

function applyDom(appearance: Appearance): void {
  const root = document.documentElement
  // 用**可播放**路径判断有没有背景：被拒的背景不该让界面进入"有背景"状态
  // （否则面板会转半透明、遮罩会生效，而其实什么都没渲染）。
  const kind = backgroundKindOf(appearance.backgroundPlaybackPath)

  // 图片与视频都由 `.app-bg` 图层渲染（见 theme.scss），所以这里不再喂 url()：
  // CSS 只需要知道"要不要压暗"和"模糊多少"。之前图片是 .shell 的
  // background-image，而 `filter: blur()` 对背景图无效 —— 同一个滑块在图片模式
  // 下是坏的。两个媒体类型走同一条路径之后不会再有这种分叉。
  // 没有背景时遮罩强度必须是 0：否则纯色界面会被叠上一层 72% 的黑，默认观感
  // 会被这个功能悄悄改掉。
  root.style.setProperty('--app-bg-dim', kind === 'none' ? '0' : String(Math.min(0.95, Math.max(0, appearance.backgroundDim / 100))))
  root.style.setProperty('--app-bg-blur', kind === 'none' ? '0px' : `${Math.max(0, Math.min(40, appearance.backgroundBlur))}px`)
  root.dataset.hasBg = kind === 'none' ? 'false' : 'true'
  root.dataset.bgKind = kind
  // 明暗自适应是否生效：qa/探针据此判断，不用去猜
  root.dataset.modeAuto = appearance.modeAuto ? 'true' : 'false'
  root.dataset.accent = appearance.accent
  root.dataset.mode = appearance.mode
  root.dataset.density = appearance.density
  root.dataset.accentStrength = appearance.accentStrength
  // 自定义强调色：直接覆盖 --accent-raw，其余色阶由 theme.scss 用 color-mix
  // 从它推导，因此自定义色和 6 个预设走的是同一条链路。
  if (appearance.accent === 'custom') {
    const hex = normalizeHexColor(appearance.customAccent) || APPEARANCE_DEFAULT.customAccent
    root.style.setProperty('--accent-raw', hex)
    // 浅色模式的压深值预设色写在 CSS 里，自定义色只能这里算。
    if (appearance.mode === 'light') root.style.setProperty('--accent', darkenForLight(hex))
    else root.style.removeProperty('--accent')
  } else {
    root.style.removeProperty('--accent-raw')
    root.style.removeProperty('--accent')
  }
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
export const setBackgroundPath = (path: string): void => {
  const next = String(path || '').trim()
  // 乐观更新：主进程可能返回一个转码缓存路径（下次 config:get 才拿得到），
  // 先用用户选的文件把界面点亮，避免"选了没反应"。
  commit(
    { backgroundPath: next, backgroundPlaybackPath: next, backgroundRejected: '' },
    (key, value) => void window.electronAPI.config.set(key, value)
  )
}

export const setBackgroundDim = (dim: number): void =>
  commit({ backgroundDim: Math.min(100, Math.max(0, Math.round(dim || 0))) }, (key, value) => void window.electronAPI.config.set(key, value))

export const setBackgroundBlur = (blur: number): void =>
  commit({ backgroundBlur: Math.min(40, Math.max(0, Math.round(blur || 0))) }, (key, value) => void window.electronAPI.config.set(key, value))

/**
 * 背景视频画质档位。
 *
 * 乐观更新：`videoQualityEffective` / `videoQualityDemoted` 只是**显示**用的，
 * 真正生效的档位由主进程算（模糊 ≥4px 会把高于平衡的档位压回去）。这里先按
 * 本地规则预判一次，界面立刻有反馈；下一次 refreshVideoQualityInfo() 再拿
 * 主进程的权威值覆盖。
 */
export const setVideoQuality = (quality: VideoQuality): void => {
  const next = isVideoQuality(quality) ? quality : APPEARANCE_DEFAULT.videoQuality
  const demoted = current.backgroundBlur >= BLUR_FORCES_BALANCED_PX && next === 'native'
  commit(
    {
      videoQuality: next,
      videoQualityEffective: demoted ? 'balanced' : next,
      videoQualityDemoted: demoted,
    },
    (key, value) => void window.electronAPI.config.set(key, value)
  )
}

/**
 * 从主进程取回"实际生效的档位"。改模糊/换背景/切档位之后调用。
 *
 * 必须问主进程而不是本地算：解码长边取决于显示器设备宽度，渲染层不知道
 * 用户把窗口拖到了哪块屏上。拿不到就保持当前值 —— 猜一个只会让提示与实际不符。
 */
export async function refreshVideoQualityInfo(): Promise<void> {
  // 不是视频背景就归零：留着上一段视频的字体信息只会在下次选中视频前
  // 显示出一个过期的"解码长边"。
  if (backgroundKindOf(current.backgroundPath) !== 'video') {
    if (current.videoDecodeEdge !== 0 || current.videoQualityDemoted) {
      current = { ...current, videoQualityEffective: current.videoQuality, videoQualityDemoted: false, videoDecodeEdge: 0 }
      listeners.forEach((listener) => listener())
    }
    return
  }
  try {
    const info = (await window.electronAPI.config.get('appearanceBackgroundVideoInfo')) as
      | { quality?: unknown; demoted?: unknown; longEdge?: unknown }
      | undefined
    if (!info) return
    const quality = isVideoQuality(info.quality) ? info.quality : current.videoQuality
    const demoted = info.demoted === true
    const longEdge = Number.isFinite(Number(info.longEdge)) ? Number(info.longEdge) : 0
    if (
      quality === current.videoQualityEffective &&
      demoted === current.videoQualityDemoted &&
      longEdge === current.videoDecodeEdge
    ) {
      return
    }
    // 只更新显示字段，不写回配置：它们是主进程算出来的结果，不是用户的选择。
    current = { ...current, videoQualityEffective: quality, videoQualityDemoted: demoted, videoDecodeEdge: longEdge }
    listeners.forEach((listener) => listener())
  } catch {
    /* 主进程还没起来 / 键不存在：保持当前显示 */
  }
}

export const setAccent = (accent: AccentId): void =>
  commit({ accent: isAccent(accent) ? accent : 'blue' }, (key, value) => void window.electronAPI.config.set(key, value))

/** 自定义强调色（#rrggbb）。设置它会同时把 accent 切到 custom。 */
export const setCustomAccent = (color: string): void => {
  const hex = normalizeHexColor(color)
  if (!hex) return
  commit({ accent: 'custom', customAccent: hex }, (key, value) => void window.electronAPI.config.set(key, value))
}

/**
 * 手动设置明暗。
 *
 * `auto: true` 是"背景自适应"在内部切换时用的：它不能把 modeAuto 关掉，否则
 * 第一次自动判定之后用户就再也得不到自适应了。只有用户真的点了明暗选项
 * （默认路径）才把 modeAuto 置 false —— 那就是"手动覆盖"。
 */
export const setMode = (mode: Mode, opts?: { auto?: boolean }): void => {
  const patch: Partial<Appearance> = { mode: isMode(mode) ? mode : 'dark' }
  if (!opts?.auto) patch.modeAuto = false
  commit(patch, (key, value) => void window.electronAPI.config.set(key, value))
}

/** 恢复"明暗跟随背景"（立刻按当前背景重判一次由调用方触发）。 */
export const setModeAuto = (auto: boolean): void =>
  commit({ modeAuto: auto }, (key, value) => void window.electronAPI.config.set(key, value))

export const setDensity = (density: Density): void =>
  commit({ density: isDensity(density) ? density : 'comfortable' }, (key, value) => void window.electronAPI.config.set(key, value))

export const setAccentStrength = (strength: AccentStrength): void =>
  commit({ accentStrength: isStrength(strength) ? strength : 'standard' }, (key, value) => void window.electronAPI.config.set(key, value))

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

/**
 * 亮度 → 明暗。
 *
 * **暗背景配浅色主题**（深色壁纸 + 深色面板 = 糊成一片），**亮背景配深色主题**，
 * 所以在 0.5 处切开：低于中灰就切浅色主题。
 *
 * 第一版把方向写反了（`> 0.42 ? 'dark'`），深色壁纸被判成深色主题 —— 表现成
 * "自适应没生效"，其实只是反了。scripts/verify-auto-mode.mjs 里的 expected 就是
 * 本函数的镜像表达式，改动这里要一起改。
 */
function modeForLuminance(luminance: number): Mode {
  return luminance < 0.5 ? 'light' : 'dark'
}

/**
 * 按背景的实际亮度自动切换明暗。仅当用户没有手动指定过明暗（modeAuto）时生效。
 *
 * 亮度**由主进程算**：渲染层拿到的是 `weport-media://`（自定义协议），把它画到
 * canvas 会把 canvas 标记为 tainted，`getImageData` 直接抛 SecurityError —— 在
 * 渲染层这条路根本走不通（实测报的就是这个错）。这里只做一次 IPC + 阈值判断。
 *
 * 返回实际采用的明暗；拿不到亮度（ffmpeg 缺失 / 文件损坏）或用户已手动指定时
 * 返回 null —— 静默不动，绝不猜一个值去覆盖用户的选择。
 */
export async function adoptModeFromBackground(): Promise<Mode | null> {
  if (!current.modeAuto) return null
  const path = current.backgroundPath
  if (!path) return null
  try {
    const result = await window.electronAPI.app.backgroundLuminance(path)
    // 期间用户可能换了背景或手动选了明暗，落地前用当前状态再核对一次
    if (!result?.success || typeof result.luminance !== 'number') return null
    if (current.backgroundPath !== path || !current.modeAuto) return null
    const next = modeForLuminance(result.luminance)
    if (next !== current.mode) setMode(next, { auto: true })
    return next
  } catch {
    return null
  }
}

/** 当前的明暗是否由背景自动决定（设置页据此显示"跟随背景"）。 */
export function isModeAuto(): boolean {
  return current.modeAuto
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

  const [backgroundPath, backgroundDim, backgroundBlur, accent, customAccent, mode, density, accentStrength, modeAuto, legacyColorMode, backgroundPlaybackPath, backgroundRejected, videoQuality, videoInfo] = await Promise.all([
    // 存的两个键：Source = 用户选的文件（界面显示），Path = 实际该播的
    // （主进程可能换成转码缓存；被拒时为空串）。
    read('appearanceBackgroundSource'),
    read(KEYS.backgroundDim),
    read(KEYS.backgroundBlur),
    read(KEYS.accent),
    read(KEYS.customAccent),
    read(KEYS.mode),
    read(KEYS.density),
    read(KEYS.accentStrength),
    read(KEYS.modeAuto),
    // v1.0 之前的「色彩主题」：colorful / mono。它现在只是强调色的一种，
    // 因此在没有新的 accent 配置时把它迁移过来，而不是丢下不管。
    read('colorMode'),
    read(KEYS.backgroundPath),
    read('appearanceBackgroundRejected'),
    read(KEYS.videoQuality),
    // 实际生效的档位由主进程回答（它知道显示器设备宽度与模糊规则）。
    read('appearanceBackgroundVideoInfo'),
  ])

  const legacyAccent: AccentId | undefined =
    legacyColorMode === 'mono' ? 'graphite' : legacyColorMode === 'colorful' ? 'blue' : undefined

  const next: Appearance = {
    backgroundPath: typeof backgroundPath === 'string' ? backgroundPath.trim() : APPEARANCE_DEFAULT.backgroundPath,
    // 主进程**总是**回答这个键（被拒时明确回空串），所以"是字符串"就照它用；
    // 只有它完全没回答（undefined，例如主进程还没起来）才退回用户选的文件。
    // 不能写成"空串就退回" —— 那正好把"被拒"重新变成一个会播放的背景。
    backgroundPlaybackPath:
      typeof backgroundPlaybackPath === 'string'
        ? backgroundPlaybackPath.trim()
        : typeof backgroundPath === 'string'
          ? backgroundPath.trim()
          : '',
    backgroundRejected: typeof backgroundRejected === 'string' ? backgroundRejected : '',
    backgroundDim: Number.isFinite(Number(backgroundDim))
      ? Math.min(100, Math.max(0, Number(backgroundDim)))
      : APPEARANCE_DEFAULT.backgroundDim,
    backgroundBlur: Number.isFinite(Number(backgroundBlur))
      ? Math.min(40, Math.max(0, Number(backgroundBlur)))
      : APPEARANCE_DEFAULT.backgroundBlur,
    videoQuality: isVideoQuality(videoQuality) ? videoQuality : APPEARANCE_DEFAULT.videoQuality,
    videoQualityEffective: isVideoQuality((videoInfo as any)?.quality)
      ? ((videoInfo as any).quality as VideoQuality)
      : isVideoQuality(videoQuality)
        ? videoQuality
        : APPEARANCE_DEFAULT.videoQuality,
    videoQualityDemoted: (videoInfo as any)?.demoted === true,
    videoDecodeEdge: Number.isFinite(Number((videoInfo as any)?.longEdge))
      ? Number((videoInfo as any).longEdge)
      : 0,
    accent: isAccent(accent) ? accent : legacyAccent || APPEARANCE_DEFAULT.accent,
    customAccent: normalizeHexColor(customAccent) || APPEARANCE_DEFAULT.customAccent,
    mode: isMode(mode) ? mode : APPEARANCE_DEFAULT.mode,
    density: isDensity(density) ? density : APPEARANCE_DEFAULT.density,
    accentStrength: isStrength(accentStrength) ? accentStrength : APPEARANCE_DEFAULT.accentStrength,
    // 从来没写过这个键 → 老用户，默认交给背景自适应；写过就用存下来的值
    modeAuto: modeAuto === undefined ? APPEARANCE_DEFAULT.modeAuto : modeAuto === true,
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
