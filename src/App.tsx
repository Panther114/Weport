import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Plug,
  PlugZap,
  Download,
  ShieldCheck,
  Bell,
  BellOff,
  Eye,
  EyeOff,
  ChevronDown,
  Archive,
  HardDrive,
  FileText,
  Braces,
  Code2,
  Table2,
  FileCode,
  MessageSquareText,
  Rows3,
  Boxes,
  FileSpreadsheet,
  Database,
  FolderOpen,
  KeyRound,
  Users,
  UserRound,
  RefreshCw,
  Trash2,
  RotateCcw,
  Paperclip,
  FileType,
  // ListChecks 已不再导入：v1.0 移除了通知页的「前置条件」清单，
  // 它与左侧栏的全局状态栏重复表达同一件事。
  Filter,
  Search,
  BellRing,
  ShieldPlus,
  Undo2,
  CheckCircle2,
  XCircle,
  Info,
  Rocket,
  Minimize2,
  ScrollText,
  Sparkles,
  Images,
  LineChart,
  Palette,
  Contrast,
  MapPin,
  Timer,
  CalendarClock,
  Pin,
  Fingerprint,
  Copy,
  GitPullRequest,
  Loader2,
  Server,
  Settings2 as SettingsIcon,
} from 'lucide-react'

import type { SetupInfo } from './components/weportAi/aiPanelTypes'
import type { AnalyticsSection } from './pages/analytics/AnalyticsModule'
import { Avatar } from './components/Avatar'
import ExportProgressBar, { type ExportProgressBarHandle } from './components/export/ExportProgressBar'
import BackgroundTasks from './components/BackgroundTasks'
import { LIVE_TASK, liveTask } from './utils/liveTask'
import { invalidateReferenceCandidates } from './utils/sessionCandidates'
import { summarizeNotifyScope } from './utils/notifyScope'
import ExportSessionPicker, { type ExportSelectionMode, type ExportSessionPickerItem, type ExportSessionType } from './components/export/ExportSessionPicker'

/**
 * 页面级代码分割。
 *
 * 打包成一个入口时实测 `dist/assets/index-*.js` 是 **1751 KB**：里面塞着 ECharts
 * （只被「分析」用）、html2canvas（只被年度报告用）、react-markdown（只被 AI 面板与
 * 更新日志用）以及几个大页面。这些字节必须在**启动时**解析并执行一遍，代价直接
 * 体现在首屏上（实测 FCP 2.3s、DCL 1.2s，中间那 1.1s 就是解析 + 首次渲染）。
 *
 * 拆出去之后启动只剩外壳与「连接微信 / 导出数据」两个核心页；其余页面第一次打开
 * 时才加载（本地文件，几十毫秒），这块开销从"每次启动都付"变成"用到才付"。
 *
 * 为什么必须先验证 `file://` 下能不能 dynamic import：Chromium 对 file 协议的模块
 * 加载有额外限制，一旦被挡住，分割出来的 chunk 会永远停在 fallback 上（等于白屏），
 * 而 typecheck 和 vite build 都不会报错。`.ui-probe/check-dynamic-import.mjs` 在
 * 打包后的 app.asar 里实测过：可用（13 个导出正常拿到）。
 *
 * 类型导入保持静态：`import type` 会被完全擦除，不产生 chunk。
 */
const WeportAiPanel = lazy(() => import('./components/weportAi/WeportAiPanel'))
const AiSettingsModal = lazy(() => import('./components/weportAi/AiSettingsModal'))
const ConnectorsPanel = lazy(() => import('./components/settings/ConnectorsPanel'))
// 液态玻璃导航层（v1.0.4）：用本项目自己的折射引擎（lensDisplacementMap + GlassFilter）。
// 静态引入 —— 左侧导航首屏就在，没法 lazy。刻意不用 @samasante/liquid-glass：
// 那个库在本项目的内部尺寸测量恒为 0，材质从不生效（证据见 .ui-probe/diagnose-glass-errors.mjs）。
import { GlassSurface } from './components/LiquidGlass/GlassSurface'
// 通知玻璃设置面板：内部用的是真弹窗组件（NotificationToast + LiquidGlass，~230KB），
// 必须 lazy —— 静态引入会把它拉进主窗口的启动图，正是 AGENTS.md 记过的那个坑。
const NotificationGlassPanel = lazy(() =>
  import('./components/settings/NotificationGlassPanel').then((m) => ({ default: m.NotificationGlassPanel }))
)
const WeBotModule = lazy(() => import('./pages/WeBotModule'))
const WeClonePage = lazy(() => import('./pages/WeClonePage'))
const AiMarkdown = lazy(() => import('./components/weportAi/AiMarkdown'))
const SnsPage = lazy(() => import('./pages/SnsPage'))
const AnalyticsModule = lazy(() => import('./pages/analytics/AnalyticsModule'))

/**
 * 懒加载页面的占位。
 *
 * 刻意不放转圈：本地 chunk 几十毫秒就位，一个 spinner 反而比空白更刺眼。占位保持
 * `.panel` 的骨架，所以从占位切到真页面时外边距不变，不会多出一次布局偏移。
 */
function LazyFallback({ label }: { label: string }) {
  return (
    <section className="panel panel-fill lazy-page" aria-busy="true" aria-label={`${label}加载中`}>
      <span className="lazy-page-hint">{label}…</span>
    </section>
  )
}
import {
  ACCENT_OPTIONS,
  ACCENT_STRENGTH_OPTIONS,
  BLUR_FORCES_BALANCED_PX,
  DENSITY_OPTIONS,
  MODE_OPTIONS,
  PRESET_ACCENTS,
  VIDEO_QUALITY_OPTIONS,
  backgroundKindOf,
  backgroundProtocolUrl,
  initAppearance,
  normalizeHexColor,
  probeBackground,
  adoptModeFromBackground,
  refreshVideoQualityInfo,
  setAccent,
  setAccentStrength,
  setBackgroundBlur,
  setBackgroundDim,
  setBackgroundPath,
  setCustomAccent,
  setDensity,
  setMode,
  setModeAuto,
  setVideoQuality,
  useAppearance,
} from './utils/appearance'
import './styles/v09.scss'
// WeClone（人格克隆）自带样式表 —— 从 9669dcb 恢复，勿删。
import './styles/weclone.scss'
// v1.0 外壳（左侧导航 + 全局状态 + 设计令牌）。必须在 v09.scss 之后加载：
// 同优先级下它负责覆盖 .shell / .topbar 的旧规则。
import './styles/v1.scss'
// 主题令牌（强调色 × 明暗）。必须最后加载：它要在 styles.css 写死的浅蓝家族
// 和 v1.scss 之后生效。
import './styles/theme.scss'

type Tab = 'connect' | 'export' | 'antirecall' | 'notifications' | 'ai' | 'webot' | 'webot-notes' | 'weclone' | 'sns' | 'analytics' | 'settings'
type Format = 'txt' | 'json' | 'arkme-json' | 'html' | 'markdown' | 'excel' | 'sql' | 'chatlab' | 'chatlab-jsonl' | 'weclone'
type PathStyle = 'auto' | 'posix' | 'windows'
type ConflictStrategy = 'incremental' | 'overwrite' | 'rename'
type DisplayNamePref = 'group-nickname' | 'remark' | 'nickname'
type WriteLayout = 'A' | 'B' | 'C'
type NotificationPosition = 'top-right' | 'top-left' | 'bottom-right' | 'bottom-left' | 'top-center'
type FilterMode = 'all' | 'whitelist' | 'blacklist' | 'mentions'
type SessionType = 'all' | 'private' | 'group' | 'official' | 'other'
type ToastKind = 'ok' | 'err' | 'info'
type Toast = { id: number; kind: ToastKind; title: string; body?: string; leaving?: boolean }

type Account = {
  wxid: string
  modifiedTime: number
  nickname?: string
  avatarUrl?: string
}

type ExportLogInfo = {
  path: string
  txt: string | null
  json: string | null
  exists: boolean
}

type AntiRevokeSession = {
  username: string
  displayName?: string
  type?: number
  avatarUrl?: string
}

const DEFAULT_DB_HINT = String.raw`C:\Users\<you>\Documents\xwechat_files`
let toastSeq = 1

const FORMATS: Array<{ value: Format; label: string; desc: string; icon: React.ComponentType<{ size?: number | string; strokeWidth?: number | string }> }> = [
  { value: 'txt', label: 'TXT', desc: '纯文本', icon: FileText },
  { value: 'json', label: 'JSON', desc: '完整消息详情', icon: Braces },
  { value: 'html', label: 'HTML', desc: '网页浏览', icon: Code2 },
  { value: 'excel', label: 'XLSX', desc: '表格统计', icon: Table2 },
  { value: 'markdown', label: 'Markdown', desc: 'AI 友好', icon: FileCode },
  { value: 'chatlab', label: 'ChatLab', desc: '标准格式', icon: MessageSquareText },
  { value: 'chatlab-jsonl', label: 'ChatLab JSONL', desc: '流式 · 适合大量消息', icon: Rows3 },
  { value: 'arkme-json', label: 'Arkme JSON', desc: '紧凑 JSON', icon: Boxes },
  { value: 'weclone', label: 'WeClone CSV', desc: 'CSV 兼容', icon: FileSpreadsheet },
  { value: 'sql', label: 'PostgreSQL', desc: '数据库脚本', icon: Database },
]

const FORMAT_FOLDERS: Record<Format, string> = {
  txt: 'TXT',
  json: 'JSON',
  'arkme-json': 'ARKME-JSON',
  html: 'HTML',
  markdown: 'MARKDOWN',
  excel: 'XLSX',
  sql: 'SQL',
  chatlab: 'CHATLAB',
  'chatlab-jsonl': 'CHATLAB-JSONL',
  weclone: 'WECLONE',
}

const WRITE_LAYOUTS: Array<{ value: WriteLayout; label: string; desc: string; tree: string[] }> = [
  {
    value: 'A',
    label: '文本在根目录',
    desc: '最常用（建议）',
    tree: ['群聊_名称.txt', 'media/群聊_名称/'],
  },
  {
    value: 'B',
    label: '按类型分目录',
    desc: '文字媒体分类',
    tree: ['texts/ 文本', 'images/ 媒体'],
  },
  {
    value: 'C',
    label: '按会话分目录',
    desc: '每会话一个目录',
    tree: ['群聊_名称/', '├ 文本 + media/'],
  },
]

const CONFLICT_OPTIONS: Array<{ value: ConflictStrategy; label: string }> = [
  { value: 'incremental', label: '增量跳过' },
  { value: 'overwrite', label: '全量覆盖' },
  { value: 'rename', label: '保留副本' },
]

const PATH_STYLE_OPTIONS: Array<{ value: PathStyle; label: string }> = [
  { value: 'auto', label: '自动' },
  { value: 'windows', label: 'Windows' },
  { value: 'posix', label: 'macOS/Linux' },
]

const NAME_PREF_OPTIONS: Array<{ value: DisplayNamePref; label: string }> = [
  { value: 'group-nickname', label: '群昵称优先' },
  { value: 'remark', label: '备注优先' },
  { value: 'nickname', label: '用户名优先' },
]

const CONCURRENCY_OPTIONS = [1, 3, 5, 10]

const NOTIFICATION_POSITION_OPTIONS: Array<{ value: NotificationPosition; label: string }> = [
  { value: 'top-right', label: '右上角' },
  { value: 'top-left', label: '左上角' },
  { value: 'bottom-right', label: '右下角' },
  { value: 'bottom-left', label: '左下角' },
  { value: 'top-center', label: '顶部居中' },
]

const isValidDecryptKey = (value: string): boolean => /^[0-9a-f]{64}$/i.test(value.trim())

const EXPORT_DEFAULTS = {
  format: 'txt' as Format,
  writeLayout: 'A' as WriteLayout,
  media: { images: false, videos: false, voices: false, emojis: false, files: false, maxFileSizeMb: 200 },
  avatars: false,
  voiceAsText: false,
  pathStyle: 'auto' as PathStyle,
  conflict: 'overwrite' as ConflictStrategy,
  namePref: 'group-nickname' as DisplayNamePref,
  concurrency: 3,
}

/**
 * 左侧导航分组。
 *
 * 旧版是 8 个平级页签挤在顶栏里：没有层级、没有分组，再加 WeBot / 笔记 /
 * 模型设置就必然溢出。按「我连上了什么 → 我用它做什么 → 我调整什么」分成三组，
 * 顺序即使用顺序：先连接，再使用，最后才是系统设置。
 */
const NAV_GROUPS: Array<{ id: string; label: string }> = [
  { id: 'wechat', label: '微信' },
  { id: 'intelligence', label: '智能' },
  { id: 'system', label: '系统' },
]

const TABS: Array<{
  id: Tab
  label: string
  icon: React.ComponentType<{ size?: number | string; strokeWidth?: number | string }>
  group: string
  /** 页面标题下方的一句话说明——替代原先每个卡片头里重复标题的灰字。 */
  hint: string
}> = [
  { id: 'connect', label: '连接微信', icon: PlugZap, group: 'wechat', hint: '数据目录、账号与解密密钥' },
  { id: 'export', label: '导出数据', icon: Download, group: 'wechat', hint: '选择会话与格式，导出到本地' },
  { id: 'sns', label: '朋友圈', icon: Images, group: 'wechat', hint: '浏览与导出朋友圈动态' },
  { id: 'analytics', label: '分析', icon: LineChart, group: 'wechat', hint: '全局与群聊统计图表' },
  { id: 'antirecall', label: '防撤回', icon: ShieldCheck, group: 'wechat', hint: '防撤回触发与已撤回消息' },
  { id: 'notifications', label: '消息通知设置', icon: Bell, group: 'wechat', hint: '弹窗外观、玻璃样式与接收范围都在这里（系统「设置」页里没有）' },
  { id: 'ai', label: 'WeportAI', icon: Sparkles, group: 'intelligence', hint: '本地聊天记录分析助手' },
  { id: 'webot', label: 'WeBot', icon: CalendarClock, group: 'intelligence', hint: '按时间自动执行的分析任务' },
  { id: 'webot-notes', label: 'WeBot 笔记', icon: Pin, group: 'intelligence', hint: '任务留下的结论与记录' },
  { id: 'weclone', label: 'WeClone', icon: Fingerprint, group: 'intelligence', hint: '从聊天记录构建可对话的人格副本' },
  { id: 'settings', label: '设置', icon: SettingsIcon, group: 'system', hint: '启动、外观、AI 服务、数据与接口' },
]

const FEATURE_LOCK_TIP = '请先获取解密密钥后再使用'

function MarkIcon() {
  // 顶栏品牌图标：真实应用图标（唯一来源 assets/branding/weport-icon.jpg
  // → assets/icons/icon.png → public/icon.png）
  return <img className="mark-img" src="icon.png" alt="Weport" draggable={false} />
}

/**
 * 导航底部的全局状态点。
 *
 * 颜色只表示状态，不表示品牌：ok=绿 / 未就绪=琥珀。文字始终存在，所以颜色
 * 不是唯一的信息通道（色盲用户与截图都能读懂）。
 */
function StatusChip({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span className="status-chip" data-state={ok ? 'ok' : 'warn'}>
      <span className="status-chip-dot" aria-hidden />
      {label}
    </span>
  )
}

export default function App() {
  const [version, setVersion] = useState('')
  const [tab, setTab] = useState<Tab>('connect')
  const [dbPath, setDbPath] = useState('')
  const [exportPath, setExportPath] = useState('')
  const [format, setFormat] = useState<Format>('txt')
  const [accounts, setAccounts] = useState<Account[]>([])
  const [selectedWxid, setSelectedWxid] = useState('')
  const [decryptKey, setDecryptKey] = useState('')
  const [showKey, setShowKey] = useState(false)
  const [keyStatus, setKeyStatus] = useState('')
  const [keyHookReady, setKeyHookReady] = useState(false)
  const [imageKeyStatus, setImageKeyStatus] = useState('')
  const [imageKeysOk, setImageKeysOk] = useState(false)
  const loadKeySeqRef = useRef(0)
  /** 缺图片密钥时"再点一次继续"的一次性确认（见 startExport 中的守卫） */
  const imageKeyAckRef = useRef(false)
  const [busy, setBusy] = useState(false)
  const [busyLabel, setBusyLabel] = useState('')
  /**
   * 导出进度**完全不进 App 的 state**（连 taskId 都不进）：导出期间主进程按
   * ~400ms 一条的频率推进度，App 是四千多行、含全部页面的组件，任何一条进度
   * 落到它的 state 上都会重渲染整棵树 —— 那就是用户看到的"所有元素被推来推去"。
   * 进度条组件（ExportProgressBar）自己订阅、自己保存 taskId，App 只在导出
   * 结束时通过 ref 让它定格。
   */
  const exportProgressRef = useRef<ExportProgressBarHandle | null>(null)
  const [exportLog, setExportLog] = useState<ExportLogInfo | null>(null)
  const [notificationsEnabled, setNotificationsEnabled] = useState(false)
  const [notificationPosition, setNotificationPosition] = useState<NotificationPosition>('top-right')
  const [notificationDuration, setNotificationDuration] = useState(3000)
  const [durationInput, setDurationInput] = useState('3')
  const [notificationAnimationEnabled, setNotificationAnimationEnabled] = useState(true)
  /** Linux 通知投递方式（其他平台忽略）：auto/force-dbus/off，见 electron/services/linuxNotify.ts */
  const [linuxNotificationMode, setLinuxNotificationMode] = useState<'auto' | 'force-dbus' | 'off'>('auto')
  const [respectWechatMute, setRespectWechatMute] = useState(true)
  const [launchAtStartup, setLaunchAtStartup] = useState(false)
  const [startupSupported, setStartupSupported] = useState(true)
  const [startupReason, setStartupReason] = useState<string | undefined>()
  const [silentStartup, setSilentStartup] = useState(false)
  const [closeToTray, setCloseToTray] = useState(true)
  const [updateInfo, setUpdateInfo] = useState<{ version: string; body?: string } | null>(null)
  const [updateBusy, setUpdateBusy] = useState(false)
  const [updateProgress, setUpdateProgress] = useState<{ percent: number; transferred?: number; total?: number } | null>(null)
  const [changelogOpen, setChangelogOpen] = useState(false)
  const [changelogContent, setChangelogContent] = useState<string | null>(null)
  const [changelogLoading, setChangelogLoading] = useState(false)
  const [aboutOpen, setAboutOpen] = useState(false)
  const [backupBusy, setBackupBusy] = useState(false)
  const [backupIncludeMedia, setBackupIncludeMedia] = useState(false)
  const [httpApiEnabled, setHttpApiEnabled] = useState(false)
  const [httpApiRunning, setHttpApiRunning] = useState(false)
  const [httpApiPort, setHttpApiPort] = useState(5031)
  // 设置页在 v1.0 改成「左侧分类 + 右侧内容」：之前是六块等权重的面板竖着
  // 排成一条长滚动，想改一项得先滚过另外五项。默认落在「常规」。
  const [settingsSection, setSettingsSection] = useState<'general' | 'appearance' | 'ai' | 'assign' | 'connectors' | 'data' | 'connect' | 'about'>('general')
  const [mcpStatus, setMcpStatus] = useState<{ running: boolean; port: number; host: string; tokenConfigured: boolean } | null>(null)
  const [mcpCopied, setMcpCopied] = useState(false)
  // 免打扰自检结果（「跟随微信消息免打扰」到底有没有在生效）
  const [muteReport, setMuteReport] = useState<Awaited<ReturnType<typeof window.electronAPI.notification.getMuteReport>> | null>(null)
  const [muteReportBusy, setMuteReportBusy] = useState(false)
  /**
   * 微信里标了「消息免打扰」的会话（`null` = 还不知道）。
   *
   * 「接收范围」那行文案要把它们算进屏蔽数 —— 打开「跟随微信消息免打扰」之后
   * 它们确实不会弹窗，但以前的计数只算手选的会话，用户看到的是"这个开关没生效"。
   */
  const [mutedSessions, setMutedSessions] = useState<{ usernames: string[]; at: number } | null>(null)
  const [mutedSessionsLoading, setMutedSessionsLoading] = useState(false)
  /** 三个功能面各自指向哪个 AI 服务（设置 → AI 服务）。 */
  const [aiAssignments, setAiAssignments] = useState<Awaited<ReturnType<typeof window.electronAPI.ai.getConsumerAssignments>> | null>(null)
  // 自定义强调色的输入框草稿：允许用户先打出半截十六进制。
  const [customAccentDraft, setCustomAccentDraft] = useState('')
  const [clearOpen, setClearOpen] = useState(false)
  const [toasts, setToasts] = useState<Toast[]>([])
  const toastTimers = useRef<Map<number, number>>(new Map())
  const [antiRevokeSessions, setAntiRevokeSessions] = useState<AntiRevokeSession[]>([])
  const [antiRevokeInstalled, setAntiRevokeInstalled] = useState<Record<string, boolean>>({})
  const [antiRevokeBusy, setAntiRevokeBusy] = useState(false)
  const [antiRevokeNewGroupsEnabled, setAntiRevokeNewGroupsEnabled] = useState(false)
  const [antiRevokeQuery, setAntiRevokeQuery] = useState('')
  const [antiRevokeFilter, setAntiRevokeFilter] = useState<'all' | 'installed' | 'pending'>('all')
  const [notifyListening, setNotifyListening] = useState(false)
  const [analyticsSection, setAnalyticsSection] = useState<AnalyticsSection>('hub')
  const appearance = useAppearance()
  const backgroundVideoRef = useRef<HTMLVideoElement | null>(null)

  // 视频背景只在窗口处于前台时播放：后台窗口没人看，继续解码只是白烧 GPU。
  // 焦点事件挂在 window 上（Electron 窗口失焦会同步触发 blur/focus）。
  //
  // **试过并被否掉的优化（v1.0.3，别再重做）**：窗口不可见时把解码器整个拆掉
  // （`removeAttribute('src')` + `load()`），想收回视频留下的 GPU 内存。
  // 实测无效 —— 托盘态销毁窗口之后，GPU 进程 243MB（改动后）vs 226~237MB（改动前），
  // 在噪声范围内，没有可测量的收益；原因是那部分内存是 **GPU 进程的资源池**，
  // 与"当前还在不在解码"无关（对照实验：全程没加载过视频的背景，同一回收流程后
  // GPU 只有 139MB，即"这个 GPU 进程有没有解过视频"决定了它，而不是"现在解不解"），
  // Chromium 不重启 GPU 进程就不会把它还回来。
  // 拆解码器反而给恢复路径多加一次本地重载，所以回退了，只保留"暂停"。
  useEffect(() => {
    const sync = () => {
      const video = backgroundVideoRef.current
      if (!video) return
      if (document.hasFocus()) void video.play().catch(() => undefined)
      else video.pause()
    }
    sync()
    window.addEventListener('focus', sync)
    window.addEventListener('blur', sync)
    document.addEventListener('visibilitychange', sync)
    return () => {
      window.removeEventListener('focus', sync)
      window.removeEventListener('blur', sync)
      document.removeEventListener('visibilitychange', sync)
    }
  }, [appearance.backgroundPlaybackPath])

  /**
   * 明暗自适应：背景变化后让主进程按背景亮度重判一次明暗。
   *
   * 渲染层不参与采样 —— 图片与视频都通过 `weport-media://` 加载，把它们画到
   * canvas 会 taint，`getImageData` 抛 SecurityError（实测）。主进程侧有
   * nativeImage 解码（图片）与 ffmpeg 抽帧（视频）两条路。
   *
   * 视频首次导入时降采样缓存还在后台生成，所以多试几次；每次都会重新核对
   * 「用户有没有手动选过明暗 / 背景是否又变了」，不会覆盖用户的选择。
   */
  useEffect(() => {
    if (!appearance.backgroundPath) return
    let cancelled = false
    const timers = [600, 3500, 9000].map((delay) =>
      window.setTimeout(() => {
        if (!cancelled) void adoptModeFromBackground()
      }, delay)
    )
    return () => {
      cancelled = true
      timers.forEach((t) => window.clearTimeout(t))
    }
  }, [appearance.backgroundPath])
  /**
   * macOS 能力诊断结果（仅 darwin 显示）。把「拿不到密钥」的三条独立原因
   * 逐条测出来 —— 否则用户手上只有一句「失败」，既不能自查也不能反馈。
   */
  const [macDiag, setMacDiag] = useState<{
    checks: Array<{ id: string; label: string; state: 'ok' | 'warn' | 'fail' | 'unknown'; detail: string }>
    summary: string
  } | null>(null)
  const [macDiagBusy, setMacDiagBusy] = useState(false)
  /** 「设置 → AI 服务」内联的提供商编辑器数据源（provider 配置只在这里可改）。 */
  const [aiSetup, setAiSetup] = useState<SetupInfo | null>(null)

  async function refreshAiSetup() {
    try {
      setAiSetup((await api.ai.getSetup()) as unknown as SetupInfo)
    } catch {
      setAiSetup(null)
    }
  }

  useEffect(() => {
    // 主题（强调色 × 明暗）与背景都在 initAppearance 里恢复 —— v1.0 之前
    // 「色彩主题」是另一个独立的 initColorMode，两个系统各管各的。
    // 背景是用户上传的任意文件，配置里只存绝对路径 —— 用户可能已经把原文件
    // 移走或删掉。加载失败时自动清空并回退到纯色，避免留下一块破图。
    void initAppearance().then(() => probeBackground(() => pushToast('err', '背景已失效', '找不到原来选择的文件，已恢复纯色背景。', 9000)))
    void refreshAiAssignments()
    void refreshAiSetup()
  }, [])

  // 导出选项（WeFlow 对齐）
  const [exportMedia, setExportMedia] = useState({ images: false, videos: false, voices: false, emojis: false, files: false, maxFileSizeMb: 200 })
  const [exportAvatars, setExportAvatars] = useState(false)
  const [exportVoiceAsText, setExportVoiceAsText] = useState(false)
  const [exportPathStyle, setExportPathStyle] = useState<PathStyle>('auto')
  const [exportConflict, setExportConflict] = useState<ConflictStrategy>('overwrite')
  const [displayNamePref, setDisplayNamePref] = useState<DisplayNamePref>('group-nickname')
  const [exportConcurrency, setExportConcurrency] = useState(3)
  const [writeLayout, setWriteLayout] = useState<WriteLayout>('A')
  const [showAdvanced, setShowAdvanced] = useState(true)
  const [exportSessions, setExportSessions] = useState<ExportSessionPickerItem[]>([])
  const [selectedExportSessionIds, setSelectedExportSessionIds] = useState<Set<string>>(new Set())
  const [exportSelectionMode, setExportSelectionMode] = useState<ExportSelectionMode>('all')
  const [exportSessionSearch, setExportSessionSearch] = useState('')
  const [exportSessionType, setExportSessionType] = useState<ExportSessionType>('all')
  const [exportSessionsLoading, setExportSessionsLoading] = useState(false)
  const [exportSessionsLoaded, setExportSessionsLoaded] = useState(false)

  // 会话通知过滤
  const [notifyFilterOpen, setNotifyFilterOpen] = useState(false)
  const [notifyFilterMode, setNotifyFilterMode] = useState<FilterMode>('all')
  const [notifyFilterList, setNotifyFilterList] = useState<string[]>([])
  const [notifySessions, setNotifySessions] = useState<Array<{ username: string; displayName?: string; avatarUrl?: string; sortTimestamp?: number; lastTimestamp?: number }>>([])
  const [notifyFilterSearch, setNotifyFilterSearch] = useState('')
  const [notifyFilterType, setNotifyFilterType] = useState<SessionType>('all')
  const [notifyFilterDraft, setNotifyFilterDraft] = useState<Set<string>>(new Set())
  const [notifyFilterBusy, setNotifyFilterBusy] = useState(false)

  const api = window.electronAPI
  const imageKeyRequired = api.process.platform === 'win32'    || api.process.platform === 'darwin'
    || api.process.platform === 'linux'
  // issue #15：macOS/Linux 的图片密钥是从微信 kvcomm 缓存推导的（不附加进程），
  // Windows 走 wx_key.dll。把差异写在按钮旁边，用户失败时才看得到下一步。
  const imageKeyHint = api.process.platform === 'win32'
    ? '未配置：导出图片前必须先获取（微信 4.x 图片为加密 .dat）'
    : '未配置：导出图片前必须先获取，密钥从微信缓存推导（无需附加微信进程）。若失败：先在微信中打开几张图片大图，并在「系统设置 → 隐私与安全性 → 完全磁盘访问权限」中允许 Weport，再重试。'

  useEffect(() => {
    setDurationInput(String(Math.round(notificationDuration / 1000)))
  }, [notificationDuration])


  const dismissToast = useCallback((id: number) => {
    const t = toastTimers.current.get(id)
    if (t) {
      window.clearTimeout(t)
      toastTimers.current.delete(id)
    }
    // 先播放退场动画，再移除 DOM
    setToasts((prev) => prev.map((x) => (x.id === id ? { ...x, leaving: true } : x)))
    const removeTimer = window.setTimeout(() => {
      setToasts((prev) => prev.filter((x) => x.id !== id))
    }, 230)
    toastTimers.current.set(id, removeTimer)
  }, [])

  const pushToast = useCallback((kind: ToastKind, title: string, body?: string, ms = 5200) => {
    const id = toastSeq++
    setToasts((prev) => [...prev.slice(-4), { id, kind, title, body }])
    const t = window.setTimeout(() => {
      dismissToast(id)
    }, ms)
    toastTimers.current.set(id, t)
  }, [dismissToast])

  const persist = useCallback((patch: { dbPath?: string; decryptKey?: string; exportPath?: string; wxid?: string; format?: Format }) => {
    if (patch.dbPath !== undefined) void api.config.set('dbPath', patch.dbPath)
    if (patch.decryptKey !== undefined) void api.config.set('decryptKey', patch.decryptKey)
    if (patch.exportPath !== undefined) void api.config.set('exportPath', patch.exportPath)
    if (patch.wxid !== undefined) void api.config.set('myWxid', patch.wxid)
    if (patch.format !== undefined) void api.config.set('exportFormat', patch.format)
  }, [api])

  const saveExportOptions = useCallback((opts: {
    format?: Format
    media?: typeof exportMedia
    avatars?: boolean
    voiceAsText?: boolean
    pathStyle?: PathStyle
    conflict?: ConflictStrategy
    namePref?: DisplayNamePref
    concurrency?: number
    layout?: WriteLayout
  }) => {
    if (opts.format !== undefined) void api.config.set('exportFormat', opts.format)
    if (opts.media !== undefined) void api.config.set('exportMedia', opts.media)
    if (opts.avatars !== undefined) void api.config.set('exportAvatars', opts.avatars)
    if (opts.voiceAsText !== undefined) void api.config.set('exportVoiceAsText', opts.voiceAsText)
    if (opts.pathStyle !== undefined) void api.config.set('exportDefaultPathStyle', opts.pathStyle)
    if (opts.conflict !== undefined) void api.config.set('exportConflictStrategy', opts.conflict)
    if (opts.namePref !== undefined) void api.config.set('exportDefaultDisplayNamePreference', opts.namePref)
    if (opts.concurrency !== undefined) void api.config.set('exportConcurrency', opts.concurrency)
    if (opts.layout !== undefined) void api.config.set('exportWriteLayout', opts.layout)
  }, [api])

  function resetExportDefaults() {
    setFormat(EXPORT_DEFAULTS.format)
    setWriteLayout(EXPORT_DEFAULTS.writeLayout)
    setExportMedia(EXPORT_DEFAULTS.media)
    setExportAvatars(EXPORT_DEFAULTS.avatars)
    setExportVoiceAsText(EXPORT_DEFAULTS.voiceAsText)
    setExportPathStyle(EXPORT_DEFAULTS.pathStyle)
    setExportConflict(EXPORT_DEFAULTS.conflict)
    setDisplayNamePref(EXPORT_DEFAULTS.namePref)
    setExportConcurrency(EXPORT_DEFAULTS.concurrency)
    setExportSelectionMode('all')
    void saveExportOptions({
      format: EXPORT_DEFAULTS.format,
      layout: EXPORT_DEFAULTS.writeLayout,
      media: EXPORT_DEFAULTS.media,
      avatars: EXPORT_DEFAULTS.avatars,
      voiceAsText: EXPORT_DEFAULTS.voiceAsText,
      pathStyle: EXPORT_DEFAULTS.pathStyle,
      conflict: EXPORT_DEFAULTS.conflict,
      namePref: EXPORT_DEFAULTS.namePref,
      concurrency: EXPORT_DEFAULTS.concurrency,
    })
    pushToast('ok', '已恢复默认导出设置', '目录结构 A · TXT 格式')
  }

  const refreshExportLog = useCallback(async (path: string) => {
    if (!path.trim()) {
      setExportLog(null)
      return
    }
    try {
      setExportLog(await api.export.getExportLog(path.trim()))
    } catch {
      setExportLog(null)
    }
  }, [api])

  const loadExportSessions = useCallback(async () => {
    setExportSessionsLoading(true)
    try {
      const result = await api.chat.getSessions()
      const seen = new Set<string>()
      const sessions: ExportSessionPickerItem[] = []
      for (const raw of result?.sessions || []) {
        const username = String(raw?.username || '').trim()
        if (!username || username.toLowerCase().includes('placeholder_foldgroup') || seen.has(username)) continue
        seen.add(username)
        sessions.push({
          username,
          displayName: String(raw?.displayName || '').trim() || undefined,
          summary: String(raw?.summary || '').trim() || undefined,
          avatarUrl: String(raw?.avatarUrl || '').trim() || undefined,
          messageCountHint: Number.isFinite(Number(raw?.messageCountHint)) ? Math.max(0, Math.floor(Number(raw?.messageCountHint))) : undefined,
        })
      }

      const missingNames = sessions.filter((session) => !session.displayName).map((session) => session.username)
      if (missingNames.length > 0) {
        try {
          const enriched = await api.chat.enrichSessionsContactInfo(missingNames)
          for (const session of sessions) {
            if (!session.displayName) {
              session.displayName = String(enriched?.contacts?.[session.username]?.displayName || '').trim() || undefined
            }
          }
        } catch { /* cached/raw username remains usable */ }
      }

      sessions.sort((a, b) => (a.displayName || a.username).localeCompare(b.displayName || b.username, 'zh-Hans-CN'))
      setExportSessions(sessions)
      setSelectedExportSessionIds((previous) => {
        if (previous.size === 0) return previous
        const available = new Set(sessions.map((session) => session.username))
        return new Set(Array.from(previous).filter((id) => available.has(id)))
      })
    } catch (error) {
      setExportSessions([])
      setSelectedExportSessionIds(new Set())
      pushToast('err', '加载导出会话失败', String(error))
    } finally {
      setExportSessionsLoaded(true)
      setExportSessionsLoading(false)
    }
  }, [api, pushToast])

  const loadAccountKey = useCallback(async (wxid: string) => {
    const seq = ++loadKeySeqRef.current
    if (!wxid) {
      setDecryptKey('')
      setImageKeysOk(false)
      return
    }
    try {
      const wxidConfigs = (await api.config.get('wxidConfigs')) || {}
      if (seq !== loadKeySeqRef.current) return
      const cfg = wxidConfigs[wxid]
      const key = typeof cfg?.decryptKey === 'string' ? cfg.decryptKey : ''
      if (seq !== loadKeySeqRef.current) return
      setDecryptKey(key)
      // 图片密钥状态（issue #9a）：aesKey 非空视为已配置（xorKey 可合法为 0）。
      // 与主进程 getImageKeysForCurrentWxid 一致：账号级缺省时回退全局配置。
      let imageOk = Boolean(cfg?.imageAesKey)
      if (!imageOk) {
        try {
          const globalAes = await api.config.get('imageAesKey')
          if (seq !== loadKeySeqRef.current) return
          imageOk = Boolean(globalAes)
        } catch { /* noop */ }
      }
      if (seq !== loadKeySeqRef.current) return
      setImageKeysOk(imageOk)
      // 全局 decryptKey 必须与当前账号一致，导出/后端连接都读全局配置；
      // 只改 React 状态会让「界面显示 A 账号密钥、实际用 B 账号密钥」的错位状态出现。
      // 注意：仅当与全局配置确实不同才写回——启动加载时两者通常已一致，
      // 无脑写会触发主进程 config:set → close → reconnect 循环（连接抖动）。
      if (key) {
        try {
          const globalKey = await api.config.get('decryptKey')
          if (globalKey !== key) void persist({ decryptKey: key })
        } catch { /* noop */ }
      }
    } catch {
      setDecryptKey('')
    }
  }, [api, persist])

  const saveAccountKey = useCallback(async (wxid: string, key: string): Promise<boolean> => {
    if (!wxid || !key) return false
    try {
      const result = await api.config.updateWxidEntry(wxid, { decryptKey: key, updatedAt: Date.now() })
      return result?.success !== false
    } catch {
      return false
    }
  }, [api])

  // 密钥输入与自动捕获共用同一条确认路径，确保主进程拿到最新的账号/目录/密钥，
  // 并在 UI 解锁前实际打开 WCDB、读取一次会话列表。此前这里只是 fire-and-forget
  // 写配置，用户看到密钥已填入但数据库仍未连接，容易误以为需要再次登录微信。
  const persistAndConnectKey = useCallback(async (rawKey: string): Promise<{ success: boolean; error?: string }> => {
    const key = rawKey.trim()
    const path = dbPath.trim()
    const wxid = selectedWxid.trim()
    if (!isValidDecryptKey(key)) return { success: false, error: '请输入完整的 64 位十六进制密钥' }
    if (!path) return { success: false, error: '请先选择微信数据目录' }
    if (!wxid) return { success: false, error: '请先选择微信账号' }

    const ensureConfig = async (configKey: string, value: string) => {
      const current = await api.config.get(configKey)
      if (current === value) return
      const result = await api.config.set(configKey, value)
      if (result?.success === false) throw new Error(`保存${configKey}失败`)
    }

    try {
      await ensureConfig('dbPath', path)
      await ensureConfig('myWxid', wxid)
      await ensureConfig('decryptKey', key)
      if (!await saveAccountKey(wxid, key)) return { success: false, error: '账号密钥保存失败' }

      const connection = await api.chat.connect()
      if (!connection?.success) {
        return { success: false, error: connection?.error || '数据库连接失败' }
      }
      const sessions = await api.chat.getSessions()
      if (!sessions?.success) {
        return { success: false, error: sessions?.error || '数据库已打开，但会话读取失败' }
      }
      return { success: true }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  }, [api, dbPath, saveAccountKey, selectedWxid])

  const refreshAccounts = useCallback(async (path: string) => {
    if (!path.trim()) {
      setAccounts([])
      setSelectedWxid('')
      return
    }
    try {
      const list = await api.dbPath.scanWxids(path.trim())
      setAccounts(list || [])
      if (list?.length) {
        // 自动切换选中账号时必须同步加载该账号的密钥状态，否则 decryptKey /
        // imageKeysOk 仍停留在旧账号上（导出拦截、密钥展示全部错位）。
        const chosen = list.some((a) => a.wxid === selectedWxid) ? selectedWxid : list[0].wxid
        setSelectedWxid(chosen)
        if (chosen !== selectedWxid) void loadAccountKey(chosen)
        pushToast('ok', `找到 ${list.length} 个账号`, path.trim(), 3200)
      } else {
        setSelectedWxid('')
        pushToast('info', '未找到账号目录', '请确认选择的是 xwechat_files 根目录')
      }
    } catch (e) {
      setAccounts([])
      setSelectedWxid('')
      pushToast('err', '扫描账号失败', String(e))
    }
  }, [api, pushToast, selectedWxid, loadAccountKey])

  const detectDb = useCallback(async () => {
    setBusy(true)
    setBusyLabel('正在扫描微信数据目录…')
    try {
      const result = await api.dbPath.autoDetect()
      if (result.success && result.path) {
        setDbPath(result.path)
        void persist({ dbPath: result.path })
        await refreshAccounts(result.path)
        pushToast('ok', '已定位数据目录', result.path)
      } else {
        pushToast('info', '未能自动检测', result.error || '请手动选择 xwechat_files 文件夹')
      }
    } catch (e) {
      pushToast('err', '扫描失败', String(e))
    } finally {
      setBusy(false)
      setBusyLabel('')
    }
  }, [api, pushToast, refreshAccounts, persist])

  // issue #9a：图片密钥提取（kvcomm 缓存 → 内存扫描兜底），成功后按账号持久化
  const extractImageKey = useCallback(async () => {
    if (busy) return
    if (!selectedWxid) {
      pushToast('err', '请先选择要导出的账号')
      return
    }
    if (!dbPath.trim()) {
      // 无 dbPath 时 kvcomm 路径无法校验密钥归属（keyService 会退化为
      // candidates[0] 猜测），内存扫描也找不到 *_t.dat 模板——直接拦截。
      pushToast('err', '请先选择微信数据目录', '获取图片密钥需要数据目录来校验密钥归属')
      return
    }
    setBusy(true)
    setBusyLabel('正在获取图片密钥…')
    setImageKeyStatus('正在从微信缓存读取图片密钥…')
    try {
      let result = await api.key.autoGetImageKey(dbPath || undefined, selectedWxid)
      // issue #20：缓存路径的失败原因必须留住。以前它被内存扫描的报错直接覆盖，
      // 用户只看到"60 秒内未找到 AES 密钥"——而真正的原因（密钥码与这个账号对不上、
      // 或者两个账号同机时模板取错了账号）就永远不出现在界面上。
      const cacheError = result.success ? '' : String(result.error || '').trim()
      if (!result.success) {
        setImageKeyStatus('缓存读取失败，正在用内存扫描兜底（请先在微信中打开 2-3 张图片大图）…')
        result = await api.key.scanImageKeyFromMemory(dbPath || '')
      }
      if (result.success && typeof result.xorKey === 'number' && result.aesKey) {
        await api.config.updateWxidEntry(selectedWxid, { imageXorKey: result.xorKey, imageAesKey: result.aesKey, updatedAt: Date.now() })
        setImageKeysOk(true)
        if (result.verified === false) {
          // keyService 未能用本账号自己的 *_t.dat 模板校验密钥归属（目录里还没有图片
          // 缓存，或账号目录没定位到）——明确提示而不是静默当作成功。
          pushToast('info', '图片密钥已保存（未校验）', `未能确认密钥属于账号 ${selectedWxid}；若导出图片仍失败，请用该账号在微信中打开几张图片后重新获取`, 12000)
        } else {
          pushToast('ok', '图片密钥获取成功', `已按账号 ${selectedWxid} 校验并保存，现在可以导出图片了`)
        }
      } else if (result.success) {
        pushToast('err', '图片密钥不完整', '未取得完整的 XOR/AES 密钥，请重试或使用内存扫描')
      } else {
        // 两条路径的说明都带上：缓存路径解释"为什么没推导出来"，内存扫描解释"下一步"。
        const detail = [cacheError, String(result.error || '').trim()].filter(Boolean).join(' ')
        pushToast('err', '图片密钥获取失败', detail || '请先在微信中查看几张图片后重试', 20000)
      }
    } catch (e) {
      pushToast('err', '图片密钥获取失败', String(e), 10000)
    } finally {
      setBusy(false)
      setBusyLabel('')
      setImageKeyStatus('')
    }
  }, [api, busy, selectedWxid, dbPath, pushToast])

  const selectAccount = useCallback((wxid: string) => {
    setSelectedWxid(wxid)
    setExportSessions([])
    setSelectedExportSessionIds(new Set())
    setExportSelectionMode('all')
    setExportSessionsLoaded(false)
    void persist({ wxid })
    void loadAccountKey(wxid)
  }, [persist, loadAccountKey])

  useEffect(() => {
    void api.app.getVersion().then(setVersion).catch(() => undefined)

    ;(async () => {
      try {
        const last = await api.config.get('lastTab')
        if (TABS.some((t) => t.id === last)) setTab(last)
      } catch { /* noop */ }
      try {
        const db = await api.config.get('dbPath')
        if (typeof db === 'string' && db) setDbPath(db)
        const out = await api.config.get('exportPath')
        if (typeof out === 'string' && out) {
          setExportPath(out)
          await refreshExportLog(out)
        }
        const wxid = await api.config.get('myWxid')
        if (typeof wxid === 'string' && wxid) setSelectedWxid(wxid)
        const fmt = await api.config.get('exportFormat')
        if (typeof fmt === 'string' && FORMATS.some((f) => f.value === fmt)) setFormat(fmt as Format)
        const notif = await api.config.get('notificationEnabled')
        setNotificationsEnabled(notif === true)
        const notifPosition = await api.config.get('notificationPosition')
        if (NOTIFICATION_POSITION_OPTIONS.some((option) => option.value === notifPosition)) {
          setNotificationPosition(notifPosition as NotificationPosition)
        }
        const notifDuration = await api.config.get('notificationDuration')
        if (Number.isFinite(Number(notifDuration))) {
          setNotificationDuration(Math.min(60_000, Math.max(1000, Math.round(Number(notifDuration)))))
        } else {
          setNotificationDuration(3000)
        }
        const notifAnimation = await api.config.get('notificationAnimationEnabled')
        if (typeof notifAnimation === 'boolean') setNotificationAnimationEnabled(notifAnimation)
        const linuxNotifyMode = await api.config.get('linuxNotificationMode')
        if (linuxNotifyMode === 'auto' || linuxNotifyMode === 'force-dbus' || linuxNotifyMode === 'off') {
          setLinuxNotificationMode(linuxNotifyMode)
        }
        const respectMute = await api.config.get('messagePushRespectWechatMute')
        if (typeof respectMute === 'boolean') setRespectWechatMute(respectMute)
        try {
          const httpOn = await api.config.get('httpApiEnabled')
          setHttpApiEnabled(httpOn === true)
          if (httpOn === true) {
            const status = await api.http.getStatus().catch(() => null)
            setHttpApiRunning(status?.running === true)
            if (status?.running) setHttpApiPort(status.port)
          }
        } catch { /* noop */ }
        // MCP 服务的状态一直只存在于主进程：v1.0 之前用户既看不到它是否在跑，
        // 也拿不到那份客户端配置，只能照文档手抄。这里把它读进设置页。
        try {
          setMcpStatus(await api.mcp.getStatus())
        } catch { /* noop */ }
        const silent = await api.config.get('silentStartup')
        setSilentStartup(silent === true)
        const close = await api.config.get('windowCloseBehavior')
        setCloseToTray(close !== 'quit')
        try {
          const autoApply = await api.config.get('antiRevokeAutoApplyNewGroups')
          setAntiRevokeNewGroupsEnabled(autoApply === true)
        } catch { /* default-off */ }

        // 导出选项
        try {
          const media = await api.config.get('exportMedia')
          if (media && typeof media === 'object') {
            setExportMedia((prev) => ({
              ...prev,
              ...(media as Partial<typeof exportMedia>),
            }))
          }
          const avatars = await api.config.get('exportAvatars')
          if (typeof avatars === 'boolean') setExportAvatars(avatars)
          const voiceAsText = await api.config.get('exportVoiceAsText')
          if (typeof voiceAsText === 'boolean') setExportVoiceAsText(voiceAsText)
          const pathStyle = await api.config.get('exportDefaultPathStyle')
          if (pathStyle === 'auto' || pathStyle === 'posix' || pathStyle === 'windows') setExportPathStyle(pathStyle)
          const conflict = await api.config.get('exportConflictStrategy')
          if (conflict === 'incremental' || conflict === 'overwrite' || conflict === 'rename') setExportConflict(conflict)
          const namePref = await api.config.get('exportDefaultDisplayNamePreference')
          if (namePref === 'group-nickname' || namePref === 'remark' || namePref === 'nickname') setDisplayNamePref(namePref)
          const concurrency = await api.config.get('exportConcurrency')
          if (typeof concurrency === 'number' && CONCURRENCY_OPTIONS.includes(concurrency)) setExportConcurrency(concurrency)
          const layout = await api.config.get('exportWriteLayout')
          if (layout === 'A' || layout === 'B' || layout === 'C') setWriteLayout(layout)
        } catch { /* 保持默认 */ }

        // 会话通知过滤
        try {
          const mode = await api.config.get('messagePushFilterMode')
          if (mode === 'whitelist' || mode === 'blacklist' || mode === 'mentions') setNotifyFilterMode(mode)
          const list = await api.config.get('messagePushFilterList')
          if (Array.isArray(list)) setNotifyFilterList(list.map((x) => String(x || '').trim()).filter(Boolean))
        } catch { /* 保持默认 */ }
        if (db) {
          await refreshAccounts(String(db))
          await loadAccountKey(String(wxid || ''))
        } else {
          await detectDb()
        }
      } catch {
        await detectDb()
      }
    })()

    const unsubs = [
      api.key.onDbKeyStatus((payload) => {
        setKeyStatus(payload.message)
        if (payload.message.includes('已准备就绪') || payload.message.includes('可以登录') || payload.message.includes('Hook安装成功')) {
          setKeyHookReady(true)
        }
        if (payload.message.includes('密钥获取成功')) {
          setKeyHookReady(false)
        }
      }),
      api.key.onImageKeyStatus((payload) => {
        setImageKeyStatus(payload.message)
      }),
      api.app.onUpdateAvailable((info) => {
        setUpdateInfo({ version: info.version, body: info.releaseNotes || undefined })
        pushToast('info', `发现新版本 v${info.version}`, '可在顶部横幅更新')
      }),
      api.app.onDownloadProgress((p) => {
        setUpdateProgress({ percent: Number(p?.percent) || 0, transferred: p?.transferred, total: p?.total })
      }),
      api.app.onUpdateDownloaded(() => {
        // 下载完成：应用即将退出安装并自动重启，禁用更新按钮
        setUpdateBusy(true)
        setUpdateProgress({ percent: 100, total: 1, transferred: 1 })
      })
    ]

    void api.app.getLaunchAtStartupStatus().then((s) => {
      setLaunchAtStartup(s.enabled)
      setStartupSupported(s.supported)
      setStartupReason(s.reason)
    }).catch(() => undefined)

    return () => {
      unsubs.forEach((u) => u())
      toastTimers.current.forEach((t) => window.clearTimeout(t))
    }
  }, [api, detectDb, refreshAccounts, refreshExportLog, loadAccountKey, pushToast])

  useEffect(() => {
    void refreshExportLog(exportPath)
  }, [exportPath, refreshExportLog])

  const keyOk = decryptKey.trim().length === 64
  const dbReady = dbPath.trim().length > 0
  const accountReady = selectedWxid.length > 0
  const allReady = dbReady && accountReady && keyOk
  const activeTab = TABS.find((t) => t.id === tab) ?? TABS[0]

  useEffect(() => {
    if (tab !== 'export' || !keyOk || exportSessionsLoaded || exportSessionsLoading) return
    void loadExportSessions()
  }, [tab, keyOk, exportSessionsLoaded, exportSessionsLoading, loadExportSessions])

  const filteredExportSessions = useMemo(() => {
    const keyword = exportSessionSearch.trim().toLowerCase()
    return exportSessions.filter((session) => {
      const isGroup = session.username.endsWith('@chatroom')
      const isOfficial = session.username.startsWith('gh_')
      if (exportSessionType === 'group' && !isGroup) return false
      if (exportSessionType === 'private' && (isGroup || isOfficial)) return false
      if (exportSessionType === 'official' && !isOfficial) return false
      if (!keyword) return true
      const name = String(session.displayName || '').toLowerCase()
      const id = session.username.toLowerCase()
      const summary = String(session.summary || '').toLowerCase()
      return name.includes(keyword) || id.includes(keyword) || summary.includes(keyword)
    })
  }, [exportSessionSearch, exportSessionType, exportSessions])

  const allVisibleExportSessionsSelected = filteredExportSessions.length > 0 &&
    filteredExportSessions.every((session) => selectedExportSessionIds.has(session.username))

  const toggleExportSession = useCallback((username: string) => {
    setSelectedExportSessionIds((previous) => {
      const next = new Set(previous)
      if (next.has(username)) next.delete(username)
      else next.add(username)
      return next
    })
  }, [])

  const toggleVisibleExportSessions = useCallback(() => {
    setSelectedExportSessionIds((previous) => {
      const next = new Set(previous)
      if (allVisibleExportSessionsSelected) {
        for (const session of filteredExportSessions) next.delete(session.username)
      } else {
        for (const session of filteredExportSessions) next.add(session.username)
      }
      return next
    })
  }, [allVisibleExportSessionsSelected, filteredExportSessions])

  async function pickDbFolder() {
    const selected = await api.dialog.openDirectory({ title: '选择微信数据目录 (xwechat_files)' })
    if (selected) {
      setDbPath(selected)
      void persist({ dbPath: selected })
      await refreshAccounts(selected)
    }
  }

  async function pickExportFolder() {
    const selected = await api.dialog.openDirectory({ title: '选择导出输出文件夹' })
    if (selected) {
      setExportPath(selected)
      void persist({ exportPath: selected })
      await refreshExportLog(selected)
    }
  }

  async function extractKey() {
    if (busy) return
    if (!dbPath.trim()) {
      pushToast('err', '请先选择微信数据目录')
      return
    }
    if (!selectedWxid) {
      pushToast('err', '请先选择微信账号', '获取密钥后需要绑定当前账号并验证数据库连接')
      return
    }
    setBusy(true)
    setKeyHookReady(false)
    setBusyLabel('正在连接微信进程…')
    pushToast('info', '开始提取密钥', '密钥在登录瞬间捕获。请关闭微信「自动登录」，等待「已准备就绪」后重新登录。', 7000)
    try {
      const result = await api.key.autoGetDbKey()
      if (result.success && result.key) {
        const key = result.key.trim()
        setDecryptKey(key)
        setKeyHookReady(false)
        const connection = await persistAndConnectKey(key)
        if (connection.success) {
          pushToast('ok', '密钥提取并连接成功', '已读取会话，可以开始导出全部聊天记录')
        } else {
          pushToast('err', '密钥已获取，但数据库连接失败', connection.error, 10000)
        }
      } else {
        pushToast('err', '密钥提取失败', result.error || '请按左侧说明重试', 10000)
      }
    } catch (e) {
      pushToast('err', '密钥提取失败', String(e), 10000)
    } finally {
      setBusy(false)
      setBusyLabel('')
      setKeyStatus('')
    }
  }

  async function confirmKeyAndConnect() {
    if (busy) return
    if (!keyOk) {
      pushToast('err', '密钥格式不正确', '请输入完整的 64 位十六进制密钥')
      return
    }
    setBusy(true)
    setBusyLabel('正在验证密钥并连接数据库…')
    try {
      const result = await persistAndConnectKey(decryptKey)
      if (result.success) {
        setKeyHookReady(false)
        pushToast('ok', '密钥已确认，数据库已连接', '已读取会话，可以开始导出')
      } else {
        pushToast('err', '数据库连接失败', result.error, 10000)
      }
    } finally {
      setBusy(false)
      setBusyLabel('')
    }
  }

  /**
   * 账号一换，`@` 的会话候选缓存必须作废。
   *
   * 候选是**按账号**的（每个 wxid 一套会话表），而缓存是模块级的、TTL 60 秒。
   * 不主动清的话，切账号后的第一个 `@` 会列出上一个账号的联系人 —— 这正是
   * "引用了不存在的人"这类难查的问题的来源。密钥/数据目录变化同理。
   */
  useEffect(() => {
    invalidateReferenceCandidates()
  }, [selectedWxid, dbPath, decryptKey])

  /**
   * 全局长任务指示器要的两个回调。
   *
   * 「跳转」不是锦上添花：看到角落写着"导出 62%"想去看一眼，用户得自己回忆
   * 它在哪个标签下 —— 这个按钮把那一步省掉。取消则直接复用各功能已有的取消
   * 通道（导出按 taskId、克隆走 weclone.cancel）。
   */
  const handleOpenTaskTab = useCallback((target: 'connect' | 'export' | 'weclone' | 'settings') => {
    setTab(target)
  }, [])

  const handleCancelTask = useCallback(
    (key: string) => {
      if (key === LIVE_TASK.export) {
        const taskId = liveTask(LIVE_TASK.export).getState().detail?.taskId
        if (typeof taskId === 'string' && taskId) void api.export.cancelTask(taskId)
        return
      }
      if (key === LIVE_TASK.wecloneGenerate) {
        void api.weclone.cancel()
      }
    },
    [api]
  )

  async function runExport() {    if (!dbPath.trim()) {
      pushToast('err', '请选择微信数据目录')
      return
    }
    if (!selectedWxid) {
      pushToast('err', '请选择要导出的账号')
      return
    }
    if (!exportPath.trim()) {
      pushToast('err', '请选择导出输出文件夹')
      return
    }
    if (!keyOk) {
      pushToast('err', '请先提取或粘贴 64 位解密密钥')
      return
    }
    if (exportSelectionMode === 'selected' && selectedExportSessionIds.size === 0) {
      pushToast('err', '请选择要导出的会话', '可使用“全选当前”快速选择筛选结果')
      return
    }
    // issue #15：微信 4.x 在 Windows/macOS/Linux 均可能使用加密 .dat 图片，
    // 缺失图片密钥时导出只会得到 [图片] 占位符。
    //
    // 但**不能直接拒绝导出**：在 macOS 上图片密钥经常拿不到（WeChat 是
    // 加固签名 + 沙盒进程，task_for_pid 会被系统拒绝），硬拦截会把用户彻底
    // 卡死 —— 连文字记录都导不出去，比导出占位符糟糕得多。
    // 因此改为「先警告、再确认」：第一次点击只说明后果，第二次点击照常导出；
    // 缺密钥的图片会以 [图片] 占位，并在完成提示里给出具体数量。
    if (exportMedia.images && imageKeyRequired && !imageKeysOk) {
      if (!imageKeyAckRef.current) {
        imageKeyAckRef.current = true
        pushToast(
          'err',
          '尚未配置图片密钥',
          '导出的图片将全部显示为 [图片] 占位符。再次点击「开始导出」仍会继续；建议先点击「获取图片密钥」。',
          12000
        )
        return
      }
      imageKeyAckRef.current = false
    }

    setBusy(true)
    exportProgressRef.current?.reset()
    setBusyLabel(exportSelectionMode === 'all'
      ? '开始导出全部会话…'
      : `开始导出 ${selectedExportSessionIds.size} 个会话…`)

    const mediaEnabled = exportMedia.images || exportMedia.videos || exportMedia.voices || exportMedia.emojis || exportMedia.files
    const options: ExportRequest = {
      // v0.9.6: the IPC integrator must scope the main-process session list to
      // this explicit selection before calling exportService.exportSessions.
      sessionIds: exportSelectionMode === 'selected' ? Array.from(selectedExportSessionIds) : undefined,
      format,
      exportImages: exportMedia.images,
      exportVideos: exportMedia.videos,
      exportVoices: exportMedia.voices,
      exportEmojis: exportMedia.emojis,
      exportFiles: exportMedia.files,
      exportMedia: mediaEnabled,
      maxFileSizeMb: exportMedia.maxFileSizeMb,
      exportAvatars,
      exportVoiceAsText,
      exportPathStyle,
      exportConflictStrategy: exportConflict,
      displayNamePreference: displayNamePref,
      exportConcurrency,
      exportWriteLayout: writeLayout,
      sessionLayout: writeLayout === 'C' ? 'per-session' : 'shared',
      sessionNameWithTypePrefix: true,
    }

    try {
      const result = await api.export.exportSessions(exportPath.trim(), options)
      await refreshExportLog(exportPath.trim())
      // issue #15/#5b：缺图片密钥不再是静默占位 —— 计数随导出结果返回，这里必须可见。
      const imageKeyMissing = Math.max(0, Math.floor(Number(result.imageKeyMissingFiles || 0)))
      const imageKeyWarning = imageKeyMissing > 0 ? ` · ${imageKeyMissing} 张图片缺密钥显示为[图片]，请获取图片密钥后重新导出` : ''
      if (result.success) {
        pushToast('ok', '导出完成', `成功 ${result.successCount ?? 0} 个会话 → ${result.formatFolder}/（已覆盖同名文件）${imageKeyWarning}`, imageKeyMissing > 0 ? 12000 : 7000)
        // 让进度条定格到完成态（并**换掉会话名**）：原来只把 phase 改掉，面板上会
        // 留着 `准备中…  189 / 189` —— 数字满了、文字还停在准备阶段。
        exportProgressRef.current?.complete()
      } else {
        pushToast('err', '导出未完全成功', `${result.error || `成功 ${result.successCount ?? 0} / 失败 ${result.failCount ?? 0}`}${imageKeyWarning}`, 12000)
      }
    } catch (e) {
      pushToast('err', '导出失败', String(e), 12000)
    } finally {
      setBusy(false)
      setBusyLabel('')
    }
  }

  async function confirmClearLibrary() {
    if (!exportPath.trim()) {
      pushToast('err', '请先选择输出文件夹')
      setClearOpen(false)
      return
    }
    setBusy(true)
    setBusyLabel('正在清空导出库…')
    try {
      const result = await api.export.clearLibrary(exportPath.trim())
      await refreshExportLog(exportPath.trim())
      pushToast('ok', result.success ? '已清空导出库' : '清空失败', result.removed?.length ? `已删除 ${result.removed.length} 项` : result.error)
    } catch (e) {
      pushToast('err', '清空失败', String(e), 10000)
    } finally {
      setBusy(false)
      setBusyLabel('')
      setClearOpen(false)
    }
  }

  async function openChangelog() {
    setChangelogOpen(true)
    if (changelogContent !== null) return
    setChangelogLoading(true)
    try {
      const result = await api.app.getChangelog()
      if (result.success && typeof result.content === 'string') {
        setChangelogContent(result.content)
      } else {
        setChangelogContent('')
        pushToast('err', '无法读取更新日志', result.error || '文件缺失', 8000)
      }
    } catch (e) {
      setChangelogContent('')
      pushToast('err', '无法读取更新日志', String(e), 8000)
    } finally {
      setChangelogLoading(false)
    }
  }

  async function checkForUpdates(fromAbout = false) {
    setUpdateBusy(true)
    try {
      const result = await api.app.checkForUpdates()
      if (!result.hasUpdate) {
        pushToast('ok', '已是最新版本', `当前 v${version}`)
        setUpdateInfo(null)
        void fromAbout
        return
      }
      setUpdateInfo({ version: result.version || '', body: result.releaseNotes || undefined })
      pushToast('info', `发现新版本 v${result.version}`, '已打开更新日志，确认后即可安装')
      void openChangelog()
    } catch (e) {
      pushToast('err', '检查更新失败', String(e))
    } finally {
      setUpdateBusy(false)
    }
  }

  async function installUpdate() {
    setUpdateBusy(true)
    setUpdateProgress({ percent: 0 })
    let restarting = false
    try {
      const result = await api.app.downloadAndInstall()
      if (result.success) {
        if (result.restarting) {
          // 主进程已触发 quitAndInstall：应用即将退出 → 静默安装 → 自动重启，
          // 保持「正在安装并重启…」状态直到进程退出
          restarting = true
          setUpdateBusy(true)
          setUpdateProgress(null)
        } else {
          setUpdateProgress(null)
          pushToast('ok', '更新已下载', '重启应用完成安装')
        }
      } else {
        setUpdateProgress(null)
        pushToast('err', '更新失败', result.error || '未知错误', 10000)
      }
    } catch (e) {
      setUpdateProgress(null)
      pushToast('err', '更新失败', String(e), 10000)
    } finally {
      if (!restarting) setUpdateBusy(false)
    }
  }

  async function createBackup() {
    setBackupBusy(true)
    try {
      const dir = await api.dialog.openDirectory()
      if (!dir) return
      // 备份可能要几分钟（含附件时更久），期间用户一定会去干别的 ——
      // 记进长任务 store，左下角角标就一直在，切页面也看得见。
      liveTask(LIVE_TASK.backup).start('正在创建备份…')
      pushToast('info', '正在创建备份…', '数据库表快照打包中，请稍候')
      const r = await api.backup.create({
        outputPath: dir,
        options: { includeImages: backupIncludeMedia, includeVideos: backupIncludeMedia, includeFiles: backupIncludeMedia },
      })
      if (r.success) {
        liveTask(LIVE_TASK.backup).update({ status: 'done', progress: 100, message: '备份完成' })
        pushToast('ok', '备份完成', r.filePath || '')
      } else {
        liveTask(LIVE_TASK.backup).update({ status: 'failed', message: r.error || '备份失败', error: r.error })
        pushToast('err', '备份失败', r.error || '未知错误', 10000)
      }
    } catch (e) {
      liveTask(LIVE_TASK.backup).update({ status: 'failed', message: String(e), error: String(e) })
      pushToast('err', '备份失败', String(e), 10000)
    } finally {
      setBackupBusy(false)
    }
  }

  async function restoreBackup() {
    setBackupBusy(true)
    try {
      const file = await api.dialog.openFile({
        filters: [{ name: 'Weport 备份', extensions: ['zip'] }],
      })
      if (!file) return
      liveTask(LIVE_TASK.backup).start('正在恢复备份…')
      pushToast('info', '正在恢复备份…', '将覆盖当前数据库中的对应表')
      const r = await api.backup.restore(file)
      if (r.success) {
        liveTask(LIVE_TASK.backup).update({ status: 'done', progress: 100, message: '恢复完成' })
        pushToast('ok', '恢复完成', '请重启应用以重新加载数据')
      } else {
        liveTask(LIVE_TASK.backup).update({ status: 'failed', message: r.error || '恢复失败', error: r.error })
        pushToast('err', '恢复失败', r.error || '未知错误', 10000)
      }
    } catch (e) {
      liveTask(LIVE_TASK.backup).update({ status: 'failed', message: String(e), error: String(e) })
      pushToast('err', '恢复失败', String(e), 10000)
    } finally {
      setBackupBusy(false)
    }
  }

  async function toggleHttpApi(on: boolean) {
    setHttpApiEnabled(on)
    await api.config.set('httpApiEnabled', on)
    try {
      const port = Number((await api.config.get('httpApiPort')) || 5031)
      setHttpApiPort(port)
      if (on) {
        const r = await api.http.start()
        setHttpApiRunning(r.success)
        if (!r.success) pushToast('err', 'HTTP API 启动失败', r.error || '', 8000)
      } else {
        await api.http.stop()
        setHttpApiRunning(false)
      }
    } catch {
      setHttpApiRunning(false)
    }
  }

  /**
   * 把 MCP 客户端配置整段复制到剪贴板。
   *
   * 配置里含有访问令牌，所以整段 JSON 由主进程拼好返回 —— 令牌不出主进程，
   * 渲染进程只负责写剪贴板。
   */
  async function copyMcpClientConfig() {
    try {
      const result = await api.mcp.getClientConfig()
      await navigator.clipboard.writeText(result.json)
      setMcpStatus({ running: result.running, port: result.port, host: result.host, tokenConfigured: result.tokenConfigured })
      setMcpCopied(true)
      window.setTimeout(() => setMcpCopied(false), 2000)
      pushToast('ok', '已复制 MCP 客户端配置', '粘进 claude_desktop_config.json 后重启宿主', 6000)
    } catch (e) {
      pushToast('err', '复制失败', String((e as Error)?.message || e), 8000)
    }
  }

  /**
   * 拉取免打扰自检报告。
   *
   * 「跟随微信消息免打扰」跨四层（原生 → wcdbCore → chatService 缓存 → 推送
   * 过滤），任何一层返回空都只会表现成「通知照发」，不会有任何报错。所以这里
   * 把每层的中间数字都取回来给用户看，而不是只显示一句「已开启」。
   */
  async function openMuteReport() {
    setMuteReportBusy(true)
    try {
      setMuteReport(await api.notification.getMuteReport())
    } catch (e) {
      pushToast('err', '自检失败', String((e as Error)?.message || e), 9000)
    } finally {
      setMuteReportBusy(false)
    }
  }

  /** 读取「设置 → AI 服务」的分配情况。 */
  async function refreshAiAssignments() {
    try {
      setAiAssignments(await api.ai.getConsumerAssignments())
    } catch {
      setAiAssignments({ success: false, consumers: [], profiles: [], activeProfileId: '' })
    }
  }

  async function assignAiConsumer(consumer: 'chat' | 'weclone' | 'webot', profileId: string) {
    const result = await api.ai.assignConsumer(consumer, profileId)
    if (!result.success) {
      pushToast('err', '设置失败', result.error || '', 8000)
      return
    }
    await refreshAiAssignments()
  }

  async function activateAiProfile(profileId: string) {
    const result = await api.ai.activateProfile(profileId)
    if (!result.success) {
      pushToast('err', '设置默认服务失败', result.error || '', 8000)
      return
    }
    await refreshAiAssignments()
  }

  async function toggleNotifications(on: boolean) {
    setNotificationsEnabled(on)
    await api.config.set('notificationEnabled', on)
    await api.config.set('messagePushEnabled', on)
    if (on) {
      if (!dbReady || !accountReady || !keyOk) {
        pushToast('info', '消息提醒已开启', '完成上面的准备条件后开始监听')
      } else {
        const result = await api.chat.connect()
        setNotifyListening(result.success)
        pushToast(result.success ? 'ok' : 'err', result.success ? '正在监听新消息' : '监听启动失败', result.error)
      }
    } else {
      setNotifyListening(false)
    }
  }

  async function updateNotificationPosition(value: NotificationPosition) {
    const previous = notificationPosition
    setNotificationPosition(value)
    try {
      const result = await api.config.set('notificationPosition', value)
      if (result?.success === false) throw new Error('配置保存失败')
    } catch (error) {
      setNotificationPosition(previous)
      pushToast('err', '弹窗位置保存失败', String(error))
    }
  }

  async function updateNotificationDuration(value: number) {
    const previous = notificationDuration
    setNotificationDuration(value)
    try {
      const result = await api.config.set('notificationDuration', value)
      if (result?.success === false) throw new Error('配置保存失败')
    } catch (error) {
      setNotificationDuration(previous)
      pushToast('err', '弹窗时长保存失败', String(error))
    }
  }

  async function toggleNotificationAnimation(on: boolean) {
    const previous = notificationAnimationEnabled
    setNotificationAnimationEnabled(on)
    try {
      const result = await api.config.set('notificationAnimationEnabled', on)
      if (result?.success === false) throw new Error('配置保存失败')
    } catch (error) {
      setNotificationAnimationEnabled(previous)
      pushToast('err', '弹窗动效设置失败', String(error))
    }
  }

  async function updateLinuxNotificationMode(value: 'auto' | 'force-dbus' | 'off') {
    const previous = linuxNotificationMode
    setLinuxNotificationMode(value)
    try {
      const result = await api.config.set('linuxNotificationMode', value)
      if (result?.success === false) throw new Error('配置保存失败')
    } catch (error) {
      setLinuxNotificationMode(previous)
      pushToast('err', '通知方式保存失败', String(error))
    }
  }

  async function toggleRespectWechatMute(on: boolean) {
    const previous = respectWechatMute
    setRespectWechatMute(on)
    try {
      const result = await api.config.set('messagePushRespectWechatMute', on)
      if (result?.success === false) throw new Error('配置保存失败')
      // 打开这个开关就立刻把「哪些会话被它压住了」查出来：不查的话页面头上
      // 只会显示手选的数字，看起来像这个开关什么也没做（用户报的 bug）。
      void refreshMutedSessions(true)
    } catch (error) {
      setRespectWechatMute(previous)
      pushToast('err', '免打扰同步设置失败', String(error))
    }
  }

  /**
   * 拉取「微信里标了消息免打扰」的会话列表。
   *
   * 为什么要单独查一次：会话对象上的 `isMuted` 只在缓存命中时才带，推送侧是
   * 在每次同步里补查的；设置页不能拿一个"未知"当"没有免打扰"。批量走
   * `chat:getSessionStatuses`（主进程会写回同一个缓存，推送侧随后直接用）。
   *
   * 单个批次失败只影响那一批：整页数字因为一次超时变成 0 是最糟的结果。
   */
  async function refreshMutedSessions(force = false) {
    if (!respectWechatMute && !force) {
      setMutedSessions(null)
      return
    }
    if (!force && mutedSessions && Date.now() - mutedSessions.at < 300_000) return
    setMutedSessionsLoading(true)
    try {
      const result = await api.chat.getSessions()
      const usernames = (result?.sessions || [])
        .map((session) => String(session?.username || '').trim())
        .filter(Boolean)
      const muted: string[] = []
      const batchSize = 200
      for (let offset = 0; offset < usernames.length; offset += batchSize) {
        const batch = usernames.slice(offset, offset + batchSize)
        try {
          const statuses = await api.chat.getSessionStatuses(batch)
          for (const username of batch) if (statuses?.map?.[username]?.isMuted === true) muted.push(username)
        } catch { /* 这一批读不到就当未知，不影响其它批次 */ }
      }
      setMutedSessions({ usernames: muted, at: Date.now() })
    } catch (error) {
      // 读失败要保持 null（未知），不能变成"没有免打扰会话"
      setMutedSessions(null)
      console.warn('[Notify] 读取免打扰会话失败:', error)
    } finally {
      setMutedSessionsLoading(false)
    }
  }

  async function toggleLaunchAtStartup(on: boolean) {
    const result = await api.app.setLaunchAtStartup(on)
    if (result.success) {
      // 以系统实际状态为准（reg 写入失败时 UI 不显示"已开启"）
      const status = await api.app.getLaunchAtStartupStatus().catch(() => null)
      if (status) setLaunchAtStartup(status.enabled)
      if (!status?.enabled) pushToast('err', '开机自启设置失败', result.error || '系统未接受设置')
    } else {
      setLaunchAtStartup(false)
      pushToast('err', '开机自启设置失败', result.error || '未知错误')
    }
  }

  async function toggleSilentStartup(on: boolean) {
    setSilentStartup(on)
    await api.config.set('silentStartup', on)
    if (launchAtStartup) {
      // 重新写入 Run 键（带/不带 --background）
      await api.app.setLaunchAtStartup(true)
    }
  }

  async function toggleCloseToTray(on: boolean) {
    setCloseToTray(on)
    await api.config.set('windowCloseBehavior', on ? 'tray' : 'quit')
  }

  useEffect(() => {
    // 打开防撤回页时自动加载状态
    if (tab === 'antirecall' && allReady && antiRevokeSessions.length === 0 && !antiRevokeBusy) {
      void refreshAntiRevoke()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, allReady])

  async function refreshAntiRevoke() {
    setAntiRevokeBusy(true)
    try {
      const sessionsResult = await api.chat.getAntiRevokeSessions()
      const sessions: AntiRevokeSession[] = sessionsResult.sessions || []
      setAntiRevokeSessions(sessions)
      // 头像/昵称补全不阻塞列表：`getSessions()` 只回缓存里的联系人信息，未读过的
      // 会话没有头像，先渲染列表再补齐，避免"打开这一页先白等一秒"。
      void enrichAntiRevokeContacts(sessions)
      if (sessions.length > 0) {
        const ids = sessions.map((s) => s.username)
        const check = await api.chat.checkAntiRevokeTriggers(ids)
        const installed: Record<string, boolean> = {}
        for (const row of check.rows || []) {
          if (row.success) installed[row.sessionId] = row.installed === true
        }
        setAntiRevokeInstalled(installed)
      } else {
        setAntiRevokeInstalled({})
      }
    } catch (e) {
      pushToast('err', '防撤回状态刷新失败', String(e))
    } finally {
      setAntiRevokeBusy(false)
    }
  }

  async function enrichAntiRevokeContacts(sessions: AntiRevokeSession[]) {
    const missing = sessions.filter((s) => !s.avatarUrl || !s.displayName).map((s) => s.username)
    if (!missing.length) return
    try {
      const enriched = await api.chat.enrichSessionsContactInfo(missing)
      const contacts = enriched?.contacts
      if (!contacts) return
      setAntiRevokeSessions((prev) =>
        prev.map((s) => {
          const info = contacts[s.username]
          if (!info) return s
          return {
            ...s,
            displayName: s.displayName || info.displayName,
            avatarUrl: s.avatarUrl || info.avatarUrl,
          }
        })
      )
    } catch {
      /* 补全失败就用首字母占位，不影响安装/还原 */
    }
  }

  async function installAntiRevoke(ids: string[]) {
    if (!ids.length) return
    setAntiRevokeBusy(true)
    try {
      const result = await api.chat.installAntiRevokeTriggers(ids)
      const ok = result.rows?.filter((r) => r.success).length || 0
      const failed = result.rows?.filter((r) => !r.success).length || 0
      pushToast(ok > 0 ? 'ok' : 'err', `防撤回安装完成`, `成功 ${ok}${failed ? ` / 失败 ${failed}` : ''}`)
      await refreshAntiRevoke()
    } catch (e) {
      pushToast('err', '防撤回安装失败', String(e))
      setAntiRevokeBusy(false)
    }
  }

  async function uninstallAntiRevoke(ids: string[]) {
    if (!ids.length) return
    setAntiRevokeBusy(true)
    try {
      const result = await api.chat.uninstallAntiRevokeTriggers(ids)
      const ok = result.rows?.filter((r) => r.success).length || 0
      pushToast(ok > 0 ? 'ok' : 'err', `防撤回已还原`, `成功 ${ok}`)
      await refreshAntiRevoke()
    } catch (e) {
      pushToast('err', '防撤回还原失败', String(e))
      setAntiRevokeBusy(false)
    }
  }

  async function toggleAntiRevokeNewGroups(on: boolean) {
    setAntiRevokeNewGroupsEnabled(on)
    try {
      const result = await api.config.set('antiRevokeAutoApplyNewGroups', on)
      if (result?.success === false) throw new Error('配置保存失败')
      pushToast('ok', on ? '已开启新群聊自动防撤回' : '已关闭新群聊自动防撤回')
    } catch (e) {
      setAntiRevokeNewGroupsEnabled(!on)
      pushToast('err', '自动防撤回设置失败', String(e))
    }
  }

  const formatFolder = FORMAT_FOLDERS[format] || 'TXT'
  const installedCount = Object.values(antiRevokeInstalled).filter(Boolean).length

  // 会话一多，防撤回列表就没法用了 —— 没有搜索，也没法只看「还没装的」。
  const filteredAntiRevokeSessions = useMemo(() => {
    const kw = antiRevokeQuery.trim().toLowerCase()
    return antiRevokeSessions.filter((s) => {
      const installed = antiRevokeInstalled[s.username] === true
      if (antiRevokeFilter === 'installed' && !installed) return false
      if (antiRevokeFilter === 'pending' && installed) return false
      if (!kw) return true
      return (s.displayName || '').toLowerCase().includes(kw) || s.username.toLowerCase().includes(kw)
    })
  }, [antiRevokeSessions, antiRevokeInstalled, antiRevokeQuery, antiRevokeFilter])

  const antiRevokeActions = () => (
    <div className="panel-actions">
      <span className="hint">
        当前显示 {filteredAntiRevokeSessions.length} / {antiRevokeSessions.length} 个会话
      </span>
      <div className="panel-actions-buttons">
        <button
          className="secondary-btn"
          type="button"
          disabled={!allReady || antiRevokeBusy || antiRevokeSessions.length === 0}
          onClick={() => void installAntiRevoke(antiRevokeSessions.map((s) => s.username))}
        >
          <ShieldPlus size={14} />
          全部安装
        </button>
        <button
          className="danger-btn"
          type="button"
          disabled={!allReady || antiRevokeBusy || installedCount === 0}
          onClick={() => void uninstallAntiRevoke(Object.keys(antiRevokeInstalled).filter((id) => antiRevokeInstalled[id]))}
        >
          <Undo2 size={14} />
          全部还原
        </button>
      </div>
    </div>
  )

  function switchTab(next: Tab) {
    setTab(next)
    void api.config.set('lastTab', next)
  }

  function sessionTypeOf(username: string): Exclude<SessionType, 'all'> {
    if (username.startsWith('gh_')) return 'official'
    if (username.endsWith('@chatroom')) return 'group'
    return 'private'
  }

  const notifyFilteredSessions = useMemo(() => {
    const kw = notifyFilterSearch.trim().toLowerCase()
    return notifySessions.filter((s) => {
      if (notifyFilterType !== 'all' && sessionTypeOf(s.username) !== notifyFilterType) return false
      if (kw) {
        const name = (s.displayName || s.username).toLowerCase()
        if (!name.includes(kw) && !s.username.toLowerCase().includes(kw)) return false
      }
      return true
    })
  }, [notifySessions, notifyFilterType, notifyFilterSearch])

  /** 微信里标了免打扰、且**不在**手选列表里的会话 —— 它们让"屏蔽 n 个"变大。 */
  const mutedSet = useMemo(() => new Set(mutedSessions?.usernames || []), [mutedSessions])
  const mutedExtraCount = useMemo(() => {
    if (!mutedSessions) return null
    const selected = new Set(notifyFilterList)
    let count = 0
    for (const username of mutedSessions.usernames) if (!selected.has(username)) count += 1
    return count
  }, [mutedSessions, notifyFilterList])

  /**
   * 「接收范围」的文案。**免打扰跟随的会话必须算进屏蔽数** —— 这是用户报的
   * bug：开关开着、通知确实不弹了，但头上那行数字一动不动，看起来像没生效。
   */
  const notifyScope = useMemo(
    () =>
      summarizeNotifyScope({
        mode: notifyFilterMode,
        selectedCount: notifyFilterList.length,
        mutedExtraCount,
        followMute: respectWechatMute,
      }),
    [notifyFilterMode, notifyFilterList.length, mutedExtraCount, respectWechatMute]
  )

  /**
   * 打开「消息通知设置」时把免打扰会话查出来（60 秒内不重复查）。
   *
   * 只在这一页查：它是唯一会显示这个数字的地方，而读一次状态要走原生接口 +
   * 最多几十个会话的批量调用，不该在启动路径上做。
   */
  useEffect(() => {
    if (tab !== 'notifications') return
    if (!respectWechatMute) return
    void refreshMutedSessions()
    // refreshMutedSessions 每次渲染都是新函数；这里只依赖"进入这一页"与开关状态，
    // 5 分钟 TTL 已经在函数内部挡住了重复查询。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, respectWechatMute])

  async function openNotifyFilter() {
    setNotifyFilterDraft(new Set(notifyFilterList))
    setNotifyFilterSearch('')
    setNotifyFilterType('all')
    setNotifyFilterOpen(true)
    if (notifySessions.length > 0) return
    setNotifyFilterBusy(true)
    try {
      const result = await api.chat.getSessions()
      const sessions: Array<{ username: string; displayName?: string; avatarUrl?: string; sortTimestamp?: number; lastTimestamp?: number }> = []
      for (const s of result?.sessions || []) {
        const username = String(s?.username || '').trim()
        if (!username || username.toLowerCase().includes('placeholder_foldgroup')) continue
        const sortTimestamp = Number(s?.sortTimestamp ?? s?.sort_timestamp ?? 0)
        const lastTimestamp = Number(s?.lastTimestamp ?? s?.last_timestamp ?? 0)
        sessions.push({
          username,
          displayName: String(s?.displayName || '') || undefined,
          avatarUrl: String(s?.avatarUrl || '') || undefined,
          sortTimestamp: Number.isFinite(sortTimestamp) ? sortTimestamp : undefined,
          lastTimestamp: Number.isFinite(lastTimestamp) ? lastTimestamp : undefined,
        })
      }
      const missing = sessions.filter((s) => !s.displayName || !s.avatarUrl).map((s) => s.username)
      if (missing.length > 0) {
        try {
          const enriched = await api.chat.enrichSessionsContactInfo(missing)
          for (const s of sessions) {
            const info = enriched?.contacts?.[s.username]
            if (!s.displayName) s.displayName = info?.displayName
            if (!s.avatarUrl) s.avatarUrl = info?.avatarUrl
          }
        } catch { /* noop */ }
      }
      sessions.sort((a, b) => {
        const aRecent = Number(a.sortTimestamp || a.lastTimestamp || 0)
        const bRecent = Number(b.sortTimestamp || b.lastTimestamp || 0)
        if (bRecent !== aRecent) return bRecent - aRecent
        return a.username.localeCompare(b.username)
      })
      setNotifySessions(sessions)
    } catch (e) {
      pushToast('err', '加载会话失败', String(e))
    } finally {
      setNotifyFilterBusy(false)
    }
  }

  function saveNotifyFilter() {
    const list = Array.from(notifyFilterDraft)
    setNotifyFilterList(list)
    void api.config.set('messagePushFilterMode', notifyFilterMode)
    void api.config.set('messagePushFilterList', list)
    // 与弹窗层过滤（notificationFilter*）保持一致
    void api.config.set('notificationFilterMode', notifyFilterMode)
    void api.config.set('notificationFilterList', list)
    setNotifyFilterOpen(false)
    const summary = notifyFilterMode === 'all'
      ? '通知全部会话'
      : notifyFilterMode === 'mentions'
        ? '仅提醒群聊中明确 @你的消息（@所有人不触发）'
        : `已选 ${list.length} 个会话`
    pushToast('ok', '会话过滤已保存', summary)
  }

  /**
   * 选择背景图片。
   *
   * 只保存绝对路径、不复制文件：渲染层用既有的 `weport-media://` 协议按绝对
   * 路径读取本地图片（见 utils/appearance.ts 的说明）。这样不新增 IPC、不把
   * 图片塞进配置文件。
   */
  async function pickBackgroundImage(): Promise<void> {
    try {
      const selected = await api.dialog.openFile({
        title: '选择背景（图片或视频）',
        // 视频背景在 v1.0.1 已经支持，但这里的过滤器还只写着图片 —— 用户根本
        // 选不到 mp4。第一项是"全部支持的类型"，Windows 的资源管理器会默认选中它。
        filters: [
          { name: '图片与视频', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'avif', 'mp4', 'webm', 'm4v', 'mov', 'ogv'] },
          { name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'avif'] },
          { name: '视频', extensions: ['mp4', 'webm', 'm4v', 'mov', 'ogv'] },
        ],
      })
      if (!selected) return
      setBackgroundPath(selected)
      // 新选的可能是一段视频：主进程此刻会开始后台转码，实际档位/长边要问它。
      void refreshVideoQualityInfo()
    } catch (error) {
      pushToast('err', '选择背景失败', String((error as Error)?.message || error), 9000)
    }
  }

  /** macOS 兼容性检查：把结果直接展示出来，并支持一键复制给维护者。 */
  async function runMacDiagnostics(): Promise<void> {
    setMacDiagBusy(true)
    try {
      const report = await api.diagnostics.collectMac()
      if (!report.supported) {
        pushToast('err', '当前平台不是 macOS', '这个检查只在 macOS 上有意义。', 7000)
        return
      }
      setMacDiag({ checks: report.checks, summary: report.summary })
    } catch (error) {
      pushToast('err', '检查失败', String((error as Error)?.message || error), 9000)
    } finally {
      setMacDiagBusy(false)
    }
  }

  async function copyMacDiagnostics(): Promise<void> {
    if (!macDiag) return
    try {
      await navigator.clipboard.writeText(macDiag.summary)
      pushToast('ok', '诊断信息已复制', '可以直接粘贴给维护者；内容不含聊天记录与密钥。', 6000)
    } catch (error) {
      pushToast('err', '复制失败', String((error as Error)?.message || error), 9000)
    }
  }

  const backgroundKind = backgroundKindOf(appearance.backgroundPlaybackPath)

  return (
    <div className="shell">
      {/* 背景层：图片与视频共用同一个合成层（见 theme.scss 的 `.app-bg`）。
          视频必须是真实的 <video>（而且要 muted + playsInline 才允许自动播放），
          窗口在前台时循环播放，切到后台就暂停 —— 一个一直在解码的视频会持续吃
          GPU 和电，而后台窗口没有人看。图片走 <img>：只有它是<img>才能吃到
          「背景模糊」，也才能一次光栅化后不再重绘。 */}
      {backgroundKind === 'none' ? null : (
        <div className="app-bg" aria-hidden="true">
          {backgroundKind === 'video' ? (
            <video
              ref={backgroundVideoRef}
              src={backgroundProtocolUrl(appearance.backgroundPlaybackPath)}
              autoPlay
              loop
              muted
              playsInline
              preload="auto"
              // 出帧后按背景亮度自动定明暗（用户手动选过就不再干预）。
              // 挂在 loadeddata 而不是 mount：视频没解码完时读不到像素。
              onLoadedData={() => void adoptModeFromBackground()}
            />
          ) : (
            // 同一条亮度自适应：探针与设置页都靠它决定「跟随背景」的明暗。
            <img
              src={backgroundProtocolUrl(appearance.backgroundPlaybackPath)}
              alt=""
              draggable={false}
              onLoad={() => void adoptModeFromBackground()}
            />
          )}
          <div className="app-bg-dim" />
        </div>
      )}
      <GlassSurface
        className="rail"
        role="navigation"
        aria-label="主导航"
        surfaceId="rail"
      >
        <div
          className="rail-brand"
          role="button"
          tabIndex={0}
          title="关于与更新"
          onClick={() => setAboutOpen(true)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault()
              setAboutOpen(true)
            }
          }}
        >
          <div className="mark" aria-hidden>
            <MarkIcon />
          </div>
          <div className="rail-brand-text">
            <h1>Weport</h1>
            <p>v{version}</p>
          </div>
        </div>

        <nav className="rail-nav" role="tablist" aria-label="功能">
          {NAV_GROUPS.map((group) => (
            <div className="rail-group" key={group.id}>
              <div className="rail-group-label">{group.label}</div>
              {TABS.filter((t) => t.group === group.id).map((t) => {
                const Icon = t.icon
                // 与其余功能一致：未完成数据目录/账号/密钥准备前不可用
                const locked = t.id !== 'connect' && !allReady
                const button = (
                  <button
                    key={t.id}
                    type="button"
                    role="tab"
                    aria-selected={tab === t.id}
                    className="rail-item"
                    data-active={tab === t.id}
                    disabled={locked}
                    onClick={() => switchTab(t.id)}
                  >
                    {/* 描边跟着文字重量走：选中态文字更重，图标也加粗一档 */}
                    <Icon size={16} strokeWidth={tab === t.id ? 2 : 1.6} />
                    <span>{t.label}</span>
                  </button>
                )
                // disabled 按钮不触发原生 title 提示，用外层包裹实现悬停提示
                return locked ? (
                  <span key={t.id} className="tab-tip" title={FEATURE_LOCK_TIP} aria-disabled="true">
                    {button}
                  </span>
                ) : (
                  button
                )
              })}
            </div>
          ))}
        </nav>

        {/* 全局状态：旧版把「已连接 / 已就绪 / 1 个」分别写在连接页、通知页和
            导出页里，用户永远不确定哪一个才是当前真实状态。这里合并成唯一
            一处真源，各页面里的重复状态随之删掉。 */}
        <div className="rail-foot" aria-label="连接状态">
          <StatusChip ok={dbReady} label={dbReady ? '数据目录' : '未连接目录'} />
          <StatusChip ok={accountReady} label={accountReady ? '账号已选' : '未选账号'} />
          <StatusChip ok={keyOk} label={keyOk ? '密钥就绪' : '缺少密钥'} />
        </div>
      </GlassSurface>

      <header className="topbar">
        <div className="topbar-title">
          <h2>{activeTab.label}</h2>
          <p>{activeTab.hint}</p>
        </div>
        <div className="top-actions">
          {busy && busyLabel ? (
            <span className="status-busy" role="status">
              {busyLabel}
            </span>
          ) : null}
        </div>
      </header>

      {updateInfo && (
        <div className="update-banner">
          <div className="update-banner-body">
            <h2>发现新版本 v{updateInfo.version}</h2>
            {updateInfo.body ? (
              <div className="update-banner-notes">
                <Suspense fallback={null}>
                  <AiMarkdown text={updateInfo.body} />
                </Suspense>
              </div>
            ) : (
              <p className="hint" style={{ marginTop: 4 }}>建议更新以获得修复与改进。</p>
            )}
            <button className="update-banner-link" type="button" onClick={() => void openChangelog()}>
              <ScrollText size={13} />
              查看完整更新日志
            </button>
            {updateBusy && updateProgress && (
              <div className="update-progress" aria-live="polite">
                <div className="progress-track">
                  <div
                    className="progress-fill"
                    style={{ width: `${Math.max(0, Math.min(100, updateProgress.percent))}%` }}
                  />
                </div>
                <span>{Math.round(updateProgress.percent)}%</span>
              </div>
            )}
          </div>
          <button className="primary-btn" type="button" disabled={updateBusy} onClick={() => void installUpdate()}>
            {updateBusy ? (updateProgress ? `下载中 ${Math.round(updateProgress.percent)}%` : '正在安装并重启…') : '立即更新'}
          </button>
        </div>
      )}

      <div className="workspace" key={tab}>
        {tab === 'connect' && (
          /* 重排：原来是「左栏 = 数据位置 + 账号，右栏 = 密钥」的两列排布，读起来
             是 1 → 3 → 2 —— 密钥排在账号前面，而它实际上必须最后做。现在改成
             和导出页同一套编号分区，按真正的先后顺序单栏排列，每一步自带完成状态，
             于是这一页本身也是一张进度清单。 */
          <div className="page-stack">
            <section className="panel">
              {/* 第 1、2 步并排：它们各自只有「一个输入框 + 两个按钮」和「一个账号
                  列表」，单栏铺满 1040px 时中间全是空白；密钥那一步有输入框和
                  折叠说明，独占一行。 */}
              <div className="connect-steps">
              <div className="exp-section">
                <div className="exp-sec-head">
                  <span className="exp-num">1</span>
                  <FolderOpen size={14} />
                  微信聊天记录数据位置
                  <span className="exp-sec-meta">
                    {dbReady ? <span className="badge ok">已就绪</span> : <span className="badge">待设置</span>}
                  </span>
                </div>
                <div className="field">
                  <label htmlFor="dbPath">微信数据文件夹</label>
                  <div className="path-row">
                    <input
                      id="dbPath"
                      className="path-input"
                      value={dbPath}
                      placeholder={DEFAULT_DB_HINT}
                      onChange={(e) => setDbPath(e.target.value)}
                      onBlur={() => {
                        if (dbPath.trim()) void persist({ dbPath: dbPath.trim() })
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && dbPath.trim()) {
                          void persist({ dbPath: dbPath.trim() })
                          void refreshAccounts(dbPath.trim())
                        }
                      }}
                      spellCheck={false}
                    />
                    <button className="ghost-btn" type="button" onClick={() => void pickDbFolder()} disabled={busy}>
                      浏览
                    </button>
                  </div>
                </div>
                <div className="btn-row">
                  <button className="secondary-btn" type="button" onClick={() => void detectDb()} disabled={busy}>
                    <RefreshCw size={14} />
                    自动扫描
                  </button>
                  <button
                    className="secondary-btn"
                    type="button"
                    onClick={() => void refreshAccounts(dbPath)}
                    disabled={busy || !dbPath.trim()}
                  >
                    <Users size={14} />
                    刷新账号
                  </button>
                </div>
              </div>

              <div className="exp-section">
                <div className="exp-sec-head">
                  <span className="exp-num">2</span>
                  <Users size={14} />
                  选择微信账号
                  <span className="exp-sec-meta">
                    {accounts.length > 0 ? <span className="card-sub">{accounts.length} 个</span> : null}
                    {accountReady ? <span className="badge ok">已选择</span> : <span className="badge">待选择</span>}
                  </span>
                </div>
                {accounts.length === 0 ? (
                  <div className="empty">选择或扫描数据目录后显示账号</div>
                ) : (
                  <div className="account-list account-list-row" role="listbox" aria-label="微信账号">
                    {accounts.map((account) => (
                      <button
                        key={account.wxid}
                        type="button"
                        className="account-item"
                        data-active={account.wxid === selectedWxid}
                        role="option"
                        aria-selected={account.wxid === selectedWxid}
                        onClick={() => selectAccount(account.wxid)}
                        disabled={busy}
                      >
                        {account.avatarUrl ? (
                          <img
                            className="account-avatar"
                            src={account.avatarUrl}
                            alt=""
                            loading="lazy"
                            onError={(e) => {
                              ;(e.target as HTMLImageElement).style.display = 'none'
                            }}
                          />
                        ) : (
                          <span className="account-avatar fallback">
                            {(account.nickname || account.wxid).charAt(0).toUpperCase()}
                          </span>
                        )}
                        <div>
                          <strong>{account.nickname || account.wxid}</strong>
                          <span>{account.wxid}</span>
                        </div>
                        {account.wxid === selectedWxid ? (
                          <span className="badge ok">当前</span>
                        ) : (
                          <span className="badge">选择</span>
                        )}
                      </button>
                    ))}
                  </div>
                )}
              </div>
              </div>

              <div className="exp-section">
                <div className="exp-sec-head">
                  <span className="exp-num">3</span>
                  <KeyRound size={14} />
                  解密密钥
                  <span className="exp-sec-meta">
                    {keyOk ? <span className="badge ok">格式正确</span> : <span className="badge">待提取</span>}
                  </span>
                </div>

                {/* 顺序即优先级：这是一张「要你做事」的卡片，所以控件在最前，
                    说明收进折叠区。旧版把四段编号散文放在最上面，用户必须先读完
                    才能看见按钮在哪。 */}
                <div className="field">
                  <label htmlFor="decryptKey">数据库密钥</label>
                  <div className="path-row">
                    <input
                      id="decryptKey"
                      className="path-input"
                      type={showKey ? 'text' : 'password'}
                      value={decryptKey}
                      placeholder="64 位十六进制密钥…"
                      onChange={(e) => {
                        const v = e.target.value.trim()
                        setDecryptKey(v)
                      }}
                      spellCheck={false}
                      autoComplete="off"
                      disabled={busy}
                    />
                    <button
                      className="ghost-btn icon-btn-sm"
                      type="button"
                      onClick={() => setShowKey((v) => !v)}
                      disabled={busy}
                      title={showKey ? '隐藏密钥' : '显示密钥'}
                      aria-label={showKey ? '隐藏密钥' : '显示密钥'}
                    >
                      {showKey ? <EyeOff size={14} /> : <Eye size={14} />}
                    </button>
                  </div>
                </div>

                <div className="btn-row">
                  <button className="primary-btn" type="button" onClick={() => void extractKey()} disabled={busy}>
                    <KeyRound size={14} />
                    {busy ? '提取中…' : '提取密钥'}
                  </button>
                  <button
                    className="secondary-btn"
                    type="button"
                    onClick={() => void confirmKeyAndConnect()}
                    disabled={busy || !dbReady || !accountReady || !keyOk}
                  >
                    <PlugZap size={14} />
                    确认密钥并连接
                  </button>
                </div>

                {keyHookReady && busy && (
                  <div className="callout ready" role="status">
                    Hook 已就绪 — 请现在登录微信，或退出账号后重新登录（可在手机上确认）。
                  </div>
                )}
                {keyStatus && <p className="hint">{keyStatus}</p>}

                <div className="steps-details">
                  <div className="steps-details-title">如何获取密钥？</div>
                  <ol className="steps">
                    <li>
                      <span className="step-num">1</span>
                      <span>
                        打开微信电脑版，在「设置 → 通用」里<strong>关闭「自动登录」</strong>，
                        然后退出当前登录（或完全退出微信）
                      </span>
                    </li>
                    <li>
                      <span className="step-num">2</span>
                      <span>
                        点击上方<strong>「提取密钥」</strong>，等待出现「已准备就绪」提示——
                        此时 Weport 已挂接微信进程，正在等待登录
                      </span>
                    </li>
                    <li>
                      <span className="step-num">3</span>
                      <span>
                        用手机<strong>扫码登录微信</strong>（登录成功的瞬间密钥会被自动捕获并填入）
                      </span>
                    </li>
                    <li>
                      <span className="step-num">4</span>
                      <span>也可直接粘贴已有的 64 位十六进制密钥（从旧版本或其他工具获取）</span>
                    </li>
                  </ol>
                  <p className="hint">
                    {keyOk
                      ? '密钥格式正确，请点击「确认密钥并连接」验证当前账号数据库。'
                      : '密钥在登录瞬间捕获，不是从已登录会话直接读取。'}
                  </p>
                </div>
              </div>
            </section>

            {/* macOS 兼容性检查：只在 macOS 上出现。放在连接页是因为「拿不到
                密钥」正是用户停在这一页的原因。 */}
            {api.process.platform === 'darwin' && (
              <section className="panel">
                <div className="panel-head">
                  <h2>
                    <ShieldCheck size={15} />
                    macOS 兼容性检查
                  </h2>
                </div>
                <p className="hint" style={{ marginBottom: 10 }}>
                  逐项检查微信进程、签名权限、完全磁盘访问权限与随包助手状态，说明为什么自动获取密钥可能失败。
                </p>
                <div className="diag-actions">
                  <button className="primary-btn" type="button" disabled={macDiagBusy} onClick={() => void runMacDiagnostics()}>
                    {macDiagBusy ? '检查中…' : '开始检查'}
                  </button>
                  {macDiag ? (
                    <button className="secondary-btn" type="button" onClick={() => void copyMacDiagnostics()}>
                      复制诊断信息
                    </button>
                  ) : null}
                </div>

                {macDiag ? (
                  <ul className="diag-list">
                    {macDiag.checks.map((check) => (
                      <li key={check.id} className="diag-item" data-state={check.state}>
                        <span className="diag-dot" aria-hidden />
                        <div>
                          <strong>{check.label}</strong>
                          <span className="hint">{check.detail}</span>
                        </div>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </section>
            )}
          </div>
        )}

        {tab === 'export' && (
          <section className="panel panel-fill export-page">
            {/* 页头 + 进度合成一个吸顶块。
                进度原来挂在右栏卡片流的最前面：窗口不到 1280 CSS px 时右栏整块
                落到会话列表**下面**，进度条和「取消导出」被推出视口；宽窗口下右栏
                虽然吸顶，进度也会先把「高级选项」顶到折叠线以下。进度是这一页最
                需要随时看得见的东西，所以并入吸顶块 —— 两种布局下都始终可见，
                而且它在正常流里的位置就在顶部，不会盖住任何内容。

                吸顶块本身不设 top，页头保持 top: 0，进度条就是它的下一行。

                进度条**自己订阅**导出进度（见 ExportProgressBar）：把它内联在这里、
                由 App 持有进度 state 时，每条进度事件都会重渲染整个 App（4000 多行、
                含全部页面），导出期间就是一次持续的全量 reconciliation —— 用户看到
                的"所有元素被推来推去"的抖动来源就是这个。 */}
            <div className="exp-sticky">
            <ExportProgressBar ref={exportProgressRef} api={api.export} busy={busy} />

            <div className="panel-head exp-head">
              {/* 主操作放在页头并让页头吸顶：导出按钮从此**始终可见**，而且
                  不会像底部悬浮条那样盖住内容。页头右侧依次是「范围状态 →
                  恢复默认 → 清空导出库 → 开始导出」，破坏性操作离主操作最远。 */}
              <div className="exp-head-state">
                <span className="exp-head-chip">
                  <FileType size={13} />
                  {FORMATS.find((f) => f.value === format)?.label}
                </span>
                <span className="exp-head-chip">
                  <FolderOpen size={13} />
                  {WRITE_LAYOUTS.find((l) => l.value === writeLayout)?.label}
                </span>
                <span className="exp-head-chip">
                  <Users size={13} />
                  {exportSelectionMode === 'all' ? '全部会话' : `已选 ${selectedExportSessionIds.size} 个`}
                </span>
              </div>
              <div className="panel-head-actions">
                <button
                  className="ghost-btn"
                  type="button"
                  disabled={busy}
                  onClick={() => resetExportDefaults()}
                  title="恢复默认导出设置（目录结构 A · TXT）"
                >
                  <RotateCcw size={13} />
                  恢复默认
                </button>
                <button
                  className="danger-btn"
                  type="button"
                  disabled={busy || !exportPath.trim()}
                  onClick={() => setClearOpen(true)}
                >
                  <Trash2 size={13} />
                  清空导出库
                </button>
                <button className="primary-btn" type="button" disabled={busy} onClick={() => void runExport()}>
                  <Download size={14} />
                  {busy
                    ? '导出中…'
                    : exportSelectionMode === 'all'
                      ? '开始导出'
                      : `导出已选（${selectedExportSessionIds.size}）`}
                </button>
              </div>
            </div>
            </div>

            {/* 两栏：左边是「怎么导 / 导哪些」这几步，右边是常驻的动作与状态。
                原来五段纵向堆叠，页面有三屏高，主按钮够不到；现在主按钮和进度
                都在吸顶块里，右栏留给高级选项与导出记录。 */}
            <div className="export-layout">
              <div className="export-main">
                {/* 1. 输出设置 */}
                <div className="exp-section">
                  <div className="exp-sec-head">
                    <span className="exp-num">1</span>
                    <FolderOpen size={14} />
                    输出设置
                  </div>
                  <div className="field">
                    <label htmlFor="exportPath">输出文件夹</label>
                    <div className="path-row">
                      <input
                        id="exportPath"
                        className="path-input"
                        value={exportPath}
                        placeholder="选择导出根目录…"
                        onChange={(e) => setExportPath(e.target.value)}
                        onBlur={() => {
                          if (exportPath.trim()) void persist({ exportPath: exportPath.trim() })
                        }}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' && exportPath.trim()) {
                            void persist({ exportPath: exportPath.trim() })
                            void refreshExportLog(exportPath.trim())
                          }
                        }}
                        spellCheck={false}
                      />
                      <button className="ghost-btn" type="button" onClick={() => void pickExportFolder()} disabled={busy}>
                        浏览
                      </button>
                    </div>
                  </div>
                  <div className="field" style={{ marginBottom: 0 }}>
                    <label>目录结构</label>
                    <div className="layout-row" role="radiogroup" aria-label="目录结构">
                      {WRITE_LAYOUTS.map((l) => (
                        <button
                          key={l.value}
                          type="button"
                          className="chip format-chip layout-chip"
                          data-active={writeLayout === l.value}
                          role="radio"
                          aria-checked={writeLayout === l.value}
                          onClick={() => {
                            setWriteLayout(l.value)
                            void saveExportOptions({ layout: l.value })
                          }}
                          disabled={busy}
                        >
                          <strong>
                            <span className="layout-badge">{l.value}</span>
                            {l.label}
                          </strong>
                          <code className="layout-tree">
                            {l.tree.map((line, i) => (
                              <span key={i}>{line}</span>
                            ))}
                          </code>
                          <span>{l.desc}</span>
                        </button>
                      ))}
                    </div>
                    <p className="hint" style={{ marginTop: 8 }}>
                      输出预览：
                      <code className="exp-path">
                        {exportPath.trim()
                          ? `${exportPath.trim()}\\${formatFolder}\\${writeLayout === 'B' ? 'texts\\' : writeLayout === 'C' ? '群聊_名称\\' : ''}`
                          : '未选择根目录'}
                      </code>
                      <span> · 命名：<code>群聊_名称</code> / <code>私聊_名称</code></span>
                    </p>
                  </div>
                </div>

                {/* 2. 导出格式 */}
                <div className="exp-section">
                  <div className="exp-sec-head">
                    <span className="exp-num">2</span>
                    <FileType size={14} />
                    导出格式
                  </div>
                  <div className="format-grid" role="radiogroup" aria-label="导出格式">
                    {FORMATS.map((f) => {
                      const FIcon = f.icon
                      return (
                        <button
                          key={f.value}
                          type="button"
                          className="chip format-chip"
                          data-active={format === f.value}
                          role="radio"
                          aria-checked={format === f.value}
                          onClick={() => {
                            setFormat(f.value)
                            void saveExportOptions({ format: f.value })
                          }}
                          disabled={busy}
                        >
                          <span className="fmt-head">
                            <FIcon size={14} strokeWidth={1.8} />
                            <strong>{f.label}</strong>
                          </span>
                          <span>{f.desc}</span>
                        </button>
                      )
                    })}
                  </div>
                </div>

                {/* 3. 内容 */}
                <div className="exp-section">
                  <div className="exp-sec-head">
                    <span className="exp-num">3</span>
                    <Paperclip size={14} />
                    内容（媒体与附件）
                  </div>
                  <div className="media-row">
                    {([
                      ['images', '图片'],
                      ['videos', '视频'],
                      ['voices', '语音'],
                      ['emojis', '表情包'],
                      ['files', '文件'],
                    ] as Array<[keyof typeof exportMedia, string]>).map(([key, label]) => (
                      <label key={key} className="media-check">
                        <input
                          type="checkbox"
                          checked={exportMedia[key] === true}
                          onChange={(e) => {
                            const next = { ...exportMedia, [key]: e.target.checked }
                            setExportMedia(next)
                            void saveExportOptions({ media: next })
                          }}
                          disabled={busy}
                        />
                        <span>导出{label}</span>
                      </label>
                    ))}
                    {(exportMedia.videos || exportMedia.files) && (
                      <label className="media-size">
                        <span>视频/文件最大体积</span>
                        <input
                          className="num-input"
                          type="number"
                          min={1}
                          max={4096}
                          value={exportMedia.maxFileSizeMb}
                          onChange={(e) => {
                            const v = Math.max(1, Math.min(4096, Number(e.target.value) || 1))
                            setExportMedia((prev) => ({ ...prev, maxFileSizeMb: v }))
                          }}
                          onBlur={() => void saveExportOptions({ media: exportMedia })}
                          disabled={busy}
                        />
                        <span>MB</span>
                      </label>
                    )}
                  </div>
                  {exportMedia.images && imageKeyRequired && (
                    <div className="media-row" style={{ marginTop: 8, alignItems: 'center' }}>
                      <button
                        type="button"
                        className="ghost-btn"
                        onClick={() => void extractImageKey()}
                        disabled={busy}
                      >
                        {imageKeysOk ? '重新获取图片密钥' : '获取图片密钥'}
                      </button>
                      <span className="hint" style={{ margin: 0 }}>
                        {imageKeyStatus || (imageKeysOk
                          ? '图片密钥已配置（按账号保存）'
                          : imageKeyHint)}
                      </span>
                    </div>
                  )}
                  <p className="hint" style={{ marginTop: 6 }}>
                    不勾选则仅导出文字消息（默认）。导出媒体时会同时导出对应文字消息。
                  </p>
                </div>

                {/* 4. 选择会话 —— 放在配置之后。
                    旧顺序是「235 行会话列表 → 四组配置 → 导出按钮」：列表先把全部
                    配置挤到折叠线以下，而主按钮在整段最底部。现在的顺序对应真实的
                    心智顺序：先决定怎么导 → 再决定导哪些 → 最后按下去。 */}
                <div className="exp-section">
                  <div className="exp-sec-head">
                    <span className="exp-num">4</span>
                    <Users size={14} />
                    选择会话
                  </div>
                  <ExportSessionPicker
                    sessions={filteredExportSessions}
                    totalSessions={exportSessions.length}
                    selectedIds={selectedExportSessionIds}
                    selectionMode={exportSelectionMode}
                    search={exportSessionSearch}
                    type={exportSessionType}
                    loading={exportSessionsLoading}
                    onSearchChange={setExportSessionSearch}
                    onTypeChange={setExportSessionType}
                    onSelectionModeChange={setExportSelectionMode}
                    onToggle={toggleExportSession}
                    onToggleVisible={toggleVisibleExportSessions}
                    onRefresh={() => void loadExportSessions()}
                    allVisibleSelected={allVisibleExportSessionsSelected}
                    disabled={busy}
                  />
                </div>
              </div>

              <aside className="export-side">
                {/* 进度已移到吸顶页头下方；右栏只留「高级选项 / 导出记录」。 */}
                {/* 5. 高级选项 */}
                <div className="exp-side-card">
                  <button
                    type="button"
                    className="exp-sec-head exp-collapse"
                    onClick={() => setShowAdvanced((v) => !v)}
                    aria-expanded={showAdvanced}
                  >
                    <SettingsIcon size={14} />
                    高级选项
                    <ChevronDown size={14} className={`exp-chevron${showAdvanced ? ' open' : ''}`} />
                  </button>
                  {showAdvanced && (
                    <div className="opt-panel">
                      <div className="opt-checks">
                        <label className="check-row opt">
                          <input
                            type="checkbox"
                            checked={exportAvatars}
                            onChange={(e) => {
                              setExportAvatars(e.target.checked)
                              void saveExportOptions({ avatars: e.target.checked })
                            }}
                            disabled={busy}
                          />
                          <span>包含联系人头像</span>
                        </label>
                        <label className="check-row opt">
                          <input
                            type="checkbox"
                            checked={exportVoiceAsText}
                            onChange={(e) => {
                              setExportVoiceAsText(e.target.checked)
                              void saveExportOptions({ voiceAsText: e.target.checked })
                            }}
                            disabled={busy}
                          />
                          <span>语音转文字（若已转换）</span>
                        </label>
                      </div>
                      <div className="opt-row">
                        <span className="opt-label">媒体路径</span>
                        <div className="seg" role="radiogroup" aria-label="媒体路径">
                          {PATH_STYLE_OPTIONS.map((o) => (
                            <button
                              key={o.value}
                              type="button"
                              data-active={exportPathStyle === o.value}
                              onClick={() => {
                                setExportPathStyle(o.value)
                                void saveExportOptions({ pathStyle: o.value })
                              }}
                              disabled={busy}
                            >
                              {o.label}
                            </button>
                          ))}
                        </div>
                      </div>
                      <div className="opt-row">
                        <span className="opt-label">同名文件</span>
                        <div className="seg" role="radiogroup" aria-label="同名文件">
                          {CONFLICT_OPTIONS.map((o) => (
                            <button
                              key={o.value}
                              type="button"
                              data-active={exportConflict === o.value}
                              onClick={() => {
                                setExportConflict(o.value)
                                void saveExportOptions({ conflict: o.value })
                              }}
                              disabled={busy}
                            >
                              {o.label}
                            </button>
                          ))}
                        </div>
                      </div>
                      <div className="opt-row">
                        <span className="opt-label">命名方式</span>
                        <div className="seg" role="radiogroup" aria-label="命名方式">
                          {NAME_PREF_OPTIONS.map((o) => (
                            <button
                              key={o.value}
                              type="button"
                              data-active={displayNamePref === o.value}
                              onClick={() => {
                                setDisplayNamePref(o.value)
                                void saveExportOptions({ namePref: o.value })
                              }}
                              disabled={busy}
                            >
                              {o.label}
                            </button>
                          ))}
                        </div>
                      </div>
                      <div className="opt-row">
                        <span className="opt-label">导出并发数</span>
                        <div className="seg" role="radiogroup" aria-label="导出并发数">
                          {CONCURRENCY_OPTIONS.map((c) => (
                            <button
                              key={c}
                              type="button"
                              data-active={exportConcurrency === c}
                              onClick={() => {
                                setExportConcurrency(c)
                                void saveExportOptions({ concurrency: c })
                              }}
                              disabled={busy}
                              title={c >= 10 ? '最快，易卡顿' : undefined}
                            >
                              {c}
                            </button>
                          ))}
                        </div>
                      </div>
                    </div>
                  )}
                </div>

                <div className="exp-side-card export-meta" aria-live="polite">
                  <div className="row">
                    <span>上次 TXT</span>
                    <strong className={exportLog?.txt ? undefined : 'muted'}>{exportLog?.txt || '尚未导出'}</strong>
                  </div>
                  <div className="row">
                    <span>上次 JSON</span>
                    <strong className={exportLog?.json ? undefined : 'muted'}>{exportLog?.json || '尚未导出'}</strong>
                  </div>
                  <div className="row">
                    <span>日志文件</span>
                    <span className="muted">export_log.txt</span>
                  </div>
                </div>
              </aside>
            </div>
          </section>
        )}

        {tab === 'ai' && (
          <Suspense fallback={<LazyFallback label="WeportAI" />}>
            <WeportAiPanel
              onOpenSettings={() => {
                setSettingsSection('ai')
                switchTab('settings')
              }}
            />
          </Suspense>
        )}
        {tab === 'weclone' && (
          <Suspense fallback={<LazyFallback label="WeClone" />}>
            <WeClonePage />
          </Suspense>
        )}
        {(tab === 'webot' || tab === 'webot-notes') && (
          <Suspense fallback={<LazyFallback label={tab === 'webot-notes' ? 'WeBot 笔记' : 'WeBot'} />}>
            <WeBotModule section={tab === 'webot-notes' ? 'notes' : 'tasks'} />
          </Suspense>
        )}
        {tab === 'sns' && (
          <Suspense fallback={<LazyFallback label="朋友圈" />}>
            <SnsPage />
          </Suspense>
        )}
        {tab === 'analytics' && (
          <Suspense fallback={<LazyFallback label="分析" />}>
            <AnalyticsModule section={analyticsSection} onSectionChange={setAnalyticsSection} />
          </Suspense>
        )}

        {tab === 'antirecall' && (
          /* 重排：原来第一屏是三行解释 + 一个复选框 + 三个按钮 + 一长条会话列表，
             用户在动手之前必须先读完一段说明，而且列表多起来没法找。现在说明
             折进 details，顶部只留「装了多少」和刷新，列表带搜索与筛选。 */
          <div className="page-stack">
            <div className="status-bar" data-live={installedCount > 0}>
              <ShieldPlus size={15} />
              <div className="status-bar-text">
                <strong>
                  {antiRevokeSessions.length === 0
                    ? '尚未读取会话'
                    : `已安装 ${installedCount} / ${antiRevokeSessions.length} 个会话`}
                </strong>
                <span className="hint">触发器装在微信侧，装好后不必保持 Weport 运行</span>
              </div>
              <p className="status-bar-note">
                对选中的会话安装防撤回触发器后，对方撤回的消息在微信本地仍会保留可见。
                安装 / 卸载针对具体会话，微信升级后一般无需重装。
              </p>
              <button className="secondary-btn" type="button" disabled={!allReady || antiRevokeBusy} onClick={() => void refreshAntiRevoke()}>
                <RefreshCw size={14} />
                {antiRevokeBusy ? '刷新中…' : '刷新状态'}
              </button>
            </div>

            {!allReady && (
              <div className="status-warn">
                完成「连接微信」页的数据目录 / 账号 / 密钥后即可使用。
              </div>
            )}

            <section className="panel">
              <div className="panel-head">
                <h2>
                  <ShieldCheck size={15} />
                  会话
                </h2>
                <div className="panel-head-actions">
                  <input
                    className="filter-input"
                    value={antiRevokeQuery}
                    disabled={!allReady}
                    placeholder="搜索会话…"
                    aria-label="搜索会话"
                    onChange={(e) => setAntiRevokeQuery(e.target.value)}
                  />
                  <div className="segmented" role="radiogroup" aria-label="会话筛选">
                    {(
                      [
                        { id: 'all', label: '全部' },
                        { id: 'installed', label: '已安装' },
                        { id: 'pending', label: '未安装' },
                      ] as const
                    ).map((option) => (
                      <button
                        key={option.id}
                        type="button"
                        role="radio"
                        aria-checked={antiRevokeFilter === option.id}
                        className="segmented-item"
                        data-active={antiRevokeFilter === option.id}
                        onClick={() => setAntiRevokeFilter(option.id)}
                      >
                        {option.label}
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              {antiRevokeActions()}

              {allReady && antiRevokeSessions.length === 0 && !antiRevokeBusy && (
                <div className="empty" style={{ marginTop: 12 }}>
                  未找到可安装防撤回的会话（联系人或群聊）。点击「刷新状态」重试。
                </div>
              )}

              {antiRevokeSessions.length > 0 && filteredAntiRevokeSessions.length === 0 && (
                <div className="empty" style={{ marginTop: 12 }}>
                  没有符合当前筛选的会话。
                </div>
              )}

              {filteredAntiRevokeSessions.length > 0 && (
                <div className="account-list anti-revoke-list" role="listbox" aria-label="防撤回会话">
                  {filteredAntiRevokeSessions.map((s) => {
                    const installed = antiRevokeInstalled[s.username] === true
                    return (
                      <div key={s.username} className="account-item static anti-revoke" data-active={installed}>
                        {/* 群/私聊一眼可分：列表里大多是群，混着几个联系人时
                            光看名字判断不出这是群还是个人。能拿到头像就显示头像
                            （形状本身也区分群/人），拿不到再退回类型图标。 */}
                        {s.avatarUrl ? (
                          <Avatar
                            src={s.avatarUrl}
                            name={s.displayName || s.username}
                            size={22}
                            shape={s.username.endsWith('@chatroom') ? 'rounded' : 'circle'}
                          />
                        ) : (
                          <span className="ar-kind" title={s.username.endsWith('@chatroom') ? '群聊' : '联系人'}>
                            {s.username.endsWith('@chatroom') ? <Users size={12} /> : <UserRound size={12} />}
                          </span>
                        )}
                        <span className="ar-name" title={s.username}>{s.displayName || s.username}</span>
                        <span className="ar-id" title={s.username}>{s.username}</span>
                        <button
                          className={installed ? 'ghost-btn' : 'secondary-btn'}
                          type="button"
                          disabled={antiRevokeBusy}
                          onClick={() => (installed ? void uninstallAntiRevoke([s.username]) : void installAntiRevoke([s.username]))}
                        >
                          {installed ? '还原' : '安装'}
                        </button>
                      </div>
                    )
                  })}
                </div>
              )}
            </section>

            <section className="panel">
              <div className="panel-head">
                <h2>
                  <Undo2 size={15} />
                  自动与批量
                </h2>
              </div>
              <div className="setting-row">
                <div className="setting-label">
                  <ShieldPlus size={14} />
                  <div>
                    <strong>新群聊自动安装</strong>
                    <span className="hint">只处理开启后首次观察到的群聊，会延迟排队，不影响消息通知</span>
                  </div>
                </div>
                <label className="switch">
                  <input
                    type="checkbox"
                    checked={antiRevokeNewGroupsEnabled}
                    disabled={!allReady || antiRevokeBusy}
                    onChange={(e) => void toggleAntiRevokeNewGroups(e.target.checked)}
                  />
                  <span className="track" />
                </label>
              </div>
            </section>
          </div>
        )}

        {tab === 'notifications' && (
          /* 重排：原来一张面板里塞了「开不开」「长什么样」「收谁的」「现在有没有在跑」，
             全部同权，于是每一行都要读一遍才知道自己在看什么。现在分成
             状态条（是否在跑 + 总开关）/ 弹窗外观 / 接收范围 三层。 */
          <div className="page-stack">
            <div className="status-bar" data-live={notificationsEnabled && allReady && notifyListening}>
              <span className={`status-dot${notificationsEnabled && allReady && notifyListening ? ' listening' : ''}`} />
              <div className="status-bar-text">
                <strong>
                  {!notificationsEnabled
                    ? '消息提醒已关闭'
                    : !allReady
                      ? '等待配置完成'
                      : notifyListening
                        ? '正在监听新消息与撤回事件'
                        : '已开启，连接数据库后开始监听'}
                </strong>
                <span className="hint">
                  {!allReady
                    ? `还需完成：${[
                        ['微信数据目录', dbReady],
                        ['微信账号', accountReady],
                        ['解密密钥', keyOk],
                      ].filter(([, ok]) => !ok).map(([label]) => label as string).join('、')}`
                    : api.process.platform === 'linux' && linuxNotificationMode === 'force-dbus'
                      ? '始终尝试由桌面通知服务显示（mako / dunst / swaync 等）'
                      : api.process.platform === 'linux' && linuxNotificationMode === 'auto'
                        ? '优先由桌面通知服务显示，检测不到时回退应用内弹窗'
                        : '弹窗出现在屏幕一角，右键卡片可立即关闭'}
                </span>
              </div>
              <button className="ghost-btn" type="button" onClick={() => void api.notification.showTest()}>
                <BellRing size={13} />
                {api.process.platform === 'linux' && linuxNotificationMode !== 'off' ? '测试通知' : '测试弹窗'}
              </button>
              <label className="switch" title="启用消息提醒">
                <input
                  type="checkbox"
                  checked={notificationsEnabled}
                  onChange={(e) => void toggleNotifications(e.target.checked)}
                />
                <span className="track" />
              </label>
            </div>

            {/* Linux 通知方式：应用内弹窗在 Wayland 下抓桌面做实时玻璃会
                触发 xdg-desktop-portal 的「共享屏幕」授权框，而且位置/超时无法复用
                通知守护进程的配置。默认把通知交给系统通知服务，检测不到再回退弹窗。 */}
            {api.process.platform === 'linux' && (
              <section className="panel">
                <div className="panel-head">
                  <h2>
                    <Bell size={15} />
                    系统通知
                  </h2>
                  <span>由 mako / dunst / swaync 等通知服务显示</span>
                </div>

                <div className="setting-row">
                  <div className="setting-label">
                    <Bell size={14} />
                    <div>
                      <strong>通知方式</strong>
                      <span className="hint">
                        自动：有通知服务时用系统通知，检测不到回退应用内弹窗（回退不抓桌面）
                      </span>
                    </div>
                  </div>
                  <select
                    className="notification-select"
                    value={linuxNotificationMode}
                    onChange={(e) => void updateLinuxNotificationMode(e.target.value as 'auto' | 'force-dbus' | 'off')}
                    aria-label="Linux 通知方式"
                  >
                    <option value="auto">自动（推荐）</option>
                    <option value="force-dbus">强制系统通知</option>
                    <option value="off">应用内弹窗</option>
                  </select>
                </div>
              </section>
            )}

            <section className="panel">
              <div className="panel-head">
                <h2>
                  <Sparkles size={15} />
                  弹窗外观
                </h2>
              </div>

              <div className="setting-row">
                <div className="setting-label">
                  <MapPin size={14} />
                  <div>
                    <strong>弹窗位置</strong>
                    <span className="hint">通知卡片出现在屏幕的哪个角</span>
                  </div>
                </div>
                <select
                  className="notification-select"
                  value={notificationPosition}
                  onChange={(e) => void updateNotificationPosition(e.target.value as NotificationPosition)}
                  aria-label="弹窗位置"
                >
                  {NOTIFICATION_POSITION_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>{option.label}</option>
                  ))}
                </select>
              </div>

              <div className="setting-row">
                <div className="setting-label">
                  <Timer size={14} />
                  <div>
                    <strong>显示时长</strong>
                    <span className="hint">到点自动淡出，右键卡片可立即关闭</span>
                  </div>
                </div>
                <div className="notification-duration-control">
                  <input
                    type="number"
                    className="notification-select notification-duration-input"
                    min={1}
                    max={60}
                    step={1}
                    value={durationInput}
                    onChange={(e) => {
                      const text = e.target.value
                      setDurationInput(text)
                      const seconds = Number(text)
                      if (text === '' || !Number.isFinite(seconds) || seconds < 1) return
                      const durationMs = Math.min(60_000, Math.max(1000, Math.round(seconds * 1000)))
                      if (durationMs !== notificationDuration) void updateNotificationDuration(durationMs)
                    }}
                    onBlur={() => setDurationInput(String(Math.round(notificationDuration / 1000)))}
                    aria-label="弹窗显示时长（秒）"
                  />
                  <span className="hint">秒</span>
                </div>
              </div>

              <div className="setting-row">
                <div className="setting-label">
                  <Sparkles size={14} />
                  <div>
                    <strong>弹窗动效</strong>
                    <span className="hint">关闭后直接显示和隐藏，减少干扰</span>
                  </div>
                </div>
                <label className="switch">
                  <input
                    type="checkbox"
                    checked={notificationAnimationEnabled}
                    onChange={(e) => void toggleNotificationAnimation(e.target.checked)}
                  />
                  <span className="track" />
                </label>
              </div>
            </section>

            {/* 通知玻璃（v1.0.1 重做）：填充、渐变、文字色、描边、圆角、折射、模糊、
                投影、卡片宽度与正文行数全部可调，预览用的是真弹窗组件，
                见 NotificationGlassPanel 顶部说明。 */}
            <section className="panel">
              <div className="panel-head">
                <h2>
                  <Sparkles size={15} />
                  通知玻璃
                </h2>
                <span>整张卡片的填充、文字、形状、材质与尺寸，改一下预览立刻变</span>
              </div>
              <Suspense fallback={<div className="wp-loading">正在加载玻璃设置…</div>}>
                <NotificationGlassPanel />
              </Suspense>
            </section>

            <section className="panel">
              <div className="panel-head">
                <h2>
                  <Filter size={15} />
                  接收范围
                </h2>
                <span className="notify-scope">
                  <span className="notify-scope-primary" data-loading={mutedSessionsLoading || undefined}>
                    {notifyScope.primary}
                  </span>
                  {notifyScope.detail ? <em className="notify-scope-detail">{notifyScope.detail}</em> : null}
                </span>
              </div>

              <div className="setting-row">
                <div className="setting-label">
                  <BellOff size={14} />
                  <div>
                    <strong>跟随微信消息免打扰</strong>
                    <span className="hint">微信里标了「消息免打扰」的会话不发弹窗（默认开启）</span>
                  </div>
                </div>
                <div className="setting-inline">
                  <button className="secondary-btn" type="button" onClick={() => void openMuteReport()}>
                    {muteReportBusy ? <Loader2 size={13} className="spin" /> : <Search size={13} />}
                    检测结果…
                  </button>
                  <label className="switch">
                    <input
                      type="checkbox"
                      checked={respectWechatMute}
                      onChange={(e) => void toggleRespectWechatMute(e.target.checked)}
                    />
                    <span className="track" />
                  </label>
                </div>
              </div>

              <div className="setting-row">
                <div className="setting-label">
                  <Filter size={14} />
                  <div>
                    <strong>会话过滤</strong>
                    <span className="hint">按会话白名单 / 黑名单，或只提醒 @你 的消息</span>
                  </div>
                </div>
                {!allReady ? (
                  <span className="tab-tip" title={FEATURE_LOCK_TIP} aria-disabled="true">
                    <button className="secondary-btn" type="button" disabled>
                      配置…
                    </button>
                  </span>
                ) : (
                  <button className="secondary-btn" type="button" onClick={() => void openNotifyFilter()}>
                    <Filter size={14} />
                    配置…
                  </button>
                )}
              </div>
            </section>
          </div>
        )}

        {tab === 'settings' && (
          /* v1.0 重排：六块等权重的面板竖着排成一条长滚动，找一项要滚过另外五项。
             改成「左侧分类 + 右侧内容」，五个分类一次点击直达，右侧每页只放
             一个主题的内容。 */
          <div className="settings-page">
            <nav className="settings-nav" aria-label="设置分类">
              {(
                [
                  { id: 'general', label: '常规', hint: '启动与后台', icon: Rocket },
                  { id: 'appearance', label: '外观', hint: '背景 · 强调色 · 主题', icon: Images },
                  { id: 'ai', label: 'AI 服务', hint: '提供商 · 模型 · 密钥', icon: Sparkles },
                  { id: 'assign', label: '服务分配', hint: '功能面用哪个服务', icon: PlugZap },
                  { id: 'connectors', label: '连接器', hint: 'Todoist 等第三方工具', icon: Plug },
                  { id: 'data', label: '数据', hint: '备份与恢复', icon: Archive },
                  { id: 'connect', label: '接口', hint: 'HTTP API · MCP', icon: Server },
                  { id: 'about', label: '关于', hint: '版本与更新', icon: Info },
                ] as const
              ).map((item) => {
                const Icon = item.icon
                return (
                  <button
                    key={item.id}
                    type="button"
                    className="settings-nav-item"
                    data-active={settingsSection === item.id}
                    aria-current={settingsSection === item.id ? 'page' : undefined}
                    onClick={() => setSettingsSection(item.id)}
                  >
                    <Icon size={15} />
                    <span>
                      <strong>{item.label}</strong>
                      <em>{item.hint}</em>
                    </span>
                  </button>
                )
              })}
            </nav>

            <div className="settings-pane">
              {settingsSection === 'general' && (
                <section className="panel">
                  <div className="panel-head">
                    <h2>
                      <SettingsIcon size={15} />
                      启动与后台行为
                    </h2>
                  </div>

              <div className="setting-row">
                <div className="setting-label">
                  <Rocket size={14} />
                  <div>
                    <strong>开机自启</strong>
                    <span className="hint">
                      {startupSupported ? '登录系统后自动启动 Weport' : startupReason || '当前环境不支持'}
                    </span>
                  </div>
                </div>
                <label className="switch">
                  <input
                    type="checkbox"
                    checked={launchAtStartup}
                    disabled={!startupSupported}
                    onChange={(e) => void toggleLaunchAtStartup(e.target.checked)}
                  />
                  <span className="track" />
                </label>
              </div>
              <div className="setting-row">
                <div className="setting-label">
                  <EyeOff size={14} />
                  <div>
                    <strong>启动时隐藏到托盘</strong>
                    <span className="hint">开机自启时以托盘模式启动，不显示主窗口</span>
                  </div>
                </div>
                <label className="switch">
                  <input
                    type="checkbox"
                    checked={silentStartup}
                    disabled={!startupSupported}
                    onChange={(e) => void toggleSilentStartup(e.target.checked)}
                  />
                  <span className="track" />
                </label>
              </div>
              <div className="setting-row">
                <div className="setting-label">
                  <Minimize2 size={14} />
                  <div>
                    <strong>关闭窗口时最小化到托盘而不是退出</strong>
                    <span className="hint">关闭后从系统托盘恢复（托盘菜单「退出」才会完全退出）</span>
                  </div>
                </div>
                <label className="switch">
                  <input type="checkbox" checked={closeToTray} onChange={(e) => void toggleCloseToTray(e.target.checked)} />
                  <span className="track" />
                </label>
              </div>
                </section>
              )}

              {settingsSection === 'appearance' && (
                <section className="panel">
                  <div className="panel-head">
                    <h2>
                      <Images size={15} />
                      外观
                    </h2>
                    <span>明暗 · 强调色 · 背景 · 密度</span>
                  </div>

              {/* 主题 = 明暗 × 强调色，但**两个轴分别可选**。
                  
                  原来是 12 张"深色·冷蓝 / 浅色·冷蓝 …"的组合卡片，点哪张就把
                  明暗和颜色一起改掉 —— 于是"我只想换个颜色"会顺手把深浅翻过去，
                  「自定义」那张的标题还跟着当前明暗变（"深色·自定义"↔"浅色·自定义"），
                  看起来像另一套独立设置。用户指出的正是这个：深浅不该由选色决定。

                  现在：先选深浅（两个分段按钮），再选强调色（7 个色块）。两轴互不
                  干扰，"自定义"只是第 7 个色块，选中后才展开调色面板。 */}
              <div className="setting-block">
                <div className="setting-label">
                  <Palette size={14} />
                  <div>
                    <strong>主题</strong>
                    <span className="hint">
                      {appearance.modeAuto && appearance.backgroundPath
                        ? `明暗跟随背景：${MODE_OPTIONS.find((m) => m.id === appearance.mode)?.label} · `
                        : ''}
                      强调色：
                      {appearance.accent === 'custom' ? '自定义' : ACCENT_OPTIONS.find((a) => a.id === appearance.accent)?.label}
                    </span>
                  </div>
                </div>

                {/* 轴一：深浅 */}
                <div className="opt-row theme-axis">
                  <span className="opt-label">深浅</span>
                  <div className="seg" role="radiogroup" aria-label="深浅">
                    {MODE_OPTIONS.map((mode) => (
                      <button
                        key={mode.id}
                        type="button"
                        data-active={appearance.mode === mode.id}
                        title={mode.hint}
                        onClick={() => setMode(mode.id)}
                      >
                        {mode.label}
                      </button>
                    ))}
                  </div>
                  {appearance.backgroundPath ? (
                    <label className="mode-auto-toggle inline">
                      <input
                        type="checkbox"
                        checked={appearance.modeAuto}
                        onChange={(e) => {
                          setModeAuto(e.target.checked)
                          // 重新打开时立刻按当前背景重判一次，不用等重启
                          if (e.target.checked) void adoptModeFromBackground()
                        }}
                      />
                      <span>跟随背景</span>
                    </label>
                  ) : null}
                </div>

                {/* 轴二：强调色（含自定义）。只改颜色，不动深浅。 */}
                <div className="theme-picker">
                  {PRESET_ACCENTS.map((accent) => {
                    const active = appearance.accent === accent.id
                    const dark = appearance.mode === 'dark'
                    const surface = dark ? '#17171d' : '#ffffff'
                    const ink = dark ? '#f2f2f5' : '#16171d'
                    return (
                      <button
                        key={accent.id}
                        type="button"
                        className={`theme-card ${active ? 'theme-card-active' : ''}`}
                        title={accent.label}
                        onClick={() => setAccent(accent.id)}
                      >
                        <div className="theme-card-head">
                          <span
                            className="theme-card-preview"
                            style={{ background: surface, color: ink, borderColor: accent.swatch }}
                          >
                            <i style={{ background: accent.swatch }} />
                            <i style={{ background: ink, opacity: 0.35 }} />
                          </span>
                          <strong>{accent.label}</strong>
                          {active && <span className="theme-card-check">当前</span>}
                        </div>
                        <div className="theme-swatches">
                          {[0.95, 0.8, 0.65, 0.5, 0.35, 0.2].map((t) => (
                            <span key={t} style={{ background: accent.swatch, opacity: t }} />
                          ))}
                          <span style={{ background: surface, border: `1px solid ${ink}22` }} />
                        </div>
                      </button>
                    )
                  })}
                  {/* 「自定义」是强调色的**第 7 个色块**：标题不带深浅（那由上面的
                      「深浅」分段决定），选中后才展开调色面板。 */}
                  {(() => {
                    const dark = appearance.mode === 'dark'
                    const surface = dark ? '#17171d' : '#ffffff'
                    const ink = dark ? '#f2f2f5' : '#16171d'
                    const swatch = normalizeHexColor(appearance.customAccent) || '#5b8eff'
                    const active = appearance.accent === 'custom'
                    return (
                      <button
                        type="button"
                        className={`theme-card theme-card-custom ${active ? 'theme-card-active' : ''}`}
                        title="自定义强调色"
                        onClick={() => setAccent('custom')}
                      >
                        <div className="theme-card-head">
                          <span
                            className="theme-card-preview theme-card-preview-custom"
                            style={{ background: surface, color: ink, borderColor: swatch }}
                          >
                            <i style={{ background: swatch }} />
                            <i style={{ background: ink, opacity: 0.35 }} />
                          </span>
                          <strong>自定义</strong>
                          {active && <span className="theme-card-check">当前</span>}
                        </div>
                        <div className="theme-swatches">
                          {[0.95, 0.8, 0.65, 0.5, 0.35, 0.2].map((t) => (
                            <span key={t} style={{ background: swatch, opacity: t }} />
                          ))}
                          <span style={{ background: surface, border: `1px solid ${ink}22` }} />
                        </div>
                      </button>
                    )
                  })()}
                </div>
                {/* 调色面板只在「自定义」被选中时出现 —— 它是这个主题选项的详情，
                    不是全局常驻设置。含明/暗两个无彩色近路：很多用户想要的只是
                    "黑白主题"而不想自己去挑十六进制。 */}
                {appearance.accent === 'custom' && (() => {
                  // 无彩色色板按明暗分成**方向相反**的两套，见下面注释
                  const dark = appearance.mode === 'dark'
                  return (
                  <div className="accent-custom">
                    <span className="accent-custom-label">
                      <Palette size={13} /> 自定义强调色
                    </span>
                    <input
                      type="color"
                      className="accent-color-input"
                      value={normalizeHexColor(appearance.customAccent) || '#5b8eff'}
                      aria-label="自定义强调色"
                      onChange={(e) => setCustomAccent(e.target.value)}
                    />
                    <input
                      className="accent-hex-input"
                      value={customAccentDraft || appearance.customAccent}
                      maxLength={7}
                      spellCheck={false}
                      aria-label="自定义强调色十六进制值"
                      onChange={(e) => {
                        // 边打字边校验：合法的十六进制立刻生效，半成品（#5b8e）留在
                        // 输入框里不提交，否则用户打一半就被强制纠正，光标乱跳。
                        setCustomAccentDraft(e.target.value)
                        if (normalizeHexColor(e.target.value)) setCustomAccent(e.target.value)
                      }}
                      onBlur={() => setCustomAccentDraft('')}
                    />
                    {/* 无彩色近路：按当前明暗给出**方向相反**的两套无彩色，而不是
                        一套通用的"黑到白"。深色背景下白与浅灰是真的能用（提亮、描边、
                        数值），近黑等于什么都看不见；浅色背景恰恰相反。
                        之前两档共用同一组色块，深色模式下前三个色块点下去界面上没有
                        任何变化，看起来像"点了没反应" —— 那不是 bug 而是色块选错了对象。 */}
                    <div className="accent-swatches" role="group" aria-label={dark ? '无彩色（深色主题）' : '无彩色（浅色主题）'}>
                      {(dark
                        ? [
                            { hex: '#ffffff', label: '纯白' },
                            { hex: '#f2f2f5', label: '亮白' },
                            { hex: '#9a9aa4', label: '中性灰' },
                            { hex: '#5a5a63', label: '深灰' },
                            { hex: '#17171d', label: '近黑' },
                          ]
                        : [
                            { hex: '#000000', label: '纯黑' },
                            { hex: '#16171d', label: '近黑' },
                            { hex: '#4b5563', label: '深灰' },
                            { hex: '#9ca3af', label: '中性灰' },
                            { hex: '#ffffff', label: '纯白（仅描边）' },
                          ]
                      ).map(({ hex, label }) => (
                        <button
                          key={hex}
                          type="button"
                          className="accent-swatch-mini"
                          title={`${label} ${hex}`}
                          aria-label={`${label} ${hex}`}
                          data-active={appearance.accent === 'custom' && appearance.customAccent === hex}
                          data-mono="true"
                          style={{ background: hex }}
                          onClick={() => setCustomAccent(hex)}
                        />
                      ))}
                    </div>
                    <div className="accent-swatches" role="group" aria-label={dark ? '常用颜色（深色主题）' : '常用颜色（浅色主题）'}>
                      {(dark
                        // 深色主题：取色板里偏亮的一档，落在深底上才有分量
                        ? [
                            '#5b8eff', '#3b82f6', '#818cf8', '#a78bfa', '#c084fc', '#e879f9',
                            '#f472b6', '#fb7185', '#f87171', '#fb923c', '#fbbf24', '#facc15',
                            '#a3e635', '#4ade80', '#34d399', '#2dd4bf', '#22d3ee', '#38bdf8',
                          ]
                        // 浅色主题：同一批色相压深一档 —— 亮色当文字放在白面板上会看不清
                        : [
                            '#4166b8', '#2f6fd0', '#4f46e5', '#7c3aed', '#9333ea', '#c026d3',
                            '#db2777', '#e11d48', '#dc2626', '#ea580c', '#d97706', '#ca8a04',
                            '#65a30d', '#16a34a', '#059669', '#0d9488', '#0891b2', '#0284c7',
                          ]
                      ).map((hex) => (
                        <button
                          key={hex}
                          type="button"
                          className="accent-swatch-mini"
                          title={hex}
                          aria-label={hex}
                          data-active={appearance.accent === 'custom' && appearance.customAccent === hex}
                          style={{ background: hex }}
                          onClick={() => setCustomAccent(hex)}
                        />
                      ))}
                    </div>
                  </div>
                  )
                })()}
              </div>

              <div className="setting-row">
                <div className="setting-label">
                  <Images size={14} />
                  <div>
                    <strong>背景</strong>
                    <span className="hint">
                      {appearance.backgroundRejected === 'too-large'
                        ? '这个视频超过 50MB，已停用：背景每一帧都要解码，几百 MB 的片子会让界面变卡。请换一个 ≤50MB 的循环片段。'
                        : appearance.backgroundPath
                          ? backgroundKindOf(appearance.backgroundPath) === 'video'
                            ? '视频背景：窗口在前台时循环播放，切到后台自动暂停省电'
                            : '图片背景：面板自动转为半透明以保证文字可读'
                          : '支持图片与视频（mp4 / webm，≤50MB）；默认纯色'}
                    </span>
                  </div>
                </div>
                <div className="appearance-actions">
                  <button className="secondary-btn" type="button" onClick={() => void pickBackgroundImage()}>
                    {appearance.backgroundPath ? '更换…' : '选择文件…'}
                  </button>
                  {appearance.backgroundPath ? (
                    <button className="secondary-btn" type="button" onClick={() => setBackgroundPath('')}>
                      移除
                    </button>
                  ) : null}
                </div>
              </div>

              {appearance.backgroundPath ? (
                <>
                  <div className="setting-row">
                    <div className="setting-label">
                      <div>
                        <strong>背景遮罩</strong>
                        <span className="hint">数值越高文字越清晰、背景越淡（推荐 60-80）</span>
                      </div>
                    </div>
                    <div className="appearance-slider">
                      <input
                        type="range"
                        min={0}
                        max={95}
                        value={appearance.backgroundDim}
                        onChange={(e) => setBackgroundDim(Number(e.target.value))}
                        aria-label="背景遮罩强度"
                      />
                      <span className="appearance-slider-value">{appearance.backgroundDim}%</span>
                    </div>
                  </div>
                  <div className="setting-row">
                    <div className="setting-label">
                      <div>
                        <strong>背景模糊</strong>
                        <span className="hint">让背景退到后景，界面文字更干净（0 为不模糊）</span>
                      </div>
                    </div>
                    <div className="appearance-slider">
                      <input
                        type="range"
                        min={0}
                        max={40}
                        value={appearance.backgroundBlur}
                        onChange={(e) => {
                          setBackgroundBlur(Number(e.target.value))
                          // 模糊跨过 4px 阈值会改变实际生效的画质档位，
                          // 提示文案必须跟着变（主进程算，别在本地猜）。
                          void refreshVideoQualityInfo()
                        }}
                        aria-label="背景模糊半径"
                      />
                      <span className="appearance-slider-value">{appearance.backgroundBlur}px</span>
                    </div>
                  </div>
                </>
              ) : null}

              {backgroundKindOf(appearance.backgroundPath) === 'video' ? (
                <div className="setting-row">
                  <div className="setting-label">
                    <div>
                      <strong>背景视频画质</strong>
                      <span className="hint">
                        背景每一帧都要解码，档位越高越清晰也越费资源。
                        {appearance.videoQualityDemoted ? (
                          <>
                            {' '}
                            <strong>
                              当前已自动降到「
                              {VIDEO_QUALITY_OPTIONS.find((o) => o.id === appearance.videoQualityEffective)?.label}
                              」
                            </strong>
                            ：背景模糊 ≥{BLUR_FORCES_BALANCED_PX}px 时更高分辨率看不出差别，纯属浪费
                            {appearance.videoDecodeEdge
                              ? `（实际解码长边约 ${appearance.videoDecodeEdge}px）`
                              : ''}
                            。把模糊调低即可恢复。
                          </>
                        ) : appearance.videoDecodeEdge ? (
                          ` 当前解码长边约 ${appearance.videoDecodeEdge}px。`
                        ) : (
                          ''
                        )}
                      </span>
                    </div>
                  </div>
                  <div className="segmented" role="radiogroup" aria-label="背景视频画质">
                    {VIDEO_QUALITY_OPTIONS.map((option) => (
                      <button
                        key={option.id}
                        type="button"
                        role="radio"
                        aria-checked={appearance.videoQuality === option.id}
                        className="segmented-item"
                        data-active={appearance.videoQuality === option.id}
                        title={option.hint}
                        onClick={() => {
                          setVideoQuality(option.id)
                          // 主进程才知道真实的长边与是否降级：提交后把权威值取回来。
                          void refreshVideoQualityInfo()
                        }}
                      >
                        {option.label}
                      </button>
                    ))}
                  </div>
                </div>
              ) : null}

              <div className="setting-row">
                <div className="setting-label">
                  <Palette size={14} />
                  <div>
                    <strong>用色浓度</strong>
                    <span className="hint">控制强调色铺开多少：从只标选中项，到面板也带色底</span>
                  </div>
                </div>
                <div className="segmented" role="radiogroup" aria-label="用色浓度">
                  {ACCENT_STRENGTH_OPTIONS.map((option) => (
                    <button
                      key={option.id}
                      type="button"
                      role="radio"
                      aria-checked={appearance.accentStrength === option.id}
                      className="segmented-item"
                      data-active={appearance.accentStrength === option.id}
                      title={option.hint}
                      onClick={() => setAccentStrength(option.id)}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
              </div>

              <div className="setting-row">
                <div className="setting-label">
                  <div>
                    <strong>界面密度</strong>
                    <span className="hint">紧凑模式收紧间距，字号保持不变</span>
                  </div>
                </div>
                <div className="segmented" role="radiogroup" aria-label="界面密度">
                  {DENSITY_OPTIONS.map((option) => (
                    <button
                      key={option.id}
                      type="button"
                      role="radio"
                      aria-checked={appearance.density === option.id}
                      className="segmented-item"
                      data-active={appearance.density === option.id}
                      onClick={() => setDensity(option.id)}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
              </div>
                </section>
              )}

              {settingsSection === 'ai' && (
                <section className="panel">
                  <div className="panel-head">
                    <h2>
                      <Sparkles size={15} />
                      AI 服务
                    </h2>
                    <span>提供商与密钥只在这里配置，WeportAI · WeBot · WeClone 共用</span>
                  </div>

                  {aiSetup ? (
                    <Suspense fallback={<div className="wp-loading">正在加载 AI 服务面板…</div>}>
                      <AiSettingsModal
                        inline
                        setup={aiSetup}
                        onSaved={(next) => {
                          setAiSetup(next)
                          void refreshAiAssignments()
                        }}
                      />
                    </Suspense>
                  ) : (
                    <div className="wp-loading">正在读取 AI 服务配置…</div>
                  )}
                </section>
              )}

              {settingsSection === 'assign' && aiAssignments !== null && (
                <section className="panel">
                  <div className="panel-head">
                    <h2>
                      <Sparkles size={15} />
                      服务分配
                    </h2>
                    <span>哪个功能面用哪个服务（默认都跟随默认服务）</span>
                  </div>
                  {aiAssignments.profiles.length === 0 ? (
                    <div className="empty">还没有配置任何 AI 服务。到「AI 服务」添加一个提供商与模型，这里就会出现。</div>
                  ) : (
                    <>
                      {/* 三个功能面各一行。它们默认都跟随「默认服务」，所以绝大多数
                          用户只需要配一次；想给定时任务单独用一个便宜模型时才分开设。 */}
                      {(
                        [
                          { id: 'chat', label: 'WeportAI', hint: '手动对话与工具调用' },
                          { id: 'webot', label: 'WeBot', hint: '定时任务的后台执行' },
                          { id: 'weclone', label: 'WeClone', hint: '生成人格档案' },
                        ] as const
                      ).map((row) => {
                        const current = aiAssignments.consumers.find((item) => item.consumer === row.id)
                        return (
                          <div className="setting-row" key={row.id}>
                            <div className="setting-label">
                              <div>
                                <strong>{row.label}</strong>
                                <span className="hint">
                                  {current?.followsDefault
                                    ? `跟随默认服务 · ${current?.model || '未配置'}`
                                    : `${row.hint} · ${current?.model || '未配置'}`}
                                </span>
                              </div>
                            </div>
                            <select
                              className="notification-select"
                              value={current?.followsDefault ? '' : current?.profileId || ''}
                              aria-label={`${row.label} 使用的 AI 服务`}
                              onChange={(e) => void assignAiConsumer(row.id, e.target.value)}
                            >
                              <option value="">跟随默认服务</option>
                              {aiAssignments.profiles.map((profile) => (
                                <option key={profile.id} value={profile.id}>
                                  {profile.name} · {profile.model}
                                </option>
                              ))}
                            </select>
                          </div>
                        )
                      })}

                      <div className="setting-row">
                        <div className="setting-label">
                          <div>
                            <strong>默认服务</strong>
                            <span className="hint">未单独指定时，三个功能面都用它</span>
                          </div>
                        </div>
                        <select
                          className="notification-select"
                          value={aiAssignments.activeProfileId}
                          aria-label="默认 AI 服务"
                          onChange={(e) => void activateAiProfile(e.target.value)}
                        >
                          {aiAssignments.profiles.map((profile) => (
                            <option key={profile.id} value={profile.id}>
                              {profile.name} · {profile.model}
                            </option>
                          ))}
                        </select>
                      </div>

                      <div className="setting-block">
                        <div className="setting-label">
                          <div>
                            <strong>已配置的服务</strong>
                            <span className="hint">增删改都在「AI 服务」页；这里只做分配</span>
                          </div>
                        </div>
                        <div className="ai-profile-list">
                          {aiAssignments.profiles.map((profile) => (
                            <div className="ai-profile-row" key={profile.id} data-active={profile.id === aiAssignments.activeProfileId}>
                              <strong>{profile.name}</strong>
                              <span className="ai-profile-model">{profile.providerId} · {profile.model}</span>
                              {profile.hasApiKey ? (
                                <span className="badge ok">{profile.apiKeyHint || '已配置密钥'}</span>
                              ) : (
                                <span className="badge">未配置密钥</span>
                              )}
                              {profile.id === aiAssignments.activeProfileId && <span className="badge ok">默认</span>}
                            </div>
                          ))}
                        </div>
                      </div>
                    </>
                  )}
                </section>
              )}

              {settingsSection === 'connectors' && (
                <Suspense fallback={<div className="wp-loading">正在加载连接器…</div>}>
                  <ConnectorsPanel />
                </Suspense>
              )}

              {settingsSection === 'data' && (
                <section className="panel">
                  <div className="panel-head">
                    <h2>
                      <Archive size={15} />
                      数据备份
                    </h2>
                  </div>
              <div className="setting-row backup-row">
                <div className="setting-label">
                  <HardDrive size={14} />
                  <div>
                    <strong>创建备份</strong>
                    <span className="hint">把消息/联系人/朋友圈等数据库表快照打包为压缩存档（可选包含图片视频文件）</span>
                  </div>
                </div>
                <div className="backup-actions">
                  <label className="ghost-btn backup-media-toggle" title="同时备份图片/视频/文件附件（体积可能很大）">
                    <input
                      type="checkbox"
                      checked={backupIncludeMedia}
                      onChange={(e) => setBackupIncludeMedia(e.target.checked)}
                    />
                    含附件
                  </label>
                  <button
                    className="primary-btn"
                    type="button"
                    disabled={backupBusy || !allReady}
                    onClick={() => void createBackup()}
                  >
                    {backupBusy ? '备份中…' : '开始备份'}
                  </button>
                </div>
              </div>
              <div className="setting-row">
                <div className="setting-label">
                  <RotateCcw size={14} />
                  <div>
                    <strong>恢复备份</strong>
                    <span className="hint">从备份存档恢复数据库表（会覆盖当前数据，请先确认）</span>
                  </div>
                </div>
                <div className="backup-actions">
                  <button
                    className="secondary-btn"
                    type="button"
                    disabled={backupBusy || !allReady}
                    onClick={() => void restoreBackup()}
                  >
                    恢复…
                  </button>
                </div>
              </div>
                </section>
              )}

              {settingsSection === 'connect' && (
                <>
                <section className="panel">
                  <div className="panel-head">
                    <h2>
                      <Database size={15} />
                      本地 HTTP API
                    </h2>
                    <span>只读接口，供脚本与本地工具使用</span>
                  </div>
                  <div className="setting-row">
                    <div className="setting-label">
                      <Code2 size={14} />
                      <div>
                        <strong>启用本地 HTTP API</strong>
                        <span className="hint">
                          提供 /api/sessions、/api/messages、/api/sns/timeline 等只读接口
                          {httpApiRunning ? ` · 运行中 http://127.0.0.1:${httpApiPort}` : ' · 默认端口 5031'}
                        </span>
                      </div>
                    </div>
                    <label className="switch">
                      <input
                        type="checkbox"
                        checked={httpApiEnabled}
                        onChange={(e) => void toggleHttpApi(e.target.checked)}
                      />
                      <span className="track" />
                    </label>
                  </div>
                </section>

                {/* MCP 服务在 v0.9.5 就做完了，但一直没有界面：用户看不到它在不在跑，
                    也拿不到那份客户端配置，只能照着文档手抄 bridge 路径和 token。 */}
                <section className="panel mcp-panel">
                  <div className="panel-head">
                    <h2>
                      <Server size={15} />
                      MCP 服务
                    </h2>
                    <span>给 Claude Desktop 等支持 MCP 的宿主调用同一批只读接口</span>
                  </div>
                  <div className="setting-row">
                    <div className="setting-label">
                      <Server size={14} />
                      <div>
                        <strong>{mcpStatus?.running ? '运行中' : '未运行'}</strong>
                        <span className="hint">
                          {mcpStatus
                            ? `http://${mcpStatus.host}:${mcpStatus.port} · ${mcpStatus.tokenConfigured ? '已配置访问令牌' : '未配置访问令牌'}`
                            : '正在读取服务状态…'}
                        </span>
                      </div>
                    </div>
                    <button
                      className="secondary-btn"
                      type="button"
                      onClick={() => void copyMcpClientConfig()}
                    >
                      <Copy size={13} />
                      {mcpCopied ? '已复制' : '复制客户端配置'}
                    </button>
                  </div>
                  <p className="setting-note">
                    复制得到的是 Claude Desktop 的 <code>mcpServers</code> 片段，粘进
                    <code>claude_desktop_config.json</code> 后重启宿主即可。
                  </p>
                </section>
                </>
              )}

              {settingsSection === 'about' && (
                <section className="panel">
                  <div className="panel-head">
                    <h2>
                      <Info size={15} />
                      关于
                    </h2>
                  </div>
                  <div className="setting-row">
                    <div className="setting-label">
                      <Info size={14} />
                      <div>
                        <strong>Weport v{version}</strong>
                        {/* 更新源不只是一句说明 —— 直接给可点的链接。原来这里只是
                            一行纯文本 "(Panther114/Weport)"，用户想去看仓库/issues
                            得自己手敲地址。 */}
                        <span className="hint">
                          开源在 GitHub：
                          <button
                            className="link-inline"
                            type="button"
                            onClick={() => void api.shell.openExternal('https://github.com/Panther114/Weport')}
                          >
                            Panther114/Weport
                          </button>
                        </span>
                      </div>
                    </div>
                  {/* 操作必须包成**一个**子元素：`.setting-row` 是两列 grid，
                      多塞两个按钮会变成两个新的网格单元、把「更新日志」甩到下一行
                      （用户报的"位置不对"）。 */}
                  <div className="setting-actions">
                    <button
                      className="ghost-btn"
                      type="button"
                      title="在浏览器里打开项目主页"
                      onClick={() => void api.shell.openExternal('https://github.com/Panther114/Weport')}
                    >
                      <GitPullRequest size={13} />                      GitHub
                    </button>
                    <button className="ghost-btn" type="button" disabled={updateBusy} onClick={() => void checkForUpdates(true)}>
                      {updateBusy ? '检查中…' : '检查更新'}
                    </button>
                    <button className="ghost-btn" type="button" onClick={() => void openChangelog()}>
                      更新日志
                    </button>
                    {updateInfo && (
                      <button className="primary-btn" type="button" disabled={updateBusy} onClick={() => void installUpdate()}>
                        {updateBusy && updateProgress ? `下载中 ${Math.round(updateProgress.percent)}%` : updateBusy ? '正在安装并重启…' : `安装 v${updateInfo.version}`}
                      </button>
                    )}
                  </div>
                  </div>
                </section>
              )}
            </div>
          </div>
        )}
      </div>

      <div className="toast-stack" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast${t.leaving ? ' leaving' : ''}`} data-kind={t.kind}>
            <span className="toast-icon">
              {t.kind === 'ok' ? <CheckCircle2 size={16} /> : t.kind === 'err' ? <XCircle size={16} /> : <Info size={16} />}
            </span>
            <div>
              <h4>{t.title}</h4>
              {t.body ? <p>{t.body}</p> : null}
            </div>
            <button className="toast-close" type="button" aria-label="关闭" onClick={() => dismissToast(t.id)}>
              ×
            </button>
          </div>
        ))}
      </div>

      {clearOpen && (
        <div className="modal-backdrop" onClick={() => !busy && setClearOpen(false)}>
          <div className="modal danger" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-labelledby="clear-title">
            <h3 id="clear-title">
              <Trash2 size={15} />
              清空导出库？
            </h3>
            <p>将删除下列内容（不可恢复）：</p>
            <p style={{ marginTop: 8 }}>
              <code>TXT/</code>、<code>JSON/</code>、<code>export_log.txt</code>
              {exportPath ? (
                <>
                  <br />
                  根目录：{exportPath}
                </>
              ) : null}
            </p>
            <div className="modal-actions">
              <button className="secondary-btn" type="button" disabled={busy} onClick={() => setClearOpen(false)}>
                取消
              </button>
              <button className="danger-btn" type="button" disabled={busy} onClick={() => void confirmClearLibrary()}>
                {busy ? '清空中…' : '确认清空'}
              </button>
            </div>
          </div>
        </div>
      )}

      {changelogOpen && (
        <div className="modal-backdrop" onClick={() => setChangelogOpen(false)}>
          <div className="modal modal-wide changelog-modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-labelledby="changelog-title">
            <h3 id="changelog-title">
              <ScrollText size={15} />
              更新日志
            </h3>
            {updateInfo && (
              <div className="changelog-new">
                <span className="changelog-new-tag">新版本 v{updateInfo.version}</span>
                {updateInfo.body ? (
                  <Suspense fallback={null}>
                    <AiMarkdown text={updateInfo.body} />
                  </Suspense>
                ) : (
                  <p className="hint" style={{ margin: '6px 0 0' }}>暂无该版本的更新说明。</p>
                )}
              </div>
            )}
            <div className="changelog-body">
              {changelogLoading ? (
                <div className="empty">正在加载更新日志…</div>
              ) : changelogContent ? (
                <Suspense fallback={<div className="empty">正在排版更新日志…</div>}>
                  <AiMarkdown text={changelogContent} />
                </Suspense>
              ) : (
                <div className="empty">暂无更新日志</div>
              )}
            </div>
            <div className="modal-actions">
              <button className="secondary-btn" type="button" onClick={() => setChangelogOpen(false)}>
                关闭
              </button>
            </div>
          </div>
        </div>
      )}

      {muteReport && (
        <div className="modal-backdrop" onClick={() => setMuteReport(null)}>
          <div className="modal modal-wide" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-labelledby="mute-report-title">
            <h3 id="mute-report-title">
              <BellOff size={15} />
              免打扰检测结果
            </h3>

            <div className="mute-report-grid">
              <div className="mute-report-cell" data-state={muteReport.success ? 'ok' : 'fail'}>
                <span>读取会话</span>
                <b>{muteReport.success ? `${muteReport.sessionCount} 个` : '失败'}</b>
              </div>
              <div className="mute-report-cell" data-state={muteReport.nativeAvailable ? 'ok' : 'fail'}>
                <span>原生接口</span>
                <b>{muteReport.nativeAvailable ? '可用' : '不可用'}</b>
              </div>
              <div className="mute-report-cell" data-state={muteReport.returnedKeyCount > 0 ? 'ok' : 'fail'}>
                <span>原生返回</span>
                <b>{muteReport.nativeRawKeyCount ?? muteReport.returnedKeyCount}</b>
              </div>
              <div className="mute-report-cell" data-state={muteReport.unknownStatusCount === 0 ? 'ok' : 'warn'}>
                <span>状态未知</span>
                <b>{muteReport.unknownStatusCount}</b>
              </div>
              <div className="mute-report-cell" data-state={muteReport.mutedCount > 0 ? 'ok' : 'warn'}>
                <span>判定免打扰</span>
                <b>{muteReport.mutedCount} 个</b>
              </div>
            </div>

            {!muteReport.success && (
              <p className="mute-report-note fail">读取失败：{muteReport.error || '未知错误'}</p>
            )}
            {muteReport.success && !muteReport.nativeAvailable && (
              <p className="mute-report-note fail">
                原生接口没有就绪（{muteReport.error || '接口未就绪'}），因此**任何会话都不会被判定为免打扰** ——
                通知会照常弹出。这是「跟随微信免打扰」失效最常见的原因。
              </p>
            )}
            {muteReport.success && muteReport.nativeAvailable && muteReport.returnedKeyCount === 0 && (
              <p className="mute-report-note fail">
                原生接口返回了 0 条 —— 和请求的 {muteReport.sessionCount} 个会话对不上，同样会导致全部按「未免打扰」处理。
              </p>
            )}
            {muteReport.success && muteReport.nativeAvailable && muteReport.returnedKeyCount > 0 && muteReport.mutedCount === 0 && (
              <p className="mute-report-note warn">
                接口正常但一个免打扰都没识别出来。如果你在微信里确实给某些会话开了免打扰，这一条就是问题所在。
              </p>
            )}
            {muteReport.success && muteReport.unknownStatusCount > 0 && (
              <p className="mute-report-note warn">
                有 {muteReport.unknownStatusCount} 个会话的状态没查到。v1.0.0 之前「状态未知」会被当成「未免打扰」，
                这些会话的免打扰设置不会生效 —— 现在会在每次同步时补查（补查后带标记的会话：{muteReport.flagBefore} → {muteReport.flagAfter}）。
              </p>
            )}

            <div className="mute-report-list">
              {muteReport.muted.length === 0 ? (
                <div className="empty">没有被判定为免打扰的会话</div>
              ) : (
                muteReport.muted.map((row) => (
                  <div className="mute-report-row" key={row.username}>
                    <strong>{row.displayName}</strong>
                    <span className="mute-report-id">{row.username}</span>
                    <span className="badge">{row.isMuted ? '免打扰' : '正常'}</span>
                    {row.isFolded && <span className="badge">已折叠</span>}
                  </div>
                ))
              )}
            </div>

            <div className="modal-actions">
              <button
                className="ghost-btn"
                type="button"
                onClick={() => void navigator.clipboard.writeText(JSON.stringify(muteReport, null, 2)).then(() => pushToast('ok', '已复制自检结果', '', 4000))}
              >
                <Copy size={13} />
                复制结果
              </button>
              <button className="secondary-btn" type="button" onClick={() => void openMuteReport()}>
                <RefreshCw size={13} />
                重新检测
              </button>
              <button className="secondary-btn" type="button" onClick={() => setMuteReport(null)}>
                关闭
              </button>
            </div>
          </div>
        </div>
      )}

      {notifyFilterOpen && (
        <div className="modal-backdrop" onClick={() => !notifyFilterBusy && setNotifyFilterOpen(false)}>
          <div className="modal modal-wide" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-labelledby="filter-title">
            <h3 id="filter-title">
              <Filter size={15} />
              会话通知过滤
            </h3>
            <p className="hint">
              勾选要接收通知的会话。仅通知已选时，白名单为空表示不通知任何会话；
              屏蔽已选时，黑名单为空表示不屏蔽任何会话。选择“仅提醒 @我”时，仅群聊中明确提及你的消息会触发，@所有人不会触发。
            </p>

            <div className="chip-row" style={{ marginTop: 12 }} role="radiogroup" aria-label="过滤模式">
              {([
                ['all', '接收所有通知'],
                ['whitelist', '仅通知已选'],
                ['blacklist', '屏蔽已选'],
                ['mentions', '仅 @我'],
              ] as Array<[FilterMode, string]>).map(([m, label]) => (
                <button
                  key={m}
                  type="button"
                  className="chip chip-sm"
                  data-active={notifyFilterMode === m}
                  onClick={() => setNotifyFilterMode(m)}
                >
                  {label}
                </button>
              ))}
            </div>

            {notifyFilterMode !== 'mentions' && <div className="filter-toolbar">
              <input
                className="path-input"
                placeholder="搜索会话…"
                value={notifyFilterSearch}
                onChange={(e) => setNotifyFilterSearch(e.target.value)}
                spellCheck={false}
              />
              <div className="chip-row" role="radiogroup" aria-label="会话类型">
                {([
                  ['all', '全部'],
                  ['private', '私聊'],
                  ['group', '群聊'],
                  ['official', '公众号'],
                ] as Array<[SessionType, string]>).map(([t, label]) => (
                  <button
                    key={t}
                    type="button"
                    className="chip chip-sm"
                    data-active={notifyFilterType === t}
                    onClick={() => setNotifyFilterType(t)}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>}

            {notifyFilterMode === 'mentions' ? (
              <div className="empty" style={{ marginTop: 12 }}>
                当前模式只提醒群聊中明确 @你的消息；私聊不会触发，@所有人也不会触发。
              </div>
            ) : <div className="notify-filter-list">
              {notifyFilterBusy ? (
                <div className="empty">正在加载会话…</div>
              ) : notifyFilteredSessions.length === 0 ? (
                <div className="empty">{notifySessions.length === 0 ? '未找到会话（请先在连接页完成配置）' : '无匹配会话'}</div>
              ) : (
                notifyFilteredSessions.map((s) => {
                  const checked = notifyFilterDraft.has(s.username)
                  return (
                    <label key={s.username} className={`notify-row${checked ? ' checked' : ''}`}>
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => {
                          const next = new Set(notifyFilterDraft)
                          if (next.has(s.username)) next.delete(s.username)
                          else next.add(s.username)
                          setNotifyFilterDraft(next)
                        }}
                      />
                      <Avatar src={s.avatarUrl} name={s.displayName || s.username} size={22} shape={sessionTypeOf(s.username) === 'group' ? 'rounded' : 'circle'} className="notify-avatar" />
                      <span className="notify-name">{s.displayName || s.username}</span>
                      {/* 免打扰跟随命中的会话在这里也要标出来：用户在微信里标过免打扰，
                          但过滤对话框里看不出它已经被自动屏蔽了。 */}
                      {respectWechatMute && mutedSet.has(s.username) ? (
                        <span className="notify-muted-chip" title="微信里标了「消息免打扰」，跟随设置不会弹窗">免打扰</span>
                      ) : null}
                      <span className="notify-id">{s.username}</span>
                    </label>
                  )
                })
              )}
            </div>}

            {notifyFilterMode !== 'mentions' && <div className="modal-actions" style={{ justifyContent: 'space-between' }}>
              <div className="btn-row">
                <button
                  className="ghost-btn"
                  type="button"
                  onClick={() => setNotifyFilterDraft(new Set(notifyFilteredSessions.map((s) => s.username)))}
                >
                  全选当前
                </button>
                <button className="ghost-btn" type="button" onClick={() => setNotifyFilterDraft(new Set())}>
                  清空选中
                </button>
              </div>
              <div className="btn-row">
                <button className="secondary-btn" type="button" onClick={() => setNotifyFilterOpen(false)}>
                  取消
                </button>
                <button className="primary-btn" type="button" onClick={() => saveNotifyFilter()}>
                  保存
                </button>
              </div>
            </div>}
            {notifyFilterMode === 'mentions' && <div className="modal-actions" style={{ justifyContent: 'flex-end' }}>
              <div className="btn-row">
                <button className="secondary-btn" type="button" onClick={() => setNotifyFilterOpen(false)}>
                  取消
                </button>
                <button className="primary-btn" type="button" onClick={() => saveNotifyFilter()}>
                  保存
                </button>
              </div>
            </div>}
          </div>
        </div>
      )}

      {aboutOpen && (
        <div className="modal-backdrop" onClick={() => setAboutOpen(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
            <h3>
              <Info size={15} />
              Weport v{version}
            </h3>
            <p>轻量微信聊天记录导出工具。读取本机微信 4.x 数据，导出全部私聊与群聊为 TXT / JSON。</p>
            <p style={{ marginTop: 8 }}>
              导出写入 <code>TXT/</code> 与 <code>JSON/</code> 子目录；根目录 <code>export_log.txt</code> 记录上次导出时间。
            </p>
            <p style={{ marginTop: 8 }}>数据仅在本地处理。路径与密钥会保存在本机，关闭应用后自动恢复。</p>
            <p
              style={{
                marginTop: 10,
                fontSize: 11.5,
                color: 'var(--text-faint)',
                lineHeight: 1.6,
                borderTop: '1px solid var(--line)',
                paddingTop: 10,
              }}
            >
              免责声明：本工具仅供个人学习与本地数据归档使用。使用前请遵守微信《软件许可及服务协议》
              及所在国家/地区的法律法规，且仅允许处理本人账号的本地数据。因不当使用（包括但不限于
              侵犯他人隐私、违反微信服务条款、用于商业用途等）造成的一切后果由使用者自行承担，作者
              不对任何滥用行为负责。
            </p>
            <p style={{ marginTop: 8, fontSize: 12, color: 'var(--text-faint)' }}>更新源：GitHub Releases (Panther114/Weport)</p>
            <div className="modal-actions">
              <button className="secondary-btn" type="button" disabled={updateBusy} onClick={() => void checkForUpdates(true)}>
                {updateBusy ? '检查中…' : '检查更新'}
              </button>
              {updateInfo && (
                <button className="primary-btn" type="button" disabled={updateBusy} onClick={() => void installUpdate()}>
                  {updateBusy && updateProgress ? `下载中 ${Math.round(updateProgress.percent)}%` : updateBusy ? '正在安装并重启…' : `安装 v${updateInfo.version}`}
                </button>
              )}
              <button className="secondary-btn" type="button" onClick={() => setAboutOpen(false)}>
                关闭
              </button>
            </div>
          </div>
        </div>
      )}

      {/*
        全局长任务指示器（v1.0.1）。

        挂在 App 上而不是某个页面里：它要回答的问题正是"我切到别的页面之后，
        刚才点的那件事还在跑吗"。任何标签页下都显示，任务结束就自己消失。
      */}
      <BackgroundTasks onOpen={handleOpenTaskTab} onCancel={handleCancelTask} />
    </div>
  )
}


