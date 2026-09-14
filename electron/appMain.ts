/**
 * Weport GUI 主进程实现（由 main.ts 在非宿主模式下调用）。
 *
 * 生命周期与 WeFlow 对齐（electron/main.ts），按 Weport 行为裁剪：
 * - 单实例（第二实例唤醒主窗口）
 * - 关闭窗口 → 最小化到托盘（默认），托盘菜单 显示主窗口 / 退出
 * - 开机自启（Run 键，可选 --background 静默启动）
 * - 更新：electron-updater（GitHub Releases）
 * - 通知：chatService 监控 → messagePushService → notificationWindow 液态玻璃弹窗
 */
import {
  app,
  BrowserWindow,
  Tray,
  Menu,
  nativeImage,
  ipcMain,
  dialog,
  shell,
  session,
  protocol,
  net,
} from 'electron'
import { pathToFileURL } from 'url'
import { autoUpdater } from 'electron-updater'
import { dirname, join } from 'path'
import { appendFileSync, existsSync, readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync } from 'fs'
import { readdir, copyFile, mkdir as mkdirAsync, rm as rmAsync, writeFile as writeFileAsync } from 'fs/promises'
import { Worker } from 'worker_threads'
import { ConfigService } from './services/config'
import { avatarCacheService, toProtocolUrl, protocolUrlToPath } from './services/avatarCacheService'
import { BackgroundVideoService } from './services/backgroundVideoService'
import { snsService, isVideoUrl } from './services/snsService'
import { WasmService } from './services/wasmService'
import { analyticsService } from './services/analyticsService'
import { groupAnalyticsService } from './services/groupAnalyticsService'
import { annualReportService } from './services/annualReportService'
import { chatService } from './services/chatService'
import { wcdbService } from './services/wcdbService'
import { exportService } from './services/export'
import { exportTaskControlService } from './services/exportTaskControlService'
import { backupService } from './services/backupService'
import { httpService } from './services/httpService'
import { mcpService } from './services/mcpService'
import { windowsHelloService } from './services/windowsHelloService'
import { dbPathService } from './services/dbPathService'
import { KeyService } from './services/keyService'
import { KeyServiceMac } from './services/keyServiceMac'
import { KeyServiceLinux } from './services/keyServiceLinux'
import { MessagePushService } from './services/messagePushService'
import { weportAiService } from './services/weportAiService'

import { getProviderCatalog } from './services/ai/providerCatalog'
import { refreshModelRegistry } from './services/ai/registryRuntime'
import { WeBotService, type WeBotDispatchRequest, type WeBotDispatchResult } from './services/weBotService'
import { setWeBotService } from './services/weBotRegistry'
import { weCloneService } from './services/weCloneService'
import { connectorsService } from './services/connectors/connectorsService'
import { registerCliCommands } from './services/cliCommands'
import { runCommand } from './services/weportCommands'
import { collectMacDiagnostics } from './services/macDiagnosticsService'
import {
  registerNotificationHandlers,
  destroyNotificationWindow,
  showNotification,
  suppressLiveGlassProtection,
  getBackdropFrameCount,
  getBackdropSeq,
  setNotificationNavigateHandler,
} from './windows/notificationWindow'
import type { MessagePushPayload } from './services/messagePushService'

const isDev = !!process.env.VITE_DEV_SERVER_URL
const APP_VERSION = app.getVersion()

// 本地媒体协议：渲染层通过 weport-media:// 读取本地解密产物（朋友圈图片/视频预览）。
// 必须在 app ready 之前注册特权，否则 file:// 在 webSecurity 下无法渲染。
protocol.registerSchemesAsPrivileged([
  { scheme: 'weport-media', privileges: { secure: true, standard: true, supportFetchAPI: true, stream: true } },
])

let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
let isAppQuitting = false
let mainWindowReady = false
let configService: ConfigService | null = null
/** 视频背景降采样缓存（startApp 里初始化，config:get 会用到） */
let backgroundVideoService: BackgroundVideoService | null = null
let messagePushService: MessagePushService | null = null
let shutdownPromise: Promise<void> | null = null
let fatalProcessError = false
/** 是否以静默方式启动（开机自启 Run 键带 --background，主窗口保持隐藏） */
const startHidden = process.argv.includes('--background')
/**
 * TUI 引擎模式（`weport` 在终端里起的子进程）。
 *
 * 终端界面本身是另一个进程（packages/weport-tui），它需要的是"服务能力"而不是
 * 渲染层，所以这个模式不创建主窗口、不建托盘，只在既有 IPC 通道上接一个
 * JSON-RPC 服务器 —— 命令走的是和 GUI 完全相同的 service 层。
 */
const isCliMode = process.argv.includes('--cli')
/** QA 截图模式（scripts/capture-ui.ps1 驱动）。 */
const isScreenshotMode = process.env.WEPORT_SCREENSHOT_POPUP === '1'
/** README 截图模式：读取隔离的用户配置/数据库副本，并在渲染层统一模糊隐私字段。 */
const isRealScreenshotMode = isScreenshotMode && process.env.WEPORT_REAL_SCREENSHOT === '1'
/** 普通截图 QA 使用虚构数据；真实 README 截图只复用截图流程。 */
const isDemoScreenshotMode = isScreenshotMode && !isRealScreenshotMode
/** 任一 QA/自测模式（截图 / v0.9 转储 / 真实数据转储 / UI 转储 / 自测 / AI 自测）：
 *  这些模式下不执行隐藏窗口内存回收等会影响断言稳定性的行为 */
const isAnyQaMode =
  isScreenshotMode ||
  process.env.WEPORT_V09_DUMP === '1' ||
  process.env.WEPORT_REAL_DUMP === '1' ||
  process.env.WEPORT_UI_DUMP === '1' ||
  process.env.WEPORT_SELFTEST === '1' ||
  process.env.WEPORT_AI_SELFTEST === '1' ||
  process.env.WEPORT_AI_PROBE === '1' ||
  process.env.WEPORT_AI_SETUP === '1' ||
  isCliMode

// ---------------------------------------------------------------------------
// 资源路径（wcdb / key / runtime DLL）
// ---------------------------------------------------------------------------
function resolveResourcesPath(): string {
  const candidate = app.isPackaged
    ? join(process.resourcesPath, 'resources')
    : join(app.getAppPath(), 'resources')
  const fallback = join(process.cwd(), 'resources')
  return existsSync(candidate) ? candidate : fallback
}

// ---------------------------------------------------------------------------
// 旧版设置迁移（Rust egui v0.6.x → electron-store）
// ---------------------------------------------------------------------------
function migrateLegacySettings() {
  // 截图 / 转储模式**绝不**迁移：`settings.json` 是 v0.6.x 遗留的真实配置，
  // 里面就是真实的 dbPath 与解密密钥。迁移之后，harness 用的那个一次性
  // user-data-dir 会连上真实数据库 —— 演示数据只覆盖了「有 override 的那些
  // 通道」，任何新加的、没写 override 的通道（例如新的自检对话框）都会把真实
  // 会话 id 截进 README 截图里。实测过一次，就是这么漏的。
  if (isScreenshotMode) return

  const store = configService!
  const fresh = !store.get('dbPath') && !store.get('myWxid') && !store.get('decryptKey') && !store.get('onboardingDone')
  // 修复模式：旧版存在密钥而 store 为空时也要迁移（早期迁移可能因字段名不一致漏掉）
  const legacyPath = join(app.getPath('appData'), 'Weport', 'settings.json')
  if (!fresh && store.get('decryptKey')) return

  let legacy: Record<string, unknown> | null = null
  if (existsSync(legacyPath)) {
    try {
      legacy = JSON.parse(readFileSync(legacyPath, 'utf8'))
    } catch (e) {
      console.warn('[Weport] 读取旧版设置失败:', e)
    }
  }

  // 兼容 v0.6.x 两种字段命名（Rust serde rename_all="camelCase"，
  // 早期版本可能写 snake_case）
  const pick = (...keys: string[]): unknown => {
    if (!legacy) return undefined
    for (const key of keys) {
      const v = legacy[key]
      if (v !== undefined && v !== null && v !== '') return v
    }
    return undefined
  }

  const dbPath = pick('dbPath', 'db_path')
  const decryptKey = pick('decryptKey', 'decrypt_key')
  const exportPath = pick('exportPath', 'export_path')
  const selectedWxid = pick('selectedWxid', 'selected_wxid')
  const format = pick('format')
  const accountKeys = pick('accountKeys', 'account_keys')
  const notificationsEnabled = pick('notificationsEnabled', 'notifications_enabled')
  const launchAtStartup = pick('launchAtStartup', 'launch_at_startup')
  const startInBackground = pick('startInBackground', 'start_in_background')
  const closeToTray = pick('closeToTray', 'close_to_tray')

  const hasLegacyContent = !!dbPath || !!decryptKey || !!exportPath
  if (legacy && hasLegacyContent) {
    try {
      if (dbPath) store.set('dbPath', String(dbPath))
      if (decryptKey) store.set('decryptKey', String(decryptKey))
      if (exportPath) store.set('exportPath', String(exportPath))
      if (selectedWxid) store.set('myWxid', String(selectedWxid))
      if (format === 'json' || format === 'txt') store.set('exportFormat', format)
      if (accountKeys && typeof accountKeys === 'object') {
        const wxidConfigs: Record<string, { decryptKey?: string; updatedAt?: number }> = {}
        for (const [wxid, key] of Object.entries(accountKeys as Record<string, unknown>)) {
          if (typeof key === 'string' && key.length === 64) {
            wxidConfigs[wxid] = { decryptKey: key, updatedAt: Date.now() }
          }
        }
        if (Object.keys(wxidConfigs).length > 0) store.set('wxidConfigs', wxidConfigs)
      }
      const notificationsOn = notificationsEnabled === true
      store.set('launchAtStartup', launchAtStartup !== false)
      store.set('silentStartup', startInBackground === true)
      store.set('windowCloseBehavior', closeToTray === false ? 'quit' : 'tray')
      store.set('notificationEnabled', notificationsOn)
      store.set('messagePushEnabled', notificationsOn)
      store.set('onboardingDone', true)
      console.log('[Weport] 已迁移旧版设置 (settings.json)')
    } catch (e) {
      console.warn('[Weport] 迁移旧版设置失败:', e)
    }
  }

  // Weport 行为默认值（与 Rust 版一致）
  if (store.get('launchAtStartup') === undefined) store.set('launchAtStartup', true)
  if (!store.get('windowCloseBehavior')) store.set('windowCloseBehavior', 'tray')
  // 历史版本默认值是 'ask'（弹窗询问，从未实现）——统一映射为托盘模式，
  // 否则「关闭窗口最小化到托盘」勾选显示开启但实际直接退出
  if (store.get('windowCloseBehavior') === 'ask') store.set('windowCloseBehavior', 'tray')
  if (store.get('notificationEnabled') === undefined) store.set('notificationEnabled', false)
  if (store.get('messagePushEnabled') === undefined) store.set('messagePushEnabled', false)
}

// ---------------------------------------------------------------------------
// 开机自启
// - Windows：直接写 HKCU Run 键（Electron 的 setLoginItemSettings 在本构建上
//   静默失效，且旧版 Rust 应用就是写注册表，保持同一机制）
// - macOS：LoginItems（app.setLoginItemSettings）
// - Linux：XDG autostart desktop entry（Electron API 不提供 Linux LoginItems）
// ---------------------------------------------------------------------------
const RUN_KEY_PATH = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'
const RUN_VALUE_NAME = 'Weport'
const isWindowsHost = process.platform === 'win32'
const isMacHost = process.platform === 'darwin'
const isLinuxHost = process.platform === 'linux'

const getLinuxAutostartPath = (): string => {
  const configuredHome = String(process.env.XDG_CONFIG_HOME || '').trim()
  const configHome = configuredHome
    ? (configuredHome.startsWith('/') ? configuredHome : join(app.getPath('home'), configuredHome))
    : join(app.getPath('home'), '.config')
  return join(configHome, 'autostart', 'com.weport.desktop.desktop')
}

const quoteDesktopExecArg = (value: string): string => {
  const escaped = String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')
  return `"${escaped}"`
}

const getLinuxAutostartEntry = (): string => [
  '[Desktop Entry]',
  'Type=Application',
  'Version=1.0',
  'Name=Weport',
  `Exec=${quoteDesktopExecArg(process.execPath)}${configService?.get('silentStartup') === true ? ' --background' : ''}`,
  'Terminal=false',
  'StartupNotify=false',
  'X-GNOME-Autostart-enabled=true',
  '',
].join('\n')

const isLinuxAutostartCurrent = (): boolean => {
  try {
    return readFileSync(getLinuxAutostartPath(), 'utf8') === getLinuxAutostartEntry()
  } catch {
    return false
  }
}

const getLaunchAtStartupUnsupportedReason = (): string | null => {
  if (!app.isPackaged) return '仅安装后的版本支持开机自启动'
  return null
}

const getSystemLaunchAtStartup = (): boolean => {
  if (isLinuxHost) {
    try {
      const autostartPath = getLinuxAutostartPath()
      if (!existsSync(autostartPath)) return false
      const content = readFileSync(autostartPath, 'utf8')
      return !/^Hidden\s*=\s*true\s*$/im.test(content) &&
        !/^X-GNOME-Autostart-enabled\s*=\s*false\s*$/im.test(content)
    } catch {
      return false
    }
  }
  if (isMacHost) {
    try {
      return app.getLoginItemSettings({ path: process.execPath }).openAtLogin
    } catch {
      return false
    }
  }
  if (!isWindowsHost) return false
  const { execFileSync } = require('child_process') as typeof import('child_process')
  try {
    execFileSync(process.env.ComSpec || 'cmd.exe', ['/c', 'reg', 'query', RUN_KEY_PATH, '/v', RUN_VALUE_NAME], {
      stdio: 'ignore',
      windowsHide: true,
    })
    return true
  } catch {
    return false
  }
}

/** macOS 专用：读取当前 LoginItem 的启动参数（用于核对 --background 是否一致） */
const getMacLoginItemArgs = (): string[] => {
  try {
    const settings = app.getLoginItemSettings({ path: process.execPath })
    return (settings.launchItems || []).find((item) => item.enabled)?.args || []
  } catch {
    return []
  }
}

const setSystemLaunchAtStartup = (enabled: boolean): { success: boolean; enabled: boolean; error?: string } => {
  if (isLinuxHost) {
    const autostartPath = getLinuxAutostartPath()
    try {
      if (enabled) {
        mkdirSync(dirname(autostartPath), { recursive: true })
        writeFileSync(autostartPath, getLinuxAutostartEntry(), { encoding: 'utf8', mode: 0o644 })
      } else if (existsSync(autostartPath)) {
        rmSync(autostartPath, { force: true })
      }
      return { success: true, enabled: getSystemLaunchAtStartup() }
    } catch (e) {
      return {
        success: false,
        enabled: getSystemLaunchAtStartup(),
        error: `设置 Linux 开机自启动失败: ${String((e as Error)?.message || e)}`,
      }
    }
  }
  if (isMacHost) {
    const silent = configService?.get('silentStartup') === true
    try {
      app.setLoginItemSettings({
        openAtLogin: enabled,
        openAsHidden: enabled && silent,
        args: enabled && silent ? ['--background'] : [],
        path: process.execPath,
      })
      return { success: true, enabled: getSystemLaunchAtStartup() }
    } catch (e) {
      return {
        success: false,
        enabled: getSystemLaunchAtStartup(),
        error: `设置开机自启动失败: ${String((e as Error)?.message || e)}`,
      }
    }
  }
  if (!isWindowsHost) {
    return { success: false, enabled: false, error: '当前平台不支持开机自启动' }
  }
  const { execFileSync } = require('child_process') as typeof import('child_process')
  const cmd = process.env.ComSpec || 'cmd.exe'
  try {
    if (enabled) {
      const args = configService?.get('silentStartup') === true ? ['--background'] : []
      const value = `"${process.execPath}"${args.length ? ` ${args.join(' ')}` : ''}`
      execFileSync(cmd, ['/c', 'reg', 'add', RUN_KEY_PATH, '/v', RUN_VALUE_NAME, '/t', 'REG_SZ', '/d', value, '/f'], {
        stdio: 'ignore',
        windowsHide: true,
      })
    } else {
      execFileSync(cmd, ['/c', 'reg', 'delete', RUN_KEY_PATH, '/v', RUN_VALUE_NAME, '/f'], {
        stdio: 'ignore',
        windowsHide: true,
      })
    }
    return { success: true, enabled }
  } catch (e) {
    return {
      success: false,
      enabled: getSystemLaunchAtStartup(),
      error: `设置开机自启动失败: ${String((e as Error)?.message || e)}`,
    }
  }
}

const getLaunchAtStartupStatus = (): { enabled: boolean; supported: boolean; reason?: string } => {
  const reason = getLaunchAtStartupUnsupportedReason()
  if (reason) return { enabled: configService?.get('launchAtStartup') === true, supported: false, reason }
  return { enabled: getSystemLaunchAtStartup(), supported: true }
}

const applyLaunchAtStartupPreference = (
  enabled: boolean
): { success: boolean; enabled: boolean; supported: boolean; reason?: string; error?: string } => {
  const reason = getLaunchAtStartupUnsupportedReason()
  if (reason) {
    configService?.set('launchAtStartup', enabled)
    return { success: false, enabled, supported: false, reason }
  }
  const result = setSystemLaunchAtStartup(enabled)
  configService?.set('launchAtStartup', result.enabled)
  return { ...result, supported: true }
}

/** 读取当前 Run 键的启动命令值（不含则返回 null；仅 Windows） */
const getRunKeyValue = (): string | null => {
  if (!isWindowsHost) return null
  const { execFileSync } = require('child_process') as typeof import('child_process')
  try {
    const stdout = execFileSync(process.env.ComSpec || 'cmd.exe', ['/c', 'reg', 'query', RUN_KEY_PATH, '/v', RUN_VALUE_NAME], {
      encoding: 'utf8',
      windowsHide: true,
    })
    const line = stdout.split(/\r?\n/).map((l) => l.trim()).find((l) => l.includes('REG_SZ'))
    if (!line) return null
    return line.slice(line.indexOf('REG_SZ') + 6).trim().replace(/^"|"$/g, '')
  } catch {
    return null
  }
}

/** 期望的 Run 键值（与 getRunKeyValue 同样去除外层引号后再比较） */
const desiredRunKeyValue = (): string => {
  const silent = configService?.get('silentStartup') === true
  const value = `"${process.execPath}"${silent ? ' --background' : ''}`
  return value.replace(/^"|"$/g, '')
}

const syncLaunchAtStartupPreference = () => {
  if (!configService) return
  const reason = getLaunchAtStartupUnsupportedReason()
  if (reason) return
  const stored = configService.get('launchAtStartup')
  const silent = configService.get('silentStartup') === true
  if (typeof stored !== 'boolean') {
    configService.set('launchAtStartup', getSystemLaunchAtStartup())
    return
  }
  if (!stored) {
    if (getSystemLaunchAtStartup()) setSystemLaunchAtStartup(false)
    return
  }
  // 已开启时：不仅要保证登录项存在，还要保证启动参数与 silentStartup 一致
  // （否则「启动时隐藏到托盘」勾选开启但开机仍然弹窗——只有再点一次开关才会生效）
  if (isWindowsHost) {
    const desired = desiredRunKeyValue()
    const current = getRunKeyValue()
    // 值缺失 / 指向其他可执行文件（旧安装路径、unpacked 构建）/ 参数不一致 → 重写
    if (current === desired) return
    setSystemLaunchAtStartup(true)
    return
  }
  if (isMacHost) {
    const currentArgs = getMacLoginItemArgs()
    const argsMatch = silent ? currentArgs.includes('--background') : !currentArgs.includes('--background')
    if (getSystemLaunchAtStartup() && argsMatch) return
    setSystemLaunchAtStartup(true)
    return
  }
  if (isLinuxHost) {
    // The XDG desktop entry is rewritten when the stored preference and file
    // state diverge (for example after an app update changes execPath).
    if (getSystemLaunchAtStartup() !== stored || (stored && !isLinuxAutostartCurrent())) {
      setSystemLaunchAtStartup(stored)
    }
    return
  }
}

/**
 * 清理历史版本残留的开机自启 Run 值（仅 Windows）：
 * - `electron.app.Electron` 可能指向开发目录的 node_modules\electron，开机时会把
 *   裸 Electron 一起拉起（表现为开机多出一个 "Electron" 窗口）；
 * - `electron.app.Weport` 与当前 `Weport` 值重复，会造成开机双实例竞争，触发
 *   second-instance 把静默启动（--background）的主窗口带出来；
 * - `electron.app.WeFlow` 为参考项目 WeFlow 安装时遗留的登录项，会随系统开机
 *   拉起无关的 WeFlow 应用。
 */
const cleanupLegacyAutostartEntries = () => {
  if (!isWindowsHost) return
  const { execFileSync } = require('child_process') as typeof import('child_process')
  const cmd = process.env.ComSpec || 'cmd.exe'
  for (const name of ['electron.app.Weport', 'electron.app.Electron', 'electron.app.WeFlow']) {
    try {
      const stdout = execFileSync(cmd, ['/c', 'reg', 'query', RUN_KEY_PATH, '/v', name], {
        encoding: 'utf8',
        windowsHide: true,
      })
      const line = stdout.split(/\r?\n/).map((l) => l.trim()).find((l) => l.includes('REG_SZ'))
      if (!line) continue
      const target = line.slice(line.indexOf('REG_SZ') + 6).trim().replace(/^"|"$/g, '')
      const isOurs = target.includes('Weport') || target.includes('WeFlow') || target.toLowerCase().includes('node_modules\\electron')
      if (!isOurs) continue
      execFileSync(cmd, ['/c', 'reg', 'delete', RUN_KEY_PATH, '/v', name, '/f'], {
        stdio: 'ignore',
        windowsHide: true,
      })
      console.log('[Weport] 已清理残留开机自启项:', name, '→', target)
    } catch {
      // 值不存在或已删除
    }
  }
}

// ---------------------------------------------------------------------------
// 更新（electron-updater + GitHub Releases）
// ---------------------------------------------------------------------------
let updateCheckTimer: NodeJS.Timeout | null = null
const isUpdaterSupported = isWindowsHost || isMacHost
const updaterUnsupportedReason = '当前 Linux 版本不提供内置自动更新，请从 Releases 下载最新安装包。'

const getUpdaterFeedUrl = (): string => {
  // WEPORT_UPDATE_URL 可覆盖更新源（测试镜像/自建源）；默认 GitHub Releases
  const override = process.env.WEPORT_UPDATE_URL
  if (override && /^https?:\/\//.test(override)) return override
  return 'https://github.com/Panther114/Weport/releases/latest/download'
}

const applyUpdaterChannel = (): boolean => {
  if (!isUpdaterSupported) {
    console.info('[Weport] 跳过更新器初始化:', updaterUnsupportedReason)
    return false
  }
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.disableDifferentialDownload = true
  try {
    autoUpdater.setFeedURL({ provider: 'generic', url: getUpdaterFeedUrl() })
  } catch (e) {
    console.warn('[Weport] 设置更新源失败:', e)
  }
  return true
}

// 简单 semver 比较（a > b 返回 true），区分预发布：
// 1.0.0-beta.1 视为比 1.0.0 旧；1.0.0-beta.2 > 1.0.0-beta.1。
// 此前只比数字段：1.0.0 与 1.0.0-beta.2 判等 → 用户永远收不到正式版更新。
function isNewerVersion(a: string, b: string): boolean {
  const parse = (v: string) => {
    const [core = '', pre = ''] = String(v || '').trim().split('-', 2)
    return {
      nums: core.split('.').map((x) => parseInt(x, 10) || 0),
      pre: pre.trim(),
    }
  }
  const pa = parse(a)
  const pb = parse(b)
  const len = Math.max(pa.nums.length, pb.nums.length)
  for (let i = 0; i < len; i += 1) {
    const va = pa.nums[i] || 0
    const vb = pb.nums[i] || 0
    if (va > vb) return true
    if (va < vb) return false
  }
  // 数字部分相等时比较预发布后缀：有 pre 的版本更旧；都无 pre 则相等
  if (pa.pre && !pb.pre) return false
  if (!pa.pre && pb.pre) return true
  if (pa.pre === pb.pre) return false
  return pa.pre > pb.pre
}

async function checkForUpdatesManual(): Promise<{
  hasUpdate: boolean
  version?: string
  releaseNotes?: string
  error?: string
}> {
  if (!app.isPackaged) return { hasUpdate: false, error: '开发模式不检查更新' }
  if (!isUpdaterSupported) return { hasUpdate: false, error: updaterUnsupportedReason }
  applyUpdaterChannel()
  try {
    const result = await autoUpdater.checkForUpdates()
    const info = result?.updateInfo
    if (!info || !isNewerVersion(String(info.version || ''), APP_VERSION)) return { hasUpdate: false }
    const ignored = configService?.get('ignoredUpdateVersion')
    if (ignored && ignored === info.version) return { hasUpdate: false }
    return { hasUpdate: true, version: info.version, releaseNotes: normalizeReleaseNotes(info.releaseNotes) }
  } catch (e) {
    return { hasUpdate: false, error: String((e as Error)?.message || e) }
  }
}

/** electron-updater 的 releaseNotes 可能是字符串，也可能是多段 {note, version} 数组 */
function normalizeReleaseNotes(notes: unknown): string {
  if (Array.isArray(notes)) {
    return notes.map((entry) => String((entry as { note?: unknown })?.note || '')).filter(Boolean).join('\n\n')
  }
  return String(notes || '')
}

let updateCheckScheduled = false

function checkForUpdatesOnStartup() {
  if (!isUpdaterSupported || !app.isPackaged || updateCheckScheduled) return
  updateCheckScheduled = true
  const ignored = configService?.get('ignoredUpdateVersion')
  updateCheckTimer = setTimeout(async () => {
    try {
      const result = await autoUpdater.checkForUpdates()
      const info = result?.updateInfo
      if (!info || !isNewerVersion(String(info.version || ''), APP_VERSION)) return
      if (ignored && ignored === info.version) return
      mainWindow?.webContents.send('app:updateAvailable', {
        version: info.version,
        releaseNotes: normalizeReleaseNotes(info.releaseNotes),
      })
    } catch (e) {
      console.warn('[Weport] 启动更新检查失败:', e)
    }
  }, 3000)
  updateCheckTimer.unref?.()
}

/** 下载完成后是否已触发安装（避免重复 quitAndInstall） */
let updateInstallTriggered = false

/** 是否正在下载/安装更新（渲染层据此禁用更新按钮） */
let isDownloadInProgress = false

/**
 * 下载并安装更新。
 *
 * 下载完成后（update-downloaded）：
 * 1. 通知渲染层切换为「正在安装」状态；
 * 2. 调用 autoUpdater.quitAndInstall(true, true)：
 *    - isSilent=true  → NSIS 以 /S 静默安装（macOS 由 Squirrel.Mac 处理，忽略该参数）；
 *    - isForceRunAfter=true → 安装完成后自动重新启动应用。
 * 此前版本只下载不安装：用户点「立即更新」后应用既不退出也不重启，
 * 更新要等用户手动退出应用才会装上（autoInstallOnAppQuit），
 * 而托盘模式下窗口关闭不等于退出，绝大多数用户永远不会走到这一步。
 */
async function downloadAndInstall(): Promise<{ success: boolean; restarting?: boolean; error?: string }> {
  if (!app.isPackaged) return { success: false, error: '开发模式不可更新' }
  if (!isUpdaterSupported) return { success: false, error: updaterUnsupportedReason }
  if (isDownloadInProgress) return { success: false, error: '正在下载中' }
  applyUpdaterChannel()
  isDownloadInProgress = true
  updateInstallTriggered = false
  try {
    return await new Promise((resolve) => {
      const onProgress = (info: { percent?: number; transferred?: number; total?: number }) => {
        mainWindow?.webContents.send('app:downloadProgress', info)
      }
      const onDownloaded = () => {
        autoUpdater.removeListener('download-progress', onProgress)
        autoUpdater.removeListener('update-downloaded', onDownloaded)
        isDownloadInProgress = false
        // 先让渲染层把按钮切到「正在安装…」并停止交互，再退出应用
        mainWindow?.webContents.send('app:updateDownloaded')
        resolve({ success: true, restarting: true })
        // 给渲染层 ~250ms 绘制安装状态，随后退出 → 静默安装 → 自动重启
        setTimeout(() => {
          if (updateInstallTriggered) return
          updateInstallTriggered = true
          try {
            autoUpdater.quitAndInstall(true, true)
          } catch (e) {
            console.error('[Weport] 触发安装失败:', e)
          }
        }, 250)
      }
      const onError = (e: Error) => {
        autoUpdater.removeListener('download-progress', onProgress)
        autoUpdater.removeListener('update-downloaded', onDownloaded)
        isDownloadInProgress = false
        updateInstallTriggered = false
        resolve({ success: false, error: String(e?.message || e) })
      }
      autoUpdater.on('download-progress', onProgress)
      autoUpdater.once('update-downloaded', onDownloaded)
      autoUpdater.once('error', onError)
      void autoUpdater.downloadUpdate().catch((e) => {
        onError(e as Error)
      })
    })
  } finally {
    // 下载失败时恢复；成功路径已在 onDownloaded 里提前复位
    isDownloadInProgress = false
  }
}

// ---------------------------------------------------------------------------
// 导出（Weport 布局：out/TXT、out/JSON + export_log.txt）
// ---------------------------------------------------------------------------
const EXPORT_LOG_NAME = 'export_log.txt'

/** 导出格式 → 输出根目录下的文件夹名 */
const EXPORT_FORMAT_FOLDERS: Record<string, string> = {
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

function formatLocalTime(): string {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

function parseExportLog(path: string): { txt?: string; json?: string } {
  let txt: string | undefined
  let json: string | undefined
  try {
    const text = readFileSync(path, 'utf8')
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim()
      if (line.startsWith('TXT:')) {
        const v = line.slice(4).trim()
        if (v && v !== '—' && v.toLowerCase() !== 'never') txt = v
      } else if (line.startsWith('JSON:')) {
        const v = line.slice(5).trim()
        if (v && v !== '—' && v.toLowerCase() !== 'never') json = v
      }
    }
  } catch {
    /* 不存在 */
  }
  return { txt, json }
}

function writeExportLog(root: string, format: 'txt' | 'json', when: string, success: number, fail: number) {
  const logPath = join(root, EXPORT_LOG_NAME)
  const { txt, json } = parseExportLog(logPath)
  const summary = `${when}  ·  success=${success}  fail=${fail}`
  const body = [
    '# Weport export log',
    '# Last successful run times for each format (local time).',
    '# Files live under TXT/ and JSON/ subfolders; re-export overwrites same names.',
    '',
    `TXT: ${format === 'txt' ? summary : (txt || '—')}`,
    `JSON: ${format === 'json' ? summary : (json || '—')}`,
    '',
  ].join('\n')
  try {
    writeFileSync(logPath, body, 'utf8')
  } catch (e) {
    console.warn('[Weport] 写入导出日志失败:', e)
  }
}

function readExportLog(root: string) {
  const logPath = join(root, EXPORT_LOG_NAME)
  const { txt, json } = parseExportLog(logPath)
  return {
    path: logPath,
    txt: txt ?? null,
    json: json ?? null,
    exists: existsSync(logPath),
  }
}

function clearExportLibrary(root: string): { success: boolean; removed: string[]; error?: string } {
  if (!root.trim()) return { success: false, removed: [], error: '未指定输出目录' }
  const removed: string[] = []
  try {
    const folderNames = Array.from(new Set(Object.values(EXPORT_FORMAT_FOLDERS)))
    for (const name of [...folderNames, EXPORT_LOG_NAME]) {
      const p = join(root, name)
      if (!existsSync(p)) continue
      if (name === EXPORT_LOG_NAME) {
        rmSync(p, { force: true })
      } else {
        rmSync(p, { recursive: true, force: true })
      }
      removed.push(name)
    }
    return { success: true, removed }
  } catch (e) {
    return { success: false, removed, error: String((e as Error)?.message || e) }
  }
}

// ---------------------------------------------------------------------------
// 通知推送 → 弹窗
// ---------------------------------------------------------------------------
function buildPopupData(p: MessagePushPayload) {  const title = p.groupName && p.sourceName
    ? `${p.groupName} · ${p.sourceName}`
    : (p.groupName || p.sourceName || p.sessionId || 'Weport')
  return {
    sessionId: p.sessionId,
    channel: 'message',
    title,
    content: p.content || '',
    avatarUrl: p.avatarUrl || undefined,
    timestamp: p.timestamp,
  }
}

function setupNotificationPipeline() {
  messagePushService = new MessagePushService()
  messagePushService.onPush((payload: MessagePushPayload) => {
    // 弹窗渲染 CDN 头像同样需要 UA/Referer 拦截（注册是幂等的）。
    // 延迟到真正出弹窗时才注册，避免静默启动时过早拉起网络服务子进程
    ensureWeChatRequestHeaderInterceptor()
    void showNotification(buildPopupData(payload))
  })
  setNotificationNavigateHandler(() => {
    // 静默启动不建主窗口：通知点击时按需创建/显示
    showMainWindow()
  })
  chatService.addDbMonitorListener((type, json) => {
    messagePushService?.handleDbMonitorChange(type, json)
  })
}

// ---------------------------------------------------------------------------
// 联系人显示名/头像预热（WeFlow 同款：startup warmup）
// ---------------------------------------------------------------------------
// 会话列表/popup/导出/会话过滤首次使用时，若联系缓存为空会显示原始 wxid
// （wxid_xxx / xxx@chatroom 等）。启动时异步把前 600 个会话的显示名与头像
// 拉取并持久化到 contactCache，之后所有展示路径都能拿到真实昵称。
let contactWarmupTimer: NodeJS.Timeout | null = null
let timelineWarmupTimer: NodeJS.Timeout | null = null
let groupWarmupTimer: NodeJS.Timeout | null = null
/** 静默启动（--background）时跳过开机预热，标记为延迟到主窗口首次创建时补跑 */
let contactWarmupDeferred = false

async function warmupContactNames(): Promise<void> {
  try {
    const dbPath = String(configService?.get('dbPath') || '').trim()
    const decryptKey = String(configService?.get('decryptKey') || '').trim()
    const myWxid = String(configService?.get('myWxid') || '').trim()
    if (!dbPath || decryptKey.length !== 64 || !myWxid) return

    const connectResult = await chatService.connect()
    if (!connectResult.success) return
    const sessionsResult = await chatService.getSessions()
    if (!sessionsResult.success || !Array.isArray(sessionsResult.sessions)) return

    const usernames = (sessionsResult.sessions as Array<{ username: string }>)
      .map((s) => String(s?.username || '').trim())
      .filter(Boolean)
      .slice(0, 600)
    if (usernames.length === 0) return
    await chatService.enrichSessionsContactInfo(usernames)
    console.log(`[Weport] 联系人预热完成: ${usernames.length} 个会话`)
    // 让会话/头像预热先释放 WCDB 队列，再预取 SNS 和群成员数据，
    // 避免冷启动时多个全量查询争抢同一个串行宿主。
    if (timelineWarmupTimer) clearTimeout(timelineWarmupTimer)
    timelineWarmupTimer = setTimeout(() => {
      timelineWarmupTimer = null
      void snsService.warmupTimeline()
    }, 200)
    timelineWarmupTimer.unref?.()
    if (groupWarmupTimer) clearTimeout(groupWarmupTimer)
    groupWarmupTimer = setTimeout(() => {
      groupWarmupTimer = null
      void warmupGroupMembers(sessionsResult.sessions as Array<{ username: string }>)
    }, 900)
    groupWarmupTimer.unref?.()
  } catch (e) {
    console.warn('[Weport] 联系人预热失败:', e)
  }
}

/** 群成员预热上限：最多预热 12 个群 / 1500 名成员（预算耗尽即停止） */
const GROUP_WARMUP_MAX = 12
const GROUP_WARMUP_MEMBER_BUDGET = 1500

/**
 * 预生成群成员面板数据（includeMessageCounts=false，不触发全历史聚合）。
 * 成员头像与显示名进入持久化/内存缓存，后续任何入口（群聊分析面板、
 * 排行、成员画像）都命中本地文件与 LRU，零宿主调用。
 * 单群失败不阻塞；纯后台任务，不等待。
 */
async function warmupGroupMembers(existingSessions?: Array<{ username: string }>): Promise<void> {
  try {
    const sessions = existingSessions || (await chatService.getSessions()).sessions
    if (!Array.isArray(sessions)) return
    const groupIds = sessions
      .map((s) => String(s?.username || '').trim())
      .filter((u) => u.includes('@chatroom'))
      .slice(0, GROUP_WARMUP_MAX)
    if (groupIds.length === 0) return
    let budget = GROUP_WARMUP_MEMBER_BUDGET
    let warmedGroups = 0
    for (const gid of groupIds) {
      if (budget <= 0) break
      try {
        const r = await groupAnalyticsService.getGroupMembersPanelData(gid, { includeMessageCounts: false })
        if (r.success && Array.isArray(r.data)) budget -= r.data.length
        warmedGroups += 1
      } catch {
        // 单群失败不阻塞其余预热
      }
    }
    console.log(`[Weport] 群成员预热完成: ${warmedGroups} 个群，头像定位缓存 ${avatarCacheService.getHeadImageCacheStats().entries} 条`)
  } catch (e) {
    console.warn('[Weport] 群成员预热失败:', e)
  }
}

/** 配置变更后延迟触发预热（合并连续写入；连接页完成密钥提取后立即生效） */
function scheduleContactWarmup(): void {
   if (contactWarmupTimer) clearTimeout(contactWarmupTimer)
  contactWarmupTimer = setTimeout(() => {
    contactWarmupTimer = null
    void warmupContactNames()
  }, 800)
  contactWarmupTimer.unref?.()
}

// ---------------------------------------------------------------------------
// 微信 CDN 请求头拦截（头像/图片 URL 需要 MicroMessenger UA + Referer，
// 否则 wx.qlogo.cn / qpic.cn 返回 403 → 弹窗头像显示占位）
// ---------------------------------------------------------------------------
let wechatInterceptorRegistered = false

function ensureWeChatRequestHeaderInterceptor() {
  if (wechatInterceptorRegistered) return
  wechatInterceptorRegistered = true

  session.defaultSession.webRequest.onBeforeSendHeaders(
    {
      urls: [
        '*://*.qpic.cn/*',
        '*://*.qlogo.cn/*',
        '*://*.wechat.com/*',
        '*://*.weixin.qq.com/*',
        '*://*.wx.qq.com/*',
      ],
    },
    (details: Electron.OnBeforeSendHeadersListenerDetails, callback: (beforeSendResponse: Electron.BeforeSendResponse) => void) => {
      details.requestHeaders['User-Agent'] =
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/107.0.0.0 Safari/537.36 MicroMessenger/7.0.20.1781(0x6700143B) WindowsWechat(0x63090719) XWEB/8351'
      details.requestHeaders['Accept'] = 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8'
      details.requestHeaders['Accept-Encoding'] = 'gzip, deflate, br'
      details.requestHeaders['Accept-Language'] = 'zh-CN,zh;q=0.9'
      details.requestHeaders['Connection'] = 'keep-alive'
      details.requestHeaders['Range'] = 'bytes=0-'
      let host = ''
      try {
        host = new URL(details.url).hostname.toLowerCase()
      } catch { /* noop */ }
      const isWxQQ = host === 'wx.qq.com' || host.endsWith('.wx.qq.com')
      details.requestHeaders['Referer'] = isWxQQ ? 'https://wx.qq.com/' : 'https://servicewechat.com/'
      callback({ cancel: false, requestHeaders: details.requestHeaders })
    },
  )
}

// ---------------------------------------------------------------------------
// 应用图标（唯一来源：assets/branding/weport-icon.jpg → assets/icons/icon.png，
// 打包时必须把 icon.png 放进 asar，否则窗口/托盘图标为空）
// ---------------------------------------------------------------------------
function resolveAppIconPath(): string {
  return join(app.getAppPath(), 'assets', 'icons', 'icon.png')
}

// ---------------------------------------------------------------------------
// 主窗口
// ---------------------------------------------------------------------------
function createWindow(autoShow: boolean): BrowserWindow {
  const win = new BrowserWindow({
    width: 1080,
    height: 720,
    minWidth: 920,
    minHeight: 600,
    icon: nativeImage.createFromPath(resolveAppIconPath()),
    // 渲染层加载前窗口底色（否则首帧闪白）
    backgroundColor: '#000000',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // 关闭拼写检查：省去拼写服务与词典内存（本应用无文本编辑需求）
      spellcheck: false,
    },
  })

  win.once('ready-to-show', () => {
    mainWindowReady = true
    if (autoShow) {
      win.show()
      // 必须在 show 之后再 maximize，Windows 上 show 前的 maximize 会被忽略导致启动时不是全屏
      if (!isAnyQaMode && !win.isMaximized()) {
        try { win.maximize() } catch { /* noop */ }
      }
    }
  })

  // 导航守卫：渲染层只能停留在应用页面；外链一律交给系统浏览器。
  // (AI 聊天若输出恶意链接，preventDefault 保证不会在应用窗口内导航/开新窗)
  // about:blank 是隐藏窗口内存回收（discard）的卸载页，必须放行
  win.webContents.on('will-navigate', (event, url) => {
    const devServer = process.env.VITE_DEV_SERVER_URL || ''
    const allowed = url === 'about:blank' || (devServer ? url.startsWith(devServer) : url.startsWith('file://'))
    if (!allowed) event.preventDefault()
  })
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })

  // 锁定缩放：禁止 Ctrl+Plus / Ctrl+Minus / Ctrl+0 / Ctrl+滚轮 缩放界面，
  // 并每次加载后把缩放因子复位为 100%（用户曾遇到 Ctrl± 把界面放大后无法还原）
  try {
    win.webContents.setVisualZoomLevelLimits(1, 1)
  } catch { /* noop */ }
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type === 'keyDown' && input.control && ['+', '-', '=', '0'].includes(input.key)) {
      event.preventDefault()
    }
  })
  win.webContents.on('did-finish-load', () => {
    try {
      win.webContents.setZoomFactor(1)
    } catch { /* noop */ }
  })
  win.webContents.on('zoom-changed', (event) => {
    event.preventDefault()
    try {
      win.webContents.setZoomFactor(1)
    } catch { /* noop */ }
  })

  win.on('close', (e) => {
    if (isAppQuitting || win !== mainWindow) return
    const behavior = configService?.get('windowCloseBehavior') || 'tray'
    if (behavior === 'tray' && tray) {
      e.preventDefault()
      hideMainWindowToTray()
    } else {
      isAppQuitting = true
      app.quit()
    }
  })

  win.on('closed', () => {
    mainWindow = null
    mainWindowReady = false
    if (!isAppQuitting && process.platform !== 'darwin') {
      destroyNotificationWindow()
      if (BrowserWindow.getAllWindows().length === 0) app.quit()
    }
  })

  loadMainWindowPage(win)
  // 默认最大化启动（QA 模式保持固定窗口尺寸，保证截图/断言稳定）
  if (!isAnyQaMode && autoShow) {
    win.maximize()
  }
  // 主窗口创建即注册微信 CDN 请求头拦截（幂等；首窗口/弹窗两条路径共用）。
  // 静默启动不建窗口时不注册，避免开机即初始化网络栈拉起网络服务子进程
  ensureWeChatRequestHeaderInterceptor()
  return win
}

/** 加载主窗口应用页面（createWindow 与隐藏窗口恢复共用） */
function loadMainWindowPage(win: BrowserWindow): void {
  if (isDev) {
    win.loadURL(process.env.VITE_DEV_SERVER_URL!)
  } else {
    win.loadFile(join(__dirname, '../dist/index.html'))
  }
}

// ---------------------------------------------------------------------------
// 隐藏窗口内存回收（v0.9.3）：主窗口隐藏到托盘超过 5 分钟 → 卸载渲染层
// （about:blank），省掉渲染进程堆与 GPU 缓冲；托盘点击恢复时重新加载应用页。
// 应用状态全部在主进程侧（config / 联系人缓存 / AI 会话 / 导出任务），
// 渲染层每次启动都从 IPC 重建，因此卸载不会丢失任何功能。
// ---------------------------------------------------------------------------
const MAIN_WINDOW_DISCARD_DELAY_MS = Math.max(
  1000,
  Number(process.env.WEPORT_DISCARD_DELAY_MS || 5 * 60 * 1000)
)
let mainWindowDiscarded = false
let mainWindowDiscardTimer: NodeJS.Timeout | null = null

/** 常驻诊断：隐藏窗口内存回收/恢复路径写入 userData/discard.log（每轮仅 1-2 行） */
function discardDiag(msg: string): void {
  try {
    appendFileSync(join(app.getPath('userData'), 'discard.log'), `${new Date().toISOString()} ${msg}\n`, 'utf8')
  } catch { /* noop */ }
}

function scheduleMainWindowDiscard(): void {
  discardDiag(`schedule delay=${MAIN_WINDOW_DISCARD_DELAY_MS}`)
  if (mainWindowDiscardTimer) {
    clearTimeout(mainWindowDiscardTimer)
    mainWindowDiscardTimer = null
  }
  if (isAppQuitting || isAnyQaMode) return
  if (exportTaskControlService.hasActiveTasks()) {
    // 导出中不卸载渲染层（进度事件目标需存活），导出结束后再试
    mainWindowDiscardTimer = setTimeout(() => {
      mainWindowDiscardTimer = null
      scheduleMainWindowDiscard()
    }, MAIN_WINDOW_DISCARD_DELAY_MS)
    mainWindowDiscardTimer.unref?.()
    return
  }
  mainWindowDiscardTimer = setTimeout(() => {
    mainWindowDiscardTimer = null
    discardDiag(`tick visible=${mainWindow?.isVisible()} destroyed=${mainWindow?.isDestroyed() ?? true} quitting=${isAppQuitting} qa=${isAnyQaMode}`)
    if (!mainWindow || mainWindow.isDestroyed() || mainWindow.isVisible()) return
    if (isAppQuitting || isAnyQaMode) return
    if (exportTaskControlService.hasActiveTasks()) {
      scheduleMainWindowDiscard()
      return
    }
    try {
      mainWindowDiscarded = true
      void mainWindow.loadURL('about:blank').then(
        () => discardDiag('discard load ok'),
        (e) => discardDiag(`discard load rejected: ${String(e)}`)
      )
      console.log('[Weport] 主窗口隐藏超时，已卸载渲染层回收内存 (about:blank)')
    } catch (e) {
      discardDiag(`discard exception: ${String(e)}`)
      mainWindowDiscarded = false
    }
  }, MAIN_WINDOW_DISCARD_DELAY_MS)
  mainWindowDiscardTimer.unref?.()
}

/** 隐藏到托盘：必须同时移除任务栏按钮，否则关闭后窗口仍留在任务栏 */
function hideMainWindowToTray() {
  if (!mainWindow || mainWindow.isDestroyed()) return
  try {
    mainWindow.setSkipTaskbar(true)
  } catch { /* noop */ }
  mainWindow.hide()
  scheduleMainWindowDiscard()
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    mainWindow = createWindow(true)
    // 静默启动跳过的主窗口按需创建后，补跑延迟的联系人预热
    // （不阻塞窗口显示；无有效配置时 warmupContactNames 内部直接返回）
    if (contactWarmupDeferred) {
      contactWarmupDeferred = false
      void warmupContactNames()
    } else if (!isAnyQaMode) {
      // 静默启动跳过的朋友圈预加载，随窗口首次创建补跑（幂等，内部有节流）
      void snsService.warmupTimeline()
    }
    // 静默启动跳过的更新检查，随窗口首次创建补跑（幂等）
    if (!isAnyQaMode) {
      checkForUpdatesOnStartup()
    }
    return
  }
  if (mainWindowDiscarded) {
    // 渲染层已被内存回收：先重载应用页，就绪后再显示（避免黑屏闪烁）。
    // ready-to-show 在隐藏窗口的后续导航上可能不再触发，用 did-finish-load
    // 兜底（短延时等首帧），保证恢复路径在任何情况下都能把窗口带回前台
    mainWindowDiscarded = false
    loadMainWindowPage(mainWindow)
    discardDiag('restore: reloading app page')
    console.log('[Weport] 恢复主窗口渲染层')
    let restoreTimer: NodeJS.Timeout | null = null
    const showRestored = () => {
      if (restoreTimer) { clearTimeout(restoreTimer); restoreTimer = null }
      if (!mainWindow || mainWindow.isDestroyed()) return
      mainWindowReady = true
      mainWindow.show()
      try {
        mainWindow.setSkipTaskbar(false)
      } catch { /* noop */ }
      mainWindow.focus()
      discardDiag('restore: window shown')
    }
    mainWindow.once('ready-to-show', showRestored)
    mainWindow.webContents.once('did-finish-load', () => {
      restoreTimer = setTimeout(showRestored, 250)
      restoreTimer.unref?.()
    })
    return
  }
  if (!mainWindow.isVisible()) {
    mainWindow.show()
    try {
      mainWindow.setSkipTaskbar(false)
    } catch { /* noop */ }
  }
  mainWindow.focus()
}

// ---------------------------------------------------------------------------
// 托盘
// ---------------------------------------------------------------------------
function createTray() {
  try {
    const icon = nativeImage
      .createFromPath(resolveAppIconPath())
      .resize({ width: 16, height: 16 })
    tray = new Tray(icon)
    tray.setToolTip('Weport')
    const menu = Menu.buildFromTemplate([
      {
        label: '显示主窗口',
        click: () => showMainWindow(),
      },
      { type: 'separator' },
      {
        label: '退出',
        click: () => {
          isAppQuitting = true
          app.quit()
        },
      },
    ])
    tray.setContextMenu(menu)
    tray.on('click', () => showMainWindow())
    tray.on('double-click', () => showMainWindow())
  } catch (e) {
    console.warn('[Weport] 托盘创建失败:', e)
  }
}

// ---------------------------------------------------------------------------
// v0.9 功能层辅助（朋友圈导出任务控制 / 旧版缓存迁移 / 年度报告年份加载）
// ---------------------------------------------------------------------------
const normalizeExportTaskId = (taskId: unknown): string => String(taskId || '').trim()

const finalizeExportTaskControlResult = async (taskId: string, result: any) => {
  if (!taskId) return result
  if (result?.stopped) {
    const cleanup = await exportTaskControlService.cleanupTask(taskId)
    if (!cleanup.success) {
      return {
        ...result,
        success: false,
        error: `导出已停止，但清理已导出文件失败：${cleanup.error || '未知错误'}`,
      }
    }
    return { ...result, cleanup }
  }
  if (!result?.paused) {
    exportTaskControlService.releaseTask(taskId)
  }
  return result
}

type SnsCacheMigrationCandidate = {
  label: string
  sourceDir: string
  targetDir: string
  fileCount: number
}

type SnsCacheMigrationPlan = {
  legacyBaseDir: string
  currentBaseDir: string
  candidates: SnsCacheMigrationCandidate[]
  totalFiles: number
}

type SnsCacheMigrationProgressPayload = {
  status: 'running' | 'done' | 'error'
  phase: 'copying' | 'cleanup' | 'done' | 'error'
  current: number
  total: number
  copied: number
  skipped: number
  remaining: number
  message?: string
  currentItemLabel?: string
}

let snsCacheMigrationInProgress = false

const normalizeFsPathForCompare = (value: string): string => {
  const normalized = String(value || '').replace(/\\/g, '/').replace(/\/+$/, '')
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

const countFilesInDir = async (dirPath: string): Promise<number> => {
  if (!dirPath || !existsSync(dirPath)) return 0
  try {
    const entries = await readdir(dirPath, { withFileTypes: true })
    let count = 0
    for (const entry of entries) {
      const fullPath = join(dirPath, entry.name)
      if (entry.isDirectory()) {
        count += await countFilesInDir(fullPath)
        continue
      }
      if (entry.isFile()) count += 1
    }
    return count
  } catch {
    return 0
  }
}

const migrateDirectoryPreserveNewFiles = async (
  sourceDir: string,
  targetDir: string,
  onFileProcessed?: (payload: { copied: boolean }) => void,
): Promise<{ copied: number; skipped: number; processed: number }> => {
  let copied = 0
  let skipped = 0
  let processed = 0

  if (!existsSync(sourceDir)) return { copied, skipped, processed }
  await mkdirAsync(targetDir, { recursive: true })

  const entries = await readdir(sourceDir, { withFileTypes: true })
  for (const entry of entries) {
    const sourcePath = join(sourceDir, entry.name)
    const targetPath = join(targetDir, entry.name)

    if (entry.isDirectory()) {
      const nested = await migrateDirectoryPreserveNewFiles(sourcePath, targetPath, onFileProcessed)
      copied += nested.copied
      skipped += nested.skipped
      processed += nested.processed
      continue
    }

    if (!entry.isFile()) continue

    if (existsSync(targetPath)) {
      skipped += 1
      processed += 1
      onFileProcessed?.({ copied: false })
      continue
    }

    await mkdirAsync(dirname(targetPath), { recursive: true })
    await copyFile(sourcePath, targetPath)
    copied += 1
    processed += 1
    onFileProcessed?.({ copied: true })
  }

  return { copied, skipped, processed }
}

const collectLegacySnsCacheMigrationPlan = async (): Promise<SnsCacheMigrationPlan | null> => {
  if (!configService) return null

  const legacyBaseDir = configService.getCacheBasePath()
  const configuredCachePath = String(configService.get('cachePath') || '').trim()
  const currentBaseDir = configuredCachePath || join(app.getPath('documents'), 'Weport')

  if (!legacyBaseDir || !currentBaseDir) return null

  const candidates = [
    {
      label: '朋友圈媒体缓存',
      sourceDir: join(legacyBaseDir, 'sns_cache'),
      targetDir: join(currentBaseDir, 'sns_cache'),
    },
    {
      label: '朋友圈表情缓存（合并到 Emojis）',
      sourceDir: join(legacyBaseDir, 'sns_emoji_cache'),
      targetDir: join(currentBaseDir, 'Emojis'),
    },
    {
      label: '朋友圈表情缓存（当前目录残留）',
      sourceDir: join(currentBaseDir, 'sns_emoji_cache'),
      targetDir: join(currentBaseDir, 'Emojis'),
    },
  ]

  const pendingKeys = new Set<string>()
  const pending: SnsCacheMigrationCandidate[] = []
  for (const item of candidates) {
    const sourceKey = normalizeFsPathForCompare(item.sourceDir)
    const targetKey = normalizeFsPathForCompare(item.targetDir)
    if (!sourceKey || sourceKey === targetKey) continue
    const dedupeKey = `${sourceKey}=>${targetKey}`
    if (pendingKeys.has(dedupeKey)) continue
    const fileCount = await countFilesInDir(item.sourceDir)
    if (fileCount <= 0) continue
    pendingKeys.add(dedupeKey)
    pending.push({ ...item, fileCount })
  }
  if (pending.length === 0) return null

  const totalFiles = pending.reduce((sum, item) => sum + item.fileCount, 0)
  return {
    legacyBaseDir,
    currentBaseDir,
    candidates: pending,
    totalFiles,
  }
}

const runLegacySnsCacheMigration = async (
  plan: SnsCacheMigrationPlan,
  onProgress: (payload: SnsCacheMigrationProgressPayload) => void,
): Promise<{ copied: number; skipped: number; totalFiles: number }> => {
  let processed = 0
  let copied = 0
  let skipped = 0
  const total = plan.totalFiles

  const emitProgress = (patch?: Partial<SnsCacheMigrationProgressPayload>) => {
    onProgress({
      status: 'running',
      phase: 'copying',
      current: processed,
      total,
      copied,
      skipped,
      remaining: Math.max(0, total - processed),
      ...patch,
    })
  }

  emitProgress({ message: '准备迁移缓存...' })

  for (const item of plan.candidates) {
    emitProgress({ currentItemLabel: item.label, message: `正在迁移：${item.label}` })
    const result = await migrateDirectoryPreserveNewFiles(item.sourceDir, item.targetDir, ({ copied: copiedThisFile }) => {
      processed += 1
      if (copiedThisFile) copied += 1
      else skipped += 1
      emitProgress({ currentItemLabel: item.label })
    })
    const expectedProcessed = copied + skipped
    if (processed !== expectedProcessed) {
      processed = expectedProcessed
      copied = Math.max(copied, result.copied)
      skipped = Math.max(skipped, result.skipped)
      emitProgress({ currentItemLabel: item.label })
    }
  }

  emitProgress({ phase: 'cleanup', message: '正在清理旧目录...' })
  for (const item of plan.candidates) {
    await rmAsync(item.sourceDir, { recursive: true, force: true })
  }

  if (existsSync(plan.legacyBaseDir)) {
    try {
      const remaining = await readdir(plan.legacyBaseDir)
      if (remaining.length === 0) {
        await rmAsync(plan.legacyBaseDir, { recursive: true, force: true })
      }
    } catch {
      // 忽略旧目录清理失败，不影响迁移结果
    }
  }

  return { copied, skipped, totalFiles: total }
}

// 年度报告：年份加载任务簿（内存态，支持取消 + 跨窗口进度广播）// 年度报告：年份加载任务簿（内存态，支持取消 + 跨窗口进度广播）
type AnnualReportYearsProgressPayload = {
  years: number[]
  done: boolean
  canceled?: boolean
  error?: string
  strategy?: string
  phase?: string
  statusText?: string
}

interface AnnualReportYearsLoadTask {
  cacheKey: string
  canceled: boolean
  done: boolean
  snapshot: AnnualReportYearsProgressPayload
  updatedAt: number
}

const annualReportYearsLoadTasks = new Map<string, AnnualReportYearsLoadTask>()
const annualReportYearsTaskByCacheKey = new Map<string, string>()

const isYearsLoadCanceled = (taskId: string): boolean =>
  annualReportYearsLoadTasks.get(taskId)?.canceled === true

const buildAnnualReportYearsCacheKey = (dbPath: unknown, wxid: unknown): string =>
  `${String(dbPath || '').trim()}|${String(wxid || '').trim()}`

const broadcastAnnualReportYearsProgress = (taskId: string, snapshot: AnnualReportYearsProgressPayload) => {
  const payload = { taskId, snapshot }
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send('annualReport:availableYearsProgress', payload)
    }
  }
}

/**
 * 在独立 worker 线程中生成年度报告（与 WeFlow 相同的生产路径）。
 * 返回 report 结果；onProgress 可选回调进度。
 */
const generateAnnualReportInWorker = (
  year: number,
  onProgress?: (progress: { status: string; progress: number }) => void,
): Promise<{ success: boolean; data?: any; error?: string }> => {
  const cfg = configService
  if (!cfg) return Promise.resolve({ success: false, error: '配置服务未就绪' })

  const dbPath = cfg.get('dbPath')
  const decryptKey = cfg.get('decryptKey')
  const wxid = cfg.getMyWxidCleaned()
  const logEnabled = cfg.get('logEnabled')
  const resourcesPath = resolveResourcesPath()
  const userDataPath = app.getPath('userData')
  const workerPath = join(__dirname, 'annualReportWorker.js')

  return new Promise((resolve) => {
    const worker = new Worker(workerPath, {
      workerData: { year, dbPath, decryptKey, myWxid: wxid, resourcesPath, userDataPath, logEnabled },
    })

    const cleanup = () => {
      worker.removeAllListeners()
    }

    worker.on('message', (msg: any) => {
      if (msg && msg.type === 'annualReport:progress') {
        onProgress?.(msg.data)
        return
      }
      if (msg && (msg.type === 'annualReport:result' || msg.type === 'done')) {
        cleanup()
        void worker.terminate()
        resolve(msg.data ?? msg.result)
        return
      }
      if (msg && (msg.type === 'annualReport:error' || msg.type === 'error')) {
        cleanup()
        void worker.terminate()
        resolve({ success: false, error: msg.error || '年度报告生成失败' })
      }
    })

    worker.on('error', (err) => {
      cleanup()
      resolve({ success: false, error: String(err) })
    })

    worker.on('exit', (code) => {
      if (code !== 0) {
        cleanup()
        resolve({ success: false, error: `年度报告线程异常退出: ${code}` })
      }
    })
  })
}

// ---------------------------------------------------------------------------
// QA 真实数据转储模式（WEPORT_REAL_DUMP=1）
// 不使用任何演示数据：读取真实配置（dbPath/decryptKey/myWxid），通过真实
// WCDB 宿主进程执行全部 v0.9 只读查询，验证真实数据库端到端可用性。
// 结果（聚合统计 + 显示名，非原文消息）写入 WEPORT_REAL_DUMP_OUT。
// ---------------------------------------------------------------------------
async function runRealDataDump() {
  const outDir = process.env.WEPORT_REAL_DUMP_OUT || join(app.getPath('temp'), 'weport-real-dump')
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
  try { mkdirSync(outDir, { recursive: true }) } catch { /* noop */ }
  const logFile = join(outDir, 'real-dump.log')
  const log = (msg: string) => {
    const line = `${new Date().toISOString()} ${msg}`
    console.log(line)
    try { appendFileSync(logFile, line + '\n') } catch { /* noop */ }
  }

  const report: Record<string, unknown> = {}
  const run = async (key: string, fn: () => Promise<unknown>): Promise<boolean> => {
    const startedAt = Date.now()
    try {
      const result = await fn()
      report[key] = result
      log(`${key} = ${JSON.stringify(result)?.slice(0, 1200)}`)
      return true
    } catch (e) {
      report[key] = { error: String((e as Error)?.message || e) }
      log(`${key} FAILED: ${String((e as Error)?.message || e)}`)
      return false
    } finally {
      log(`${key} took ${Date.now() - startedAt}ms`)
    }
  }

  log('real-data dump started (read-only queries)')
  const cfg = configService
  if (!cfg) {
    log('FAIL: configService 未就绪')
    app.exit(1)
    return
  }
  report.config = {
    dbPath: String(cfg.get('dbPath') || '').slice(0, 80),
    myWxid: String(cfg.getMyWxidCleaned() || ''),
    hasDecryptKey: String(cfg.get('decryptKey') || '').length === 64,
  }
  log(`config = ${JSON.stringify(report.config)}`)

  // 1) 连接真实数据库（真实 WCDB 宿主进程 + 真实密钥）
  const connectRes = await chatService.connect()
  report.connect = { success: connectRes.success, error: connectRes.error }
  log(`connect = ${JSON.stringify(report.connect)}`)
  if (!connectRes.success) {
    log('FAIL: 真实数据库连接失败，无法继续')
    try { writeFileSync(join(outDir, 'real-dump.json'), JSON.stringify(report, null, 2), 'utf8') } catch { /* noop */ }
    app.exit(1)
    return
  }
  await sleep(1500)

  let ok = true

  // 2) 朋友圈（真实 sns.db）
  ok = (await run('snsUsernames', () => snsService.getSnsUsernames())) && ok
  ok = (await run('snsExportStats', () => snsService.getExportStats({ allowTimelineFallback: true }))) && ok
  ok = (await run('snsTimelineSample', async () => {
    const r = await snsService.getTimeline(5, 0)
    if (r.success && r.timeline) {
      return {
        success: true,
        count: r.timeline.length,
        sample: r.timeline.map((p: any) => ({
          nickname: p.nickname,
          createTime: p.createTime,
          contentDesc: String(p.contentDesc || '').slice(0, 40),
          mediaCount: p.media?.length || 0,
          likesCount: p.likes?.length || 0,
          commentsCount: p.comments?.length || 0,
        })),
      }
    }
    return r
  })) && ok
  ok = (await run('snsUserPostCounts', () => snsService.getUserPostCounts({ preferCache: false, forceRefresh: true }))) && ok
  // 2.5) 朋友圈解密探针：真实媒体 URL + key 走完整解密管线，量化耗时
  await run('snsKeystreamProbe', async () => {
    const available = await snsService.isKeystreamAvailable()
    return {
      available,
      note: available
        ? 'wasm keystream 可用（正确且快速的解密路径）'
        : 'wasm keystream 不可用（解密将失败，请检查 wasm 打包）',
    }
  })
  await run('snsDecryptProbe', async () => {
    const tl = await snsService.getTimeline(40, 0)
    const posts = tl.success ? (tl.timeline || []) : []
    const candidates: Array<{ url: string; key?: string | number }> = []
    for (const p of posts) {
      for (const m of (p.media || [])) {
        if (!String(m.url || '').startsWith('data:')) {
          candidates.push({ url: String(m.url || ''), key: m.key })
        }
        if (candidates.length >= 3) break
      }
      if (candidates.length >= 3) break
    }
    if (candidates.length === 0) return { success: false, error: 'timeline 无可用媒体' }
    const results = []
    for (const c of candidates) {
      const t0 = Date.now()
      const first = await snsService.proxyImage(c.url, c.key)
      const firstMs = Date.now() - t0
      const t1 = Date.now()
      const second = await snsService.proxyImage(c.url, c.key)
      const secondMs = Date.now() - t1
      results.push({
        success: first.success,
        firstMs,
        secondMs,
        dataUrlLen: first.dataUrl ? first.dataUrl.length : 0,
        cachePath: first.cachePath || '',
        url: String(c.url || '').slice(0, 120),
        error: first.error,
      })
    }
    const cacheStats = WasmService.getInstance().getKeystreamCacheStats()
    return { success: results.every((r) => r.success), results, keystreamCache: cacheStats }
  })

  // 3) 全局分析（真实聚合统计）
  ok = (await run('analyticsOverall', () => analyticsService.getOverallStatistics(true))) && ok
  ok = (await run('analyticsTimeDistribution', () => analyticsService.getTimeDistribution())) && ok
  ok = (await run('analyticsContactRankings', () => analyticsService.getContactRankings(8, 0, 0))) && ok

  // 3.5) 头像本地化探针：head_image.db 覆盖率 + 磁盘缓存文件存在率
  await sleep(3500) // 等启动预热（enrich + 落盘）完成，避免与探针竞争
  await run('avatarProbe', async () => {
    const sessionsRes = await chatService.getSessions()
    const allUsernames = ((sessionsRes as any)?.sessions || [])
      .map((s: any) => String(s?.username || '').trim())
      .filter(Boolean)
    const usernames = allUsernames.slice(0, 60)

    // 全量 head_image 覆盖：分批（60/批）直接查询，与 enrich 内部一致
    let fullHit = 0
    for (let i = 0; i < allUsernames.length; i += 60) {
      const batch = allUsernames.slice(i, i + 60)
      const res = await wcdbService.getHeadImageBuffers(batch)
      if (res.success && res.map) {
        fullHit += Object.keys(res.map).filter((u) => res.map![u]).length
      }
    }

    const headImages = await wcdbService.getHeadImageBuffers(usernames)
    const headHit = headImages.success ? Object.keys(headImages.map || {}).filter((u) => headImages.map![u]).length : 0
    const enriched = await chatService.enrichSessionsContactInfo(usernames)
    const contacts = enriched.success ? enriched.contacts || {} : {}
    const entries = Object.values(contacts) as Array<{ avatarUrl?: string }>
    const withAvatar = entries.filter((e) => e.avatarUrl).length
    const localProtocol = entries.filter((e) => e.avatarUrl?.startsWith('weport-media://')).length
    const dataAvatar = entries.filter((e) => e.avatarUrl?.startsWith('data:image/')).length
    const cdnAvatar = entries.filter((e) => e.avatarUrl?.startsWith('http')).length
    // 文件存在性：协议 URL 直接验证文件；CDN URL 验证 sha1 文件是否已下载
    const { createHash } = await import('crypto')
    const { join } = await import('path')
    const { existsSync } = await import('fs')
    const avatarDir = join(configService!.getCacheBasePath(), 'avatars')
    let filesOnDisk = 0
    try {
      const { readdirSync } = await import('fs')
      filesOnDisk = readdirSync(avatarDir).filter((f: string) => f.endsWith('.jpg')).length
    } catch { /* noop */ }
    const fileResolvable = entries.filter((e) => {
      const url = e.avatarUrl
      if (!url) return false
      if (url.startsWith('weport-media://')) {
        const p = protocolUrlToPath(url)
        return !!p && existsSync(p)
      }
      if (url.startsWith('http')) {
        const hash = createHash('sha1').update(url).digest('hex')
        return existsSync(join(avatarDir, `${hash}.jpg`))
      }
      return true
    }).length
    const sampleLocal = entries.filter((e) => e.avatarUrl?.startsWith('weport-media://')).slice(0, 3).map((e) => e.avatarUrl)
    return {
      probed: usernames.length,
      totalSessions: allUsernames.length,
      headImageFullHit: fullHit,
      headImageFullHitRate: allUsernames.length > 0 ? Math.round((fullHit / allUsernames.length) * 100) : 0,
      headImageHit: headHit,
      headImageHitRate: usernames.length > 0 ? Math.round((headHit / usernames.length) * 100) : 0,
      withAvatar,
      localProtocol,
      dataUrl: dataAvatar,
      cdnFallback: cdnAvatar,
      fileResolvable,
      fileResolvableRate: entries.length > 0 ? Math.round((fileResolvable / entries.length) * 100) : 0,
      filesOnDisk,
      avatarDir,
      sampleLocal,
      headImageLocator: avatarCacheService.getHeadImageCacheStats(),
    }
  })

  // 4) 群聊分析（真实群数据）
  const groupsRes = (await run('groupChats', () => groupAnalyticsService.getGroupChats())) ? (report.groupChats as any) : null
  const groups = groupsRes?.data || []
  if (groups.length > 0) {
    const first = groups[0]?.username as string
    await run('groupMembers', () => groupAnalyticsService.getGroupMembersPanelData(first, { includeMessageCounts: true, forceRefresh: true }))
    // 二次打开（无 forceRefresh）：应命中成员面板缓存 + 头像定位缓存 → 毫秒级
    await run('groupMembersReopen', () => groupAnalyticsService.getGroupMembersPanelData(first, { includeMessageCounts: true }))
    await run('groupRanking', () => groupAnalyticsService.getGroupMessageRanking(first, 5, 0, 0))
  // 4.5) 模拟页面打开时的 4 面板并行加载（成员/排行/活跃时段/消息类型），
  // 验证 getGroupStats 共享缓存把 4 次全历史聚合合并为 1 次
  await run('groupPanelParallel', async () => {
    const t0 = Date.now()
    const [membersRes, rankRes, hoursRes, mediaRes] = await Promise.all([
      groupAnalyticsService.getGroupMembersPanelData(first, { includeMessageCounts: true, forceRefresh: true }),
      groupAnalyticsService.getGroupMessageRanking(first, 5, 0, 0),
      groupAnalyticsService.getGroupActiveHours(first, 0, 0),
      groupAnalyticsService.getGroupMediaStats(first, 0, 0),
    ])
    return {
      elapsedMs: Date.now() - t0,
      members: membersRes.success ? membersRes.data?.length : membersRes.error,
      ranking: rankRes.success ? rankRes.data?.length : rankRes.error,
      hours: hoursRes.success ? Object.keys(hoursRes.data?.hourlyDistribution || {}).length : hoursRes.error,
      media: mediaRes.success ? mediaRes.data?.total : mediaRes.error,
    }
  })
  // 4.6) 多群 getGroupStats 原始结果探针（诊断「聚合失败」是否群相关）
  await run('groupStatsProbe', async () => {
    const results: Array<{ group: string; success: boolean; error?: string; senders?: number; total?: number; ms: number }> = []
    const { wcdbService: wsvc } = await import('./services/wcdbService')
    for (const g of groups.slice(0, 3)) {
      const t0 = Date.now()
      try {
        const r = await wsvc.getGroupStats(String(g?.username || ''), 0, 0)
        const ms = Date.now() - t0
        const sd = r?.data?.sessions?.[String(g?.username || '')]
        results.push({
          group: String(g?.username || '').slice(0, 30),
          success: !!r?.success,
          error: r?.error,
          senders: sd?.senders ? Object.keys(sd.senders).length : undefined,
          total: sd?.total ?? r?.data?.total,
          ms,
        })
      } catch (e) {
        results.push({ group: String(g?.username || '').slice(0, 30), success: false, error: String(e), ms: Date.now() - t0 })
      }
    }
    return results
  })
  } else {
    log('groupChats: 无群聊（可能无数据）')
  }

  // 5) 年度报告：真实年份 + 真实 worker 生成（最大年份）
  const yearsRes = (await run('annualYears', () => annualReportService.getAvailableYears({
    dbPath: cfg.get('dbPath'),
    decryptKey: cfg.get('decryptKey'),
    wxid: cfg.getMyWxidCleaned(),
  }))) ? (report.annualYears as any) : null
  const years: number[] = yearsRes?.data || []
  if (years.length > 0) {
    const year = Math.max(...years)
    ok = (await run(`annualReport_${year}`, () => generateAnnualReportInWorker(year, (progress) => {
      log(`  annualReport progress: ${progress.status} (${progress.progress}%)`)
    }))) && ok
    // 4.7) 双人报告探针：取排行第一的好友，在独立 worker 中生成
    await run('dualReport', async () => {
      const rankings = await analyticsService.getContactRankings(1, 0, 0)
      const friend = rankings.success && rankings.data && rankings.data[0]
      if (!friend) return { success: false, error: '无可选好友' }
      const cfg = configService
      if (!cfg) return { success: false, error: '配置服务未就绪' }
      const dbPath = cfg.get('dbPath')
      const decryptKey = cfg.get('decryptKey')
      const wxid = cfg.getMyWxidCleaned()
      const logEnabled = cfg.get('logEnabled')
      const resourcesPath = resolveResourcesPath()
      const userDataPath = app.getPath('userData')
      const workerPath = join(__dirname, 'dualReportWorker.js')
      const excludeWords = cfg.get('wordCloudExcludeWords') || []
      return new Promise((resolve) => {
        const worker = new Worker(workerPath, {
          workerData: { year: 0, friendUsername: friend.username, dbPath, decryptKey, myWxid: wxid, resourcesPath, userDataPath, logEnabled, excludeWords },
        })
        const cleanup = () => worker.removeAllListeners()
        worker.on('message', (msg: any) => {
          if (msg?.type === 'dualReport:progress') return
          if (msg?.type === 'dualReport:result' || msg?.type === 'done') {
            cleanup()
            void worker.terminate()
            const d = msg.data ?? msg.result
            resolve({
              success: !!d?.success,
              error: d?.error,
              friend: d?.data?.friendName,
              totalMessages: d?.data?.stats?.totalMessages,
              topPhrases: d?.data?.topPhrases?.length,
              heatmap: d?.data?.heatmap ? 'present' : 'missing',
              initiative: d?.data?.initiative,
            })
            return
          }
          if (msg?.type === 'dualReport:error' || msg?.type === 'error') {
            cleanup()
            void worker.terminate()
            resolve({ success: false, error: msg.error || '双人报告生成失败' })
          }
        })
        worker.on('error', (err) => {
          cleanup()
          resolve({ success: false, error: String(err) })
        })
        worker.on('exit', (code) => {
          if (code !== 0) {
            cleanup()
            resolve({ success: false, error: `双人报告线程异常退出: ${code}` })
          }
        })
      })
    })
  } else {
    log('annualYears: 无可用年份')
  }

  report.ok = ok
  log(`RESULT ok=${ok}`)
  try {
    writeFileSync(join(outDir, 'real-dump.json'), JSON.stringify(report, null, 2), 'utf8')
    log(`written to ${join(outDir, 'real-dump.json')}`)
  } catch { /* noop */ }
  try { await chatService.close() } catch { /* noop */ }
  app.exit(ok ? 0 : 1)
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------
/**
 * WeBot 定时任务（v1.0）。
 *
 * 派发直接走 `weportAiService.runChat` —— 与用户在 WeportAI 页面手动提问是
 * **同一条路径**。任务因此同样受工具白名单、只读约束与缓存策略管辖，不存在
 * 一条绕过用户可见配置的「特权」通道。
 */
let weBotService: WeBotService | null = null

async function dispatchWeBotTask(request: WeBotDispatchRequest, signal: AbortSignal): Promise<WeBotDispatchResult> {
  if (signal.aborted) throw new Error('已中止')

  const chat = weportAiService.createChat(request.task.title)
  const sections: string[] = []
  if (request.task.description.trim()) sections.push(request.task.description.trim())

  if (request.task.references.length > 0) {
    const lines = request.task.references
      .map((reference) => {
        const kind = reference.kind === 'group' ? '群聊' : reference.kind === 'official' ? '公众号' : '私聊'
        return `- ${reference.label}（${kind}）`
      })
      .join('\n')
    sections.push(`本任务限定的会话：\n${lines}\n请聚焦这些会话（可用 list_sessions 找到对应 id 后读取消息）。`)
  }

  sections.push(
    `这是 WeBot 定时任务的自动执行（${new Date().toLocaleString('zh-CN')}）。` +
      '请只输出简洁结论，正文控制在 300 字以内，不要复述原始消息。'
  )

  // WeBot 在「设置 → AI 服务」里有自己的服务指向（默认跟随默认服务），因此定时
  // 任务可以独立指向一个便宜/快的模型，而不影响 WeportAI 的手动对话。
  const result = await weportAiService.runChat(chat.id, sections.join('\n\n'), { consumer: 'webot' })
  if (!result.success) throw new Error(result.error || '任务执行失败')

  const finished = weportAiService.getChat(chat.id)
  const answer = [...(finished?.messages || [])]
    .reverse()
    .find((message) => message.role === 'assistant' && String(message.content || '').trim())
  return { title: request.task.title, summary: String(answer?.content || '').trim() || '（本次运行没有产出内容）' }
}

function ensureWeBotService(): WeBotService {
  if (weBotService) return weBotService
  weBotService = new WeBotService({
    dataDir: join(app.getPath('userData'), 'webot'),
    dispatch: dispatchWeBotTask,
    notify: (note) => {
      // 复用聊天通知的那套独立置顶窗口（notificationWindow.ts），不另起一套
      // 通知系统 —— 用户已经熟悉它出现的位置与交互。
      try {
        ensureWeChatRequestHeaderInterceptor()
        void showNotification({
          sessionId: `webot:${note.taskId}`,
          channel: 'webot',
          title: note.status === 'error' ? `WeBot 任务失败 · ${note.taskTitle}` : `WeBot 任务完成 · ${note.taskTitle}`,
          content: note.summary.slice(0, 160),
          timestamp: note.createdAt,
        })
      } catch (e) {
        console.warn('[WeBot] 通知发送失败:', e)
      }
      try {
        mainWindow?.webContents.send('webot:note', note)
      } catch { /* 窗口可能尚未创建 */ }
    },
  })
  return weBotService
}

/**
 * MCP stdio 桥接脚本的绝对路径。
 *
 * 开发期在仓库的 `scripts/` 下，打包后由 `prepare-mcp-bundle.cjs` 产出到
 * `resources/mcp/`，再由 extraResources 映射成 `<resources>/mcp/`。设置页要
 * 把这条路径写进用户的客户端配置，所以两边都得算对。
 */
function resolveMcpBridgePath(): string {
  if (app.isPackaged) return join(process.resourcesPath, 'mcp', 'mcp-stdio-bridge.cjs')
  return join(app.getAppPath(), 'scripts', 'mcp-stdio-bridge.mjs')
}

function registerIpcHandlers() {
  void registerNotificationHandlers()

  ipcMain.on('notification-clicked', (_event, _payload) => {
    showMainWindow()
  })

  // 配置
  ipcMain.handle('config:get', (_e, key: string) => {
    // 视频背景的透明降采样：渲染进程只管拿到「该播哪个文件」，转码与缓存全在
    // 主进程做（见 backgroundVideoService）。第一次返回原文件并启动后台转码，
    // 之后返回缓存 —— 启动路径永远不等 ffmpeg。
    if (key === 'appearanceBackgroundPath') {
      const requested = String((configService as any)?.get(key) || '')
      if (!requested || !backgroundVideoService) return requested
      return backgroundVideoService.resolve(requested).path
    }
    return (configService as any)?.get(key)
  })
  ipcMain.handle('config:set', async (_e, key: string, value: unknown) => {
    (configService as any)?.set(key, value)
    if (key === 'launchAtStartup') {
      applyLaunchAtStartupPreference(value === true)
    }
    if (key === 'silentStartup' && configService?.get('launchAtStartup')) {
      applyLaunchAtStartupPreference(true)
    }
    if (['messagePushEnabled', 'messagePushRespectWechatMute', 'notificationEnabled', 'antiRevokeAutoApplyNewGroups', 'dbPath', 'decryptKey', 'myWxid'].includes(key)) {
      // 关闭推送时同步停掉轮询/监控并释放 WCDB 连接（此前只会在开启时 start，
      // 关闭路径从不 stop，连接会一直占着）
      if (configService?.get('messagePushEnabled') || configService?.get('antiRevokeAutoApplyNewGroups')) messagePushService?.start()
      else messagePushService?.stop()
      await messagePushService?.handleConfigChanged(key)
    }
    if (key === 'dbPath' || key === 'decryptKey' || key === 'myWxid') {
      // 连接条件就绪后预热联系人缓存（首次使用即可显示真实昵称）
      scheduleContactWarmup()
    }
    return { success: true }
  })
  ipcMain.handle('config:clear', () => {
    configService?.clear()
    messagePushService?.handleConfigCleared()
    return { success: true }
  })
  ipcMain.handle('config:updateWxidEntry', async (_e, wxid: string, patch: Record<string, unknown>) => {
    const id = String(wxid || '').trim()
    if (!id) return { success: false, error: 'wxid 为空' }
    const p = (patch && typeof patch === 'object' ? patch : {}) as Record<string, unknown>
    // 仅允许合并已定义的 wxidConfigs 字段，避免污染
    const allowed = new Set(['decryptKey', 'imageXorKey', 'imageAesKey', 'updatedAt'])
    const filtered: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(p)) if (allowed.has(k)) filtered[k] = v
    if (!filtered.updatedAt) filtered.updatedAt = Date.now()
    const cur = ((configService as any)?.get('wxidConfigs') || {}) as Record<string, any>
    cur[id] = { ...(cur[id] || {}), ...filtered }
    ;(configService as any)?.set('wxidConfigs', cur)
    return { success: true }
  })

  // 对话框 / 外壳
  ipcMain.handle('dialog:openDirectory', (_e, options?: any) => {
    const win = mainWindow ?? BrowserWindow.getAllWindows().find((w) => !w.isDestroyed()) ?? null
    if (!win) return Promise.resolve(null)
    return dialog.showOpenDialog(win, {
      properties: ['openDirectory'],
      ...(options || {}),
    }).then((r) => (r.canceled ? null : r.filePaths[0]))
  })
  ipcMain.handle('dialog:openFile', (_e, options?: any) =>
    dialog.showOpenDialog(mainWindow!, {
      properties: ['openFile'],
      ...(options || {}),
    }).then((r) => (r.canceled ? null : r.filePaths[0])))
  ipcMain.handle('shell:openPath', (_e, p: string) => shell.openPath(String(p || '')))
  ipcMain.handle('shell:openExternal', (_e, url: string) => shell.openExternal(String(url || '')))

  // 应用
  ipcMain.handle('app:getVersion', () => APP_VERSION)
  ipcMain.handle('app:getLaunchAtStartupStatus', () => getLaunchAtStartupStatus())
  ipcMain.handle('app:setLaunchAtStartup', (_e, enabled: boolean) => applyLaunchAtStartupPreference(enabled === true))
  ipcMain.handle('app:checkForUpdates', () => checkForUpdatesManual())
  ipcMain.handle('app:downloadAndInstall', () => downloadAndInstall())
  ipcMain.handle('app:ignoreUpdate', (_e, version: string) => {
    configService?.set('ignoredUpdateVersion', String(version || ''))
    return { success: true }
  })
  ipcMain.handle('app:getChangelog', () => {
    try {
      const content = readFileSync(join(app.getAppPath(), 'RELEASE_NOTES.md'), 'utf8').trim()
      return { success: true, version: APP_VERSION, content }
    } catch (e) {
      return { success: false, version: APP_VERSION, error: String((e as Error)?.message || e) }
    }
  })

  // 数据备份（v0.9.4：本地聊天数据库快照备份/恢复）
  ipcMain.handle('backup:create', async (_e, payload: { outputPath: string; options?: { includeImages?: boolean; includeVideos?: boolean; includeFiles?: boolean } }) => {
    try {
      return await backupService.createBackup(String(payload?.outputPath || ''), {
        includeImages: payload?.options?.includeImages === true,
        includeVideos: payload?.options?.includeVideos === true,
        includeFiles: payload?.options?.includeFiles === true,
      })
    } catch (e) {
      return { success: false, error: String(e) }
    }
  })
  ipcMain.handle('backup:inspect', async (_e, payload: { archivePath: string }) => {
    try {
      return await backupService.inspectBackup(String(payload?.archivePath || ''))
    } catch (e) {
      return { success: false, error: String(e) }
    }
  })
  ipcMain.handle('backup:restore', async (_e, payload: { archivePath: string }) => {
    try {
      return await backupService.restoreBackup(String(payload?.archivePath || ''))
    } catch (e) {
      return { success: false, error: String(e) }
    }
  })

  // 本地 HTTP API（v0.9.4 只读接口，配置 httpApiEnabled/httpApiPort/httpApiToken）
  ipcMain.handle('http:start', async () => {
    const port = Number(configService?.get('httpApiPort') || 5031)
    const host = String(configService?.get('httpApiHost') || '127.0.0.1')
    return httpService.start(port, host)
  })
  ipcMain.handle('http:stop', () => httpService.stop())
  ipcMain.handle('http:getStatus', () => httpService.getStatus())
  ipcMain.handle('mcp:getStatus', () => mcpService.getStatus())
  // 客户端配置在**主进程**里拼好再交给渲染进程：mcpToken 是 safeStorage 加密的
  // 密钥，没必要为了渲染一段 JSON 把它送进渲染进程。
  ipcMain.handle('mcp:getClientConfig', () => {
    const status = mcpService.getStatus()
    const bridge = resolveMcpBridgePath()
    const token = String(configService?.get('mcpToken') || '')
    return {
      ...status,
      bridgePath: bridge,
      json: JSON.stringify(
        { mcpServers: { weport: { command: bridge, args: ['--port', String(status.port), '--token', token] } } },
        null,
        2,
      ),
    }
  })
  // macOS 能力诊断（v1.0）：把「为什么拿不到密钥」的三条独立原因逐条测出来。
  // 非 darwin 平台返回 supported:false，界面据此隐藏入口。
  ipcMain.handle('diagnostics:collectMac', () =>
    collectMacDiagnostics({ appVersion: APP_VERSION, resourcesPath: process.resourcesPath }))
  ipcMain.handle('auth:verifyHello', (_e, message: string) => {
    // Windows Hello（mac 为 Touch ID 路径）：Linux 无对应生物认证后端，直接给出明确错误
    if (process.platform !== 'win32' && process.platform !== 'darwin') {
      return Promise.resolve({ success: false, error: '生物识别解锁仅支持 Windows / macOS' })
    }
    return windowsHelloService.verify(String(message || '请验证您的身份'))
  })

  // 数据库路径
  ipcMain.handle('dbpath:autoDetect', () => dbPathService.autoDetect())
  ipcMain.handle('dbpath:scanWxids', (_e, rootPath: string) => dbPathService.scanWxids(String(rootPath || '')))
  ipcMain.handle('dbpath:getDefault', () => dbPathService.getDefaultPath())

  // 密钥（Linux：keyServiceLinux 自 v0.7.5 起随仓库携带，v0.9.10 接线）
  ipcMain.handle('key:autoGetDbKey', async () => {
    const keyService =
      process.platform === 'darwin'
        ? new KeyServiceMac()
        : process.platform === 'linux'
          ? new KeyServiceLinux()
          : new KeyService()
    const result = await keyService.autoGetDbKey(180_000, (message, level) => {
      mainWindow?.webContents.send('key:dbKeyStatus', { message, level })
    })
    return result
  })

  // 图片密钥（issue #9a：kvcomm 缓存读取 + 内存扫描兜底，WeFlow 同名通道）
  const sendImageKeyStatus = (event: Electron.IpcMainInvokeEvent, message: string) => {
    try {
      if (!event.sender.isDestroyed()) event.sender.send('key:imageKeyStatus', { message: String(message || '') })
    } catch { /* noop */ }
  }
  const createImageKeyService = (): KeyService | KeyServiceMac | KeyServiceLinux =>
    process.platform === 'darwin'
      ? new KeyServiceMac()
      : process.platform === 'linux'
        ? new KeyServiceLinux()
        : new KeyService()
  ipcMain.handle('key:autoGetImageKey', async (event, manualDir?: string, wxid?: string) => {
    if (process.platform === 'win32') {
      const dir = manualDir ? String(manualDir).trim() : ''
      if (dir && dir.startsWith('\\\\')) return { success: false, error: '不支持网络路径' }
      return new KeyService().autoGetImageKey(
        dir || undefined,
        (message) => sendImageKeyStatus(event, message),
        wxid ? String(wxid) : undefined
      )
    }
    if (process.platform !== 'linux' && process.platform !== 'darwin') {
      return { success: false, error: '图片密钥提取不支持当前平台' }
    }
    const dir = manualDir ? String(manualDir).trim() : ''
    if (dir && dir.startsWith('\\\\')) return { success: false, error: '不支持网络路径' }
    return createImageKeyService().autoGetImageKey(
      dir || undefined,
      (message) => sendImageKeyStatus(event, message),
      wxid ? String(wxid) : undefined
    )
  })
  ipcMain.handle('key:scanImageKeyFromMemory', async (event, userDir: string) => {
    if (process.platform !== 'win32' && process.platform !== 'darwin' && process.platform !== 'linux') {
      return { success: false, error: '图片密钥内存扫描不支持当前平台' }
    }
    const dir = String(userDir || '').trim()
    if (dir && dir.startsWith('\\\\')) return { success: false, error: '不支持网络路径' }
    return createImageKeyService().autoGetImageKeyByMemoryScan(
      dir,
      (message) => sendImageKeyStatus(event, message)
    )
  })

  // WCDB
  ipcMain.handle('wcdb:testConnection', (_e, dbPath: string, hexKey: string, wxid: string) => {
    const accountDir = configService?.getAccountDir(String(dbPath || ''), String(wxid || ''))
    if (!accountDir) return Promise.resolve({ success: false, error: '无法解析账号目录（未找到 db_storage/session.db）' })
    return wcdbService.testConnection(accountDir, String(hexKey || ''))
  })

  // 聊天
  ipcMain.handle('chat:connect', () => chatService.connect())
  ipcMain.handle('chat:close', () => {
    chatService.close()
    return { success: true }
  })
  ipcMain.handle('chat:getSessions', () => chatService.getSessions())
  ipcMain.handle('chat:markAllSessionsRead', () => chatService.markAllSessionsRead())
  ipcMain.handle('chat:getContactAvatar', (_e, username: string, chatroomId?: string) =>
    chatService.getContactAvatar(String(username || ''), chatroomId ? String(chatroomId) : undefined))
  ipcMain.handle('chat:enrichSessionsContactInfo', (_e, usernames: string[], options?: any) =>
    chatService.enrichSessionsContactInfo((usernames || []).map(String), options))
  ipcMain.handle('chat:getSessionStatuses', (_e, usernames: string[]) =>
    chatService.getSessionStatuses((usernames || []).map(String)))
  ipcMain.handle('chat:getNewMessages', (_e, sessionId: string, minTime: number, limit?: number) =>
    chatService.getNewMessages(String(sessionId || ''), Number(minTime || 0), limit || 50))

  // 防撤回（WeFlow 式：会话级 WCDB 触发器）
  ipcMain.handle('chat:getAntiRevokeSessions', () => chatService.getAntiRevokeSessions())
  ipcMain.handle('chat:checkAntiRevokeTriggers', (_e, sessionIds: string[]) =>
    chatService.checkAntiRevokeTriggers((sessionIds || []).map(String)))
  ipcMain.handle('chat:installAntiRevokeTriggers', (_e, sessionIds: string[]) =>
    chatService.installAntiRevokeTriggers((sessionIds || []).map(String)))
  ipcMain.handle('chat:uninstallAntiRevokeTriggers', (_e, sessionIds: string[]) =>
    chatService.uninstallAntiRevokeTriggers((sessionIds || []).map(String)))

  // 导出
  ipcMain.handle('export:exportSessions', async (_e, outputRoot: string, formatOrOptions?: any, legacyOptions?: any) => {
    const root = String(outputRoot || '').trim()
    if (!root) return { success: false, successCount: 0, failCount: 1, error: '未指定输出目录' }

    // 兼容两种调用：旧 (outputRoot, format, options) 与新 (outputRoot, options)
    const userOptions: any = typeof formatOrOptions === 'string' ? legacyOptions || {} : formatOrOptions || {}
    const fmt = String(
      userOptions.format || (typeof formatOrOptions === 'string' ? formatOrOptions : '') || 'txt'
    ).trim()
    const formatFolder = EXPORT_FORMAT_FOLDERS[fmt]
    if (!formatFolder) {
      return { success: false, successCount: 0, failCount: 1, error: `不支持的导出格式: ${fmt}` }
    }

    const connectResult = await chatService.connect()
    if (!connectResult.success) {
      return { success: false, successCount: 0, failCount: 1, error: connectResult.error || '数据库连接失败' }
    }

    const sessionsResult = await chatService.getSessions()
    if (!sessionsResult.success || !sessionsResult.sessions) {
      return { success: false, successCount: 0, failCount: 1, error: sessionsResult.error || '获取会话列表失败' }
    }
    const availableSessionIds: string[] = (sessionsResult.sessions as Array<{ username: string }>)
      .map((s) => String(s?.username || '').trim())
      .filter(Boolean)
    const requestedSessionIds: string[] | undefined = Array.isArray(userOptions.sessionIds)
      ? Array.from(new Set((userOptions.sessionIds as unknown[]).map((id) => String(id || '').trim()).filter(Boolean)))
      : undefined
    if (requestedSessionIds && requestedSessionIds.length === 0) {
      return { success: false, successCount: 0, failCount: 0, error: '请至少选择一个会话' }
    }
    if (requestedSessionIds) {
      const available = new Set(availableSessionIds)
      const unknown = requestedSessionIds.filter((id) => !available.has(id))
      if (unknown.length > 0) {
        return {
          success: false,
          successCount: 0,
          failCount: 0,
          error: `所选会话已失效，请刷新会话列表后重试（${unknown.length} 个）`,
        }
      }
    }
    let sessionIds: string[] = requestedSessionIds || availableSessionIds

    // 过滤无消息会话（公众号/广告账号/空聊天室没有消息表，导出会报 -3 游标错误）。
    // 数量查询失败时回退为导出全部。
    try {
      const countsResult = await wcdbService.getSessionMessageCounts(sessionIds)
      if (countsResult.success && countsResult.counts) {
        const withMessages = sessionIds.filter((sid) => Number(countsResult.counts?.[sid] || 0) > 0)
        const skipped = sessionIds.length - withMessages.length
        if (skipped > 0) console.log(`[Weport] 跳过 ${skipped} 个无消息会话`)
        sessionIds = withMessages
      }
    } catch (e) {
      console.warn('[Weport] 会话数量查询失败，导出全部:', e)
    }

    if (sessionIds.length === 0) {
      return { success: true, successCount: 0, failCount: 0, skipped: true, formatFolder }
    }

    const outDir = join(root, formatFolder)
    try {
      mkdirSync(outDir, { recursive: true })
    } catch (e) {
      return { success: false, successCount: 0, failCount: sessionIds.length, error: `创建输出目录失败: ${String((e as Error)?.message || e)}` }
    }

    const taskId = `export-${Date.now()}`
    const control = exportTaskControlService.createControl(taskId, outDir)
    const progressEmitter = (progress: any) => {
      // 进度事件携带 taskId：渲染层靠它执行 export:cancelTask
      mainWindow?.webContents.send('export:progress', { ...progress, taskId })
    }

    // Weport 默认值（与旧版 TXT/JSON 行为一致），用户选项优先
    const exportOptions: any = {
      format: fmt,
      contentType: 'text',
      exportMedia: false,
      exportWriteLayout: 'C',
      exportConflictStrategy: 'overwrite',
      displayNamePreference: 'group-nickname',
      exportPathStyle: 'windows',
      sessionNameWithTypePrefix: true,
      sessionLayout: 'shared',
      ...userOptions,
    }
    if (requestedSessionIds) exportOptions.sessionIds = requestedSessionIds
    // 开启媒体导出时按 WeFlow 语义使用 per-session 布局
    if (exportOptions.exportMedia === true && exportOptions.sessionLayout === 'shared') {
      exportOptions.sessionLayout = 'per-session'
    }

    try {
      exportService.setRuntimeConfig({
        dbPath: configService?.get('dbPath') || '',
        decryptKey: configService?.get('decryptKey') || '',
        myWxid: configService?.get('myWxid') || '',
        resourcesPath: resolveResourcesPath(),
        appPath: app.getAppPath(),
        isPackaged: app.isPackaged,
      })
      const result = await exportService.exportSessions(sessionIds, outDir, exportOptions, progressEmitter, control)
      // 用户取消：清掉本次运行已写出的部分文件/目录，避免残留半截导出
      if (exportTaskControlService.getState(taskId) === 'cancel_requested') {
        const cleanup = await exportTaskControlService.cleanupTask(taskId)
        if (!cleanup.success) {
          console.warn('[Export] 取消后的清理未完全成功:', cleanup.error)
        }
      }
      const when = formatLocalTime()
      // 导出日志仅跟踪 TXT / JSON（旧版格式），其他格式不覆盖这两行
      if (fmt === 'txt' || fmt === 'json') {
        writeExportLog(root, fmt, when, result.successCount || 0, result.failCount || 0)
      }
      return {
        ...result,
        success: result.success && result.failCount === 0,
        formatFolder,
        formatDir: outDir,
        taskId,
      }
    } catch (e) {
      return { success: false, successCount: 0, failCount: sessionIds.length, error: String((e as Error)?.message || e) }
    } finally {
      exportTaskControlService.releaseTask(taskId)
    }
  })
  ipcMain.handle('export:cancelTask', (_e, taskId: string) => {
    const ok = exportTaskControlService.cancelTask(String(taskId || ''))
    return { success: ok }
  })
  ipcMain.handle('export:getExportLog', (_e, outputRoot: string) => readExportLog(String(outputRoot || '')))
  ipcMain.handle('export:clearLibrary', (_e, outputRoot: string) => clearExportLibrary(String(outputRoot || '')))

  // -------------------------------------------------------------------------
  // v0.9 朋友圈（SNS）
  // -------------------------------------------------------------------------
  ipcMain.handle('sns:getTimeline', (_e, limit: number, offset: number, usernames?: string[], keyword?: string, startTime?: number, endTime?: number) =>
    snsService.getTimeline(limit, offset, usernames, keyword, startTime, endTime))
  ipcMain.handle('sns:getSnsUsernames', () => snsService.getSnsUsernames())
  ipcMain.handle('sns:getUserPostCounts', (_e, options?: { preferCache?: boolean; forceRefresh?: boolean }) =>
    snsService.getUserPostCounts(options))
  ipcMain.handle('sns:getExportStats', (_e, options?: { allowTimelineFallback?: boolean; preferCache?: boolean; forceRefresh?: boolean }) =>
    snsService.getExportStats(options))
  ipcMain.handle('sns:getExportStatsFast', () => snsService.getExportStatsFast())
  ipcMain.handle('sns:getUserPostStats', (_e, username: string) => snsService.getUserPostStats(String(username || '')))
  ipcMain.handle('sns:debugResource', (_e, url: string) => snsService.debugResource(String(url || '')))
  ipcMain.handle('sns:proxyImage', (_e, payload: string | { url: string; key?: string | number; skipFailedCache?: boolean }) => {
    const url = typeof payload === 'string' ? payload : payload?.url
    const key = typeof payload === 'string' ? undefined : payload?.key
    const skipFailedCache = typeof payload === 'string' ? undefined : payload?.skipFailedCache
    return snsService.proxyImage(url, key, { skipFailedCache: skipFailedCache === true })
  })
  ipcMain.handle('sns:warmupTimeline', () => snsService.warmupTimeline())
  ipcMain.handle('sns:peekNewestTimeline', () => snsService.peekNewestTimeline())
  ipcMain.handle('sns:downloadImage', async (_e, payload: { url: string; key?: string | number }) => {
    try {
      const { url, key } = payload
      const result = await snsService.downloadImage(url, key)
      if (!result.success || !result.data) {
        return { success: false, error: result.error || '下载图片失败' }
      }
      const ext = (result.contentType || '').split('/')[1] || 'jpg'
      const defaultPath = `SNS_${Date.now()}.${ext}`
      const filters = isVideoUrl(url)
        ? [{ name: 'Videos', extensions: ['mp4', 'mov', 'avi', 'mkv'] }]
        : [{ name: 'Images', extensions: [ext, 'jpg', 'jpeg', 'png', 'webp', 'gif'] }]
      const { filePath, canceled } = await dialog.showSaveDialog(mainWindow!, { defaultPath, filters })
      if (canceled || !filePath) return { success: false, error: '用户已取消' }
      await writeFileAsync(filePath, result.data)
      return { success: true, filePath }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  })
  ipcMain.handle('sns:exportTimeline', async (event, options: any) => {
    const exportOptions = { ...(options || {}) }
    const taskId = normalizeExportTaskId(exportOptions.taskId)
    delete exportOptions.taskId
    const taskControl = taskId
      ? exportTaskControlService.createControl(taskId, String(exportOptions.outputDir || ''))
      : undefined
    try {
      const result = await snsService.exportTimeline(
        exportOptions,
        (progress) => {
          if (!event.sender.isDestroyed()) {
            event.sender.send('sns:exportProgress', progress)
          }
        },
        taskControl,
      )
      return await finalizeExportTaskControlResult(taskId, result)
    } finally {
      if (taskId) exportTaskControlService.releaseTask(taskId)
    }
  })
  ipcMain.handle('sns:selectExportDir', async () => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      properties: ['openDirectory', 'createDirectory'],
      title: '选择导出目录',
    })
    if (result.canceled || !result.filePaths?.[0]) return { canceled: true }
    return { canceled: false, filePath: result.filePaths[0] }
  })
  ipcMain.handle('sns:installBlockDeleteTrigger', () => snsService.installSnsBlockDeleteTrigger())
  ipcMain.handle('sns:uninstallBlockDeleteTrigger', () => snsService.uninstallSnsBlockDeleteTrigger())
  ipcMain.handle('sns:checkBlockDeleteTrigger', () => snsService.checkSnsBlockDeleteTrigger())
  ipcMain.handle('sns:deleteSnsPost', (_e, postId: string) => snsService.deleteSnsPost(String(postId || '')))
  ipcMain.handle('sns:downloadEmoji', (_e, params: { url: string; encryptUrl?: string; aesKey?: string }) =>
    snsService.downloadSnsEmoji(params?.url, params?.encryptUrl, params?.aesKey))
  ipcMain.handle('sns:getCacheMigrationStatus', async () => {
    try {
      const plan = await collectLegacySnsCacheMigrationPlan()
      if (!plan) {
        return { success: true, needed: false, inProgress: snsCacheMigrationInProgress, totalFiles: 0, items: [] }
      }
      return {
        success: true,
        needed: true,
        inProgress: snsCacheMigrationInProgress,
        totalFiles: plan.totalFiles,
        legacyBaseDir: plan.legacyBaseDir,
        currentBaseDir: plan.currentBaseDir,
        items: plan.candidates,
      }
    } catch (error) {
      return { success: false, needed: false, error: String((error as Error)?.message || error || '') }
    }
  })
  ipcMain.handle('sns:startCacheMigration', async (event) => {
    if (snsCacheMigrationInProgress) {
      return { success: false, error: '迁移任务正在进行中' }
    }
    const sender = event.sender
    let lastProgress: SnsCacheMigrationProgressPayload = {
      status: 'running',
      phase: 'copying',
      current: 0,
      total: 0,
      copied: 0,
      skipped: 0,
      remaining: 0,
    }
    const emitProgress = (payload: SnsCacheMigrationProgressPayload) => {
      lastProgress = payload
      if (!sender.isDestroyed()) {
        sender.send('sns:cacheMigrationProgress', payload)
      }
    }
    try {
      const plan = await collectLegacySnsCacheMigrationPlan()
      if (!plan) {
        emitProgress({ status: 'done', phase: 'done', current: 0, total: 0, copied: 0, skipped: 0, remaining: 0, message: '无需迁移' })
        return { success: true, copied: 0, skipped: 0, totalFiles: 0, message: '无需迁移' }
      }
      snsCacheMigrationInProgress = true
      const result = await runLegacySnsCacheMigration(plan, emitProgress)
      return { success: true, ...result }
    } catch (error) {
      const message = String((error as Error)?.message || error || '')
      emitProgress({ ...lastProgress, status: 'error', phase: 'error', message })
      return { success: false, error: message }
    } finally {
      snsCacheMigrationInProgress = false
    }
  })

  // -------------------------------------------------------------------------
  // v0.9 全局分析（确定性统计）
  // -------------------------------------------------------------------------
  ipcMain.handle('analytics:getOverallStatistics', (_e, force?: boolean) => analyticsService.getOverallStatistics(force === true))
  ipcMain.handle('analytics:getContactRankings', (_e, limit?: number, beginTimestamp?: number, endTimestamp?: number, options?: { includeGroupChats?: boolean }) =>
    analyticsService.getContactRankings(limit, beginTimestamp, endTimestamp, { includeGroupChats: options?.includeGroupChats === true }))
  ipcMain.handle('analytics:getTimeDistribution', (_e, force?: boolean) => analyticsService.getTimeDistribution(force === true))
  ipcMain.handle('analytics:getSelfSentDailyDistribution', (_e, beginTimestamp?: number, endTimestamp?: number, force?: boolean) =>
    analyticsService.getSelfSentDailyDistribution(beginTimestamp, endTimestamp, force === true))
  ipcMain.handle('analytics:getExcludedUsernames', () => analyticsService.getExcludedUsernames())
  ipcMain.handle('analytics:setExcludedUsernames', (_e, usernames: string[]) =>
    analyticsService.setExcludedUsernames((usernames || []).map(String)))
  ipcMain.handle('analytics:getExcludeCandidates', (_e, options?: { includeGroupChats?: boolean }) =>
    analyticsService.getExcludeCandidates(options?.includeGroupChats === true))
  ipcMain.handle('analytics:getDailyActivity', (_e, force?: boolean) => analyticsService.getDailyActivity(force === true))
  ipcMain.handle('analytics:getWordFrequency', (_e, limit?: number, force?: boolean) =>
    analyticsService.getWordFrequency(Number(limit) || 60, force === true))
  ipcMain.handle('cache:clearAnalytics', () => analyticsService.clearCache())

  // -------------------------------------------------------------------------
  // v0.9 群聊分析
  // -------------------------------------------------------------------------
  ipcMain.handle('groupAnalytics:getGroupChats', () => groupAnalyticsService.getGroupChats())
  ipcMain.handle('groupAnalytics:getGroupMembers', (_e, chatroomId: string) =>
    groupAnalyticsService.getGroupMembers(String(chatroomId || '')))
  ipcMain.handle('groupAnalytics:getGroupMembersPanelData', (_e, chatroomId: string, options?: { forceRefresh?: boolean; includeMessageCounts?: boolean } | boolean) => {
    const normalizedOptions = typeof options === 'boolean' ? { forceRefresh: options } : options
    return groupAnalyticsService.getGroupMembersPanelData(String(chatroomId || ''), normalizedOptions)
  })
  ipcMain.handle('groupAnalytics:getGroupMessageRanking', (_e, chatroomId: string, limit?: number, startTime?: number, endTime?: number) =>
    groupAnalyticsService.getGroupMessageRanking(String(chatroomId || ''), limit, startTime, endTime))
  ipcMain.handle('groupAnalytics:getGroupActiveHours', (_e, chatroomId: string, startTime?: number, endTime?: number) =>
    groupAnalyticsService.getGroupActiveHours(String(chatroomId || ''), startTime, endTime))
ipcMain.handle('groupAnalytics:getGroupMediaStats', (_e, chatroomId: string, startTime?: number, endTime?: number) =>
    groupAnalyticsService.getGroupMediaStats(String(chatroomId || ''), startTime, endTime))
  ipcMain.handle('groupAnalytics:getGroupActivityHeatmap', (_e, chatroomId: string, startTime?: number, endTime?: number) =>
    groupAnalyticsService.getGroupActivityHeatmap(String(chatroomId || ''), startTime, endTime))
  ipcMain.handle('groupAnalytics:getGroupMemberAnalytics', (_e, chatroomId: string, memberUsername: string, startTime?: number, endTime?: number) =>
    groupAnalyticsService.getGroupMemberAnalytics(String(chatroomId || ''), String(memberUsername || ''), startTime, endTime))
  ipcMain.handle('groupAnalytics:getGroupMemberMessages', (_e, chatroomId: string, memberUsername: string, options?: { startTime?: number; endTime?: number; limit?: number; cursor?: number }) =>
    groupAnalyticsService.getGroupMemberMessages(String(chatroomId || ''), String(memberUsername || ''), options))
  ipcMain.handle('groupAnalytics:exportGroupMembers', (_e, chatroomId: string, outputPath: string) =>
    groupAnalyticsService.exportGroupMembers(String(chatroomId || ''), String(outputPath || '')))
  ipcMain.handle('groupAnalytics:exportGroupMemberMessages', (_e, chatroomId: string, memberUsername: string, outputPath: string, startTime?: number, endTime?: number) =>
    groupAnalyticsService.exportGroupMemberMessages(String(chatroomId || ''), String(memberUsername || ''), String(outputPath || ''), startTime, endTime))

  // -------------------------------------------------------------------------
  // v0.9 年度报告
  // -------------------------------------------------------------------------
  ipcMain.handle('annualReport:getAvailableYears', () =>
    annualReportService.getAvailableYears({
      dbPath: String(configService?.get('dbPath') || ''),
      decryptKey: String(configService?.get('decryptKey') || ''),
      wxid: String(configService?.getMyWxidCleaned() || ''),
    }))
  ipcMain.handle('annualReport:startAvailableYearsLoad', async (event) => {
    const cfg = configService
    if (!cfg) return { success: false, error: '配置服务未就绪' }

    const dbPath = cfg.get('dbPath')
    const decryptKey = cfg.get('decryptKey')
    const wxid = cfg.get('myWxid')
    const cacheKey = buildAnnualReportYearsCacheKey(dbPath, wxid)

    const runningTaskId = annualReportYearsTaskByCacheKey.get(cacheKey)
    if (runningTaskId) {
      const runningTask = annualReportYearsLoadTasks.get(runningTaskId)
      if (runningTask && !runningTask.done) {
        return { success: true, taskId: runningTaskId, reused: true, snapshot: runningTask.snapshot }
      }
      annualReportYearsTaskByCacheKey.delete(cacheKey)
    }

    const taskId = `years_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    const initialSnapshot: AnnualReportYearsProgressPayload = {
      years: [],
      done: false,
      strategy: 'native',
      phase: 'native',
      statusText: '准备使用原生快速模式加载年份...',
    }

    annualReportYearsLoadTasks.set(taskId, {
      cacheKey,
      canceled: false,
      done: false,
      snapshot: { ...initialSnapshot },
      updatedAt: Date.now(),
    })
    annualReportYearsTaskByCacheKey.set(cacheKey, taskId)

    void (async () => {
      try {
        const result = await annualReportService.getAvailableYears({
          dbPath,
          decryptKey,
          wxid,
          onProgress: (progress: any) => {
            if (isYearsLoadCanceled(taskId)) return
            const task = annualReportYearsLoadTasks.get(taskId)
            if (!task) return
            task.snapshot = { ...task.snapshot, ...progress, done: false }
            task.updatedAt = Date.now()
            broadcastAnnualReportYearsProgress(taskId, task.snapshot)
          },
          shouldCancel: () => isYearsLoadCanceled(taskId),
        })

        const canceled = isYearsLoadCanceled(taskId)
        const task = annualReportYearsLoadTasks.get(taskId)
        if (!task) return
        task.snapshot = canceled
          ? { ...task.snapshot, done: true, canceled: true, phase: 'done', statusText: '已取消年份加载' }
          : result.success
            ? {
                years: result.data || [],
                done: true,
                strategy: result.meta?.strategy,
                phase: 'done',
                statusText: result.meta?.statusText || '年份数据加载完成',
              }
            : {
                years: result.data || [],
                done: true,
                error: result.error || '加载年度数据失败',
                strategy: result.meta?.strategy,
                phase: 'done',
                statusText: result.meta?.statusText || '年份数据加载失败',
              }
        task.done = true
        task.updatedAt = Date.now()
        broadcastAnnualReportYearsProgress(taskId, task.snapshot)
      } catch (e) {
        const task = annualReportYearsLoadTasks.get(taskId)
        if (task) {
          task.snapshot = { done: true, error: String(e), phase: 'done', statusText: '年份数据加载失败', years: task.snapshot.years }
          task.done = true
          task.updatedAt = Date.now()
          broadcastAnnualReportYearsProgress(taskId, task.snapshot)
        }
      } finally {
        annualReportYearsTaskByCacheKey.delete(cacheKey)
        annualReportYearsLoadTasks.delete(taskId)
      }
    })()

    return { success: true, taskId, reused: false, snapshot: initialSnapshot }
  })
  ipcMain.handle('annualReport:cancelAvailableYearsLoad', (_e, taskId: string) => {
    const key = String(taskId || '').trim()
    if (!key) return { success: false, error: '任务ID不能为空' }
    const task = annualReportYearsLoadTasks.get(key)
    if (!task) return { success: true }
    task.canceled = true
    annualReportYearsLoadTasks.set(key, task)
    return { success: true }
  })
  ipcMain.handle('annualReport:generateReport', async (_e, year: number) => {
    const cfg = configService
    if (!cfg) return { success: false, error: '配置服务未就绪' }
    return generateAnnualReportInWorker(Number(year) || 0, (progress) => {
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) {
          win.webContents.send('annualReport:progress', progress)
        }
      }
    })
  })
  ipcMain.handle('dualReport:generateReport', async (_e, payload: { friendUsername: string; year: number }) => {
    const cfg = configService
    if (!cfg) return { success: false, error: '配置服务未就绪' }

    const dbPath = cfg.get('dbPath')
    const decryptKey = cfg.get('decryptKey')
    const wxid = cfg.getMyWxidCleaned()
    const logEnabled = cfg.get('logEnabled')
    const friendUsername = payload?.friendUsername
    const year = payload?.year ?? 0
    const excludeWords = cfg.get('wordCloudExcludeWords') || []

    if (!friendUsername) {
      return { success: false, error: '缺少好友用户名' }
    }

    const resourcesPath = resolveResourcesPath()
    const userDataPath = app.getPath('userData')
    const workerPath = join(__dirname, 'dualReportWorker.js')

    return await new Promise((resolve) => {
      const worker = new Worker(workerPath, {
        workerData: { year, friendUsername, dbPath, decryptKey, myWxid: wxid, resourcesPath, userDataPath, logEnabled, excludeWords },
      })

      const cleanup = () => {
        worker.removeAllListeners()
      }

      worker.on('message', async (msg: any) => {
        if (msg && msg.type === 'dualReport:progress') {
          for (const win of BrowserWindow.getAllWindows()) {
            if (!win.isDestroyed()) {
              win.webContents.send('dualReport:progress', msg.data)
            }
          }
          return
        }
        if (msg && (msg.type === 'dualReport:result' || msg.type === 'done')) {
          cleanup()
          void worker.terminate()
          const payload = msg.data ?? msg.result
          // Enrich hero avatars via local head_image pipeline (weport-media://) so
          // header shows instantly instead of slow/expired CDN http fetch.
          if (payload?.success && payload?.data) {
            try {
              const d: any = payload.data
              const candidates = [payload.data.friendUsername, wxid, configService?.getMyWxidCleaned?.() || wxid].filter(Boolean) as string[]
              const enriched: any = await chatService.enrichSessionsContactInfo(candidates as string[], { skipDisplayName: true }).catch(() => null)
              const pick = (u: string): string | undefined => {
                const hit = enriched?.contacts?.[u]?.avatarUrl as string | undefined
                return hit
              }
              const tryLocalize = (url?: string): string | undefined => {
                if (!url) return undefined
                if (url.startsWith('weport-media://')) return url
                try { return (avatarCacheService as any).localUrlOrOriginal?.(url) || url } catch { return url }
              }
              const selfPick = pick(wxid) || pick(String(configService?.getMyWxidCleaned?.() || '')) || d.selfAvatarUrl
              const friendPick = pick(payload.data.friendUsername) || d.friendAvatarUrl
              payload.data.selfAvatarUrl = (selfPick && selfPick.startsWith('http') ? tryLocalize(selfPick) : selfPick) || d.selfAvatarUrl
              payload.data.friendAvatarUrl = (friendPick && friendPick.startsWith('http') ? tryLocalize(friendPick) : friendPick) || d.friendAvatarUrl
              const ensureResolvable = (url?: string) => {
                if (!url || !url.startsWith('weport-media://')) return url
                try { const p = protocolUrlToPath(url); if (p && !existsSync(p)) return undefined } catch {}
                return url
              }
              const selfRes = ensureResolvable(payload.data.selfAvatarUrl)
              const friendRes = ensureResolvable(payload.data.friendAvatarUrl)
              if (selfRes !== payload.data.selfAvatarUrl) payload.data.selfAvatarUrl = selfRes
              if (friendRes !== payload.data.friendAvatarUrl) payload.data.friendAvatarUrl = friendRes
            } catch { /* avatar enrichment failure must not fail report */ }
          }
          resolve(payload)
          return
        }
        if (msg && (msg.type === 'dualReport:error' || msg.type === 'error')) {
          cleanup()
          void worker.terminate()
          resolve({ success: false, error: msg.error || '双人报告生成失败' })
        }
      })

      worker.on('error', (err) => {
        cleanup()
        resolve({ success: false, error: String(err) })
      })

      worker.on('exit', (code) => {
        if (code !== 0) {
          cleanup()
          resolve({ success: false, error: `双人报告线程异常退出: ${code}` })
        }
      })
    })
  })

  ipcMain.handle('annualReport:exportImages', async (_e, payload: { baseDir: string; folderName: string; images: Array<{ name: string; dataUrl: string }> }) => {
    try {
      const { baseDir, folderName, images } = payload
      if (!baseDir || !folderName || !Array.isArray(images) || images.length === 0) {
        return { success: false, error: '导出参数无效' }
      }
      let targetDir = join(String(baseDir), String(folderName))
      if (existsSync(targetDir)) {
        let idx = 2
        while (existsSync(`${targetDir}_${idx}`)) idx++
        targetDir = `${targetDir}_${idx}`
      }
      await mkdirAsync(targetDir, { recursive: true })
      for (const img of images) {
        const dataUrl = img.dataUrl || ''
        const commaIndex = dataUrl.indexOf(',')
        if (commaIndex <= 0) continue
        const base64 = dataUrl.slice(commaIndex + 1)
        const buffer = Buffer.from(base64, 'base64')
        await writeFileAsync(join(targetDir, img.name), buffer)
      }
      return { success: true, dir: targetDir }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  })
  ipcMain.handle('annualReport:captureCurrentWindow', async (event) => {
    try {
      const win = BrowserWindow.fromWebContents(event.sender)
      if (!win || win.isDestroyed()) {
        return { success: false, error: '窗口不可用' }
      }
      const image = await win.webContents.capturePage()
      return { success: true, dataUrl: image.toDataURL(), size: image.getSize() }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  })

  // 通知弹窗（测试）
  ipcMain.handle('notification:showTest', async () => {
    const payload = {
      sessionId: 'weport-test',
      channel: 'message',
      title: 'Weport 测试通知',
      content: '这是一条测试通知 · 弹窗为独立置顶窗口',
      timestamp: Math.floor(Date.now() / 1000),
    }
    await showNotification(payload, { force: true })
    return { success: true }
  })

  // 免打扰自检：「跟随微信消息免打扰」跨四层，任何一层悄悄返回空都表现成
  // 「通知照发且没有报错」。这个通道把每层的中间结果摊开给用户看。
  ipcMain.handle('notification:getMuteReport', () => chatService.getSessionMuteReport())

  // -------------------------------------------------------------------------
  // WeportAI（v0.8 聊天历史分析助手）
  // -------------------------------------------------------------------------
  ipcMain.handle('ai:getSetup', () => weportAiService.getSetup())
  ipcMain.handle('ai:listProviders', () => ({ providers: weportAiService.listProviders() }))
  ipcMain.handle('ai:fetchModels', (_e, input: any) => weportAiService.fetchProviderModels({
    providerId: String(input?.providerId || ''),
    protocol: input?.protocol,
    baseUrl: typeof input?.baseUrl === 'string' ? input.baseUrl : undefined,
    apiKey: typeof input?.apiKey === 'string' ? input.apiKey : undefined,
  }))
  ipcMain.handle('ai:saveProfile', (_e, input: any) => weportAiService.saveProviderProfile(input || {}))
  ipcMain.handle('ai:activateProfile', (_e, id: string) => weportAiService.activateProviderProfile(String(id || '')))
  // 「设置 → AI 服务」：三个功能面各自指向哪个服务。以前只有一个全局默认 +
  // WeClone 私自 activate，见 providerProfiles 里的说明。
  ipcMain.handle('ai:getConsumerAssignments', () => ({
    success: true,
    consumers: weportAiService.getConsumerAssignments(),
    profiles: weportAiService.listProviderProfiles(),
    activeProfileId: weportAiService.getActiveProfileId(),
  }))
  ipcMain.handle('ai:assignConsumer', (_e, consumer: string, profileId: string) =>
    weportAiService.assignConsumerProfile(String(consumer || ''), String(profileId || '')))
  ipcMain.handle('ai:deleteProfile', (_e, id: string) => weportAiService.deleteProviderProfile(String(id || '')))
  ipcMain.handle('ai:testProfile', (_e, input: any) => weportAiService.fetchProviderModels(input || {}))
  ipcMain.handle('ai:setSetup', (_e, patch: any) => {
    weportAiService.updateSetup(patch || {})
    return { success: true }
  })
  ipcMain.handle('ai:listChats', () => ({ chats: weportAiService.listChats() }))
  ipcMain.handle('ai:createChat', (_e, title?: string) => ({ chat: weportAiService.createChat(title) }))
  ipcMain.handle('ai:renameChat', (_e, chatId: string, title: string) => ({
    success: weportAiService.renameChat(String(chatId || ''), String(title || '')),
  }))
  ipcMain.handle('ai:reorderChats', (_e, orderedIds: any) => ({
    success: weportAiService.reorderChats(Array.isArray(orderedIds) ? orderedIds.map(String) : []),
  }))
  ipcMain.handle('ai:deleteChat', (_e, chatId: string) => ({
    success: weportAiService.deleteChat(String(chatId || '')),
  }))
  ipcMain.handle('ai:getChat', (_e, chatId: string) => weportAiService.getChat(String(chatId || '')))
  // 手动压缩：与 runChat 的自动压缩共用 service 侧实现，返回体区分
  // 「已压缩」和「还没到阈值」，面板据此给出不同提示。
  ipcMain.handle('ai:compactChat', (_e, chatId: string) => weportAiService.compactChat(String(chatId || '')))
  // 背景平均亮度：用于「明暗跟随背景」。必须在主进程算 —— 渲染层把
  // weport-media:// 画到 canvas 会被标记为 tainted，getImageData 抛 SecurityError。
  ipcMain.handle('appearance:backgroundLuminance', async (_e, path: string) => {
    if (!backgroundVideoService) return { success: false, luminance: null as number | null }
    const luminance = await backgroundVideoService.meanLuminance(String(path || ''))
    return { success: luminance !== null, luminance }
  })
  ipcMain.handle('ai:listNotes', (_e, chatId: string) => ({ notes: weportAiService.listNotes(String(chatId || '')) }))
  ipcMain.handle('ai:readNoteFile', (_e, chatId: string, path: string) => ({
    content: weportAiService.readNoteFile(String(chatId || ''), String(path || '')),
  }))
  ipcMain.handle('ai:deleteNoteFile', (_e, chatId: string, path: string) => ({
    success: weportAiService.deleteNoteFile(String(chatId || ''), String(path || '')),
  }))
  ipcMain.handle('ai:clearMemory', () => weportAiService.clearMemory())
  ipcMain.handle('ai:getDebugLog', (_e, limit?: number) => ({ lines: weportAiService.getDebugLog(Number(limit) || 300) }))
  ipcMain.handle('ai:clearDebugLog', () => ({ success: weportAiService.clearDebugLog() }))
  ipcMain.handle('ai:listActions', () => ({ actions: weportAiService.getActions() }))
  ipcMain.handle('ai:saveActions', (_e, actions: any) => ({
    success: weportAiService.saveActions(Array.isArray(actions) ? actions : []),
  }))
  ipcMain.handle('ai:send', (_e, chatId: string, text: string) =>
    weportAiService.runChat(String(chatId || ''), String(text || '')))
  ipcMain.handle('ai:abort', (_e, chatId: string) => {
    weportAiService.abort(String(chatId || ''))
    return { success: true }
  })

  // -------------------------------------------------------------------------
  // WeBot（v1.0）：定时任务、运行历史与笔记板
  //
  // 注意：这些**不是**可选的。截图/演示模式会用 override() 覆盖同名通道，因此
  // 少了这段代码时演示截图依然全绿，而真实应用里 WeBot 页面会全部报
  // "No handler registered"。渲染层的 demo 覆盖掩盖了缺失的真实实现。
  // -------------------------------------------------------------------------
  ipcMain.handle('webot:listTasks', () => ensureWeBotService().listTasks())
  ipcMain.handle('webot:createTask', (_e, input: any) => ensureWeBotService().createTask(input || {}))
  ipcMain.handle('webot:updateTask', (_e, id: string, patch: any) => ensureWeBotService().updateTask(String(id || ''), patch || {}))
  ipcMain.handle('webot:deleteTask', (_e, id: string) => ensureWeBotService().deleteTask(String(id || '')))
  ipcMain.handle('webot:runNow', (_e, id: string) => ensureWeBotService().runNow(String(id || '')))
  ipcMain.handle('webot:listRuns', (_e, taskId?: string) => ensureWeBotService().listRuns(taskId ? String(taskId) : undefined))
  ipcMain.handle('webot:listNotes', (_e, options?: any) => ensureWeBotService().listNotes(options || {}))
  ipcMain.handle('webot:getNote', (_e, id: string) => ensureWeBotService().getNote(String(id || '')))
  ipcMain.handle('webot:updateNote', (_e, id: string, patch: any) => ensureWeBotService().updateNote(String(id || ''), patch || {}))
  ipcMain.handle('webot:unreadCount', () => ensureWeBotService().unreadNoteCount())
  ipcMain.handle('webot:clearNotes', () => ensureWeBotService().clearNotes())

  // -------------------------------------------------------------------------
  // 连接器（第三方工具，v1.0）
  //
  // 凭据只进不出：`list` 返回 `····9f2c` 形式的掩码，明文令牌永远不会经 IPC
  // 回到渲染进程，所以界面里的输入框永远是"写一次就空"的。
  // -------------------------------------------------------------------------
  ipcMain.handle('connectors:list', () => connectorsService.list())
  ipcMain.handle('connectors:connect', (_e, id: string, token: string) =>
    connectorsService.connect(String(id || ''), String(token || '')))
  ipcMain.handle('connectors:disconnect', (_e, id: string) => connectorsService.disconnect(String(id || '')))
  ipcMain.handle('connectors:verify', (_e, id: string) => connectorsService.verify(String(id || '')))
  ipcMain.handle('connectors:listTargets', (_e, id: string) => connectorsService.listTargets(String(id || '')))
  ipcMain.handle('connectors:createTask', (_e, id: string, input: any) =>
    connectorsService.createTask(String(id || ''), input || {}))
  ipcMain.handle('connectors:getAgentSettings', () => ({ allowAgentWrite: connectorsService.agentWriteAllowed() }))
  ipcMain.handle('connectors:setAgentSettings', (_e, patch: { allowAgentWrite?: boolean }) => {
    if (typeof patch?.allowAgentWrite === 'boolean') connectorsService.setAgentWriteAllowed(patch.allowAgentWrite)
    return { allowAgentWrite: connectorsService.agentWriteAllowed() }
  })

  // -------------------------------------------------------------------------
  // WeClone（人格克隆）
  //
  // 从 9669dcb 恢复并前移。服务层 weCloneService.ts（1144 行）无需改写即兼容
  // 当前的 provider 层 —— 它用的是 ProviderProfileService / getProviderAdapter
  // 这几个我保留并扩展过的接口。此处只补齐 IPC。
  // -------------------------------------------------------------------------
  const wecloneControllers = new Map<string, AbortController>()
  ipcMain.handle('weclone:generate', async (_e, opts?: { localOnly?: boolean }) => {
    const taskId = 'generate'
    if (wecloneControllers.has(taskId)) return { success: false, error: '克隆生成已在进行中' }
    const ctrl = new AbortController()
    wecloneControllers.set(taskId, ctrl)
    try {
      return await weCloneService.generateClone(
        (progress) => mainWindow?.webContents.send('weclone:progress', progress),
        ctrl.signal
      )
    } finally {
      wecloneControllers.delete(taskId)
    }
  })
  ipcMain.handle('weclone:list', () => weCloneService.getClones())
  ipcMain.handle('weclone:get', (_e, id: string) => weCloneService.getClone(String(id || '')))
  ipcMain.handle('weclone:delete', (_e, id: string) => weCloneService.deleteClone(String(id || '')))
  // 和分身对话：**完全在本机完成**（人格 MD 注入上下文 + 本地检索语料），
  // 没有服务器可转发，也不上传任何东西。返回体带 `hint`，因为最常见的失败
  // （还没生成过克隆、模型 key 不可用）需要具体的下一步指引。
  ipcMain.handle(
    'weclone:chat',
    (_e, cloneId: string, message: string, history?: Array<{ role: string; content: string }>) =>
      weCloneService.chatWithClone({ cloneId: String(cloneId || ''), message: String(message || ''), history })
  )
  ipcMain.handle('weclone:cancel', () => {
    wecloneControllers.get('generate')?.abort()
    weCloneService.cancel()
    return { success: true }
  })
  ipcMain.handle('weclone:getForcedProviderStatus', () => weCloneService.getForcedProviderStatus())
  ipcMain.handle('weclone:ensureProvider', async (_e, payload?: { apiKey?: string }) => {
    const apiKey = payload && typeof payload === 'object' ? String(payload.apiKey || '').trim() : ''
    try {
      await weCloneService.ensureForcedProvider(apiKey || undefined)
      return { success: true, status: weCloneService.getForcedProviderStatus() }
    } catch (e) {
      return { success: false, error: String((e as Error)?.message || e), status: weCloneService.getForcedProviderStatus() }
    }
  })
  ipcMain.handle('weclone:setForcedApiKey', async (_e, payload?: { apiKey?: string }) => {
    const apiKey = payload && typeof payload === 'object' ? String(payload.apiKey || '').trim() : ''
    try {
      await weCloneService.ensureForcedProvider(apiKey || undefined)
      return { success: true, status: weCloneService.getForcedProviderStatus() }
    } catch (e) {
      return { success: false, error: String((e as Error)?.message || e), status: weCloneService.getForcedProviderStatus() }
    }
  })

  // 演示截图模式：用演示数据覆盖会暴露个人信息的通道。
  // 真实 README 截图模式读取隔离副本，不安装这些 IPC 覆盖。
  if (isDemoScreenshotMode) {
    installScreenshotDemoHandlers()
    // v0.9 页面（朋友圈 / 分析 / 设置）也需要演示数据才能渲染截图
    installV09DemoHandlers()
  }
}

// ---------------------------------------------------------------------------
// 截图演示数据（WEPORT_SCREENSHOT_POPUP=1）
// 全部为虚构值：不读取用户配置、不扫描真实微信目录、不调用真实 API。
// config:set 在截图模式下被吞掉，演示数据绝不会落盘污染真实配置。
// ---------------------------------------------------------------------------
const DEMO_DECRYPT_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
const DEMO_DB_PATH = 'D:\\demo\\xwechat_files'
const DEMO_EXPORT_PATH = 'D:\\demo\\weport-export'
const DEMO_WXID = 'wxid_demo'
const DEMO_WORKSPACE = 'D:\\demo\\weport-export\\WeportAI'
const DEMO_CHAT_ID = 'demo-chat-1'

function demoConfigValue(key: string): unknown {
  switch (key) {
    case 'dbPath':
      return DEMO_DB_PATH
    case 'exportPath':
      return DEMO_EXPORT_PATH
    case 'myWxid':
      return DEMO_WXID
    case 'wxidConfigs':
      return { [DEMO_WXID]: { decryptKey: DEMO_DECRYPT_KEY, updatedAt: 0 } }
    case 'lastTab':
      return 'connect'
    // v1.0.1 主题模型：明暗 × 强调色。截图模式据此可以整套切到浅色
    // （capture-ui.ps1 -LightMode），用来验证浅色模式不是只改了背景色。
    case 'appearanceMode':
      return process.env.WEPORT_THEME_MODE === 'light' ? 'light' : 'dark'
    case 'appearanceAccent':
      return process.env.WEPORT_THEME_ACCENT || 'blue'
    // 视频背景自检：给截图模式指定一个背景文件（图片或视频），用来验证
    // <video> 图层真的渲染出来了 —— 这条路径只有真实文件才能跑到。
    case 'appearanceBackgroundPath':
      return process.env.WEPORT_BG_PATH || ''
    case 'appearanceBackgroundDim':
      return 55
    case 'appearanceBackgroundBlur':
      return 0
    case 'colorMode':
      return 'colorful'
    case 'messagePushEnabled':
      return true
    case 'messagePushRespectWechatMute':
      return true
    case 'messagePushFilterMode':
      return 'all'
    case 'messagePushFilterList':
      return []
    case 'notificationFilterMode':
      return 'all'
    case 'notificationFilterList':
      return []
    case 'notificationEnabled':
      return false
    case 'notificationDuration':
      return 3000
    case 'antiRevokeAutoApplyNewGroups':
      return false
    default:
      return (configService as any)?.get(key)
  }
}

function demoAiSetup() {
  const profile = {
    id: 'demo-profile-deepseek',
    name: 'DeepSeek 演示配置',
    displayName: 'DeepSeek 演示配置',
    providerId: 'deepseek',
    protocol: 'openai-compatible',
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-v4-flash',
    hasApiKey: true,
    apiKeyHint: 'sk•••demo',
    // Demo model metadata so screenshot mode exercises the capability chips and
    // the real pricing line (never real user data — these are published rates).
    modelContextWindow: 1000000,
    modelMaxOutputTokens: 384000,
    modelProtocol: 'openai-compatible',
    modelCost: { input: 0.15, output: 0.6, reasoning: 0.6, cacheRead: 0.003 },
    modelCapabilities: { attachment: false, reasoning: true, toolCall: true, chatCapable: true, modalities: { input: ['text'], output: ['text'] } },
    modelReasoningOptions: [{ type: 'toggle' }, { type: 'effort', values: ['low', 'high', 'max'] }],
    modelMetadataSource: 'bundled',
    createdAt: Date.now() - 86400000,
    updatedAt: Date.now(),
    discovery: { models: ['deepseek-v4-flash', 'deepseek-v4-pro'], fetchedAt: Date.now() },
  }
  return {
    hasApiKey: true,
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-v4-flash',
    reasoningEffort: 'high',
    customPrompt: '',
    workspaceRoot: DEMO_WORKSPACE,
    exportPath: DEMO_EXPORT_PATH,
    dbReady: true,
    disabledTools: [],
    activeProfileId: profile.id,
    profiles: [profile],
    catalog: getProviderCatalog(),
  }
}

function demoAiChatData() {
  const now = Date.now()
  const day = 24 * 60 * 60 * 1000
  return {
    chat: {
      id: DEMO_CHAT_ID,
      title: '和家人聊天的总结',
      createdAt: now - 2 * day,
      updatedAt: now - 30 * 60 * 1000,
      sortOrder: 0,
      titleVersion: 2,
    },
    workspaceDir: `${DEMO_WORKSPACE}\\${DEMO_CHAT_ID}`,
    memoryDir: `${DEMO_WORKSPACE}\\memory`,
    messages: [
      {
        id: 'demo-u1',
        role: 'user',
        content: '帮我总结一下最近和家人的聊天，看看有什么值得注意的事情',
        createdAt: now - 30 * 60 * 1000,
      },
      {
        id: 'demo-a1',
        role: 'assistant',
        content: '',
        reasoning:
          '先抽样「一家人」群最近三个时间窗口的消息，了解话题分布；再细读高频话题所在日期，确认值得记录的事件。',
        toolCalls: [
          {
            id: 'demo-t1',
            name: 'sample_session_history',
            args: { username: 'family@chatroom', windows: 3 },
            friendly: '分层抽样会话「一家人」的历史消息',
            ok: true,
            result: '已读取 96 条消息（近 7 天 · 早/中/晚 3 个时间窗口）\n话题分布：出游 31 · 家庭聚餐 24 · 健康提醒 18 · 日常琐事 23',
          },
          {
            id: 'demo-t2',
            name: 'read_session_messages',
            args: { username: 'family@chatroom', start: '2026-08-06', end: '2026-08-08' },
            friendly: '读取会话「一家人」消息（08-06 ~ 08-08）',
            ok: true,
            result: '共 42 条消息。8月7日提及「周末去郊野公园野餐」，妈妈多次提醒「天热注意防暑」……',
          },
        ],
        createdAt: now - 29 * 60 * 1000,
      },
      {
        id: 'demo-a2',
        role: 'assistant',
        content:
          '## 最近与家人的聊天总结\n\n### 值得注意\n\n- **周末出游计划**：8月7日群里商定了周末去郊野公园野餐，人数约 6 人，建议提前确认天气与座位。\n- **健康提醒高频出现**：近一周「注意防暑」「早点休息」出现 18 次，天气炎热时期家人对彼此的健康提醒明显增多。\n- **家庭聚餐**：8月8日有两次聚餐提议，一次成行，一次待定。\n\n### 建议\n\n1. 出游当周记得给群里的长辈带遮阳伞和防晒。\n2. 可以把「周末出游」列入 `notes/出游计划.md`，方便后续跟进。\n3. 我已把近期家庭事件写入 `memory/events.md`，以后追问「这个月家里有什么大事」可以直接命中。',
        createdAt: now - 28 * 60 * 1000,
      },
    ],
    lastRun: {
      usage: {
        totalTokens: 48612,
        promptTokens: 40127,
        completionTokens: 8485,
        reasoningTokens: 3011,
        promptCacheHitTokens: 38121,
      },
      context: { promptTokens: 40127, cacheHitTokens: 38121, lastRequestTokens: 40127, recentRate: 95, contextWindow: 1000000 },
    },
  }
}

function demoAiNotes() {
  const now = Date.now()
  const day = 24 * 60 * 60 * 1000
  return [
    { path: 'memory/events.md', bytes: 1564, mtime: now - 30 * 60 * 1000, scope: 'memory' },
    { path: 'memory/relationships.md', bytes: 842, mtime: now - day, scope: 'memory' },
    { path: 'notes/出游计划.md', bytes: 2310, mtime: now - 2 * day, scope: 'notes' },
  ]
}

function demoAntiRevokeSessions() {
  return [
    { username: 'family@chatroom', displayName: '一家人' },
    { username: 'proj@chatroom', displayName: '项目群 · 产品迭代' },
    { username: 'alumni@chatroom', displayName: '老同学' },
    { username: 'parents@chatroom', displayName: '爸妈' },
    { username: 'wxid_zhangwei', displayName: '张伟' },
    { username: 'wxid_lina', displayName: '李娜' },
    { username: 'trip@chatroom', displayName: '周末郊游小分队' },
    { username: 'daily@chatroom', displayName: '工作日报群' },
  ]
}

function installScreenshotDemoHandlers() {
  // WEPORT_TRACE_AI=1 时把渲染进程实际发出的 ai:* 调用打到 stdout：截图模式里
  // "AI 页面只渲染出空态"这类问题，只有看清调用了哪些通道、拿到了什么才能定位。
  const traceAi = process.env.WEPORT_TRACE_AI === '1'
  const override = (channel: string, handler: (...args: any[]) => unknown) => {
    ipcMain.removeHandler(channel)
    ipcMain.handle(channel, (event, ...args) => {
      if (traceAi && channel.startsWith('ai:')) {
        console.log(`[ai-trace] ${channel} <- ${JSON.stringify(args)}`)
      }
      return handler(event, ...args)
    })
  }
  override('config:get', (_e, key: string) => demoConfigValue(String(key || '')))
  override('config:set', async () => { /* 截图模式不落盘：演示数据绝不写进真实配置 */ })
  override('dbpath:scanWxids', () => [{ wxid: DEMO_WXID, nickname: '演示账号', modifiedTime: 0, avatarUrl: '' }])
  override('chat:connect', () => ({ success: true }))
  override('chat:getAntiRevokeSessions', () => ({ sessions: demoAntiRevokeSessions() }))
  override('chat:checkAntiRevokeTriggers', () => ({
    rows: ['family@chatroom', 'parents@chatroom'].map((sessionId) => ({
      sessionId,
      installed: true,
      success: true,
    })),
  }))
  override('chat:installAntiRevokeTriggers', (e, sessionIds: string[]) => ({
    rows: (sessionIds || []).map((sessionId) => ({ sessionId, success: true })),
  }))
  override('chat:uninstallAntiRevokeTriggers', (e, sessionIds: string[]) => ({
    rows: (sessionIds || []).map((sessionId) => ({ sessionId, success: true })),
  }))
  override('ai:getSetup', () => demoAiSetup())
  override('ai:setSetup', () => ({ success: true }))
  override('ai:listProviders', () => ({ providers: demoAiSetup().catalog }))
  override('ai:fetchModels', () => ({ success: true, models: ['deepseek-v4-flash', 'deepseek-v4-pro'] }))
  override('ai:saveProfile', () => ({ success: true, profile: demoAiSetup().profiles[0] }))
  override('ai:activateProfile', () => ({ success: true }))
  override('ai:deleteProfile', () => ({ success: true }))
  override('ai:testProfile', () => ({ success: true, models: ['deepseek-v4-flash', 'deepseek-v4-pro'] }))
  override('ai:listChats', () => ({ chats: [demoAiChatData().chat] }))
  override('ai:createChat', () => ({ chat: demoAiChatData().chat }))
  override('ai:getChat', () => demoAiChatData())
  override('ai:listNotes', () => ({ notes: demoAiNotes() }))
  override('ai:readNoteFile', () => ({ content: '# 演示笔记\n\n（截图模式演示内容）' }))
  override('ai:deleteNoteFile', () => ({ success: true }))
  override('ai:listActions', () => ({ actions: [] }))
  override('ai:saveActions', () => ({ success: true }))
  override('ai:clearMemory', () => ({ success: true, removed: 0 }))
  override('ai:getDebugLog', () => ({ lines: [] }))
  override('ai:clearDebugLog', () => ({ success: true }))
  override('ai:send', () => ({ success: true }))
  override('ai:abort', () => ({ success: true }))

  // 连接器演示数据：默认给一个"已连接"的 Todoist 卡片，截图里能同时看到状态胶囊、
  // 重新验证/断开按钮和目标列表。令牌只用掩码，绝不出现真实凭据。
  override('connectors:list', () => [
    {
      id: 'todoist',
      descriptor: {
        id: 'todoist',
        name: 'Todoist',
        description: '把 WeportAI 或定时代理整理出来的待办写进 Todoist。',
        authKind: 'token',
        capabilities: { read: true, write: true, hasTargets: true },
        credentialUrl: 'https://app.todoist.com/app/settings/integrations/developer',
        credentialHelp: [
          '打开 Todoist 网页版 → 左下角头像 → 设置 → 集成 → 开发者。',
          '在「API 令牌」下点「复制」，它会复制一整串 40 位十六进制字符。',
          '粘贴到下面的输入框并保存，Weport 会立刻验证一次。',
        ],
        credentialPlaceholder: '粘贴 40 位 API 令牌',
      },
      connected: true,
      credentialHint: '····4f21',
      connectedAt: Date.now() - 7_200_000,
      lastCheck: { at: Date.now() - 600_000, ok: true, accountName: 'Todoist' },
    },
  ])
  override('connectors:getAgentSettings', () => ({ allowAgentWrite: true }))
  override('connectors:setAgentSettings', () => ({ allowAgentWrite: true }))
  override('connectors:verify', () => ({ success: true }))
  override('connectors:disconnect', () => ({ success: true }))
  override('connectors:connect', () => ({ success: true }))
  override('connectors:listTargets', () => ({
    success: true,
    data: [
      { id: '', name: '收件箱（Inbox）', kind: 'inbox' },
      { id: '6X7r8g', name: '工作', kind: 'project' },
      { id: '6X7r9h', name: '家务', kind: 'project' },
      { id: 'label:weport-verify', name: '@weport-verify', kind: 'label' },
    ],
  }))

  // WeBot 演示数据：任务与笔记各一份，用于验证新页面的渲染与布局。
  // 与其余演示数据一样是脱敏、确定性的，且绝不写进真实配置
  // （config:set 在演示模式下被吞掉，这里更是直接返回内存对象）。
  const demoWebBotTask = {
    id: 'task-demo-1',
    title: '化学群作业整理',
    description: '每天扫描 @化学 3 班，把老师布置的作业整理成笔记。',
    schedule: { kind: 'daily' as const, hour: 8, minute: 30 },
    catchUp: 'once' as const,
    enabled: true,
    references: [{ id: 'demo-room@chatroom', label: '化学 3 班', kind: 'group' as const }],
    allowParallel: false,
    createdAt: Date.now() - 86_400_000,
    updatedAt: Date.now() - 3_600_000,
    nextRunAt: Date.now() + 7_200_000,
    lastRunAt: Date.now() - 3_600_000,
  }
  const demoWebBotNote = {
    version: 1 as const,
    id: 'note-demo-1',
    taskId: 'task-demo-1',
    taskTitle: '化学群作业整理',
    runId: 'run-demo-1',
    createdAt: Date.now() - 3_600_000,
    title: '化学群作业整理',
    summary:
      '今天布置的是必修二第三章课后练习 3-5 题，另需预习有机化合物一节。\n老师提醒周三小测，范围是前两章。',
    status: 'ok' as const,
    references: [{ id: 'demo-room@chatroom', label: '化学 3 班', kind: 'group' as const }],
    read: false,
    pinned: false,
  }
  // 三条任务而不是一条：任务列表是「卡片网格」，一条任务时看不出网格是否
  // 真的排开；第二条停用、第三条是每周任务，顺带覆盖停用态与每周排期文案。
  const demoWebBotTask2 = {
    ...demoWebBotTask,
    id: 'task-demo-2',
    title: '家庭群每周摘要',
    description: '每周日晚上把 @一家人 的聊天整理成一段摘要。',
    schedule: { kind: 'weekly' as const, weekday: 0, hour: 21, minute: 0 },
    enabled: false,
    references: [{ id: 'demo-family@chatroom', label: '一家人', kind: 'group' as const }],
    nextRunAt: Date.now() + 3 * 86_400_000,
    lastRunAt: Date.now() - 4 * 86_400_000,
  }
  const demoWebBotTask3 = {
    ...demoWebBotTask,
    id: 'task-demo-3',
    title: '项目群进展跟踪',
    description: '每隔 6 小时看一次 @项目协作 群，把新的进展和待办挑出来。',
    schedule: { kind: 'interval' as const, everyMinutes: 360, anchorMs: 0 },
    references: [{ id: 'demo-work@chatroom', label: '项目协作', kind: 'group' as const }],
    nextRunAt: Date.now() + 540_000,
  }
  override('webot:listTasks', () => [demoWebBotTask, demoWebBotTask2, demoWebBotTask3])
  override('webot:listNotes', () => [demoWebBotNote])
  override('webot:getNote', () => demoWebBotNote)
  override('webot:updateNote', () => demoWebBotNote)
  override('webot:unreadCount', () => 1)
  override('webot:clearNotes', () => 0)
  override('webot:listRuns', () => [
    {
      id: 'run-demo-1',
      taskId: 'task-demo-1',
      taskTitle: '化学群作业整理',
      scheduledAt: Date.now() - 3_630_000,
      startedAt: Date.now() - 3_600_000,
      finishedAt: Date.now() - 3_570_000,
      status: 'ok' as const,
      noteId: 'note-demo-1',
      durationMs: 30_000,
    },
  ])
  override('webot:createTask', () => demoWebBotTask)
  override('webot:updateTask', () => demoWebBotTask)
  override('webot:deleteTask', () => true)
  override('webot:runNow', () => ({ success: true }))
  // 免打扰自检：必须给演示数据。它是 v1.0.1 新加的通道，没有 override 时会打到
  // 真实数据库，把真实会话 id 画进对话框 —— 而截图 harness 正是用它来出图的。
  override('notification:getMuteReport', () => ({
    success: true,
    sessionCount: 8,
    sessionFlagMutedCount: 3,
    mutedCount: 3,
    flagBefore: 3,
    flagAfter: 3,
    unknownStatusCount: 0,
    nativeRawKeyCount: 8,
    foldedCount: 1,
    error: undefined,
    muted: [
      { username: 'daily@chatroom', displayName: '工作日报群', isMuted: true, isFolded: false },
      { username: 'alumni@chatroom', displayName: '老同学', isMuted: true, isFolded: false },
      { username: 'proj@chatroom', displayName: '项目群 · 产品迭代', isMuted: true, isFolded: true },
    ],
    all: [],
    nativeAvailable: true,
    returnedKeyCount: 8,
    returnedKeysSample: ['family@chatroom', 'proj@chatroom', 'alumni@chatroom'],
    missingKeys: 0,
  }))

  // WeClone 演示数据：让「人格克隆」页在截图/转储模式下有内容可渲染。
  // 与其余演示数据一样脱敏且确定。
  const demoClone = {
    id: 'clone-demo-1',
    wxid: 'wxid_demo',
    displayName: '演示分身',
    knowledgeCutoff: '2026-08-31',
    messageCount: 48_210,
    sessionCount: 37,
    chunkCount: 1284,
    generatedAt: new Date(Date.now() - 86_400_000).toISOString(),
    piiHits: 3,
  }
  override('weclone:list', () => ({ success: true, clones: [{ ...demoClone, source: 'local' as const }] }))
  override('weclone:get', () => ({ success: true, clone: demoClone, mds: { profile: '# 演示画像\n\n这是脱敏的演示内容。' } }))
  override('weclone:getForcedProviderStatus', () => ({
    providerId: 'opencode-go',
    baseUrl: 'https://opencode.ai/zen/go/v1',
    model: 'muse-spark-1.2-contributor',
    hasApiKey: false,
    isForced: false,
  }))
  override('weclone:cancel', () => ({ success: true }))
  override('weclone:delete', () => ({ success: true }))
  override('weclone:generate', () => ({ success: false, error: '演示模式不执行克隆生成' }))
}

// ---------------------------------------------------------------------------
// QA v0.9 演示数据 + UI 转储模式（WEPORT_V09_DUMP=1）
// 用脱敏演示数据驱动 朋友圈 / 分析（全局+群聊+年度报告）真实页面渲染，
// 断言关键 DOM 节点存在后把摘要写入 JSON（无头验证 UI 端到端）。
// 与截图模式同一原则：演示数据绝不写进真实配置。
// ---------------------------------------------------------------------------
function demoSnsAvatarUrl(name: string): string {
  const hue = [...name].reduce((acc, ch) => acc + ch.charCodeAt(0), 0) % 360
  return `data:image/svg+xml;utf8,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80"><rect width="80" height="80" rx="12" fill="hsl(${hue},28%,24%)"/><text x="40" y="52" font-size="34" text-anchor="middle" fill="#f4f4f5" font-family="sans-serif">${name.slice(0, 1)}</text></svg>`,
  )}`
}

function demoSnsPosts(): any[] {
  const mk = (over: Record<string, unknown>): any => ({
    id: `demo-${Math.random().toString(36).slice(2, 10)}`,
    tid: `demo-tid-${Math.random().toString(36).slice(2, 10)}`,
    username: 'wxid_zhangwei',
    nickname: '张伟',
    avatarUrl: demoSnsAvatarUrl('张伟'),
    createTime: Math.floor(Date.now() / 1000) - 86400 * 3,
    contentDesc: '',
    type: 1,
    media: [],
    likes: [],
    comments: [],
    rawXml: '',
    ...over,
  })
  return [
    mk({
      username: 'wxid_zhangwei',
      nickname: '张伟',
      createTime: Math.floor(Date.now() / 1000) - 86400 * 2,
      contentDesc: '周末去爬山，山顶的日出真的太美了！\n顺便记录一下这周的运动量 💪',
      location: { country: '中国', city: '杭州', poiName: '北高峰' },
      likes: ['李娜', '王强', '陈晨', '赵敏'],
      comments: [
        { id: 'c1', nickname: '李娜', content: '好美！下次带我一个', refCommentId: '' },
        { id: 'c2', nickname: '王强', content: '你这体能可以啊', refCommentId: '' },
        { id: 'c3', nickname: '赵敏', content: '回复 李娜：一起一起', refCommentId: 'c1', refNickname: '李娜' },
      ],
      media: [
        { url: demoSnsAvatarUrl('山1'), thumb: demoSnsAvatarUrl('山1'), key: '' },
        { url: demoSnsAvatarUrl('山2'), thumb: demoSnsAvatarUrl('山2'), key: '' },
        { url: demoSnsAvatarUrl('山3'), thumb: demoSnsAvatarUrl('山3'), key: '' },
        { url: demoSnsAvatarUrl('山4'), thumb: demoSnsAvatarUrl('山4'), key: '' },
      ],
    }),
    mk({
      username: 'wxid_lina',
      nickname: '李娜',
      createTime: Math.floor(Date.now() / 1000) - 86400 * 5,
      contentDesc: '分享一篇文章：如何高效阅读',
      type: 3,
      linkTitle: '如何高效阅读：一份写给普通人的方法论',
      linkUrl: 'https://example.com/reading',
      media: [{ url: demoSnsAvatarUrl('文'), thumb: demoSnsAvatarUrl('文'), key: '' }],
      likes: ['张伟'],
      comments: [{ id: 'c1', nickname: '张伟', content: '收藏了', refCommentId: '' }],
    }),
    mk({
      username: 'wxid_wangqiang',
      nickname: '王强',
      createTime: Math.floor(Date.now() / 1000) - 86400 * 1,
      contentDesc: '新到的键盘，手感不错 ⌨️',
      media: [{ url: demoSnsAvatarUrl('键'), thumb: demoSnsAvatarUrl('键'), key: '' }],
      likes: ['张伟', '李娜'],
      comments: [],
    }),
    mk({
      username: 'wxid_demo',
      nickname: '我',
      createTime: Math.floor(Date.now() / 1000) - 86400 * 8,
      contentDesc: '（演示）我的动态：v0.9 朋友圈模块',
      likes: ['李娜'],
      comments: [],
      media: [],
    }),
    mk({
      username: 'wxid_chenchen',
      nickname: '陈晨',
      createTime: Math.floor(Date.now() / 1000) - 86400 * 12,
      contentDesc: '深夜加班，窗外灯火通明',
      location: { city: '上海' },
      media: [
        { url: demoSnsAvatarUrl('夜1'), thumb: demoSnsAvatarUrl('夜1'), key: '' },
        { url: demoSnsAvatarUrl('夜2'), thumb: demoSnsAvatarUrl('夜2'), key: '' },
      ],
      likes: [],
      comments: [{ id: 'c1', nickname: '王强', content: '注意身体', refCommentId: '' }],
    }),
  ]
}

function demoAnalyticsData(): Record<string, unknown> {
  const hourly: Record<number, number> = {}
  for (let h = 0; h < 24; h += 1) hourly[h] = Math.round(120 * Math.exp(-((h - 21) ** 2) / 30) + 15)
  const weekday: Record<number, number> = {}
  for (let d = 0; d < 7; d += 1) weekday[d] = 800 + Math.round(300 * Math.sin(d * 1.7) + 300 * Math.cos(d))
  const monthly: Record<string, number> = {}
  for (let m = 1; m <= 12; m += 1) monthly[`${m}月`] = 2200 + Math.round(1200 * Math.sin(m * 0.9))
  const daily: Record<string, number> = {}
  const today = new Date()
  for (let i = 180; i >= 0; i -= 1) {
    const d = new Date(today)
    d.setDate(d.getDate() - i)
    daily[`${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`] = Math.round(40 + 40 * (1 + Math.sin(i * 1.37)) + 20 * (1 + Math.cos(i * 0.41)))
  }
  return {
    stats: {
      totalMessages: 48213,
      textMessages: 32108,
      imageMessages: 8123,
      voiceMessages: 4312,
      videoMessages: 1204,
      emojiMessages: 1921,
      otherMessages: 545,
      sentMessages: 20512,
      receivedMessages: 27701,
      firstMessageTime: Math.floor(new Date('2022-03-14').getTime() / 1000),
      lastMessageTime: Math.floor(Date.now() / 1000),
      activeDays: 1421,
      messageTypeCounts: { 1: 32108, 3: 8123, 34: 4312, 43: 1204, 47: 1921, 49: 545 },
    },
    timeDistribution: { hourlyDistribution: hourly, weekdayDistribution: weekday, monthlyDistribution: monthly },
    selfSent: { unit: 'day', dailyDistribution: daily, totalMessages: 20512, firstMessageTime: 0, lastMessageTime: 0, beginTimestamp: 0, endTimestamp: 0 },
    rankings: [
      { username: 'wxid_lina', displayName: '李娜', avatarUrl: demoSnsAvatarUrl('李娜'), messageCount: 8632, sentCount: 4211, receivedCount: 4421, lastMessageTime: Math.floor(Date.now() / 1000) },
      { username: 'wxid_zhangwei', displayName: '张伟', avatarUrl: demoSnsAvatarUrl('张伟'), messageCount: 7418, sentCount: 3602, receivedCount: 3816, lastMessageTime: Math.floor(Date.now() / 1000) },
      { username: 'wxid_wangqiang', displayName: '王强', avatarUrl: demoSnsAvatarUrl('王强'), messageCount: 5301, sentCount: 2504, receivedCount: 2797, lastMessageTime: Math.floor(Date.now() / 1000) },
      { username: 'wxid_chenchen', displayName: '陈晨', avatarUrl: demoSnsAvatarUrl('陈晨'), messageCount: 4210, sentCount: 2098, receivedCount: 2112, lastMessageTime: Math.floor(Date.now() / 1000) },
      { username: 'wxid_zhaomin', displayName: '赵敏', avatarUrl: demoSnsAvatarUrl('赵敏'), messageCount: 3188, sentCount: 1602, receivedCount: 1586, lastMessageTime: Math.floor(Date.now() / 1000) },
      { username: 'wxid_liuyang', displayName: '刘洋', avatarUrl: demoSnsAvatarUrl('刘洋'), messageCount: 2754, sentCount: 1301, receivedCount: 1453, lastMessageTime: Math.floor(Date.now() / 1000) },
    ],
excluded: ['gh_official_demo'],
    candidates: [
      { username: 'gh_official_demo', displayName: '演示公众号', avatarUrl: '' },
      { username: 'wxid_liuyang', displayName: '刘洋', avatarUrl: demoSnsAvatarUrl('刘洋') },
    ],
    dailyActivity: {
      daily,
      sentDaily: daily,
    },
    wordFrequency: {
      items: [
        { word: '明天', count: 1284 },
        { word: '项目', count: 1105 },
        { word: '方案', count: 942 },
        { word: '会议', count: 861 },
        { word: '版本', count: 743 },
        { word: '发布', count: 689 },
        { word: '测试', count: 632 },
        { word: '代码', count: 590 },
        { word: '客户', count: 552 },
        { word: '需求', count: 521 },
        { word: '问题', count: 498 },
        { word: '工作', count: 475 },
        { word: '周末', count: 441 },
        { word: '吃饭', count: 420 },
        { word: '电影', count: 398 },
        { word: '旅行', count: 385 },
        { word: '健康', count: 366 },
        { word: '读书', count: 342 },
        { word: '跑步', count: 310 },
        { word: '音乐', count: 287 },
        { word: '学习', count: 265 },
        { word: '效率', count: 244 },
        { word: '复盘', count: 230 },
        { word: '目标', count: 205 },
        { word: '季度', count: 188 },
        { word: '汇报', count: 175 },
        { word: 'planning', count: 168 },
        { word: 'release', count: 151 },
        { word: 'family', count: 139 },
        { word: 'health', count: 127 },
        { word: '出差', count: 162 },
        { word: '团建', count: 150 },
        { word: '健身', count: 138 },
        { word: '早睡', count: 126 },
        { word: '沟通', count: 118 },
        { word: '协作', count: 109 },
        { word: '接口', count: 101 },
        { word: '上线', count: 96 },
        { word: '排期', count: 88 },
        { word: '验收', count: 82 },
        { word: '文档', count: 79 },
        { word: '数据', count: 71 },
        { word: '微信', count: 66 },
        { word: '消息', count: 62 },
        { word: '群聊', count: 58 },
        { word: '朋友圈', count: 55 },
        { word: '年度', count: 51 },
        { word: '报告', count: 49 },
        { word: '分析', count: 46 },
        { word: '导出', count: 42 },
        { word: '备份', count: 39 },
        { word: '清理', count: 37 },
        { word: '缓存', count: 34 },
        { word: '升级', count: 31 },
        { word: '稳定', count: 28 },
        { word: '流畅', count: 25 },
        { word: '点赞', count: 22 },
        { word: '评论', count: 19 },
        { word: '转发', count: 16 },
        { word: '早安', count: 14 },
        { word: '晚安', count: 12 },
        { word: '加油', count: 10 },
        { word: '辛苦', count: 9 },
        { word: '感谢', count: 8 },
      ],
      scannedMessages: 48213,
      textMessages: 32108,
    },
  }
}

function demoGroupData(): Record<string, unknown> {
  const member = (username: string, name: string, count: number, isOwner = false, isFriend = true): Record<string, unknown> => ({
    username,
    displayName: name,
    avatarUrl: demoSnsAvatarUrl(name),
    nickname: name,
    alias: '',
    remark: '',
    groupNickname: name,
    isOwner,
    isFriend,
    messageCount: count,
  })
  const members = [
    member('wxid_demo', '我', 1520),
    member('wxid_zhangwei', '张伟', 2301, true),
    member('wxid_lina', '李娜', 1988, false, true),
    member('wxid_wangqiang', '王强', 1204),
    member('wxid_chenchen', '陈晨', 902, false, false),
    member('wxid_zhaomin', '赵敏', 640),
  ]
const hourly: Record<number, number> = {}
  for (let h = 0; h < 24; h += 1) hourly[h] = Math.round(80 * Math.exp(-((h - 20) ** 2) / 40) + 5)
  const heatmap: number[][] = Array.from({ length: 7 }, (_, d) =>
    Array.from({ length: 24 }, (_, h) => {
      const base = Math.round(70 * Math.exp(-((h - 20) ** 2) / 45) + 6)
      return base * (d >= 1 && d <= 5 ? 1 : 0.55) + (Math.random() < 0.25 ? Math.round(Math.random() * 10) : 0)
    }),
  )
  return {
    groups: [
      // messageCount 不能省：列表行渲染的是「{messageCount} 条 · {memberCount} 人」，
      // 少了它就是屏幕上明晃晃的「undefined 条」（placeholder 扫描就是为此加的）。
      { username: 'family@chatroom', displayName: '一家人', memberCount: 6, messageCount: 9163, avatarUrl: demoSnsAvatarUrl('家') },
      { username: 'proj@chatroom', displayName: '项目群 · 产品迭代', memberCount: 18, messageCount: 48211, avatarUrl: demoSnsAvatarUrl('项') },
      { username: 'alumni@chatroom', displayName: '老同学', memberCount: 42, messageCount: 15240, avatarUrl: demoSnsAvatarUrl('同') },
    ],
    members,
    ranking: members.map((m) => ({ member: m, messageCount: m.messageCount as number })),
    activeHours: { hourlyDistribution: hourly },
    activityHeatmap: { data: heatmap, total: 9163 },
    mediaStats: {
      typeCounts: [
        { type: 1, name: '文字', count: 6120 },
        { type: 3, name: '图片', count: 1520 },
        { type: 34, name: '语音', count: 810 },
        { type: 43, name: '视频', count: 215 },
        { type: 47, name: '表情', count: 390 },
        { type: 49, name: '文件', count: 108 },
      ],
      total: 9163,
    },
    memberAnalytics: {
      statistics: {
        totalMessages: 2301,
        sentMessages: 1104,
        receivedMessages: 1197,
        activeDays: 412,
        textMessages: 1601,
        imageMessages: 320,
        voiceMessages: 180,
        videoMessages: 90,
      },
      timeDistribution: hourly,
      commonPhrases: [
        { phrase: '收到', count: 182 },
        { phrase: '好的', count: 156 },
        { phrase: '哈哈', count: 143 },
        { phrase: '辛苦了', count: 96 },
        { phrase: '这个方案不错', count: 51 },
      ],
commonEmojis: [
        { emoji: '😄', count: 88 },
        { emoji: '👍', count: 76 },
        { emoji: '🙏', count: 44 },
        { emoji: '😅', count: 39 },
      ],
      wordCloud: [
        { word: '方案', count: 132 },
        { word: '项目', count: 118 },
        { word: '会议', count: 96 },
        { word: '版本', count: 84 },
        { word: '发布', count: 71 },
        { word: '测试', count: 66 },
        { word: '代码', count: 58 },
        { word: '客户', count: 49 },
        { word: '需求', count: 45 },
        { word: '排期', count: 38 },
        { word: '验收', count: 33 },
        { word: '文档', count: 29 },
        { word: '数据', count: 26 },
        { word: '接口', count: 24 },
        { word: '上线', count: 21 },
        { word: '复盘', count: 18 },
        { word: '效率', count: 16 },
        { word: '沟通', count: 14 },
        { word: '协作', count: 12 },
        { word: '目标', count: 10 },
        { word: '季度', count: 9 },
        { word: '汇报', count: 8 },
        { word: '出差', count: 7 },
        { word: '团建', count: 6 },
        { word: '健身', count: 5 },
        { word: '读书', count: 5 },
        { word: '电影', count: 4 },
        { word: '旅行', count: 4 },
        { word: '音乐', count: 3 },
        { word: '跑步', count: 3 },
        { word: '学习', count: 3 },
        { word: '早睡', count: 2 },
        { word: '周末', count: 2 },
        { word: '吃饭', count: 2 },
        { word: '健康', count: 2 },
        { word: '工作', count: 2 },
        { word: '问题', count: 1 },
        { word: '微信', count: 1 },
        { word: '消息', count: 1 },
        { word: '群聊', count: 1 },
      ],
    },
    memberMessages: {
      messages: Array.from({ length: 12 }, (_, i) => ({
        localId: i,
        createTime: Math.floor(Date.now() / 1000) - i * 3600 * 5,
        parsedContent: ['收到，马上处理', '好的，明天见', '这个方案我再看看', '哈哈笑死', '辛苦大家了'][i % 5],
        localType: 1,
      })),
      hasMore: true,
      nextCursor: 12,
    },
  }
}

/**
 * 双人报告的演示数据（脱敏、确定）。
 *
 * 形状必须和 `dualReportWorker` 的产物一致 —— 缺一个字段，页面上就是一块空白
 * 或者一个 0，而截图断言只会告诉你"非空白"。
 */
function demoDualReport(friendUsername: string, year: number): Record<string, unknown> {
  const heatmap = Array.from({ length: 7 }, (_, day) =>
    Array.from({ length: 24 }, (_, hour) => {
      const base = Math.round(40 * Math.exp(-((hour - 21) ** 2) / 30))
      return base * (day >= 1 && day <= 5 ? 0.7 : 1)
    }),
  )
  const monthly: Record<string, number> = {}
  for (let m = 1; m <= 12; m += 1) monthly[String(m)] = 180 + Math.round(120 * Math.sin(m / 2))
  return {
    year,
    selfName: '我',
    friendUsername,
    friendName: '李娜',
    firstChat: {
      createTime: Date.now() - 400 * 86_400_000,
      createTimeStr: '2023-08-12',
      content: '在吗？想问下上次那个文档你还有吗',
      isSentByMe: false,
    },
    yearFirstChat: {
      createTime: Date.now() - 250 * 86_400_000,
      createTimeStr: '2024-01-01 09:12',
      content: '新年快乐！今年也要一起加油',
      isSentByMe: true,
      friendName: '李娜',
      firstThreeMessages: [
        { content: '新年快乐！今年也要一起加油', isSentByMe: true, createTime: 0, createTimeStr: '09:12' },
        { content: '新年快乐～ 你也是！', isSentByMe: false, createTime: 0, createTimeStr: '09:15' },
        { content: '改天一起吃个饭', isSentByMe: true, createTime: 0, createTimeStr: '09:16' },
      ],
    },
    stats: {
      totalMessages: 12846,
      totalWords: 96234,
      imageCount: 412,
      voiceCount: 168,
      emojiCount: 934,
    },
    topPhrases: [
      { phrase: '好的', count: 412 },
      { phrase: '哈哈哈', count: 356 },
      { phrase: '收到', count: 288 },
      { phrase: '明天见', count: 164 },
      { phrase: '辛苦啦', count: 142 },
      { phrase: '晚安', count: 121 },
    ],
    myExclusivePhrases: [
      { phrase: '我来订票', count: 18 },
      { phrase: '路上小心', count: 14 },
    ],
    friendExclusivePhrases: [
      { phrase: '你吃了没', count: 21 },
      { phrase: '记得带伞', count: 12 },
    ],
    heatmap,
    initiative: { initiated: 6120, received: 6726 },
    response: { avg: 214, fastest: 12, count: 1842 },
    monthly,
    streak: { days: 67, startDate: '2024-03-04', endDate: '2024-05-09' },
  }
}

function demoAnnualReport(year: number): Record<string, unknown> {  const heatmap: number[][] = Array.from({ length: 7 }, () =>
    Array.from({ length: 24 }, () => (Math.random() < 0.55 ? Math.round(Math.random() * 40) : 0)),
  )
  return {
    year,
    totalMessages: 18234,
    totalFriends: 128,
    coreFriends: [
      { username: 'wxid_lina', displayName: '李娜', avatarUrl: demoSnsAvatarUrl('李娜'), messageCount: 3210, sentCount: 1602, receivedCount: 1608 },
      { username: 'wxid_zhangwei', displayName: '张伟', avatarUrl: demoSnsAvatarUrl('张伟'), messageCount: 2804, sentCount: 1411, receivedCount: 1393 },
      { username: 'wxid_wangqiang', displayName: '王强', avatarUrl: demoSnsAvatarUrl('王强'), messageCount: 1988, sentCount: 990, receivedCount: 998 },
      { username: 'wxid_chenchen', displayName: '陈晨', avatarUrl: demoSnsAvatarUrl('陈晨'), messageCount: 1540, sentCount: 762, receivedCount: 778 },
      { username: 'wxid_zhaomin', displayName: '赵敏', avatarUrl: demoSnsAvatarUrl('赵敏'), messageCount: 1123, sentCount: 560, receivedCount: 563 },
    ],
    monthlyTopFriends: Array.from({ length: 12 }, (_, i) => ({
      month: i + 1,
      displayName: ['李娜', '张伟', '王强', '李娜', '张伟', '陈晨', '李娜', '张伟', '王强', '李娜', '张伟', '李娜'][i],
      messageCount: 180 + Math.round(Math.random() * 240),
    })),
    peakDay: { date: `${year}-08-16`, messageCount: 412, topFriend: '李娜', topFriendCount: 120 },
    longestStreak: { friendName: '李娜', days: 67, startDate: `${year}-03-01`, endDate: `${year}-05-06` },
    activityHeatmap: { data: heatmap },
    midnightKing: { displayName: '张伟', count: 88, percentage: 34.2 },
    mutualFriend: { displayName: '李娜', avatarUrl: demoSnsAvatarUrl('李娜'), sentCount: 1602, receivedCount: 1608, ratio: 49.9 },
    socialInitiative: { initiatedChats: 1204, receivedChats: 962, initiativeRate: 55.6, topInitiatedFriend: '李娜', topInitiatedCount: 188 },
    responseSpeed: { avgResponseTime: 96, fastestFriend: '王强', fastestTime: 12 },
    topPhrases: [
      { phrase: '哈哈', count: 612 },
      { phrase: '收到', count: 540 },
      { phrase: '好的', count: 488 },
      { phrase: '可以', count: 402 },
      { phrase: '辛苦了', count: 301 },
      { phrase: '晚安', count: 256 },
      { phrase: '加油', count: 214 },
      { phrase: '在吗', count: 198 },
      { phrase: '周末', count: 176 },
      { phrase: '吃饭', count: 155 },
    ],
    snsStats: { totalPosts: 86, typeCounts: { '1': 62, '3': 12, '15': 9, '5': 3 } },
    lostFriend: { username: 'wxid_liuyang', displayName: '刘洋', avatarUrl: demoSnsAvatarUrl('刘洋'), earlyCount: 412, lateCount: 38, periodDesc: '上半年无话不谈，下半年逐渐沉默' },
  }
}

function installV09DemoHandlers() {
  const override = (channel: string, handler: (...args: any[]) => unknown) => {
    ipcMain.removeHandler(channel)
    ipcMain.handle(channel, handler)
  }

  const posts = demoSnsPosts()
  const authors = Array.from(new Set(posts.map((p) => p.username)))
  const analytics = demoAnalyticsData()
  const group = demoGroupData()
  const avatarMap: Record<string, string> = {
    wxid_zhangwei: demoSnsAvatarUrl('张伟'),
    wxid_lina: demoSnsAvatarUrl('李娜'),
    wxid_wangqiang: demoSnsAvatarUrl('王强'),
    wxid_chenchen: demoSnsAvatarUrl('陈晨'),
    wxid_zhaomin: demoSnsAvatarUrl('赵敏'),
    wxid_liuyang: demoSnsAvatarUrl('刘洋'),
  }
  const nameMap: Record<string, string> = {
    wxid_zhangwei: '张伟',
    wxid_lina: '李娜',
    wxid_wangqiang: '王强',
    wxid_chenchen: '陈晨',
    wxid_zhaomin: '赵敏',
    wxid_liuyang: '刘洋',
    wxid_demo: '我',
  }

  // 基础：解锁页签 + 连接成功
  override('config:get', (_e, key: string) => demoConfigValue(String(key || '')))
  override('config:set', async () => ({ success: true }))
  override('dbpath:scanWxids', () => [{ wxid: DEMO_WXID, nickname: '演示账号', modifiedTime: 0, avatarUrl: '' }])
  override('chat:connect', () => ({ success: true }))
  override('chat:getContactAvatar', (_e, username: string) => ({
    avatarUrl: avatarMap[username] || '',
    displayName: nameMap[username] || username,
  }))
  override('chat:enrichSessionsContactInfo', (_e, usernames: string[]) => {
    // 演示用：若磁盘存在真实头像缓存文件，用真实 weport-media:// URL 驱动
    // Avatar 组件，验证「协议 → 文件」渲染链路（demo 断言检查 naturalWidth）
    let realLocalAvatar = ''
    let debugInfo = ''
    try {
      const avatarDir = join(configService!.getCacheBasePath(), 'avatars')
      const files = readdirSync(avatarDir).filter((f: string) => f.endsWith('.jpg'))
      if (files.length > 0) realLocalAvatar = toProtocolUrl(join(avatarDir, files[0]))
      debugInfo = `dir=${avatarDir} files=${files.length}`
    } catch (e) {
      debugInfo = `err=${String(e)}`
    }
    console.log(`[v09demo] enrich avatar: ${debugInfo} local=${realLocalAvatar.slice(0, 60)}`)
    const contacts: Record<string, { displayName?: string; avatarUrl?: string }> = {}
    for (const u of usernames || []) {
      contacts[u] = {
        displayName: nameMap[u] || u,
        avatarUrl: realLocalAvatar || avatarMap[u] || '',
      }
    }
    return { success: true, contacts }
  })

  // 朋友圈
  const countMap: Record<string, number> = {}
  for (const p of posts) countMap[p.username] = (countMap[p.username] || 0) + 1
  override('sns:getSnsUsernames', () => ({ success: true, usernames: authors }))
  override('sns:getUserPostCounts', () => ({ success: true, counts: countMap }))
  override('sns:getExportStats', () => ({
    success: true,
    data: { totalPosts: posts.length, totalFriends: 4, myPosts: 1 },
  }))
  override('sns:getExportStatsFast', () => ({
    success: true,
    data: { totalPosts: posts.length, totalFriends: 4, myPosts: 1 },
  }))
  override('sns:getUserPostStats', (_e, username: string) => ({
    success: true,
    data: { username, totalPosts: countMap[username] || 0 },
  }))
  override('sns:getTimeline', (_e, limit: number, offset: number, usernames?: string[], keyword?: string) => {
    let list = [...posts]
    if (usernames && usernames.length > 0) list = list.filter((p) => usernames.includes(p.username))
    if (keyword) list = list.filter((p) => String(p.contentDesc || '').includes(keyword) || String(p.nickname || '').includes(keyword))
    list = list.sort((a, b) => b.createTime - a.createTime)
    const page = list.slice(offset, offset + limit)
    return { success: true, timeline: page }
  })
  override('sns:proxyImage', (_e, payload: any) => {
    const url = typeof payload === 'string' ? payload : payload?.url
    if (url?.startsWith('data:')) return { success: true, dataUrl: url }
    return { success: true, dataUrl: demoSnsAvatarUrl('图') }
  })
  override('sns:downloadEmoji', () => ({ success: true, localPath: '' }))
  override('sns:checkBlockDeleteTrigger', () => ({ success: true, installed: true }))
  override('sns:installBlockDeleteTrigger', () => ({ success: true, alreadyInstalled: true }))
  override('sns:uninstallBlockDeleteTrigger', () => ({ success: true }))
  override('sns:deleteSnsPost', () => ({ success: true }))
  override('sns:getCacheMigrationStatus', () => ({ success: true, needed: false, inProgress: false, totalFiles: 0, items: [] }))
  override('sns:startCacheMigration', () => ({ success: true, copied: 0, skipped: 0, totalFiles: 0 }))
  override('sns:selectExportDir', () => ({ canceled: false, filePath: 'D:\\demo\\weport-export' }))
  override('sns:exportTimeline', async () => {
    await new Promise((r) => setTimeout(r, 300))
    return { success: true, filePath: 'D:\\demo\\weport-export\\sns_export.json', postCount: posts.length, mediaCount: 9 }
  })
  override('sns:downloadImage', () => ({ success: false, error: '演示模式' }))
  override('sns:debugResource', () => ({ success: true, status: 200, headers: {} }))

  // 全局分析
  override('analytics:getOverallStatistics', () => ({ success: true, data: analytics.stats }))
  override('analytics:getTimeDistribution', () => ({ success: true, data: analytics.timeDistribution }))
  override('analytics:getSelfSentDailyDistribution', () => ({ success: true, data: analytics.selfSent }))
  override('analytics:getContactRankings', (_e, limit?: number, _begin?: number, _end?: number, options?: { includeGroupChats?: boolean }) => {
    const groupRanking = {
      username: 'family@chatroom',
      displayName: '一家人群聊',
      avatarUrl: demoSnsAvatarUrl('家'),
      messageCount: 9320,
      sentCount: 3810,
      receivedCount: 5510,
      lastMessageTime: Math.floor(Date.now() / 1000),
    }
    const rankings = Array.isArray(analytics.rankings)
      ? analytics.rankings as Array<typeof groupRanking>
      : []
    const data = options?.includeGroupChats ? [groupRanking, ...rankings] : rankings
    return { success: true, data: data.slice(0, Math.max(1, Number(limit) || 20)) }
  })
  override('analytics:getExcludedUsernames', () => ({ success: true, data: analytics.excluded }))
  override('analytics:setExcludedUsernames', (_e, usernames: string[]) => ({ success: true, data: usernames }))
  override('analytics:getExcludeCandidates', () => ({ success: true, data: analytics.candidates }))
  override('analytics:getDailyActivity', () => ({ success: true, data: analytics.dailyActivity }))
  override('analytics:getWordFrequency', (_e, limit?: number) => ({
    success: true,
    data: {
      ...(analytics.wordFrequency as Record<string, unknown>),
      items: ((analytics.wordFrequency as any)?.items || []).slice(0, Number(limit) || 60),
    },
  }))
  override('cache:clearAnalytics', () => ({ success: true }))

  // 群聊分析
  override('groupAnalytics:getGroupChats', () => ({ success: true, data: group.groups }))
  override('groupAnalytics:getGroupMembersPanelData', () => ({ success: true, data: group.members }))
  override('groupAnalytics:getGroupMessageRanking', () => ({ success: true, data: group.ranking }))
override('groupAnalytics:getGroupActiveHours', () => ({ success: true, data: group.activeHours }))
  override('groupAnalytics:getGroupActivityHeatmap', () => ({ success: true, data: group.activityHeatmap }))
  override('groupAnalytics:getGroupMediaStats', () => ({ success: true, data: group.mediaStats }))
  override('groupAnalytics:getGroupMemberAnalytics', () => ({ success: true, data: group.memberAnalytics }))
  override('groupAnalytics:getGroupMemberMessages', () => ({ success: true, data: group.memberMessages }))
  override('groupAnalytics:exportGroupMembers', () => ({ success: true, filePath: 'D:\\demo\\group_members.csv' }))
  override('groupAnalytics:exportGroupMemberMessages', () => ({ success: true, filePath: 'D:\\demo\\member_messages.csv' }))

  // 年度报告
  override('annualReport:startAvailableYearsLoad', (event) => {
    setTimeout(() => {
      if (!event.sender.isDestroyed()) {
        event.sender.send('annualReport:availableYearsProgress', {
          taskId: 'years_demo',
          snapshot: { years: [2024, 2025], done: true, phase: 'done', statusText: '年份数据加载完成' },
        })
      }
    }, 400)
    return { success: true, taskId: 'years_demo', reused: false, snapshot: { years: [2024, 2025], done: true, statusText: '年份数据加载完成' } }
  })
  override('annualReport:cancelAvailableYearsLoad', () => ({ success: true }))
  // 双人报告：没有演示数据时它跑的是真实 worker，而演示配置指向不存在的目录，
  // 于是整页渲染成一片 0 —— 「渲染成功但一个字都没验证到」。这里给一份脱敏的
  // 演示报告，截图才真的能证明布局是活的。
  override('dualReport:generateReport', async (_event, payload: { friendUsername?: string; year?: number }) => {
    await new Promise((r) => setTimeout(r, 400))
    return { success: true, data: demoDualReport(String(payload?.friendUsername || 'wxid_lina'), Number(payload?.year) || 0) }
  })
  override('annualReport:generateReport', async (event, year: number) => {
    for (let i = 1; i <= 4; i += 1) {
      await new Promise((r) => setTimeout(r, 150))
      if (!event.sender.isDestroyed()) {
        event.sender.send('annualReport:progress', { status: `正在统计（${i}/4）…`, progress: i * 25 })
      }
    }
    return { success: true, data: demoAnnualReport(Number(year) || 2025) }
  })
  override('annualReport:exportImages', () => ({ success: true, dir: 'D:\\demo\\年度报告_2025' }))
  override('annualReport:captureCurrentWindow', () => ({ success: true, dataUrl: '', size: [0, 0] }))
}

async function runV09DumpMode() {
  const outDir = process.env.WEPORT_V09_DUMP_OUT || join(app.getPath('temp'), 'weport-v09-dump')
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
  try { mkdirSync(outDir, { recursive: true }) } catch { /* noop */ }
  const logFile = join(outDir, 'v09-dump.log')
  const log = (msg: string) => {
    const line = `${new Date().toISOString()} ${msg}`
    console.log(line)
    try {
      appendFileSync(logFile, line + '\n')
    } catch { /* noop */ }
  }

  installV09DemoHandlers()

  for (let i = 0; i < 40 && mainWindow && mainWindow.webContents.isLoading(); i += 1) {
    await sleep(250)
  }
  await sleep(2500)

  const wc = mainWindow?.webContents
  if (!wc) {
    log('FAIL: 主窗口不存在')
    app.exit(1)
    return
  }

  const waitForSelector = async (selector: string, timeoutMs = 12000): Promise<boolean> => {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const present = await wc.executeJavaScript(
        `document.querySelector(${JSON.stringify(selector)}) !== null`,
      ).catch(() => false)
      if (present) return true
      await sleep(250)
    }
    return false
  }

  const consoleErrors: string[] = []
  const onConsole = (_event: Electron.Event, level: string, message: string) => {
    if (level === 'error') consoleErrors.push(message)
  }
  wc.on('console-message', onConsole as any)

  const results: Record<string, unknown> = { consoleErrors: [] }
  const clickTab = async (label: string) => {
    const r = await wc.executeJavaScript(`
      (() => {
        const buttons = Array.from(document.querySelectorAll('.tab, .rail-item'));
        const b = buttons.find((x) => x.textContent.includes(${JSON.stringify(label)}));
        if (!b) return { ok: false, tabs: buttons.map((x) => x.textContent.trim()) };
        b.click();
        return { ok: true };
      })()
    `)
    await sleep(2200)
    return r
  }
  const dumpDom = async (tag: string, selectors: Record<string, string>) => {
    const payload: Record<string, unknown> = {}
    for (const [key, selector] of Object.entries(selectors)) {
      payload[key] = await wc.executeJavaScript(`
        (() => {
          const nodes = Array.from(document.querySelectorAll(${JSON.stringify(selector)}));
          if (nodes.length === 0) return null;
          if (nodes.length === 1) {
            const t = nodes[0].textContent?.trim().slice(0, 200) ?? '';
            return { count: 1, text: t };
          }
          return { count: nodes.length, first: (nodes[0].textContent || '').trim().slice(0, 120), last: (nodes[nodes.length - 1].textContent || '').trim().slice(0, 120) };
        })()
      `)
    }
    results[tag] = payload
    log(`${tag} = ${JSON.stringify(payload)}`)
  }
  const probe = async () => {
    const p = await wc.executeJavaScript(`
      (() => ({
        reducedMotion: window.matchMedia('(prefers-reduced-motion: reduce)').matches,
        countText: document.querySelector('.v09-stats b')?.textContent ?? null,
        countRect: (() => { const r = document.querySelector('.v09-stats b')?.getBoundingClientRect(); return r ? { t: Math.round(r.top), b: Math.round(r.bottom), w: Math.round(r.width) } : null; })(),
      }))()
    `)
    log(`probe = ${JSON.stringify(p)}`)
    return p
  }

  // 1) 朋友圈页签
  const snsTab = await clickTab('朋友圈')
  log(`snsTab = ${JSON.stringify(snsTab)}`)
  if (!snsTab?.ok) { results.fail = 'sns tab missing'; log('FAIL: 未找到朋友圈页签'); app.exit(1); return }
  await sleep(500)
  await probe()
  await dumpDom('sns', {
    toolbarStats: '.sns-sidebar-stats .v09-stat',
    posts: '.sns-post-item',
    authors: '.sns-author',
    authorCounts: '.sns-author-count',
    antideleteChip: '.sns-sidebar-actions .chip',
    mediaItems: '.sns-media-item',
    linkCards: '.post-link-card',
    likes: '.likes-block',
    comments: '.comment-row',
    location: '.post-location',
    feedEnd: '.sns-feed-end',
  })
  const snsDom = results.sns as Record<string, any>
  const snsOk = (snsDom.posts?.count ?? 0) >= 4 && (snsDom.authors?.count ?? 0) >= 3 && (snsDom.mediaItems?.count ?? 0) >= 3
  log(`sns checks: posts>=4 authors>=3 media>=3 → ${snsOk}`)
  if (!snsOk) { results.fail = 'sns assertions failed'; app.exit(1); return }

  // 1.5) 本地协议头像渲染验证：真实磁盘头像文件经 weport-media:// 渲染
  await sleep(2500)
  const rendererReceived = await wc.executeJavaScript(`
    window.electronAPI.chat.enrichSessionsContactInfo(['wxid_zhangwei']).then((r) => ({ ok: r.success, contact: r.contacts && r.contacts['wxid_zhangwei'] }))
  `)
  log(`rendererReceived = ${JSON.stringify(rendererReceived)}`)
  // 协议本身可用性：直接注入 <img> 加载一个真实缓存头像文件
  const protocolProbe = await wc.executeJavaScript(`
    new Promise((resolve) => {
      const img = new Image();
      const url = ${JSON.stringify(toProtocolUrl('C:/Users/admin/AppData/Roaming/weport/cache/avatars/004fa5c04b39faf3f904896649b08a0057271f93.jpg'))};
      img.onload = () => resolve({ ok: true, naturalWidth: img.naturalWidth, naturalHeight: img.naturalHeight });
      img.onerror = () => resolve({ ok: false, reason: 'img error', url });
      img.src = url;
      setTimeout(() => resolve({ ok: false, reason: 'timeout', url }), 5000);
    })
  `)
  log(`protocolProbe = ${JSON.stringify(protocolProbe)}`)
  results.protocolProbe = protocolProbe
  const avatarRender = await wc.executeJavaScript(`
    (() => {
      const imgs = Array.from(document.querySelectorAll('.sns-author .avatar-image'));
      const srcs = imgs.map((i) => i.getAttribute('src') || '');
      const protocolSrcs = srcs.filter((s) => s.startsWith('weport-media://'));
      if (protocolSrcs.length === 0) {
        return { ok: false, reason: 'no protocol src', allSrcs: srcs.slice(0, 5), authorHtml: (document.querySelector('.sns-author')?.outerHTML || '').slice(0, 400) };
      }
      return new Promise((resolve) => {
        const first = imgs.find((i) => (i.getAttribute('src') || '').startsWith('weport-media://'));
        const check = () => resolve({ ok: !!first && first.naturalWidth > 0, src: (first.getAttribute('src') || '').slice(0, 100), naturalWidth: first.naturalWidth || 0 });
        if (first && first.naturalWidth > 0) check();
        else { first.addEventListener('load', check); first.addEventListener('error', () => resolve({ ok: false, reason: 'img error', naturalWidth: 0 })); setTimeout(() => check(), 6000); }
      });
    })()
  `)
  log(`avatarRender = ${JSON.stringify(avatarRender)}`)
  results.avatarRender = avatarRender
  if (!avatarRender?.ok) { results.fail = 'avatar protocol render failed'; log('FAIL: weport-media:// 头像渲染失败'); app.exit(1); return }

  // 2) 分析页签 → 两个大按钮
  const anaTab = await clickTab('分析')
  log(`anaTab = ${JSON.stringify(anaTab)}`)
  if (!anaTab?.ok) { results.fail = 'analytics tab missing'; log('FAIL: 未找到分析页签'); app.exit(1); return }
  await dumpDom('hub', {
    bigCards: '.analytics-big-card',
    bigTitles: '.analytics-big-title',
    bigIcons: '.analytics-big-icon',
  })
  const hubDom = results.hub as Record<string, any>
  if ((hubDom.bigCards?.count ?? 0) < 4) { results.fail = 'hub cards missing'; log('FAIL: 分析入口未展示四个报告入口'); app.exit(1); return }

  // 3) 全局分析
  await wc.executeJavaScript(`(() => { const b = document.querySelector('.analytics-big-card'); b?.click(); return !!b; })()`)
  await sleep(2600)
  await dumpDom('global', {
    statCards: '.stat-card',
    mediaTypes: '.media-type-cell',
    charts: '.echarts-for-react',
    wordCloudStage: '.analytics-word-cloud__stage',
    rankingControls: '.ranking-limit-segment',
    excludeButton: '.ranking-exclude-btn',
    rankingRows: '.ranking-row',
    rankingNames: '.ranking-name',
    excludeItems: '.exclude-item',
  })
const globalDom = results.global as Record<string, any>
  const globalV095 = await wc.executeJavaScript(`
    (() => {
      const titles = Array.from(document.querySelectorAll('.v09-panel-head h3')).map((x) => x.textContent.trim());
      return {
        radarRemoved: !titles.some((title) => title.includes('交流画像')) && !document.querySelector('[data-chart-type="radar"]'),
        hasCalendar: titles.includes('活跃日历'),
        hasWordCloud: titles.includes('高频词云') && !!document.querySelector('.analytics-word-cloud__stage'),
        cloudInteractive: document.querySelectorAll('.analytics-word-cloud__word').length > 0,
        chartCount: document.querySelectorAll('.echarts-for-react').length,
      };
    })()
  `)
  log(`globalV095 = ${JSON.stringify(globalV095)}`)
  results.globalV095 = globalV095
  const globalOk =
    (globalDom.statCards?.count ?? 0) >= 4 &&
    (globalDom.charts?.count ?? 0) >= 5 &&
    (globalDom.wordCloudStage?.count ?? 0) >= 1 &&
    (globalDom.rankingControls?.count ?? 0) >= 1 &&
    (globalDom.excludeButton?.count ?? 0) >= 1 &&
    (globalDom.rankingRows?.count ?? 0) >= 3 &&
    globalV095?.radarRemoved === true &&
    globalV095?.hasCalendar === true &&
    globalV095?.hasWordCloud === true &&
    globalV095?.cloudInteractive === true
  log(`global checks: summary+charts+ranking+calendar+interactive-cloud+radar-removed → ${globalOk}`)
  if (!globalOk) { results.fail = 'global analytics assertions failed'; log('FAIL: 全局分析断言失败（含 v0.9.5 新增面板）'); app.exit(1); return }

  // 4) 年度报告
  await wc.executeJavaScript(`(() => { const b = document.querySelector('.analytics-page .v09-actions .chip'); b?.click(); return !!b; })()`)
  await waitForSelector('.analytics-big-card')
  await wc.executeJavaScript(`(() => { const cards = document.querySelectorAll('.analytics-big-card'); cards[2]?.click(); return cards.length; })()`)
  await waitForSelector('.annual-year-row .chip')
  await dumpDom('annualYears', { yearChips: '.annual-year-row .chip' })
  const annualYearsDom = results.annualYears as Record<string, any>
  if ((annualYearsDom.yearChips?.count ?? 0) < 2) { results.fail = 'annual years missing'; log('FAIL: 年度报告年份不足'); app.exit(1); return }
  await wc.executeJavaScript(`(() => { const b = document.querySelector('.annual-year-row .chip'); b?.click(); return !!b; })()`)
  await sleep(2400)
  await dumpDom('annual', {
    hero: '.annual-hero',
    heroYear: '.annual-hero-year',
    statCards: '.annual-hero .stat-card',
    friendCards: '.annual-friend-card',
    heatmap: '.annual-report-body .echarts-for-react',
    funSections: '.annual-fun-grid .v09-panel',
    phrases: '.phrase-row',
    snsStats: '.annual-sns-total b',
    exportBtn: '.annual-actions .ghost-btn',
  })
  const annualDom = results.annual as Record<string, any>
  const annualOk =
    (annualYearsDom.yearChips?.count ?? 0) >= 2 &&
    !!annualDom.hero &&
    (annualDom.heroYear?.text ?? '') !== '' &&
    (annualDom.friendCards?.count ?? 0) >= 3 &&
    (annualDom.funSections?.count ?? 0) >= 3 &&
    (annualDom.phrases?.count ?? 0) >= 5
  log(`annual checks: years>=2 hero ok friends>=3 → ${annualOk}`)
  if (!annualOk) { results.fail = 'annual report assertions failed'; app.exit(1); return }

  // 5) 关闭年度报告 → 返回选择 → 群聊分析
  await wc.executeJavaScript(`(() => { const b = Array.from(document.querySelectorAll('.annual-actions .icon-btn-ghost')); b[0]?.click(); return b.length; })()`)
  await sleep(1000)
  await wc.executeJavaScript(`(() => { const cards = document.querySelectorAll('.analytics-big-card'); cards[3]?.click(); return cards.length; })()`)
  await waitForSelector('.dual-report-friend')
  await dumpDom('dualReport', {
    friendRows: '.dual-report-friend',
    yearChips: '.dual-report-year-row .chip',
  })
  const dualDom = results.dualReport as Record<string, any>
  const dualOk = (dualDom.friendRows?.count ?? 0) >= 3 && (dualDom.yearChips?.count ?? 0) >= 2
  log(`dual checks: friends>=3 years>=2 → ${dualOk}`)
  if (!dualOk) { results.fail = 'dual report assertions failed'; log('FAIL: 双人报告入口断言失败'); app.exit(1); return }
  await wc.executeJavaScript(`(() => { const b = document.querySelector('.dual-report-page .annual-actions .chip'); b?.click(); return !!b; })()`)
  await sleep(1000)
  await wc.executeJavaScript(`(() => { const cards = document.querySelectorAll('.analytics-big-card'); cards[1]?.click(); return cards.length; })()`)
  await sleep(2200)
  await dumpDom('groupList', { groups: '.group-item', groupNames: '.group-item-name' })
  const groupListDom = results.groupList as Record<string, any>
  if ((groupListDom.groups?.count ?? 0) < 2) { results.fail = 'group list missing'; log('FAIL: 群聊列表不足'); app.exit(1); return }

  await wc.executeJavaScript(`(() => { const g = document.querySelector('.group-item'); g?.click(); return !!g; })()`)
  await sleep(2600)
  await dumpDom('groupDetail', {
    memberRows: '.group-member-row',
    ownerBadges: '.member-badge.owner',
    memberCounts: '.group-member-count',
    tabs: '.group-tabs .chip',
    memberBar: '.member-bar',
  })
const groupDetailDom = results.groupDetail as Record<string, any>
  const groupOk = (groupDetailDom.memberRows?.count ?? 0) >= 4 && (groupDetailDom.tabs?.count ?? 0) >= 4
  log(`group checks: members>=4 tabs>=4 → ${groupOk}`)
  if (!groupOk) { results.fail = 'group detail assertions failed'; log('FAIL: 群聊详情断言失败'); app.exit(1); return }

  // 5.5) 群聊活跃热力图页签：确认已移除画像雷达
  await wc.executeJavaScript(`(() => { const b = Array.from(document.querySelectorAll('.group-tabs .chip')).find((x) => x.textContent.includes('活跃热力图')); b?.click(); return !!b; })()`)
  await sleep(2200)
  const profileV095 = await wc.executeJavaScript(`
    (() => {
      const titles = Array.from(document.querySelectorAll('.v09-panel-head h3')).map((x) => x.textContent.trim());
      return {
        radarRemoved: !titles.some((title) => title.includes('交流画像')) && !document.querySelector('[data-chart-type="radar"]'),
        hasHeatmap: titles.includes('活跃热力图'),
        chartCount: document.querySelectorAll('.echarts-for-react').length,
      };
    })()
  `)
  log(`profileV095 = ${JSON.stringify(profileV095)}`)
  results.profileV095 = profileV095
  const profileOk = profileV095?.radarRemoved === true && profileV095?.hasHeatmap === true && (profileV095?.chartCount ?? 0) >= 1
  if (!profileOk) { results.fail = 'group profile tab assertions failed'; log('FAIL: 群聊画像页签断言失败'); app.exit(1); return }
  await wc.executeJavaScript(`(() => { const b = Array.from(document.querySelectorAll('.group-tabs .chip')).find((x) => x.textContent.includes('成员')); b?.click(); return !!b; })()`)
  await sleep(1000)

  // 6) 成员画像对话框
  await wc.executeJavaScript(`(() => { const r = document.querySelector('.group-member-row'); r?.click(); return !!r; })()`)
  await sleep(2200)
  await dumpDom('memberDialog', {
    dialog: '.member-dialog',
    dialogStats: '.member-dialog .stat-card',
    phrases: '.member-dialog .phrase-row',
    emojis: '.member-dialog .emoji-tag',
    messages: '.member-msg-row',
    exportBtn: '.member-dialog .ghost-btn',
  })
  const memberDom = results.memberDialog as Record<string, any>
  const memberWordCloudCharts = await wc.executeJavaScript(`
    (() => {
      const titles = Array.from(document.querySelectorAll('.member-dialog .v09-panel-head h3')).map((x) => x.textContent.trim());
      return {
        hasWordCloud: titles.includes('高频词云') && !!document.querySelector('.member-dialog .analytics-word-cloud__stage'),
        cloudInteractive: document.querySelectorAll('.member-dialog .analytics-word-cloud__word').length > 0,
        chartCount: document.querySelectorAll('.member-dialog .echarts-for-react').length,
      };
    })()
  `)
  log(`memberWordCloudV095 = ${JSON.stringify(memberWordCloudCharts)}`)
  results.memberWordCloudV095 = memberWordCloudCharts
  const memberOk =
    !!memberDom.dialog &&
    (memberDom.dialogStats?.count ?? 0) >= 3 &&
    (memberDom.messages?.count ?? 0) >= 5 &&
    memberWordCloudCharts?.hasWordCloud === true &&
    memberWordCloudCharts?.cloudInteractive === true &&
    (memberWordCloudCharts?.chartCount ?? 0) >= 1
  log(`member dialog checks: dialog stats>=3 messages>=5 wordcloud → ${memberOk}`)
  await wc.executeJavaScript(`(() => { const b = document.querySelector('.member-dialog .wp-dialog-head .icon-btn-ghost'); b?.click(); return !!b; })()`)
  await sleep(800)

  // 7) 设置页：色彩主题切换（colorful ↔ mono）+ 主题持久化
  const settingsTab = await clickTab('设置')
  log(`settingsTab = ${JSON.stringify(settingsTab)}`)
  if (!settingsTab?.ok) { results.fail = 'settings tab missing'; log('FAIL: 未找到设置页签'); app.exit(1); return }
  await dumpDom('settings', {
    themeCards: '.theme-card',
    themeChecks: '.theme-card-check',
    startupRows: '.setting-row',
    swatches: '.theme-swatches span',
  })
  const settingsDom = results.settings as Record<string, any>
  if ((settingsDom.themeCards?.count ?? 0) < 2) { results.fail = 'theme cards missing'; log('FAIL: 主题卡片不足 2 个'); app.exit(1); return }
  const themeToggle = await wc.executeJavaScript(`
    (() => {
      const cards = Array.from(document.querySelectorAll('.theme-card'));
      const mono = cards.find((c) => c.textContent.includes('黑白'));
      mono?.click();
      return !!mono;
    })()
  `)
  await sleep(800)
  const themeApplied = await wc.executeJavaScript(`
    (() => ({
      theme: document.documentElement.dataset.theme || null,
      saved: null,
    }))()
  `)
  themeApplied.saved = await wc.executeJavaScript(`window.electronAPI.config.get('colorMode').then((v) => v || null)`)
  log(`themeToggle = ${JSON.stringify(themeToggle)} applied = ${JSON.stringify(themeApplied)}`)
  results.themeApplied = themeApplied
  // 演示模式 config:set 被吞（不落盘），因此只断言主题已应用；保存逻辑由真实模式验证
  if (themeApplied.theme !== 'mono') {
    results.fail = 'theme mono not applied'
    log('FAIL: 黑白主题未生效')
    app.exit(1)
    return
  }
  await wc.executeJavaScript(`(() => { const cards = Array.from(document.querySelectorAll('.theme-card')); const c = cards.find((x) => x.textContent.includes('浅蓝')); c?.click(); return !!c; })()`)
  await sleep(800)
  const themeBack = await wc.executeJavaScript(`document.documentElement.dataset.theme || null`)
  log(`themeBack = ${themeBack}`)
  results.themeBack = themeBack
  if (themeBack !== 'colorful') {
    results.fail = 'theme colorful not restored'
    log('FAIL: 浅蓝主题未恢复')
    app.exit(1)
    return
  }

  // 8) 非全屏布局韧性：缩小窗口后关键布局不得塌陷
  const layoutProbe = async (width: number, height: number) => {
    mainWindow?.setSize(width, height)
    await sleep(700)
    const snsClick = await wc.executeJavaScript(`(() => { const b = Array.from(document.querySelectorAll('.tab, .rail-item')).find((x) => x.textContent.includes('朋友圈')); b?.click(); return !!b; })()`)
    await sleep(1200)
    const sns = await wc.executeJavaScript(`
      (() => {
        const main = document.querySelector('.sns-main');
        const cols = main ? getComputedStyle(main).gridTemplateColumns.split(' ').length : 0;
        const feed = document.querySelector('.sns-feed');
        const sidebar = document.querySelector('.sns-sidebar');
        return { cols, feedW: feed ? Math.round(feed.getBoundingClientRect().width) : 0, sidebarW: sidebar ? Math.round(sidebar.getBoundingClientRect().width) : 0, viewport: window.innerWidth };
      })()
    `)
    const anaClick = await wc.executeJavaScript(`(() => { const b = Array.from(document.querySelectorAll('.tab, .rail-item')).find((x) => x.textContent.trim() === '分析'); b?.click(); return !!b; })()`)
    await sleep(1500)
    const afterAna = await wc.executeJavaScript(`
      (() => {
        const ws = document.querySelector('.workspace');
        const active = document.querySelector('.tab[data-active="true"], .rail-item[data-active="true"]');
        return {
          workspaceText: ws ? (ws.textContent || '').trim().slice(0, 120) : null,
          activeTab: active ? active.textContent.trim() : null,
          bodyText: (document.body.textContent || '').trim().slice(0, 120),
        };
      })()
    `)
    log(`afterAnaClick = ${JSON.stringify(afterAna)}`)
    // 分析模块会记住上次进入的视图（全局/群聊）——若不在入口页，先返回入口
    await wc.executeJavaScript(`(() => {
      const back = Array.from(document.querySelectorAll('.v09-actions .chip, .v09-toolbar .chip')).find((x) => x.textContent.includes('返回选择'));
      back?.click();
      return !!back;
    })()`)
    await sleep(900)
    const cardClick = await wc.executeJavaScript(`(() => { const c = document.querySelector('.analytics-big-card'); c?.click(); return !!c; })()`)
    await sleep(2000)
    const global = await wc.executeJavaScript(`
      (() => {
        const cards = document.querySelectorAll('.analytics-summary-strip .stat-card');
        const n = cards.length;
        const charts = Array.from(document.querySelectorAll('.echarts-for-react')).filter((c) => c.getBoundingClientRect().width > 200).length;
        return {
          statCards: n,
          wideCharts: charts,
          viewport: window.innerWidth,
          globalPresent: !!document.querySelector('.analytics-global'),
          hubPresent: !!document.querySelector('.analytics-hub'),
          loading: !!document.querySelector('.analytics-global .wp-loading'),
          error: document.querySelector('.analytics-global .wp-error') ? (document.querySelector('.analytics-global .wp-error').textContent || '').slice(0, 120) : null,
        };
      })()
    `)
    // v1.0 外壳与 WeBot：断言新的左侧导航确实渲染、且没有把内容挤出横向滚动条。
    // 横向溢出是最容易被忽略的响应式缺陷 —— 它不报错，只是把右侧内容切掉。
    const shell = await wc.executeJavaScript(`
      (() => {
        const rail = document.querySelector('.rail');
        const firstLabel = rail ? rail.querySelector('.rail-item span') : null;
        return {
          railW: rail ? Math.round(rail.getBoundingClientRect().width) : 0,
          items: document.querySelectorAll('.rail-item').length,
          statusChips: document.querySelectorAll('.rail-foot .status-chip').length,
          labelsVisible: firstLabel ? getComputedStyle(firstLabel).display !== 'none' : null,
          viewport: window.innerWidth,
          docOverflow: document.documentElement.scrollWidth - window.innerWidth,
        };
      })()
    `)
    log(`shell@${width} = ${JSON.stringify(shell)}`)

    const webotClick = await wc.executeJavaScript(`(() => { const b = Array.from(document.querySelectorAll('.tab, .rail-item')).find((x) => x.textContent.includes('WeBot')); b?.click(); return !!b; })()`)
    await sleep(1200)
    const webot = await wc.executeJavaScript(`
      (() => {
        // 编辑器默认收起，先点「新建任务」把它展开再量：v1.0 的布局是
        // 「列表占满宽 + 编辑器（展开时）在列表上方」。
        const btn = Array.from(document.querySelectorAll('.webot-toolbar-actions button')).find((x) => x.textContent.includes('新建任务'));
        btn?.click();
        return { opened: !!btn };
      })()
    `)
    await sleep(400)
    const webotLayout = await wc.executeJavaScript(`
      (() => {
        const body = document.querySelector('.webot-body');
        const list = document.querySelector('.webot-list');
        const card = document.querySelector('.webot-card');
        const editor = document.querySelector('.webot-editor');
        const grid = document.querySelector('.webot-editor-grid');
        const title = document.querySelector('.webot-card-title');
        return {
          mounted: !!document.querySelector('.webot'),
          editor: !!editor,
          editorW: editor ? Math.round(editor.getBoundingClientRect().width) : 0,
          bodyW: body ? Math.round(body.getBoundingClientRect().width) : 0,
          gridCols: grid ? getComputedStyle(grid).gridTemplateColumns.split(' ').length : 0,
          listCols: list ? getComputedStyle(list).gridTemplateColumns.split(' ').length : 0,
          cardW: card ? Math.round(card.getBoundingClientRect().width) : 0,
          titleW: title ? Math.round(title.getBoundingClientRect().width) : 0,
          docOverflow: document.documentElement.scrollWidth - window.innerWidth,
        };
      })()
    `)
    log(`webot@${width} = ${JSON.stringify(webot)} opened=${webot.opened} layout=${JSON.stringify(webotLayout)}`)

    return { snsClick, anaClick, cardClick, sns, global, shell, webotClick, webot: webotLayout }
  }
  const medium = await layoutProbe(1000, 680)
  log(`layout@1000 = ${JSON.stringify(medium)}`)
  results.layout1000 = medium
  if (medium.sns.cols !== 2 || medium.sns.sidebarW < 200) {
    results.fail = 'layout 1000px broken'
    log('FAIL: 1000px 宽度下朋友圈布局塌陷')
    app.exit(1)
    return
  }
  if (medium.global.statCards < 3) {
    results.fail = 'layout stat cards broken'
    log('FAIL: 1000px 宽度下统计卡片塌陷')
    app.exit(1)
    return
  }
  // v1.0：新外壳必须真的渲染出来（10 个导航项、3 个全局状态点），且不得产生
  // 横向溢出 —— 后者是最难发现的一类响应式缺陷。
  if (!medium.shell || medium.shell.items < 10 || medium.shell.statusChips < 3) {
    results.fail = 'rail not rendered'
    log(`FAIL: 1000px 宽度下左侧导航未正确渲染 ${JSON.stringify(medium.shell)}`)
    app.exit(1)
    return
  }
  if (medium.shell.docOverflow > 2) {
    results.fail = `horizontal overflow at 1000px (${medium.shell.docOverflow}px)`
    log(`FAIL: 1000px 宽度下出现横向溢出 ${medium.shell.docOverflow}px`)
    app.exit(1)
    return
  }
  // v1.0 WeBot 布局：编辑器展开后必须几乎占满内容宽度（而不是把列表挤成
  // 约 300px 的窄条 —— 那是被修掉的旧两栏布局），并且任务卡片的标题不能被
  // 那排动作按钮压到每行一两个字。
  if (!medium.webot?.mounted || !medium.webot.editor) {
    results.fail = 'webot page did not mount'
    log(`FAIL: WeBot 页面未挂载 ${JSON.stringify(medium.webot)}`)
    app.exit(1)
    return
  }
  if (medium.webot.editorW < medium.webot.bodyW * 0.8) {
    results.fail = 'webot editor not full width'
    log(`FAIL: WeBot 编辑器没有占满内容宽度 ${JSON.stringify(medium.webot)}`)
    app.exit(1)
    return
  }
  if (medium.webot.listCols < 2 || medium.webot.titleW < 60) {
    results.fail = 'webot task list squeezed'
    log(`FAIL: WeBot 任务列表/卡片被压扁 ${JSON.stringify(medium.webot)}`)
    app.exit(1)
    return
  }
  const small = await layoutProbe(930, 640)
  log(`layout@930 = ${JSON.stringify(small)}`)
  results.layout930 = small
  if (small.sns.cols !== 2 || small.sns.sidebarW < 200) {
    results.fail = 'layout 930px broken'
    log('FAIL: 930px 宽度下朋友圈布局塌陷（窗口最小宽度 920 之上应保持双栏）')
    app.exit(1)
    return
  }
  mainWindow?.setSize(1080, 720)

  results.consoleErrors = consoleErrors.slice(0, 20)
  const summary = { ...results, snsOk, globalOk, annualOk, groupOk, memberOk, consoleErrorCount: consoleErrors.length }
  log(`RESULT = ${JSON.stringify(summary)}`)
  try {
    writeFileSync(join(outDir, 'v09-dump.json'), JSON.stringify(summary, null, 2), 'utf8')
  } catch { /* noop */ }
  app.exit(summary.consoleErrorCount > 0 || !(snsOk && globalOk && annualOk && groupOk && memberOk) ? 1 : 0)
}

// ---------------------------------------------------------------------------
// QA 截图模式（capture-ui.ps1 驱动）
// ---------------------------------------------------------------------------
async function runScreenshotMode() {
  const outDir = process.env.WEPORT_SCREENSHOT_OUT || join(app.getPath('temp'), 'weport-screenshots')
  try {
    mkdirSync(outDir, { recursive: true })
  } catch { /* noop */ }

  // 独立于 stdout 的日志文件：CI 上重定向拿不到 GUI 应用的控制台输出，
  // 截图失败时靠这个文件定位（harness 失败分支会打印它的尾部）
  const logFile = join(outDir, 'screenshot.log')
  const log = (...msgs: unknown[]) => {
    const msg = msgs.map((m) => String(m)).join(' ')
    console.log(msg)
    try { appendFileSync(logFile, `${new Date().toISOString()} ${msg}\n`) } catch { /* noop */ }
  }

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
  /** 弹窗玻璃折射管线（live / snapshot / native），由 popup 渲染层自报 */
  let popupGlassState = '(unknown)'
  /** 实时玻璃的行为证据：弹窗后桌面变动前后两帧的平均像素差（0 = 没在动） */
  let popupLiveDelta = -1
  /** 主进程实际推给弹窗的桌面帧数 */
  let popupBackdropFrames = 0
  /** 玻璃 <img> 的 src 在两帧之间是否真的换了（渲染层有没有应用新帧的硬证据） */
  let popupGlassImgChanged = false
  /** 渲染层实际应用到玻璃上的帧序号 vs 主进程最新发出的序号 */
  let popupGlassAppliedSeq = 0
  let popupGlassSentSeq = 0
  /** 两帧 NativeImage 的平均绝对像素差（BGRA，逐字节） */
  const meanAbsDiff = (a: Electron.NativeImage, b: Electron.NativeImage): number => {
    try {
      const bufA = a.toBitmap()
      const bufB = b.toBitmap()
      const n = Math.min(bufA.length, bufB.length)
      if (n === 0) return -1
      let sum = 0
      for (let i = 0; i < n; i += 4) sum += Math.abs(bufA[i] - bufB[i])
      return sum / (n / 4)
    } catch {
      return -1
    }
  }
  // capturePage 在 GPU 负载高时可能永不 resolve，加超时兜底
  const captureWithTimeout = (win: BrowserWindow, ms: number) =>
    Promise.race([
      win.webContents.capturePage(),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), ms)),
    ])

  const isBlank = (buf: Buffer, threshold: number) => {
    if (buf.length < 16) return true
    let min = 255
    let max = 0
    for (let i = 0; i < buf.length; i += 997) {
      const v = buf[i]
      if (v < min) min = v
      if (v > max) max = v
    }
    return max - min < threshold
  }

  // 渲染进程 console 转发：截图模式失败时把主/弹窗渲染器错误打进 stdout，
  // CI 日志可直接定位「空白捕获」是渲染器异常还是采集问题
  const forwardConsole = (wc: Electron.WebContents, label: string) => {
    wc.on('console-message', (e, level, message, line, sourceId) => {
      console.log(`[renderer:${label}] ${message} (${sourceId}:${line})`)
    })
  }

  // Real README captures run against a temporary copy of the user's profile,
  // but the copy can still contain personal names, IDs, paths, messages, and
  // avatars. Mask those values in the page before capture. This is deliberately
  // renderer-side and selector-driven: it preserves layout/chart geometry and
  // never writes a modified copy of the user's database or config.
  const installScreenshotPrivacyMask = async (win: BrowserWindow, label: string) => {
    if (!isRealScreenshotMode || win.isDestroyed()) return
    const selectors = [
      '[data-username]',
      '[data-session-id]',
      '[aria-label*="wxid"]',
      '[title*="wxid"]',
      '.account-item strong',
      '.account-item > div > span',
      '.account-item > span:not(.account-avatar)',
      '.account-name',
      '.account-id',
      '.session-name',
      '.session-id',
      '.session-title',
      '.contact-name',
      '.contact-id',
      '.display-name',
      '.nickname',
      '.username',
      '.wxid',
      '.group-item-name',
      '.group-member-name',
      '.group-detail-title',
      '.member-name',
      '.ranking-name',
      '.export-session-copy strong',
      '.export-session-copy > span',
      '.author-name',
      '.sns-author-name',
      '.post-text',
      '.post-location-text',
      '.comment-user',
      '.comment-content',
      '.likes-text',
      '.annual-friend-name',
      '.annual-monthly-name',
      '.annual-hero .stat-card:last-child .stat-sub',
      '.annual-mutual > div > b',
      '.dual-report-friend-name',
      '.dual-report-friend-id',
      '.media-image',
      '.sns-media-item video',
      '.sns-link-card img',
      '.notification-title',
      '.notification-body',
    ]
    try {
      const installed = await win.webContents.executeJavaScript(
        `(() => {
          const selectors = ${JSON.stringify(selectors)};
          const styleId = '__weport-real-screenshot-privacy-style';
          const className = 'weport-real-screenshot-private';
          const root = document.documentElement;
          if (!root) return false;
          let style = document.getElementById(styleId);
          if (!style) {
            style = document.createElement('style');
            style.id = styleId;
            style.textContent = '.' + className + ', ' + selectors.join(', ') + ' { filter: blur(9px) !important; }';
            document.head.appendChild(style);
          }
          const redact = (node) => {
            if (!(node instanceof Element) || node.classList.contains(className)) return;
            for (const selector of selectors) {
              try {
                if (node.matches(selector)) {
                  node.classList.add(className);
                  break;
                }
              } catch (_) { /* ignore an unsupported selector */ }
            }
          };
          const mark = (node) => {
            if (!node || typeof node.querySelectorAll !== 'function') return;
            redact(node);
            for (const selector of selectors) {
              try { node.querySelectorAll(selector).forEach(redact); } catch (_) { /* noop */ }
            }
          };
          mark(document);
          if (!window.__weportRealScreenshotPrivacyObserver) {
            const observer = new MutationObserver((mutations) => {
              for (const mutation of mutations) {
                for (const node of mutation.addedNodes) mark(node);
              }
            });
            observer.observe(root, { childList: true, subtree: true });
            window.__weportRealScreenshotPrivacyObserver = observer;
          }
          return true;
        })()`,
        true,
      )
      if (!installed) log(`[privacy:${label}] document not ready`)
    } catch (error) {
      log(`[privacy:${label}] mask install failed:`, error)
    }
  }

  // 等待渲染进程加载完成
  for (let i = 0; i < 30; i += 1) {
    if (mainWindow && !mainWindow.webContents.isLoading()) break
    await sleep(250)
  }
  // 截图模式下冻结无限循环动画（如分析入口的浮动图标），否则两帧永不静止
  try {
    await mainWindow?.webContents.executeJavaScript(
      `document.documentElement.classList.add('screenshot-mode'); true`,
      true,
    ).catch(() => false)
  } catch { /* noop */ }
  if (mainWindow) await installScreenshotPrivacyMask(mainWindow, 'main')
  if (mainWindow) forwardConsole(mainWindow.webContents, 'main')
  // 等「找到 N 个账号」之类的 toast 过期 + 字体/首屏稳定，避免入画
  await sleep(4000)

  // 稳定帧捕获：轮询直到画面非空，再隔 400ms 复拍一帧；
  // 两帧 PNG 字节完全一致 = 画面已静止（入场动画/滚动/渐隐/半透明帧都会失败重试）。
  // 这样 README 里的截图永远不会是淡出中的残影帧
  const saveStable = async (win: BrowserWindow, file: string, threshold = 12, maxAttempts = 40) => {
    // 输入框获得焦点时光标闪烁会让两帧永远不一致（CI 软渲染下尤其明显），
    // 拍照前统一失焦
    try {
      await win.webContents.executeJavaScript(
        `(() => { const el = document.activeElement; if (el && typeof el.blur === 'function') el.blur(); return true })()`,
        true,
      ).catch(() => false)
    } catch { /* noop */ }
    let prev: Buffer | null = null
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const image = await captureWithTimeout(win, 8000)
      if (image) {
        const png = image.toPNG()
        if (!isBlank(png, threshold)) {
          if (prev && prev.equals(png)) {
            writeFileSync(join(outDir, file), png)
            console.log(`[screenshot] ${file} saved (attempt ${attempt + 1}, settled)`)
            return true
          }
          prev = png
        }
      }
      await sleep(400)
    }
    console.warn(`[screenshot] ${file} stayed unstable/blank after retries`)
    return false
  }

  /**
   * 单帧非空白保存（不要求两帧相同）。
   *
   * 弹窗玻璃改成实时折射后，"连续两帧完全一致"在设计上就不可能成立 ——
   * saveStable 会一直重试到超时，popup.png 反而永远写不出来。这里只要求非空白；
   * 入场动画在上层已经等过，不会截到淡出的中间帧。
   */
  const saveNonBlank = async (win: BrowserWindow, file: string, threshold = 12, attempts = 6) => {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const image = await captureWithTimeout(win, 8000)
      if (image) {
        const png = image.toPNG()
        if (!isBlank(png, threshold)) {
          writeFileSync(join(outDir, file), png)
          console.log(`[screenshot] ${file} saved (single frame, attempt ${attempt + 1})`)
          return true
        }
      }
      await sleep(400)
    }
    console.warn(`[screenshot] ${file} stayed blank after retries`)
    return false
  }

  const clickTab = (label: string) =>
    (mainWindow?.webContents
      .executeJavaScript(
        `(() => { const b = Array.from(document.querySelectorAll('.tab, .rail-item')).find((el) => el.textContent.includes(${JSON.stringify(label)})); if (b) { b.click(); return true } return false })()`,
        true,
      )
      .catch(() => false) ?? Promise.resolve(false))

  // 输出关键 UI 元素的精确几何（CSS px），供视频演示对齐覆盖层
  const dumpRects = async (file: string, selectors: string[]) => {
    const rects = await mainWindow?.webContents
      .executeJavaScript(
        `(() => {
          const out = {};
          for (const sel of ${JSON.stringify(selectors)}) {
            const els = Array.from(document.querySelectorAll(sel));
            out[sel] = els.map((el) => {
              const r = el.getBoundingClientRect();
              const s = getComputedStyle(el);
              return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), visible: s.display !== 'none' && s.visibility !== 'hidden' };
            });
          }
          return out;
        })()`,
        true,
      )
      .catch(() => null)
    if (rects) {
      try {
        writeFileSync(join(outDir, file), JSON.stringify(rects, null, 1), 'utf8')
      } catch { /* noop */ }
    }
  }

  const waitForDom = (selector: string, tries = 40) => {
    const check = () =>
      (mainWindow?.webContents
        .executeJavaScript(`!!document.querySelector(${JSON.stringify(selector)})`, true)
        .catch(() => false) ?? Promise.resolve(false))
    return (async () => {
      for (let i = 0; i < tries; i += 1) {
        if (await check()) return true
        await sleep(250)
      }
      return false
    })()
  }

  // 1) 连接页（演示数据：假路径 / 假密钥 / 演示账号，无任何真实个人信息）
  if (mainWindow && !mainWindow.isDestroyed()) {
    try {
      // 视频背景会让每一帧都不一样，后面的 saveStable 永远等不到"连续两帧相同"。
      // 先读出它的状态（证明它真的在播），再暂停，之后所有截图才能稳定。
      if (process.env.WEPORT_BG_PATH) {
        const bgState = await mainWindow.webContents
          .executeJavaScript(
            `(() => {
               const v = document.querySelector('.app-bg video');
               return v ? { readyState: v.readyState, paused: v.paused, currentTime: v.currentTime, w: v.videoWidth } : null;
             })()`,
            true,
          )
          .catch(() => null)
        log(`[screenshot] initial video background = ${JSON.stringify(bgState)}`)
        await mainWindow.webContents
          .executeJavaScript(`(() => { const v = document.querySelector('.app-bg video'); if (v) v.pause(); return !!v; })()`, true)
          .catch(() => false)
        await sleep(400)
      }
      await saveStable(mainWindow, 'main.png')
      await dumpRects('main-rects.json', [
        '.tab', '.rail-item', '.primary-btn', '.account-item', '.callout', '.toast', '.path-input', '.checklist',
      ])
    } catch (e) {
      log('WARN [screenshot] main capture failed:', e)
    }
  }

  // 2) 导出数据页
  if (mainWindow && !mainWindow.isDestroyed()) {
    try {
      await clickTab('导出数据')
      if (await waitForDom('.format-grid')) {
        await sleep(500)
        const scopePopupOpened = await mainWindow.webContents
          .executeJavaScript(
            `(() => { const trigger = document.querySelector('.export-scope-trigger'); if (!trigger) return false; trigger.click(); return true })()`,
            true,
          )
          .catch(() => false)
        const scopePopupReady = scopePopupOpened && await waitForDom('.export-session-popover', isRealScreenshotMode ? 120 : 40)
        if (scopePopupReady) {
          await dumpRects('export-scope-rects.json', ['.export-scope-trigger', '.export-session-popover'])
          await mainWindow.webContents
            .executeJavaScript(
              `(() => { const close = document.querySelector('[aria-label="关闭导出范围菜单"]'); close?.click(); return !!close })()`,
              true,
            )
            .catch(() => false)
        } else {
          log('FAIL [screenshot] 导出范围弹出菜单未打开')
        }
        await saveStable(mainWindow, 'export.png')
        await dumpRects('export-rects.json', [
          '.format-chip.layout-chip', '.format-grid .format-chip', '.media-check',
          '.opt-panel .seg', '.export-meta .row', '.progress', '.primary-btn.block',
        ])
        // 滚动到底部，捕获导出按钮 + 进度条区域（export-bottom.png + 滚动值）
        const scrollTop = await mainWindow.webContents
          .executeJavaScript(
            `(() => { const ws = document.querySelector('.workspace'); if (!ws) return 0; ws.scrollTop = ws.scrollHeight; return Math.round(ws.scrollTop) })()`,
            true,
          )
          .catch(() => 0)
        await sleep(600)
        await saveStable(mainWindow, 'export-bottom.png')
        try {
          writeFileSync(join(outDir, 'export-scroll.json'), JSON.stringify({ scrollTop }), 'utf8')
        } catch { /* noop */ }
        await dumpRects('export-bottom-rects.json', ['.primary-btn.block', '.progress', '.export-meta .row'])
      } else {
        log('WARN [screenshot] export tab did not render')
      }
    } catch (e) {
      log('WARN [screenshot] export capture failed:', e)
    }
  }

  // 3) 防撤回页（演示会话 + 已安装状态）
  if (mainWindow && !mainWindow.isDestroyed()) {
    try {
      await clickTab('防撤回')
      if (await waitForDom('.anti-revoke-list')) {
        await sleep(500)
        await saveStable(mainWindow, 'antirecall.png')
        await dumpRects('antirecall-rects.json', [
          '.anti-revoke-list .account-item', '.anti-revoke-list .badge',
          '.panel-head .primary-btn', '.count-pill',
        ])
      } else {
        log('WARN [screenshot] antirecall tab did not render')
      }
    } catch (e) {
      log('WARN [screenshot] antirecall capture failed:', e)
    }
  }

  // 4) 消息通知页（打开监听开关 → 绿色呼吸状态点）
  if (mainWindow && !mainWindow.isDestroyed()) {
    try {
      await clickTab('消息通知')
      // 等待条件改成「通知设置行已渲染」。v1.0 移除了重复页面标题的卡片头和
      // 复述左侧栏状态的 .checklist 面板（同一事实在一屏里出现两次没有价值），
      // 因此旧选择器不再存在。
      if (await waitForDom('.notification-settings .setting-row, .setting-row')) {
        mainWindow.webContents.executeJavaScript(
          `(() => { const s = document.querySelector('.switch-label input'); if (s && !s.checked) { s.click(); return true } return false })()`,
          true,
        )
        await waitForDom('.status-dot.listening')
        // 呼吸动画会破坏「两帧一致」稳定判定：截图前临时禁用
        mainWindow.webContents.executeJavaScript(
          `(() => { const st = document.createElement('style'); st.textContent = '.status-dot.listening { animation: none !important; box-shadow: 0 0 0 4px rgba(159,232,168,0.25) !important; }'; document.head.appendChild(st); return true })()`,
          true,
        )
        await sleep(1500)
        const notifScroll = await mainWindow.webContents
          .executeJavaScript(`(() => { const ws = document.querySelector('.workspace'); return ws ? ws.scrollTop : -1 })()`, true)
          .catch(() => -1)
        console.log(`[screenshot] notifications scrollTop=${notifScroll}`)
        await saveStable(mainWindow, 'notifications.png')
        await dumpRects('notifications-rects.json', [
          '.switch-label', '.status-dot', '.setting-row', '.btn-row',
        ])
      } else {
        log('WARN [screenshot] notifications tab did not render')
      }
    } catch (e) {
      log('WARN [screenshot] notifications capture failed:', e)
    }
  }

  // 5) WeportAI 页（演示会话由截图演示处理器注入，含工具调用与笔记面板）
  if (mainWindow && !mainWindow.isDestroyed()) {
    try {
      await clickTab('WeportAI')
      const probe = () =>
        mainWindow?.webContents
          .executeJavaScript(`1 + 1`, true)
          .then((v) => v === 2)
          .catch(() => false)
      // CI 上该面板首次挂载可能让渲染进程忙很久（软渲染），放宽等待
      const shellMounted = await waitForDom('.ai-shell', 100)
      const messageMounted = shellMounted && await waitForDom('.ai-msg', 100)
      // A real profile may have no AI conversation/provider yet. The shell is
      // still the user's actual WeportAI screen and is a valid README capture.
      const mounted = shellMounted && (messageMounted || isRealScreenshotMode)
      log(`[screenshot] AI tab shell=${shellMounted} messages=${messageMounted} mounted=${mounted} rendererProbe=${await probe()}`)
      if (mounted) {
        await sleep(500)
        const ok = await saveStable(mainWindow, 'ai.png', 12, 30)
        if (!ok) {
          log('WARN [screenshot] ai.png first attempt failed, remounting AI panel...')
          await clickTab('设置')
          await sleep(800)
          await clickTab('WeportAI')
          if ((await waitForDom('.ai-shell', 100)) && (await waitForDom('.ai-msg', 100))) {
            await sleep(500)
            await saveStable(mainWindow, 'ai.png', 12, 30)
          }
        }
        await dumpRects('ai-rects.json', [
          '.ai-input', '.ai-send', '.ai-chat-item', '.ai-ws-note', '.ai-ws-usage', '.ai-msg', '.ai-ws-body',
        ])
      } else {
        log('WARN [screenshot] AI tab did not render')
        // 注意：executeJavaScript 解析的是纯 JS —— 字符串里不能带 TS 类型注解，
        // 否则探针本身报 SyntaxError（曾把真实原因掩盖成页面脚本错误）
        const aiState = await mainWindow?.webContents
          .executeJavaScript(
            `(() => {
              const tab = Array.from(document.querySelectorAll('.tab, .rail-item')).find((el) => el.textContent.includes('WeportAI'))
              const workspace = document.querySelector('.workspace')
              const active = document.querySelector('.tab[data-active="true"], .rail-item[data-active="true"]')
              return JSON.stringify({
                tabFound: !!tab,
                tabDisabled: tab ? tab.disabled : null,
                activeTab: active ? (active.textContent || '').trim() : null,
                wsChildren: workspace ? Array.from(workspace.children).map((c) => (c.className || c.tagName).toString()).slice(0, 4) : null,
                wsText: workspace ? (workspace.textContent || '').slice(0, 120) : null
              })
            })()`,
            true,
          )
          .catch(() => 'eval-failed')
        log('WARN [screenshot] AI tab state:', aiState)
      }
    } catch (e) {
      log('WARN [screenshot] AI capture failed:', e)
    }
  }

  // 6) 通知弹窗（persistent：卡片不自动淡出，稳定帧捕获必然拿到完整不透明卡片）
  try {
    let payload = {
      sessionId: 'family@chatroom',
      channel: 'message',
      title: '一家人 · Max Shuang',
      content: '晚上一起吃饭？6 点老地方见',
      avatarUrl: process.env.WEPORT_SCREENSHOT_AVATAR_URL || '',
      timestamp: Math.floor(Date.now() / 1000),
      persistent: true,
    }
    if (isRealScreenshotMode) {
      // Use the latest real session/message when the isolated profile can
      // connect. The privacy mask below protects the rendered values.
      try {
        const connected = await chatService.connect()
        if (connected.success) {
          const sessionsResult = await chatService.getSessions()
          const candidate = (sessionsResult.sessions || []).find((session: any) =>
            String(session?.username || '').trim() && Number(session?.messageCountHint || 0) > 0,
          ) || (sessionsResult.sessions || []).find((session: any) => String(session?.username || '').trim())
          if (candidate) {
            const sessionId = String(candidate.username)
            const messagesResult = await wcdbService.getMessages(sessionId, 1, 0)
            const latest = messagesResult.messages?.[0]
            const content = String(latest?.parsedContent || latest?.content || latest?.rawContent || candidate.summary || '').trim()
            payload = {
              ...payload,
              sessionId,
              title: String(candidate.displayName || sessionId),
              content: content.slice(0, 160) || '最新消息',
              avatarUrl: String(candidate.avatarUrl || ''),
              timestamp: Number(latest?.createTime || candidate.lastTimestamp || payload.timestamp),
            }
          }
        }
      } catch (error) {
        log('[screenshot] real notification data unavailable; using neutral fallback:', error)
      }
    }
    // 主进程预热真实头像（带微信 UA/Referer），保证渲染进程必命中缓存，头像不会缺失
    if (payload.avatarUrl) {
      try {
        const { net } = require('electron')
        const warm = net.request({
          url: payload.avatarUrl,
          headers: {
            'User-Agent':
              'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/107.0.0.0 Safari/537.36 MicroMessenger/7.0.20.1781(0x6700143B) WindowsWechat(0x63090719) XWEB/8351',
            Referer: 'https://servicewechat.com/',
          },
        })
        warm.on('response', () => warm.abort())
        warm.on('error', () => { /* noop */ })
        warm.end()
      } catch { /* noop */ }
      await sleep(1200)
    }
    await showNotification(payload, { force: true })
    const popup = BrowserWindow.getAllWindows().find((w) => w !== mainWindow && !w.isDestroyed())
    if (popup) {
      // 内容保护会排除该窗口被采集（含 capturePage），截图模式临时关闭。
      // 同时接管主进程侧的开关：实时玻璃会在可见期把保护重新打开，否则这里只能
      // 截到空白帧。
      suppressLiveGlassProtection(true)
      try {
        popup.setContentProtection(false)
      } catch { /* noop */ }
      forwardConsole(popup.webContents, 'popup')

      // 等待渲染器加载完成
      for (let i = 0; i < 30 && popup.webContents.isLoading(); i += 1) {
        await sleep(250)
      }
      // 等待弹窗卡片真正挂载：渲染器空窗期直接捕获会得到空帧（popup.png 缺失）
      for (let i = 0; i < 40; i += 1) {
        const mounted = await popup.webContents
          .executeJavaScript(`!!document.querySelector('.notification-toast-container')`, true)
          .catch(() => false)
        if (mounted) break
        await sleep(300)
      }
      await installScreenshotPrivacyMask(popup, 'popup')
      // 等卡片入场动画 + 玻璃面板就绪；若指定了真实头像，多等 CDN 加载完成
      await sleep(payload.avatarUrl ? 5000 : 1500)

      // 先问渲染层用的是哪条折射管线，再决定能不能用"两帧一致"来判定稳定：
      // 实时玻璃永远不会有连续两帧完全相同，saveStable 会一直重试到超时，
      // popup.png 反而写不出来。
      //
      // 要轮询而不是读一次：折射循环的第一帧要走一次完整的采集管线初始化
      // （本机实测首次 >2s，之后 ~160ms），读得太早会得到还没收到帧的 'snapshot'。
      try {
        let glass = '(unset)'
        for (let i = 0; i < 24; i += 1) {
          glass = String(await popup.webContents
            .executeJavaScript(`document.documentElement.dataset.glass || '(unset)'`, true)
            .catch(() => '(unset)'))
          if (glass === 'stream' || glass === 'frames' || glass === 'native') break
          await sleep(500)
        }
        popupGlassState = glass
        log(`[screenshot] popup glass pipeline = ${popupGlassState}`)
      } catch { /* noop */ }

      const glassIsLive = popupGlassState === 'stream' || popupGlassState === 'frames' || popupGlassState === 'native'
      // 实时玻璃会把**弹窗背后的真实画面**折射进这张图里。README 用的是这张
      // popup.png，所以先把主窗口铺成一块中性底色再截，玻璃里就只有纯色 —— 既不
      // 泄露桌面，也和文档里其它深色截图一致。截完立刻撤掉，后面的行为断言
      // （闪一块亮色、看两帧差异）用的还是真实桌面。
      if (glassIsLive) {
        // 把 QA 主窗口提到最前：玻璃折射的是**屏幕上弹窗背后**的内容，如果有别的"app 盖在 QA 窗口上面，注入的中性底色根本到不了玻璃，截出来的 popup.png 里就是真实桌面的模糊残影（README 不能出现这种东西）。
        mainWindow?.show()
        mainWindow?.moveTop()
        mainWindow?.focus()
        await sleep(700)
        await mainWindow?.webContents
          .executeJavaScript(
            `(() => {
               const d = document.createElement('div');
               d.id = 'qa-neutral-backdrop';
               d.style.cssText = 'position:fixed;inset:0;background:#101014;z-index:2147482999';
               document.body.appendChild(d);
               return true;
             })()`,
            true,
          )
          .catch(() => false)
        await sleep(1000)
      }
      // 阈值与其他 11 张截图一致（12）：CI 桌面快照可能为黑底，
      // 40 的阈值会把「有真实内容但背景暗」的弹窗误判为空白
      if (glassIsLive) await saveNonBlank(popup, 'popup.png', 12)
      else await saveStable(popup, 'popup.png', 12, 40)
      if (glassIsLive) {
        // 把 QA 主窗口提到最前：玻璃折射的是**屏幕上弹窗背后**的内容，如果有别的"app 盖在 QA 窗口上面，注入的中性底色根本到不了玻璃，截出来的 popup.png 里就是真实桌面的模糊残影（README 不能出现这种东西）。
        mainWindow?.show()
        mainWindow?.moveTop()
        mainWindow?.focus()
        await sleep(700)
        await mainWindow?.webContents
          .executeJavaScript(`(() => { document.getElementById('qa-neutral-backdrop')?.remove(); return true })()`, true)
          .catch(() => false)
        await sleep(400)
        // 关键：把内容保护还回去再跑行为断言。
        //
        // 抓帧会拍到屏幕上的一切 —— 包括弹窗自己。真实运行时靠内容保护把弹窗排除
        // 掉，玻璃采样到的才是"弹窗背后"；QA 为了让 capturePage 能截到弹窗而临时
        // 关掉了保护，于是帧里含弹窗自身，玻璃采样区域被它自己的内容占据，背景
        // 变化几乎看不出来（实测帧差 0.4，而排除自身后有 5-10）。之前这条断言时
        // 好时坏，就是这个开关的时序在决定。
        await sleep(600)
      }

      try {
        const rects = await popup.webContents.executeJavaScript(
          `(() => {
            const out = {};
            for (const sel of ['.notification-avatar', '.notification-title', '.notification-time', '.notification-body']) {
              const el = document.querySelector(sel);
              if (!el) continue;
              const r = el.getBoundingClientRect();
              out[sel] = { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
            }
            return out;
          })()`,
          true,
        )
        if (rects) writeFileSync(join(outDir, 'popup-rects.json'), JSON.stringify(rects, null, 1), 'utf8')
      } catch { /* noop */ }

      // 实时玻璃的**行为**断言：把弹窗背后的底色从亮换成暗，比较两次弹窗截图。
      //
      // 为什么用"亮 vs 暗"而不是"变一下"：开着内容保护时 capturePage 只能拿到空白
      // 帧（AGENTS 的 QA 说明），所以这一步必须在保护关闭时做；而保护关闭时抓帧会
      // 拍到弹窗自身，玻璃采样区域里有它自己的模糊残影 —— 背景的**细微**变化会被
      // 淹没（实测只差 0.4），但整档明暗变化仍然明确可辨。玻璃若没在重绘，两次
      // 截图会逐像素相同。
      {
        try {
          const setOverlay = async (colour: string | null) =>
            mainWindow?.webContents
              .executeJavaScript(
                colour
                  ? `(() => {
                       const d = document.getElementById('qa-neutral-backdrop') || document.createElement('div');
                       d.id = 'qa-neutral-backdrop';
                       d.style.cssText = 'position:fixed;inset:0;background:${colour};z-index:2147483000';
                       document.body.appendChild(d);
                       return true;
                     })()`
                  : `(() => { document.getElementById('qa-neutral-backdrop')?.remove(); return true })()`,
                true,
              )
              .catch(() => false)

          const readImg = async () =>
            String(await popup.webContents
              .executeJavaScript(
                "(() => { const img = document.querySelector('.liquid-glass img'); return img ? (img.src.length + ':' + img.complete + ':' + img.naturalWidth + 'x' + img.naturalHeight + ':' + img.src.slice(2000, 2012)) : '(no img)' })()",
                true,
              )
              .catch(() => '(err)'))

          const readHash = async () =>
            String(await popup.webContents
              .executeJavaScript(`document.documentElement.dataset.glassHash || '(none)'`, true)
              .catch(() => '(none)'))

          // 控制实验：先确认 popup 的 capturePage 真的能看到自身变化。若它拿到的是
          // 陈旧帧，下面的像素差就毫无意义（实测 117，说明是活的）。这条只记日志、
          // 不作断言 —— 它是"测量工具本身是否可用"的自检。
          {
            const cBefore = await popup.webContents.capturePage()
            await popup.webContents.executeJavaScript(`document.body.style.background = '#00d5ff'; true`, true).catch(() => false)
            await sleep(1000)
            const cAfter = await popup.webContents.capturePage()
            await popup.webContents.executeJavaScript(`document.body.style.background = ''; true`, true).catch(() => false)
            await sleep(600)
            log(`[screenshot] popup capturePage control (self-paint) delta = ${meanAbsDiff(cBefore, cAfter)}`)
          }

          // 行为断言的前提同样是"QA 窗口在弹窗正下方"：否则注入的亮/暗底色压根不在玻璃采样区里，两次截图自然只差一点点。
          mainWindow?.show()
          mainWindow?.moveTop()
          await sleep(500)
          await setOverlay('#ffd60a')
          await sleep(1700)
          const bright = await popup.webContents.capturePage()
          const imgBright = await readImg()
          log(`[screenshot] popup glass img (bright) = ${imgBright}`)
          const hashBright = await readHash()
          try { writeFileSync(join(outDir, 'popup-live-bright.png'), bright.toPNG()) } catch { /* noop */ }

          await setOverlay('#101014')
          await sleep(1700)
          const dark = await popup.webContents.capturePage()
          const imgDark = await readImg()
          log(`[screenshot] popup glass img (dark) = ${imgDark}`)
          const hashDark = await readHash()
          try { writeFileSync(join(outDir, 'popup-live-dark.png'), dark.toPNG()) } catch { /* noop */ }

          await setOverlay(null)
          await sleep(400)

          popupLiveDelta = meanAbsDiff(bright, dark)
          popupGlassImgChanged = imgBright !== imgDark
          popupGlassAppliedSeq = Number(await popup.webContents.executeJavaScript('document.documentElement.dataset.glassSeq || 0', true).catch(() => 0))
          popupGlassSentSeq = getBackdropSeq()
          log(`[screenshot] popup glass applied frame seq = ${popupGlassAppliedSeq} (sent ${popupGlassSentSeq})`)
          popupBackdropFrames = getBackdropFrameCount()
          log(
            `[screenshot] popup live-glass bright/dark delta = ${popupLiveDelta.toFixed(2)}` +
              ` (frames sent: ${popupBackdropFrames}, renderer says: ${popupGlassState})`,
          )
          log(`[screenshot] popup glass frame hash bright=${hashBright} dark=${hashDark}`)
        } catch (e) {
          log('WARN [screenshot] popup live-glass delta probe failed:', e)
        }
      }    } else {
      log('WARN [screenshot] popup window not found')
    }
  } catch (e) {
    log('WARN [screenshot] popup capture failed:', e)
  }

  // 7) v0.9 页面截图（演示数据，无真实个人信息）
  //
  // placeholderHits：截图上「看起来有内容」但内容是 undefined / NaN / [object
  // Object] 的页面不会被非空白断言拦住 —— 群聊分析页就带着三条「undefined 条」
  // 通过了很久的断言。每次截图后扫一遍可见文本，命中就记下来，最后当成失败。
  const placeholderHits: Record<string, string[]> = {}
  const contrastHits: Record<string, Array<{ text: string; ratio: number; color: string; bg: string }>> = {}
  /** 3.0-4.5 的"够用但偏低"区间：只记录不阻断，见 auditContrast 注释。 */
  const contrastWarnHits: Record<string, Array<{ text: string; ratio: number; color: string; bg: string }>> = {}
  /** 哪一步截图没有渲染出目标页面。截图"文件存在但内容是上一页"是这套工具最
      隐蔽的失败模式，必须让外层构建真的失败，而不是只打一行 WARN。 */
  const captureFailures: string[] = []
  /**
   * 对比度审计：浅色模式最容易出的问题不是"看不出来"，而是**部分文字变成白底
   * 白字 / 浅底浅字** —— 截图本身仍然是"非空白"，任何现有断言都拦不住。
   *
   * 做法：遍历有文字的元素，沿祖先链找到第一个不透明的背景色，按 WCAG 算对比度。
   * 低于 3.0 即记录（正文阈值 4.5，但界面里大量是 11-12px 的次要文字与图标，
   * 用 3.0 作为"硬失败"线，4.5 作为提示）。
   */
  const auditContrast = async (label: string) => {
    if (!mainWindow || mainWindow.isDestroyed()) return
    try {
      const rows = (await mainWindow.webContents.executeJavaScript(
        `(() => {
           const parse = (value) => {
             const raw = value || ''
             const m = /rgba?\\(([^)]+)\\)/.exec(raw)
             if (m) {
               const parts = m[1].split(',').map((v) => Number.parseFloat(v.trim()))
               if (parts.length < 3 || parts.some((n) => !Number.isFinite(n))) return null
               return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1 }
             }
             // color-mix() 的计算值序列化为 color(srgb r g b [/ a])，通道是 0..1 的小数。
             // 只认 rgb() 的话，所有由 color-mix 得到底色的元素都会被当成透明：审计
             // 于是拿祖先层去算，浅色模式下会把白底上的白字报成 1.0（假失败），
             // 真正的问题也会被更外层的背景掩盖。
             const c = /color\\(srgb\\s+([^)]+)\\)/.exec(raw)
             if (c) {
               const parts = c[1].split(/[\\s/]+/).filter(Boolean).map((v) => Number.parseFloat(v))
               if (parts.length < 3 || parts.slice(0, 3).some((n) => !Number.isFinite(n))) return null
               return {
                 r: parts[0] * 255,
                 g: parts[1] * 255,
                 b: parts[2] * 255,
                 a: parts.length > 3 && Number.isFinite(parts[3]) ? parts[3] : 1,
               }
             }
             return null
           }
           const lum = (c) => {
             const f = (v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4) }
             return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b)
           }
           const ratio = (a, b) => {
             const l1 = lum(a); const l2 = lum(b)
             const hi = Math.max(l1, l2); const lo = Math.min(l1, l2)
             return (hi + 0.05) / (lo + 0.05)
           }
           const blend = (fg, bg) => ({
             r: fg.r * fg.a + bg.r * (1 - fg.a),
             g: fg.g * fg.a + bg.g * (1 - fg.a),
             b: fg.b * fg.a + bg.b * (1 - fg.a),
             a: 1,
           })
           const effectiveBg = (el) => {
             let bg = { r: 0, g: 0, b: 0, a: 0 }
             let node = el
             const layers = []
             while (node && node.nodeType === 1) {
               const c = parse(getComputedStyle(node).backgroundColor)
               if (c && c.a > 0) layers.push(c)
               if (c && c.a >= 0.99) break
               node = node.parentElement
             }
             const root = parse(getComputedStyle(document.body).backgroundColor) || { r: 0, g: 0, b: 0, a: 1 }
             bg = root.a >= 0.99 ? root : { r: 255, g: 255, b: 255, a: 1 }
             for (let i = layers.length - 1; i >= 0; i -= 1) bg = blend(layers[i], bg)
             return bg
           }
           const out = []
           // 有浮层时只审视浮层内部：被遮罩盖住的元素，用户根本看不到它们的
           // 真实底色（遮罩是兄弟节点，祖先链里找不到），继续审计只会产生假警报。
           const scrim = document.querySelector('.modal-backdrop')
           const scope = scrim || document.body
           const nodes = scope.querySelectorAll('*')
           for (const el of nodes) {
             if (el.closest('[aria-hidden="true"], .app-bg, script, style')) continue
             const style = getComputedStyle(el)
             if (style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity) < 0.35) continue
             const rect = el.getBoundingClientRect()
             if (rect.width < 8 || rect.height < 6) continue
             // 只看直接包含文字的元素，避免每个包裹层都算一遍
             const own = Array.from(el.childNodes).filter((n) => n.nodeType === 3 && n.textContent.trim().length > 0)
             if (own.length === 0) continue
             const fgRaw = parse(style.color)
             if (!fgRaw) continue
             const bg = effectiveBg(el)
             const fg = fgRaw.a >= 0.99 ? fgRaw : blend(fgRaw, bg)
             const r = ratio(fg, bg)
             if (r < 4.5) {
               out.push({
                 text: (el.textContent || '').trim().slice(0, 40),
                 ratio: Math.round(r * 100) / 100,
                 color: style.color,
                 bg: 'rgb(' + Math.round(bg.r) + ',' + Math.round(bg.g) + ',' + Math.round(bg.b) + ')',
                 size: Number.parseFloat(style.fontSize) || 12,
                 // 哪个元素：只有文字是不够的 —— 光看 "演" 没人能定位到规则。
                 node: el.tagName.toLowerCase() + (el.className ? '.' + String(el.className).split(' ').join('.') : ''),
                 parent: el.parentElement ? el.parentElement.tagName.toLowerCase() + (el.parentElement.className ? '.' + String(el.parentElement.className).split(' ').join('.') : '') : '',
                 // 整条祖先链的计算背景色。只报"实际底色"时无法判断是"元素本身透明"
                 // 还是"祖先链上没有不透明层"，这条链能一次说清。
                 chain: (() => {
                   const parts = []
                   let node = el
                   let depth = 0
                   while (node && node.nodeType === 1 && depth < 8) {
                     const cs = getComputedStyle(node)
                     parts.push(
                       node.tagName.toLowerCase() +
                         (node.className ? '.' + String(node.className).split(' ').slice(0, 2).join('.') : '') +
                         '[' + cs.backgroundColor + ']'
                     )
                     node = node.parentElement
                     depth += 1
                   }
                   return parts.join(' < ')
                 })(),
               })
             }
           }
           return out.slice(0, 40)
         })()`,
        true,
      )) as Array<{ text: string; ratio: number; color: string; bg: string; size: number }>
      // 大号加粗文字按 WCAG 只需 3.0，不记；其余低于 3.0 视为硬失败。
      const bad = (Array.isArray(rows) ? rows : []).filter((row) => row.ratio < 3)
      // 3.0-4.5 之间记成"警告"：够不上硬失败，但正是用户说的"文字颜色不对"最常
      // 落在的区间（深灰压深底、浅灰压强调色底）。审计只把它写进单独的文件，
      // 由人判断，不阻断构建。
      const warn = (Array.isArray(rows) ? rows : []).filter((row) => row.ratio >= 3 && row.ratio < 4.5)
      if (warn.length > 0) contrastWarnHits[label] = warn
      if (bad.length > 0) {
        contrastHits[label] = bad
        console.warn(`[screenshot] ${label} contrast: ${bad.length} element(s) below 3.0, worst=${bad[0].ratio}`)
        for (const row of bad.slice(0, 4)) {
          console.warn(`   "${row.text}" ratio=${row.ratio} color=${row.color} on ${row.bg} size=${row.size}`)
        }
      }
    } catch { /* 审计失败不影响截图 */ }
  }

  const placeholderHitsExport = placeholderHits
  const scanPlaceholders = async (label: string) => {
    if (!mainWindow || mainWindow.isDestroyed()) return
    try {
      const hits = (await mainWindow.webContents.executeJavaScript(
        `(() => {
           const text = document.body ? document.body.innerText || '' : '';
           return ['undefined', 'NaN', '[object Object]'].filter((needle) => text.includes(needle));
         })()`,
        true,
      )) as string[]
      if (Array.isArray(hits) && hits.length > 0) {
        placeholderHits[label] = hits
        console.warn(`[screenshot] ${label} shows placeholder text on screen: ${hits.join(', ')}`)
      }
    } catch { /* 扫描失败不影响截图本身 */ }
  }
  const captureV09 = async (label: string, fileName: string, selectors: string[], pre?: () => Promise<unknown>, settleMs = 900) => {
    if (!mainWindow || mainWindow.isDestroyed()) return
    try {
      if (pre) await pre()
      const ok = await waitForDom(selectors[0], isRealScreenshotMode ? 240 : 40)
        || (isRealScreenshotMode && selectors[1] ? await waitForDom(selectors[1], 20) : false)
      if (!ok) {
        // 静默返回会留下一个更坏的结果：这一步没截到，但文件名仍然存在（上一次
        // 的运行残留、或者截到的是上一页），外层只看"文件存在 + 非空白"就会通过。
        // 记进 captureFailures，由 capture-ui.ps1 硬断言。
        captureFailures.push(`${label} (${selectors[0]} did not render)`)
        console.warn(`[screenshot] ${label} did not render`)
        return
      }
      await sleep(settleMs)
      await saveStable(mainWindow, fileName, 12, 30)
      await scanPlaceholders(label)
      await auditContrast(label)
      await dumpRects(`${fileName.replace('.png', '')}-rects.json`, selectors)
      console.log(`[screenshot] ${fileName} captured`)
    } catch (e) {
      captureFailures.push(`${label} (capture threw: ${String(e)})`)
      console.warn(`[screenshot] ${label} capture failed:`, e)
    }
  }

  // 7.1) 朋友圈
  //
  // 断言的是**页面**而不是某条动态：动态来自一次异步时间线加载，等它出现会让
  // 这一步随机失败（已经发生过两次）。时间线是否真的有内容由下面这条日志和
  // 非空白断言兜底。
  await captureV09('sns', 'sns.png', ['.sns-page', '.sns-post-item'], async () => {
    await clickTab('朋友圈')
    await sleep(2000)
    const state = await mainWindow!.webContents
      .executeJavaScript(
        `(() => ({
           posts: document.querySelectorAll('.sns-post-item').length,
           empty: !!document.querySelector('.sns-feed .empty, .sns-feed .wp-empty'),
           error: (document.querySelector('.wp-error') || {}).textContent || '',
           authors: document.querySelectorAll('.sns-author-list > *').length,
         }))()`,
        true,
      )
      .catch(() => null)
    log(`[screenshot] sns state = ${JSON.stringify(state)}`)
  })
  // 7.2) 分析入口（两个大卡片并排）
  await captureV09('analytics-hub', 'analytics-hub.png', ['.analytics-big-card'], async () => {
    await clickTab('分析')
    await sleep(400)
    await mainWindow!.webContents.executeJavaScript(
      `(() => { const back = Array.from(document.querySelectorAll('.v09-actions .chip, .v09-toolbar .chip')).find((x) => x.textContent.includes('返回选择')); back?.click(); return !!back; })()`,
      true,
    ).catch(() => false)
  })
  // 7.3) 全局分析（统计卡片 + 图表）
  await captureV09('global', 'analytics-global.png', ['.analytics-global .analytics-summary-strip'], async () => {
    await mainWindow!.webContents.executeJavaScript(
      `(() => { const c = document.querySelector('.analytics-big-card'); c?.click(); return !!c; })()`,
      true,
    ).catch(() => false)
    await sleep(500)
  }, 1600)
  // 7.4) 年度报告
  await captureV09('annual', 'annual-report.png', ['.annual-hero', '.annual-report-view'], async () => {
    await mainWindow!.webContents.executeJavaScript(
      `(() => { const back = document.querySelector('.analytics-page .v09-actions .chip'); back?.click(); return !!back; })()`,
      true,
    ).catch(() => false)
    await waitForDom('.analytics-big-card', isRealScreenshotMode ? 120 : 40)
    await mainWindow!.webContents.executeJavaScript(
      `(() => { const cards = document.querySelectorAll('.analytics-big-card'); cards[2]?.click(); return !!cards[2]; })()`,
      true,
    ).catch(() => false)
    await sleep(500)
    await waitForDom('.annual-report-view', isRealScreenshotMode ? 120 : 40)
    await waitForDom('.annual-year-row .chip', isRealScreenshotMode ? 120 : 40)
    await mainWindow!.webContents.executeJavaScript(
      `(() => { const c = document.querySelector('.annual-year-row .chip'); c?.click(); return !!c; })()`,
      true,
    ).catch(() => false)
    await waitForDom('.annual-hero', isRealScreenshotMode ? 240 : 40)
  }, 2000)
  // 7.5) 群聊分析（群列表 + 成员面板）
  await captureV09('group', 'analytics-group.png', ['.group-analytics', '.group-member-row'], async () => {
    await mainWindow!.webContents.executeJavaScript(
      `(() => { const b = document.querySelector('.annual-report-view .annual-actions .icon-btn-ghost'); b?.click(); return !!b; })()`,
      true,
    ).catch(() => false)
    await sleep(500)
    await waitForDom('.analytics-big-card', isRealScreenshotMode ? 120 : 40)
    await mainWindow!.webContents.executeJavaScript(
      `(() => { const back = Array.from(document.querySelectorAll('.v09-actions .chip, .v09-toolbar .chip')).find((x) => x.textContent.includes('返回选择')); back?.click(); return !!back; })()`,
      true,
    ).catch(() => false)
    await waitForDom('.analytics-big-card', isRealScreenshotMode ? 120 : 40)
    await mainWindow!.webContents.executeJavaScript(
      `(() => { const cards = document.querySelectorAll('.analytics-big-card'); cards[1]?.click(); return !!cards[1]; })()`,
      true,
    ).catch(() => false)
    await sleep(500)
    await waitForDom('.group-analytics', isRealScreenshotMode ? 120 : 40)
    await mainWindow!.webContents.executeJavaScript(
      `(() => { const g = document.querySelector('.group-item'); g?.click(); return !!g; })()`,
      true,
    ).catch(() => false)
    await sleep(500)
  }, 1600)
  // 7.5.1) 双人报告：四个分析入口里唯一没有截图的一个，等于没验证过。
  await captureV09('dual', 'dual-report.png', ['.dual-report-result', '.dual-report-hero', '.dual-report-friend'], async () => {
    await mainWindow!.webContents.executeJavaScript(
      `(() => {
         const back = Array.from(document.querySelectorAll('.v09-actions .chip, .v09-toolbar .chip')).find((x) => x.textContent.includes('返回选择'));
         back?.click();
         return !!back;
       })()`,
      true,
    ).catch(() => false)
    await sleep(500)
    await waitForDom('.analytics-big-card', isRealScreenshotMode ? 120 : 40)
    await mainWindow!.webContents.executeJavaScript(
      `(() => { const cards = document.querySelectorAll('.analytics-big-card'); cards[3]?.click(); return !!cards[3]; })()`,
      true,
    ).catch(() => false)
    await sleep(700)
    // 报告默认停在好友选择页，先挑第一个好友生成报告再截图。
    await waitForDom('.dual-report-friend', isRealScreenshotMode ? 120 : 40)
    await mainWindow!.webContents.executeJavaScript(
      `(() => { const f = document.querySelector('.dual-report-friend'); f?.click(); return !!f; })()`,
      true,
    ).catch(() => false)
    await sleep(1500)
  }, 1800)
  // 7.5.2) 免打扰自检对话框：「跟随微信消息免打扰」到底有没有生效，只能靠它看，
  // 所以它本身也得有截图（否则这个新界面等于没验证过）。
  await captureV09('mute-report', 'mute-report.png', ['.mute-report-grid'], async () => {
    const tab = await clickTab('消息通知').catch(() => false)
    await sleep(700)
    const clicked = await mainWindow!.webContents.executeJavaScript(
      `(() => {
         const b = Array.from(document.querySelectorAll('button')).find((x) => x.textContent.includes('检测结果'));
         b?.click();
         return !!b;
       })()`,
      true,
    ).catch(() => false)
    await sleep(1500)
    const state = await mainWindow!.webContents.executeJavaScript(
      `(() => {
         const active = document.querySelector('.rail-item[data-active="true"], .tab[data-active="true"]');
         return {
           tab: active ? active.textContent.trim() : '(none)',
           modal: !!document.querySelector('.modal-backdrop'),
           grid: !!document.querySelector('.mute-report-grid'),
         };
       })()`,
      true,
    ).catch(() => null)
    log(`[screenshot] mute-report pre: clickTab=${tab} clickedButton=${clicked} state=${JSON.stringify(state)}`)
    await sleep(1200)
  }, 1200)

  // 关掉对话框再往下走：它是全局浮层，不随标签切换消失 —— 忘了关的话，后面每一张
  // 截图都会压着这个对话框（视频背景那张就是这么被污染的）。
  if (mainWindow && !mainWindow.isDestroyed()) {
    await mainWindow.webContents
      .executeJavaScript(
        `(() => {
           const close = Array.from(document.querySelectorAll('.modal-backdrop button')).find((b) => b.textContent.trim() === '关闭');
           if (close) { close.click(); return true; }
           const backdrop = document.querySelector('.modal-backdrop');
           if (backdrop) { backdrop.click(); return true; }
           return false;
         })()`,
        true,
      )
      .catch(() => false)
    await sleep(600)
  }

  // 7.5.3) 视频背景：图片背景是 background-image，视频是真实的 <video> 图层 ——
  // 只有给一个真文件才跑得到这条路径。
  if (process.env.WEPORT_BG_PATH) {
    await captureV09('video-bg', 'video-bg.png', ['.app-bg video'], async () => {
      await clickTab('连接微信')
      await sleep(1200)
      const state = await mainWindow!.webContents
        .executeJavaScript(
          `(() => {
             const v = document.querySelector('.app-bg video');
             const root = document.documentElement;
             return {
               present: !!v,
               readyState: v ? v.readyState : -1,
               paused: v ? v.paused : null,
               currentTime: v ? Math.round(v.currentTime * 100) / 100 : -1,
               videoWidth: v ? v.videoWidth : 0,
               bgKind: root.dataset.bgKind || '(unset)',
               hasBg: root.dataset.hasBg || '(unset)',
               dim: getComputedStyle(root).getPropertyValue('--app-bg-dim').trim(),
             };
           })()`,
          true,
        )
        .catch(() => null)
      log(`[screenshot] video background state = ${JSON.stringify(state)}`)
      // 播放中的视频不可能有两帧完全相同，saveStable 会一直等不到稳定帧 —— 它在
      // 这里已经被证明在播放了（currentTime），暂停它只是为了能截到一张稳定的图。
      await mainWindow!.webContents
        .executeJavaScript(`(() => { const v = document.querySelector('.app-bg video'); if (v) { v.pause(); return true; } return false; })()`, true)
        .catch(() => false)
      await sleep(300)
    }, 1200)
  }

  // 7.6) 设置（默认落在「常规」分类 + 左侧分类列）
  await captureV09('settings', 'settings.png', ['.settings-nav-item', '.settings-page'], async () => {    await clickTab('设置')
  })
  // 7.7) 设置 → 外观：合并后的外观分类（背景 / 强调色 / 密度 / 主题卡片）
  await captureV09('settings-appearance', 'settings-appearance.png', ['.theme-card', '.settings-pane'], async () => {
    await mainWindow!.webContents.executeJavaScript(
      `(() => {
         const b = Array.from(document.querySelectorAll('.settings-nav-item')).find((x) => x.textContent.includes('外观'));
         b?.click();
         return !!b;
       })()`,
      true,
    ).catch(() => false)
    await sleep(400)
  })
  // 7.7) 设置 → AI 服务：三个功能面各自指向哪个服务
  await captureV09('settings-ai', 'settings-ai.png', ['.ai-profile-list'], async () => {
    await mainWindow!.webContents.executeJavaScript(
      `(() => {
         const b = Array.from(document.querySelectorAll('.settings-nav-item')).find((x) => x.textContent.includes('AI 服务'));
         b?.click();
         return !!b;
       })()`,
      true,
    ).catch(() => false)
    await sleep(500)
  })

  // 7.8) 设置 → 接口：只读 HTTP API 与服务端 MCP 面板（含「复制客户端配置」）
  await captureV09('settings-connect', 'settings-connect.png', ['.mcp-panel', '.settings-pane'], async () => {
    await mainWindow!.webContents.executeJavaScript(
      `(() => {
         const b = Array.from(document.querySelectorAll('.settings-nav-item')).find((x) => x.textContent.includes('接口'));
         b?.click();
         return !!b;
       })()`,
      true,
    ).catch(() => false)
    await sleep(400)
  })

  // WeBot（v1.0）：任务列表与笔记板。两者都断言到了具体的 DOM 节点，
  // 因此「页面挂载了但内容没渲染」这种情况会直接失败而不是产出一张空图。
  await captureV09('webot', 'webot.png', ['.webot-card'], async () => {
    await clickTab('WeBot')
  })

  // WeBot 编辑器：点「新建任务」展开表单，断言内部两栏网格真的存在。
  await captureV09('webot-editor', 'webot-editor.png', ['.webot-editor-grid', '.webot-editor'], async () => {
    await mainWindow!.webContents.executeJavaScript(
      `(() => { const b = Array.from(document.querySelectorAll('.webot-toolbar-actions button')).find((x) => x.textContent.includes('新建任务')); b?.click(); return !!b; })()`,
      true,
    ).catch(() => false)
    await sleep(500)
  })

  await captureV09('webot-notes', 'webot-notes.png', ['.webot-note', '.webot-note-list'], async () => {
    await clickTab('WeBot 笔记')
  })

  // WeClone（人格克隆）：进入时停在 hub（入口选择），因此断言 hub 的节点。
  // 注意 .weclone-server-chip 只在 manage 段渲染，用它会在 hub 上误判为
  // "did not render" —— 断言必须对应当前实际渲染的那一段。
  await captureV09('weclone', 'weclone.png', ['.weclone-hub', '.analytics-hub-cards'], async () => {
    await clickTab('人格克隆')
  })

  // WeClone 的 manage / create 两段此前从未被渲染过（hub 是唯一有截图的界面），
  // 各自补一张：没有截图的界面就等于没有验证过。
  await captureV09('weclone-manage', 'weclone-manage.png', ['.weclone-grid', '.weclone-empty-cta'], async () => {
    await mainWindow!.webContents.executeJavaScript(
      `(() => {
         const b = Array.from(document.querySelectorAll('.analytics-big-card')).find((x) => x.textContent.includes('管理分身'));
         b?.click();
         return !!b;
       })()`,
      true,
    ).catch(() => false)
    await sleep(600)
  })

  await captureV09('weclone-create', 'weclone-create.png', ['.weclone-generate-main'], async () => {
    await mainWindow!.webContents.executeJavaScript(
      `(() => {
         const back = Array.from(document.querySelectorAll('.v09-actions .chip')).find((x) => x.textContent.includes('返回'));
         back?.click();
         return !!back;
       })()`,
      true,
    ).catch(() => false)
    await sleep(400)
    await mainWindow!.webContents.executeJavaScript(
      `(() => {
         const b = Array.from(document.querySelectorAll('.analytics-big-card')).find((x) => x.textContent.includes('新建分身'));
         b?.click();
         return !!b;
       })()`,
      true,
    ).catch(() => false)
    await sleep(600)
  })

  // 响应式：把窗口缩到接近最小宽度再截一次，并**记录度量**交给 PowerShell 断言。
  //
  // 横向溢出不会报错，只会把右侧内容静默切掉 —— 必须用度量兜住，肉眼截图看不
  // 出来。导航标签在窄宽度下是否还显示同样要断言：那正是 v1.0 导航改版的核心
  // 收益，被媒体查询误藏起来就等于白做。
  if (mainWindow && !mainWindow.isDestroyed()) {
    const viewportMetrics: Record<string, unknown> = {}
    const measure = () =>
      mainWindow!.webContents.executeJavaScript(`
        (() => {
          const rail = document.querySelector('.rail');
          const label = rail ? rail.querySelector('.rail-item span') : null;
          const editor = document.querySelector('.webot-editor');
          const grid = document.querySelector('.webot-editor-grid');
          const list = document.querySelector('.webot-list');
          const card = document.querySelector('.webot-card');
          const title = document.querySelector('.webot-card-title');
          const aiShell = document.querySelector('.ai-shell');
          const aiCols = aiShell
            ? getComputedStyle(aiShell).gridTemplateColumns.split(' ').map((v) => Math.round(Number.parseFloat(v) || 0))
            : [];
          return {
            viewport: window.innerWidth,
            railW: rail ? Math.round(rail.getBoundingClientRect().width) : 0,
            labelsVisible: label ? getComputedStyle(label).display !== 'none' : null,
            railItems: document.querySelectorAll('.rail-item').length,
            statusChips: document.querySelectorAll('.rail-foot .status-chip').length,
            docOverflow: document.documentElement.scrollWidth - window.innerWidth,
            // WeBot 布局：编辑器应占满列表宽度（旧的并排两栏会把列表挤到约
            // 300px），卡片标题不能被那排动作按钮压扁。
            webotEditorW: editor ? Math.round(editor.getBoundingClientRect().width) : 0,
            webotGridCols: grid ? getComputedStyle(grid).gridTemplateColumns.split(' ').length : 0,
            webotListCols: list ? getComputedStyle(list).gridTemplateColumns.split(' ').length : 0,
            webotCardW: card ? Math.round(card.getBoundingClientRect().width) : 0,
            webotTitleW: title ? Math.round(title.getBoundingClientRect().width) : 0,
            // WeportAI 三栏：中间一栏是真正读内容的地方，窄窗口下不能被两侧挤没。
            aiCols,
            aiThreadW: aiCols.length >= 3 ? aiCols[aiCols.length - 2] : 0,
          };
        })()
      `)

    mainWindow.setSize(1000, 680)
    await sleep(1000)
    await clickTab('WeBot')
    await sleep(600)
    // 编辑器在这一步是收起的（切换标签会重挂载 WeBot 页面），而它恰恰是最需要
    // 验证响应式的那块：窄窗口下两栏要能塌成一栏。先展开再截图兼测量。
    await mainWindow.webContents.executeJavaScript(
      `(() => { const b = Array.from(document.querySelectorAll('.webot-toolbar-actions button')).find((x) => x.textContent.includes('新建任务')); b?.click(); return !!b; })()`,
      true,
    ).catch(() => false)
    await sleep(600)
    await saveStable(mainWindow, 'webot-narrow.png')
    viewportMetrics.narrow = await measure()

    // 只改尺寸、不切标签：WeBot 面板与它展开的编辑器都还在，两档测的是同一屏。
    mainWindow.setSize(1440, 900)
    await sleep(900)
    viewportMetrics.wide = await measure()

    // WeportAI 在窄窗口下也截一张：它是唯一的三栏页面，两侧栏在窄窗口下必须
    // 主动让位，否则中间一栏会被挤到读不了（原来的 1100/940 断点从未生效）。
    mainWindow.setSize(1000, 680)
    await sleep(800)
    await clickTab('WeportAI')
    await sleep(900)
    await saveStable(mainWindow, 'ai-narrow.png')
    viewportMetrics.aiNarrow = await measure()

    mainWindow.setSize(1440, 900)
    await sleep(900)
    viewportMetrics.aiWide = await measure()

    // 7.9) 全量清屏：每个页面 + 每个设置分类，顶部与底部各截一张并跑对比度审计。
    //
    // 为什么需要：上面那些捕获点只覆盖"每个页面第一屏"。用户报的"文字/底色对上
    // 不"的问题多数出现在折叠线以下（第二张卡片、列表尾部、说明段落），而
    // stddev 与单张首页截图都发现不了。底部截图同时也是一份"所有界面都长什么样"
    // 的完整记录。
    {
      mainWindow.setSize(1440, 900)
      await sleep(600)
      const scrollWorkspace = (where: 'top' | 'bottom') => mainWindow!.webContents.executeJavaScript(
        `(() => { const ws = document.querySelector('.workspace'); if (!ws) return -1; ws.scrollTop = ${where === 'top' ? 0 : 'ws.scrollHeight'}; return Math.round(ws.scrollTop) })()`,
        true,
      ).catch(() => -1)

      const sweepPages: Array<[string, string]> = [
        ['connect', '连接微信'],
        ['export', '导出数据'],
        ['sns', '朋友圈'],
        ['analytics', '分析'],
        ['antirecall', '防撤回'],
        ['notifications', '消息通知'],
        ['ai', 'WeportAI'],
        ['webot', 'WeBot'],
        ['webot-notes', 'WeBot 笔记'],
        ['weclone', '人格克隆'],
      ]

      let sweepIndex = 0
      for (const [slug, label] of sweepPages) {
        if (!mainWindow || mainWindow.isDestroyed()) break
        sweepIndex += 1
        try {
          await clickTab(label)
          await sleep(900)
          for (const where of ['top', 'bottom'] as const) {
            await scrollWorkspace(where)
            await sleep(450)
            const name = `sweep${String(sweepIndex).padStart(2, '0')}-${slug}-${where}.png`
            await saveStable(mainWindow, name)
            await auditContrast(`sweep:${slug}:${where}`)
          }
        } catch (e) {
          log(`WARN [screenshot] sweep ${slug} failed:`, e)
        }
      }

      // 设置：每个分类都是一个独立界面（很多控件只在其中一个分类里出现）
      const settingsSections = ['常规', '外观', 'AI 服务', '服务分配', '连接器', '数据', '接口', '关于']
      let sectionIndex = 0
      for (const section of settingsSections) {
        if (!mainWindow || mainWindow.isDestroyed()) break
        sectionIndex += 1
        try {
          await clickTab('设置')
          await sleep(700)
          await mainWindow.webContents.executeJavaScript(
            `(() => { const b = Array.from(document.querySelectorAll('.settings-nav-item')).find((x) => x.textContent.includes(${JSON.stringify(section)})); b?.click(); return !!b })()`,
            true,
          ).catch(() => false)
          await sleep(700)
          for (const where of ['top', 'bottom'] as const) {
            await scrollWorkspace(where)
            await sleep(400)
            const name = `sweep-settings${String(sectionIndex).padStart(2, '0')}-${section}-${where}.png`
            await saveStable(mainWindow, name)
            await auditContrast(`sweep:设置/${section}:${where}`)
          }
        } catch (e) {
          log(`WARN [screenshot] sweep settings/${section} failed:`, e)
        }
      }
      log(`[screenshot] full sweep done (${sweepPages.length} pages + ${settingsSections.length} settings sections)`)
    }

    try {
      writeFileSync(join(outDir, 'viewport-metrics.json'), JSON.stringify(viewportMetrics, null, 2), 'utf8')
      log(`[screenshot] viewport metrics = ${JSON.stringify(viewportMetrics)}`)
    } catch (e) {
      log('WARN [screenshot] could not write viewport metrics:', e)
    }

    try {
      writeFileSync(join(outDir, 'placeholder-scan.json'), JSON.stringify(placeholderHitsExport, null, 2), 'utf8')
      log(`[screenshot] placeholder scan = ${JSON.stringify(placeholderHitsExport)}`)
    } catch (e) {
      log('WARN [screenshot] could not write placeholder scan:', e)
    }

    try {
      writeFileSync(join(outDir, 'contrast-audit.json'), JSON.stringify(contrastHits, null, 2), 'utf8')
      log(`[screenshot] contrast audit = ${JSON.stringify(Object.keys(contrastHits))} (failing screens)`)
      writeFileSync(join(outDir, 'contrast-warnings.json'), JSON.stringify(contrastWarnHits, null, 2), 'utf8')
      log(`[screenshot] contrast warnings = ${JSON.stringify(Object.keys(contrastWarnHits))}`)
      // AI 页在 CI 软渲染下偶发挂载超时，那条由 capture-ui.ps1 单独软处理。
      try {
        writeFileSync(join(outDir, 'popup-glass.json'), JSON.stringify({ pipeline: popupGlassState, liveFrameDelta: popupLiveDelta, framesSent: popupBackdropFrames, glassImgChanged: popupGlassImgChanged, appliedSeq: popupGlassAppliedSeq, sentSeq: popupGlassSentSeq }, null, 2), 'utf8')
      } catch { /* noop */ }
      const hardFailures = captureFailures.filter((entry) => !entry.startsWith('ai '))
      writeFileSync(join(outDir, 'capture-failures.json'), JSON.stringify(hardFailures, null, 2), 'utf8')
      log(`[screenshot] capture failures = ${JSON.stringify(hardFailures)}`)
    } catch (e) {
      log('WARN [screenshot] could not write contrast audit:', e)
    }
  }

  log('[screenshot] captures done, shutting down services...')
  try { messagePushService?.stop() } catch { /* noop */ }
  try { chatService.close() } catch { /* noop */ }
  // 不 await 完整 shutdown（宿主调用可能卡住 180s）——直接强杀宿主后退出
  try { wcdbService.killHostNow() } catch { /* noop */ }
  log('[screenshot] services stopped, exiting...')
  await sleep(200)
  log('[screenshot] calling app.exit(0)')
  isAppQuitting = true
  app.exit(0)
  log('[screenshot] app.exit returned, forcing process.exit')
  process.exit(0)
}

// ---------------------------------------------------------------------------
// QA 自检模式（真实数据端到端验证：连接 → 会话 → 导出 → 导出日志）
// ---------------------------------------------------------------------------
async function runSelfTest() {
  const outDir = process.env.WEPORT_SELFTEST_OUT || join(app.getPath('temp'), 'weport-selftest')
  const fmt = process.env.WEPORT_SELFTEST_FORMAT === 'json' ? 'json' : 'txt'
  const maxSessions = Number(process.env.WEPORT_SELFTEST_MAX || 0) || 0
  try {
    mkdirSync(outDir, { recursive: true })
  } catch { /* noop */ }

  // 文件日志（Electron GUI 进程的 stdout 在管道下不可靠）
  const logFile = join(outDir, 'selftest.log')
  const log = (msg: string) => {
    const line = `${new Date().toISOString()} ${msg}`
    console.log(line)
    try {
      const { appendFileSync } = require('fs')
      appendFileSync(logFile, line + '\n')
    } catch { /* noop */ }
  }

  const dbPath = configService?.get('dbPath') || ''
  const myWxid = configService?.get('myWxid') || ''
  const decryptKey = configService?.get('decryptKey') || ''
  log(`dbPath = ${dbPath || '(missing)'}`)
  log(`wxid   = ${myWxid || '(missing)'}`)
  log(`key    = ${decryptKey ? `present (${decryptKey.length} hex)` : '(missing)'}`)
  if (!dbPath || !myWxid || decryptKey.trim().length !== 64) {
    log('FAIL: 配置缺失（数据目录/账号/64位密钥）')
    process.exitCode = 1
    app.exit(1)
    return
  }

  // 1) 连接
  const connectResult = await chatService.connect()
  if (!connectResult.success) {
    log(`FAIL: connect -> ${connectResult.error}`)
    process.exitCode = 1
    app.exit(1)
    return
  }
  log('connect ok')

  // 2) 会话列表
  const sessionsResult = await chatService.getSessions()
  if (!sessionsResult.success || !sessionsResult.sessions) {
    log(`FAIL: getSessions -> ${sessionsResult.error}`)
    process.exitCode = 1
    app.exit(1)
    return
  }
  const sessions = sessionsResult.sessions
  let sessionIds = sessions.map((s: { username: string }) => String(s?.username || '').trim()).filter(Boolean)

  // 与 GUI 导出一致：过滤无消息会话（无消息表会报 -3 游标错误）
  try {
    const countsResult = await wcdbService.getSessionMessageCounts(sessionIds)
    if (countsResult.success && countsResult.counts) {
      const withMessages = sessionIds.filter((sid) => Number(countsResult.counts?.[sid] || 0) > 0)
      const skipped = sessionIds.length - withMessages.length
      if (skipped > 0) log(`跳过 ${skipped} 个无消息会话`)
      sessionIds = withMessages
    }
  } catch (e) {
    log(`会话数量查询失败，导出全部: ${e}`)
  }

  const limited = maxSessions > 0 ? sessionIds.slice(0, maxSessions) : sessionIds
  log(`sessions = ${sessions.length} (${sessions.filter((s: { username: string }) => String(s?.username || '').endsWith('@chatroom')).length} groups), exporting ${limited.length}`)

  // 3) 全量导出
  const formatFolder = fmt === 'json' ? 'JSON' : 'TXT'
  const outDir2 = join(outDir, formatFolder)
  try {
    mkdirSync(outDir2, { recursive: true })
  } catch { /* noop */ }

  exportService.setRuntimeConfig({
    dbPath,
    decryptKey,
    myWxid,
    resourcesPath: resolveResourcesPath(),
    appPath: app.getAppPath(),
    isPackaged: app.isPackaged,
  })

  const exportStartedAt = Date.now()
  let lastProgress = ''
  const result = await exportService.exportSessions(limited, outDir2, {
    format: fmt,
    contentType: 'text',
    exportMedia: false,
    sessionLayout: 'shared',
    sessionNameWithTypePrefix: true,
    exportWriteLayout: 'C',
    exportConflictStrategy: 'overwrite',
    displayNamePreference: 'group-nickname',
    exportPathStyle: 'windows',
  }, (p: any) => {
    const label = p.phaseLabel || p.phase || ''
    const line = `${label} ${p.current}/${p.total} ${p.currentSession || ''}`.trim()
    if (line !== lastProgress) {
      lastProgress = line
      log(`export: ${line} (elapsed ${Math.round((Date.now() - exportStartedAt) / 1000)}s)`)
    }
  })

  writeExportLog(outDir, fmt, formatLocalTime(), result.successCount || 0, result.failCount || 0)
  log(`export success=${result.successCount} fail=${result.failCount} in ${Math.round((Date.now() - exportStartedAt) / 1000)}s`)
  if (result.error) log(`export error: ${result.error}`)
  if (result.failedSessionErrors) {
    for (const [sid, err] of Object.entries(result.failedSessionErrors)) {
      log(`failed session ${sid}: ${String(err).slice(0, 300)}`)
    }
  }

  // 4) 产物核对
  let fileCount = 0
  try {
    const entries = await (await import('fs')).promises.readdir(outDir2)
    fileCount = entries.length
    log(`${formatFolder} files = ${fileCount}`)
    log(`sample: ${entries.slice(0, 5).join(', ')}`)
  } catch (e) {
    log(`readdir failed: ${e}`)
  }

  const ok = result.success && result.failCount === 0 && fileCount > 0
  log(`${ok ? 'PASS' : 'FAIL'} (out: ${outDir})`)
  process.exitCode = ok ? 0 : 1
  isAppQuitting = true
  app.exit(ok ? 0 : 1)
}

// ---------------------------------------------------------------------------
// QA 自检模式（WeportAI 端到端：真实 API → agent loop → 工具 → 笔记）
// ---------------------------------------------------------------------------
async function runAiSelfTest() {
  const outDir = process.env.WEPORT_AI_SELFTEST_OUT || join(app.getPath('temp'), 'weport-ai-selftest')
  const logFile = join(outDir, 'selftest.log')
  const log = (msg: string) => {
    const line = `${new Date().toISOString()} ${msg}`
    console.log(line)
    try { appendFileSync(logFile, line + '\n') } catch { /* noop */ }
  }
  try { mkdirSync(outDir, { recursive: true }) } catch { /* noop */ }

  const apiKey = String(configService?.get('weportAiApiKey') || '').trim()
  if (!apiKey) {
    log('FAIL: 未配置 weportAiApiKey（请用 WEPORT_AI_BOOTSTRAP_KEY 注入）')
    process.exitCode = 1
    app.exit(1)
    return
  }
  log(`apiKey = present (${apiKey.length} chars)`)
  log(`dbPath = ${String(configService?.get('dbPath') || '') || '(missing)'}`)
  log(`wxid   = ${String(configService?.get('myWxid') || '') || '(missing)'}`)

  const chat = weportAiService.createChat('[selftest]')
  log(`chat = ${chat.id}`)

  const events: string[] = []
  let resolveDone: (ev: string) => void
  const donePromise = new Promise<string>((resolve) => { resolveDone = resolve })
  const timeout = setTimeout(() => resolveDone('TIMEOUT'), 600000)
  timeout.unref?.()

  weportAiService.setEventEmitter((ev) => {
    if (ev.type === 'tool_start') {
      events.push(`tool_start: ${ev.name} | ${ev.friendly}`)
    } else if (ev.type === 'tool_result') {
      events.push(`tool_result: ${ev.name} ok=${ev.ok}`)
    } else if (ev.type === 'error' && ev.message) {
      events.push(`error: ${ev.message}`)
    } else if (ev.type === 'done') {
      events.push(`done: usage=${JSON.stringify(ev.usage)} context=${JSON.stringify(ev.context)} aborted=${ev.aborted === true}`)
      resolveDone(ev.aborted === true ? 'ABORTED' : 'DONE')
    }
  })

  const startedAt = Date.now()
  const task = String(process.env.WEPORT_AI_SELFTEST_TASK || '').trim()
  const defaultTask = !task
  const finalTask = task ||
    '请先调用 get_self_overview 了解分析范围，再调用 list_sessions 列出前 10 个会话（不要做详细分析），最后把观察写入 memory/selftest.md。回答用中文，控制在 5 行以内。'
  const result = await weportAiService.runChat(chat.id, finalTask)
  const final = await Promise.race([donePromise, Promise.resolve('NO_EVENT')])
  clearTimeout(timeout)
  const elapsed = Math.round((Date.now() - startedAt) / 1000)

  log(`runChat result = ${JSON.stringify(result)} (${elapsed}s)`)
  log(`doneEvent = ${final}`)
  for (const ev of events) log(`event: ${ev}`)

  const chatData = weportAiService.getChat(chat.id)
  const assistantCount = chatData?.messages.filter((m) => m.role === 'assistant').length || 0
  const toolCalls = chatData?.messages.reduce((n, m) => n + (m.toolCalls?.length || 0), 0) || 0
  const notes = weportAiService.listNotes(chat.id)
  log(`assistant messages = ${assistantCount}, tool calls = ${toolCalls}, notes = ${notes.length}`)
  const finalAssistant = chatData?.messages.filter((m) => m.role === 'assistant').at(-1)
  log(`final answer = ${JSON.stringify(finalAssistant?.content || '').slice(0, 1600)}`)
  if (finalAssistant?.reasoning) {
    log(`final reasoning = ${JSON.stringify(finalAssistant.reasoning).slice(0, 400)}`)
  }
  const noteFile = notes.find((n) => n.path === 'memory/selftest.md')
  if (noteFile) {
    try {
      const { readFileSync } = await import('fs')
      log(`note memory/selftest.md = ${JSON.stringify(readFileSync(join(weportAiService.getSetup().workspaceRoot, 'memory', 'selftest.md'), 'utf8').slice(0, 800))}`)
    } catch { /* noop */ }
  }

  const noteOk = defaultTask
    ? notes.some((n) => n.path === 'memory/selftest.md')
    : true
  const ok =
    result.success === true &&
    assistantCount >= 1 &&
    toolCalls >= 1 &&
    noteOk
  log(`${ok ? 'PASS' : 'FAIL'} (out: ${outDir})`)
  weportAiService.deleteChat(chat.id)
  isAppQuitting = true
  try { chatService.close() } catch { /* noop */ }
  try { await wcdbService.shutdown() } catch (e) { log(`wcdb shutdown warning: ${String(e)}`) }
  try { mainWindow?.destroy() } catch { /* noop */ }
  mainWindow = null
  app.exit(ok ? 0 : 1)
}

// ---------------------------------------------------------------------------
// QA UI 自检模式（WEPORT_UI_DUMP=1）：真实驱动渲染进程点击 WeportAI 页签、
// 输入并发送消息，把对话 DOM 摘要写成 JSON，用于无头验证 UI 端到端。
// ---------------------------------------------------------------------------
async function runUiDumpMode() {
  const outDir = process.env.WEPORT_UI_DUMP_OUT || join(app.getPath('temp'), 'weport-ui-dump')
  const task = String(process.env.WEPORT_UI_DUMP_TASK || '').trim()
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
  try { mkdirSync(outDir, { recursive: true }) } catch { /* noop */ }
  const logFile = join(outDir, 'ui-dump.log')
  const log = (msg: string) => {
    const line = `${new Date().toISOString()} ${msg}`
    console.log(line)
    try {
      const { appendFileSync } = require('fs')
      appendFileSync(logFile, line + '\n')
    } catch { /* noop */ }
  }

  // 等待窗口加载完成
  for (let i = 0; i < 40 && mainWindow && mainWindow.webContents.isLoading(); i += 1) {
    await sleep(250)
  }
  await sleep(1200)

  const wc = mainWindow?.webContents
  if (!wc) {
    log('FAIL: 主窗口不存在')
    app.exit(1)
    return
  }

  // 1) 切换到 WeportAI 页签
  const tabClick = await wc.executeJavaScript(`
    (() => {
      const buttons = Array.from(document.querySelectorAll('.tab, .rail-item'));
      const ai = buttons.find((b) => b.textContent.includes('WeportAI'));
      if (!ai) return { ok: false, tabs: buttons.map((b) => b.textContent.trim()) };
      ai.click();
      return { ok: true, tabs: buttons.map((b) => b.textContent.trim()) };
    })()
  `)
  log(`tabClick = ${JSON.stringify(tabClick)}`)
  if (!tabClick?.ok) {
    log('FAIL: 未找到 WeportAI 页签')
    app.exit(1)
    return
  }
  await sleep(1500)

  const dumpState = async () =>
    wc.executeJavaScript(`
      (() => {
        const rect = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; };
        const shell = document.querySelector('.ai-shell');
        return {
          hasShell: !!shell,
          shellRect: rect(shell),
          side: rect(document.querySelector('.ai-side')),
          main: rect(document.querySelector('.ai-main')),
          workspace: rect(document.querySelector('.ai-workspace')),
          chatItems: Array.from(document.querySelectorAll('.ai-chat-item .ai-chat-main span')).map((s) => s.textContent),
          emptyText: document.querySelector('.ai-empty') ? document.querySelector('.ai-empty').textContent.slice(0, 200) : null,
          warnBanners: Array.from(document.querySelectorAll('.ai-warn-banner')).map((b) => b.textContent.trim()),
          composer: !!document.querySelector('.ai-input'),
          sendBtn: !!document.querySelector('.ai-send'),
          modelTag: document.querySelector('.ai-model-tag') ? document.querySelector('.ai-model-tag').textContent.trim() : null,
          settingsBtn: !!document.querySelector('.ai-settings-btn'),
          notesCount: document.querySelectorAll('.ai-ws-note').length,
          msgCount: document.querySelectorAll('.ai-msg').length,
          viewport: { w: window.innerWidth, h: window.innerHeight },
          scrollX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
          scrollY: document.documentElement.scrollHeight - document.documentElement.clientHeight,
        };
      })()
    `)

  const initial = await dumpState()
  log(`initialState = ${JSON.stringify(initial)}`)

  let expandCheck: { clicked?: boolean; expanded?: boolean } | null = null

  if (task) {
    // 2) 输入并发送消息（模拟真实用户输入）
    const typed = await wc.executeJavaScript(`
      (() => {
        const el = document.querySelector('.ai-input');
        if (!el) return false;
        const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
        setter.call(el, ${JSON.stringify(task)});
        el.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      })()
    `)
    log(`typed = ${typed}`)
    await sleep(400)
    const clicked = await wc.executeJavaScript(`
      (() => {
        const btn = document.querySelector('.ai-send');
        if (!btn || btn.disabled) return false;
        btn.click();
        return true;
      })()
    `)
    log(`sendClicked = ${clicked}`)

    // 3) 轮询等待运行结束（发送按钮重新可用 + 无 stop 按钮 + 消息数稳定）
    let lastMsgCount = -1
    let stableRounds = 0
    const deadline = Date.now() + 600000
    let done = false
    const abortAfterMs = Number(process.env.WEPORT_UI_DUMP_ABORT_MS || 0)
    if (abortAfterMs > 0) {
      log(`abort scheduled after ${abortAfterMs}ms`)
      setTimeout(() => {
        void wc.executeJavaScript(`document.querySelector('.ai-send.stop')?.click()`).then((r) => {
          log(`abortClicked = ${r}`)
        })
      }, abortAfterMs)
    }
    while (Date.now() < deadline) {
      await sleep(3000)
      const state = await dumpState()
      const stopBtn = await wc.executeJavaScript(`!!document.querySelector('.ai-send.stop')`)
      if (!stopBtn && state.msgCount > 0 && state.msgCount === lastMsgCount) {
        stableRounds += 1
        if (stableRounds >= 2) {
          done = true
          log(`runFinished msgCount=${state.msgCount}`)
          break
        }
      } else {
        stableRounds = 0
        lastMsgCount = state.msgCount
      }
      if (state.msgCount > 0 && !stopBtn && state.msgCount === lastMsgCount && stableRounds < 1) {
        lastMsgCount = state.msgCount
      }
    }
    if (!done) log(`TIMEOUT waiting for run (lastMsgCount=${lastMsgCount})`)
    if (abortAfterMs > 0) {
      const afterAbort = await dumpState()
      log(`afterAbort = ${JSON.stringify(afterAbort)}`)
      const errText = await wc.executeJavaScript(`document.querySelector('.ai-error-bubble')?.textContent.slice(0, 300) || null`)
      log(`afterAbort errorBubble = ${JSON.stringify(errText)}`)
    }

    // 4) 转储对话内容
    const convo = await wc.executeJavaScript(`
      (() => {
        const out = { msgs: [], toolCards: [], notes: [], usage: null, hasActionsBtn: !!document.querySelector('.ai-actions-btn'), toolRows: document.querySelectorAll('.ai-tool-row').length };
        out.msgs = Array.from(document.querySelectorAll('.ai-msg')).map((m) => {
          const userBubble = m.querySelector('.ai-msg-bubble');
          const md = m.querySelector('.ai-md');
          const errBubble = m.querySelector('.ai-error-bubble');
          if (userBubble) return { kind: 'user', text: userBubble.textContent.slice(0, 300) };
          if (errBubble) return { kind: 'error', text: errBubble.textContent.slice(0, 500) };
          if (m.classList.contains('live')) return { kind: 'live', md: md ? md.textContent.slice(0, 300) : '', thinking: !!m.querySelector('.ai-thinking') };
          return { kind: 'assistant', md: md ? md.textContent.slice(0, 3000) : '', reasoning: !!m.querySelector('.ai-reasoning pre') ? m.querySelector('.ai-reasoning pre').textContent.slice(0, 200) : null };
        });
        out.toolCards = Array.from(document.querySelectorAll('.ai-tool-card')).map((c) => c.textContent.replace(/\\s+/g, ' ').trim().slice(0, 220));
        out.steps = document.querySelectorAll('.ai-step').length;
        out.inlineReasoning = document.querySelectorAll('.ai-reasoning.inline').length;
        out.ctxBar = !!document.querySelector('.ai-bar-fill.ctx');
        out.cacheBar = !!document.querySelector('.ai-bar-fill.cache');
        out.notes = Array.from(document.querySelectorAll('.ai-ws-note')).map((n) => n.textContent.replace(/\\s+/g, ' ').trim());
        const usageEl = document.querySelector('.ai-ws-usage strong');
        out.usage = usageEl ? usageEl.textContent.trim() : null;
        return out;
      })()
    `)
    log(`conversation = ${JSON.stringify(convo)}`)

    // 4.5) 可折叠工具卡片验证：点击第一条工具行，检查详情展开
    const expandCheckResult = await wc.executeJavaScript(`
      (async () => {
        const row = document.querySelector('.ai-tool-row');
        if (!row) return { clicked: false };
        const card = row.closest('.ai-tool-card');
        const before = !!card.querySelector('.ai-tool-detail');
        row.click();
        await new Promise((r) => setTimeout(r, 250));
        const after = !!card.querySelector('.ai-tool-detail');
        return { clicked: true, expanded: after, wasCollapsedBefore: !before };
      })()
    `)
    expandCheck = expandCheckResult
    log(`toolCardExpand = ${JSON.stringify(expandCheck)}`)
    // 收起，恢复初始状态
    await wc.executeJavaScript(`document.querySelector('.ai-tool-row')?.click()`)
  } else {
    expandCheck = null
  }

  // 5) 打开设置弹窗并转储字段（第一个 ai-settings-btn 是调试日志按钮，选"设置"）
  const settingsOpen = await wc.executeJavaScript(`
    (() => {
      const btn = Array.from(document.querySelectorAll('.ai-settings-btn')).find((b) => b.title.includes('设置'));
      if (!btn) return false;
      btn.click();
      return true;
    })()
  `)
  await sleep(600)
  const settingsDump = await wc.executeJavaScript(`
    (() => {
      const modal = document.querySelector('.ai-settings');
      if (!modal) return null;
      const labels = Array.from(modal.querySelectorAll('label')).map((l) => l.textContent.replace(/\\s+/g, ' ').trim());
      const inputs = Array.from(modal.querySelectorAll('input, textarea, select')).map((el) => ({
        id: el.id || '',
        value: el.tagName === 'INPUT' && el.type === 'password' ? (el.value ? '(filled)' : '') : el.value.slice(0, 60),
      }));
      const r = modal.getBoundingClientRect();
      const body = modal.querySelector('.ai-settings-body');
      return {
        labels, inputs,
        modalHeight: Math.round(r.height),
        viewportHeight: window.innerHeight,
        fitsViewport: r.height <= window.innerHeight && r.bottom <= window.innerHeight && r.top >= 0,
        bodyScrollable: body ? body.scrollHeight > body.clientHeight : false,
        toolToggles: modal.querySelectorAll('.ai-tool-toggle').length,
        actionEditors: modal.querySelectorAll('.ai-action-edit').length,
      };
    })()
  `)
  log(`settingsOpen = ${settingsOpen}, settings = ${JSON.stringify(settingsDump)}`)
  const settingsOk = settingsDump?.fitsViewport === true && settingsDump?.toolToggles === 14
  log(`settingsFitCheck = ${settingsOk}`)
  await wc.executeJavaScript(`document.querySelector('.ai-settings .modal-actions .secondary-btn')?.click()`)

  // 5.5) 右栏折叠 → 展开 循环验证（边界把手必须始终可点，且平滑）
  const wsCollapseCheck = await wc.executeJavaScript(`
    (async () => {
      const toggle = document.querySelector('.ai-ws-toggle');
      if (!toggle) return { ok: false, reason: 'no toggle' };
      const before = getComputedStyle(document.querySelector('.ai-shell')).gridTemplateColumns;
      toggle.click();
      await new Promise((r) => setTimeout(r, 350));
      const bodyHidden = document.querySelector('.ai-ws-body').offsetParent === null;
      const toggleVisible = toggle.offsetParent !== null;
      const during = getComputedStyle(document.querySelector('.ai-shell')).gridTemplateColumns;
      toggle.click();
      await new Promise((r) => setTimeout(r, 350));
      const bodyVisible = document.querySelector('.ai-ws-body').offsetParent !== null;
      const after = getComputedStyle(document.querySelector('.ai-shell')).gridTemplateColumns;
      const headBtns = Array.from(document.querySelectorAll('.ai-ws-head .ai-ws-refresh')).map((b) => b.title);
      return { ok: bodyHidden && toggleVisible && bodyVisible, bodyHidden, toggleVisible, bodyVisible, before, during, after, headBtns };
    })()
  `)
  log(`wsCollapseCycle = ${JSON.stringify(wsCollapseCheck)}`)

  // 5.6) 输入框自动扩展验证：多行输入 / 长行自动换行 / 快捷动作填入
  const inputGrowCheck = await wc.executeJavaScript(`
    (async () => {
      const el = document.querySelector('.ai-input');
      if (!el) return { ok: false, reason: 'no input' };
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
      const h0 = el.getBoundingClientRect().height;
      setter.call(el, 'line1\\nline2\\nline3\\nline4');
      el.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 150));
      const h1 = el.getBoundingClientRect().height;
      setter.call(el, 'x'.repeat(220));
      el.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 150));
      const h2 = el.getBoundingClientRect().height;
      setter.call(el, '');
      el.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 150));
      const h3 = el.getBoundingClientRect().height;
      const actionBtn = document.querySelector('.ai-actions-btn');
      if (actionBtn) {
        actionBtn.click();
        await new Promise((r) => setTimeout(r, 150));
        const item = document.querySelector('.ai-action-item');
        item?.click();
        await new Promise((r) => setTimeout(r, 150));
        const filled = el.value.length > 0;
        const h4 = el.getBoundingClientRect().height;
        const actionGrew = filled && h4 > h0 + 8;
        setter.call(el, '');
        el.dispatchEvent(new Event('input', { bubbles: true }));
        await new Promise((r) => setTimeout(r, 100));
        return { ok: h1 > h0 + 8 && h2 > h0 + 8 && h3 <= h0 + 8 && actionGrew, h0: Math.round(h0), h1: Math.round(h1), h2: Math.round(h2), h3: Math.round(h3), filled, h4: actionGrew ? Math.round(h4) : null };
      }
      return { ok: h1 > h0 + 8 && h2 > h0 + 8 && h3 <= h0 + 8, h0: Math.round(h0), h1: Math.round(h1), h2: Math.round(h2), h3: Math.round(h3) };
    })()
  `)
  log(`inputGrow = ${JSON.stringify(inputGrowCheck)}`)

  // 5.7) 删除对话 → 弹窗确认（取消/确认按钮）
  const deleteConfirmCheck = await wc.executeJavaScript(`
    (async () => {
      const del = Array.from(document.querySelectorAll('.ai-chat-del')).find((b) => b.title === '删除对话');
      if (!del) return { ok: false, reason: 'no chats' };
      del.click();
      await new Promise((r) => setTimeout(r, 200));
      const modal = document.querySelector('.ai-settings, .modal.danger');
      const isDelModal = !!document.querySelector('.modal.danger');
      const hasCancel = isDelModal && !!document.querySelector('.modal.danger .secondary-btn');
      const hasConfirm = isDelModal && !!document.querySelector('.modal.danger .danger-btn');
      document.querySelector('.modal.danger .secondary-btn')?.click();
      await new Promise((r) => setTimeout(r, 150));
      const closed = !document.querySelector('.modal.danger');
      return { ok: isDelModal && hasCancel && hasConfirm && closed, isDelModal, hasCancel, hasConfirm, closed };
    })()
  `)
  log(`deleteConfirm = ${JSON.stringify(deleteConfirmCheck)}`)

  // 5.8) 对话重命名：铅笔按钮 → 行内输入框 → Esc 取消
  const renameCheck = await wc.executeJavaScript(`
    (async () => {
      const pencil = Array.from(document.querySelectorAll('.ai-chat-del')).find((b) => b.title === '重命名对话');
      if (!pencil) return { ok: false, reason: 'no pencil' };
      pencil.click();
      await new Promise((r) => setTimeout(r, 150));
      const input = document.querySelector('.ai-chat-rename');
      if (!input) return { ok: false, reason: 'no input' };
      const shown = input.value.length > 0;
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await new Promise((r) => setTimeout(r, 150));
      const closed = !document.querySelector('.ai-chat-rename');
      return { ok: shown && closed, shown, closed };
    })()
  `)
  log(`renameCheck = ${JSON.stringify(renameCheck)}`)

  // 5.9) 新建对话复用 / 置顶 / 空对话自动删除 / 可拖拽
  const newChatCheck = await wc.executeJavaScript(`
    (async () => {
      const count = () => document.querySelectorAll('.ai-chat-item').length;
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      const waitCount = async (target) => {
        for (let i = 0; i < 15; i += 1) {
          if (count() === target) return true;
          await wait(200);
        }
        return count() === target;
      };
      const initial = count();
      const draggable = document.querySelector('.ai-chat-item')?.draggable === true;
      const newBtn = document.querySelector('.ai-new-chat');
      newBtn.click();
      await wait(300);
      const afterCreate = count();
      const created = afterCreate === initial + 1;
      const topTitle = document.querySelector('.ai-chat-item .ai-chat-main span')?.textContent || '';
      newBtn.click();
      await wait(300);
      const afterSecond = count();
      const reused = afterSecond === afterCreate;
      const firstChat = document.querySelectorAll('.ai-chat-item')[1]?.querySelector('.ai-chat-main');
      firstChat?.click();
      await waitCount(initial);
      const autoDeleted = count() === initial;
      return { ok: created && reused && autoDeleted && draggable, initial, afterCreate, afterSecond, autoDeleted, draggable, topTitle: topTitle.slice(0, 16) };
    })()
  `)
  log(`newChatCheck = ${JSON.stringify(newChatCheck)}`)

  const state = await dumpState()
  log(`finalState = ${JSON.stringify(state)}`)
  const fail =
    !initial?.hasShell ||
    !initial?.composer ||
    state.msgCount === 0 ||
    (task && !expandCheck?.clicked) ||
    (task && expandCheck?.clicked && !expandCheck.expanded) ||
    !settingsOk ||
    wsCollapseCheck?.ok !== true ||
    inputGrowCheck?.ok !== true ||
    deleteConfirmCheck?.ok !== true ||
    renameCheck?.ok !== true ||
    newChatCheck?.ok !== true
  log(`${fail ? 'FAIL' : 'PASS'} (out: ${outDir})`)
  isAppQuitting = true
  app.exit(fail ? 1 : 0)
}

// ---------------------------------------------------------------------------
// 启动 / 退出
// ---------------------------------------------------------------------------
function installMainProcessErrorHandlers() {
  const fatalLog = process.env.WEPORT_FATAL_LOG ||
    (process.env.WEPORT_AI_SELFTEST_OUT
      ? join(process.env.WEPORT_AI_SELFTEST_OUT, 'fatal.log')
      : null)
  let lastSignature = ''
  let lastRecordedAt = 0
  let suppressedCount = 0

  const isBrokenPipe = (error: unknown) => (error as NodeJS.ErrnoException)?.code === 'EPIPE'
  const errorText = (error: unknown) => String((error as Error)?.stack || error)
  const appendFatal = (kind: string, error: unknown) => {
    if (isBrokenPipe(error)) return
    const details = errorText(error)
    const signature = `${kind}:${details}`
    const now = Date.now()
    // A failing event source can reject the same promise repeatedly. Keep the
    // log useful and avoid turning an error storm into an I/O storm as well.
    if (signature === lastSignature && now - lastRecordedAt < 1000) {
      suppressedCount += 1
      return
    }
    const suppressed = suppressedCount
    suppressedCount = 0
    lastSignature = signature
    lastRecordedAt = now
    const line = `${new Date().toISOString()} ${kind}: ${details}${suppressed ? ` (suppressed ${suppressed} duplicates)` : ''}\n`
    console.error(`[Weport] ${line.trim()}`)
    try {
      const logPath = fatalLog || join(app.getPath('logs'), 'fatal.log')
      mkdirSync(dirname(logPath), { recursive: true })
      appendFileSync(logPath, line, 'utf8')
    } catch {
      // Logging must never become a second uncaught exception.
    }
  }

  process.stdout?.on('error', (error) => {
    if (!isBrokenPipe(error)) appendFatal('stdout', error)
  })
  process.stderr?.on('error', (error) => {
    if (!isBrokenPipe(error)) appendFatal('stderr', error)
  })
  process.on('uncaughtException', (error) => {
    if (isBrokenPipe(error)) return
    appendFatal('uncaughtException', error)
    if (fatalProcessError) return
    fatalProcessError = true
    isAppQuitting = true
    // Registering this handler prevents Electron's default modal
    // "A JavaScript error occurred in the main process" dialog. A process
    // which reached uncaughtException is not safe to keep serving requests;
    // exit once the current callback unwinds instead of showing a dialog for
    // every follow-up exception.
    //
    // issue #7: 静默 app.exit 会把可诊断的错误呈现成"点击即闪退"。退出前弹一次
    // 错误框（含 fatal.log 路径），让用户/反馈有迹可循。QA/无人值守模式跳过弹窗。
    const inQaMode = process.env.WEPORT_SCREENSHOT_POPUP === '1' ||
      process.env.WEPORT_V09_DUMP === '1' ||
      process.env.WEPORT_AI_SELFTEST === '1' ||
  process.env.WEPORT_AI_PROBE === '1'
    if (!inQaMode && app.isReady()) {
      try {
        const logPath = fatalLog || join(app.getPath('logs'), 'fatal.log')
        dialog.showErrorBox(
          'Weport 遇到内部错误',
          `主进程出现未捕获异常，应用即将退出。\n\n${errorText(error).slice(0, 1200)}\n\n详细日志：${logPath}`
        )
      } catch {
        // 弹窗失败也要保证退出路径执行
      }
    }
    setTimeout(() => {
      try { app.exit(1) } catch { process.exit(1) }
    }, 0).unref()
  })
  process.on('unhandledRejection', (error) => {
    appendFatal('unhandledRejection', error)
  })
}

// ---------------------------------------------------------------------------
// AI 探针模式（WEPORT_AI_PROBE=1）：用**当前配置的 provider profile** 跑一段
// 多轮对话，把每一轮的用量、缓存命中与延迟写成 JSON。
//
// 为什么单独一个模式：`WEPORT_AI_SELFTEST` 读的是旧的 `weportAiApiKey`（v1.0 已经
// 换成分 profile 存储，那把钥匙早就不用了），所以它测不到真实配置。缓存命中率、
// 克隆相似度评估都需要一个"拿真实配置、可脚本调用、输出结构化指标"的入口。
//
// 环境变量：
//   WEPORT_AI_PROBE_OUT     输出目录（默认 <temp>/weport-ai-probe）
//   WEPORT_AI_PROBE_TURNS   轮数（默认 3）
//   WEPORT_AI_PROBE_TASKS   自定义提示词，JSON 数组或 | 分隔
//   WEPORT_AI_PROBE_TOOLS   设为 0 则不挂工具（纯对话，用于隔离缓存行为）
//   WEPORT_AI_PROBE_CONSUMER chat | webot | weclone（默认 chat）
//   WEPORT_AI_PROBE_PROFILE  'active'（默认）| 'all'（逐个试探）| id/名称/模型片段
//   WEPORT_AI_PROBE_MODEL    只用内存里换掉模型 id 跑一轮（"这个模型这台机器能不能调通"）
//   WEPORT_AI_PROBE_BASE_URL 配合上面一起换成别的网关
//   WEPORT_AI_PROBE_MODELS   设为 1 时先做一次模型发现，把网关 /models 的结果写进 JSON
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// 一次性服务配置（WEPORT_AI_SETUP=1）
//
// 存在的理由：provider 配置存在 safeStorage 加密的 blob 里，脚本 / 自动化没有任何
// 受支持的写入路径（手工改配置文件会毁掉加密信封）。这个模式只做一件事——把
// "唯一一个服务" 写进去并验证它能调通——因此它既是首次引导，也是密钥轮换的工具。
//
// 环境变量：
//   WEPORT_AI_SETUP_KEY       API key（必填）
//   WEPORT_AI_SETUP_MODEL     模型 id（默认 deepseek-v4.1-flash）
//   WEPORT_AI_SETUP_BASE_URL  服务地址（默认 opencode-go 网关）
//   WEPORT_AI_SETUP_PROVIDER  provider id（默认 opencode-go）
//   WEPORT_AI_SETUP_NAME      显示名称
// ---------------------------------------------------------------------------
async function runAiSetup() {
  const outDir = process.env.WEPORT_AI_PROBE_OUT || join(app.getPath('temp'), 'weport-ai-setup')
  try { mkdirSync(outDir, { recursive: true }) } catch { /* noop */ }
  const logFile = join(outDir, 'setup.log')
  const log = (msg: string) => {
    const line = `${new Date().toISOString()} ${msg}`
    console.log(line)
    try { appendFileSync(logFile, line + '\n') } catch { /* noop */ }
  }

  const apiKey = String(process.env.WEPORT_AI_SETUP_KEY || '').trim()
  if (!apiKey) {
    log('FAIL: 缺少 WEPORT_AI_SETUP_KEY')
    app.exit(1)
    return
  }
  const model = String(process.env.WEPORT_AI_SETUP_MODEL || 'deepseek-v4.1-flash').trim()
  const providerId = String(process.env.WEPORT_AI_SETUP_PROVIDER || 'opencode-go').trim()
  const baseUrl = String(process.env.WEPORT_AI_SETUP_BASE_URL || 'https://opencode.ai/zen/go/v1').trim()
  const name = String(process.env.WEPORT_AI_SETUP_NAME || 'OpenCode Go · DeepSeek V4.1 Flash').trim()

  const before = weportAiService.listProviderProfiles().map((profile) => profile.id)
  const saved = weportAiService.saveProviderProfile({ name, providerId, protocol: 'openai-compatible', baseUrl, model, apiKey })
  if (!saved.success || !saved.profile) {
    log(`FAIL: 保存失败：${saved.error}`)
    app.exit(1)
    return
  }
  const profileId = saved.profile.id
  log(`saved profile ${profileId} (${providerId}/${model})`)

  // 只保留这一个服务：用户明确要求"只有 opencode + deepseek v4.1"，留着指向已失效
  // 密钥的旧 profile 只会让其它功能面在 401 里打转。
  for (const id of before) {
    if (id === profileId) continue
    const removed = weportAiService.deleteProviderProfile(id)
    log(`removed old profile ${id}: ${removed.success}`)
  }
  log(`activate: ${weportAiService.activateProviderProfile(profileId).success}`)
  for (const consumer of ['chat', 'weclone', 'webot'] as const) {
    log(`assign ${consumer}: ${weportAiService.assignConsumerProfile(consumer, profileId).success}`)
  }

  // 验证：真发一轮请求，确认这把钥匙在**这台机器**上可用（网关按地区拒模型）。
  const chat = weportAiService.createChat('[setup]')
  let doneResolve: ((value: { usage?: Record<string, unknown>; context?: Record<string, unknown> }) => void) | null = null
  weportAiService.setEventEmitter((ev) => {
    if (ev.type === 'done' && doneResolve) {
      const resolve = doneResolve
      doneResolve = null
      resolve({ usage: ev.usage as unknown as Record<string, unknown>, context: ev.context as unknown as Record<string, unknown> })
    }
  })
  const completion = new Promise<{ usage?: Record<string, unknown>; context?: Record<string, unknown> }>((resolve) => {
    doneResolve = resolve
    setTimeout(() => { doneResolve = null; resolve({}) }, 180000).unref?.()
  })
  const result = await weportAiService.runChat(chat.id, '回复两个字：就绪', { consumer: 'chat' })
  const done = await completion
  const usage = done.usage || {}
  log(`verify: ok=${result.success} error=${result.error || ''} prompt=${Number(usage.promptTokens) || 0} cacheHit=${Number((usage as Record<string, unknown>).promptCacheHitTokens) || 0}`)
  weportAiService.deleteChat(chat.id)

  const payload = {
    profileId,
    providerId,
    baseUrl,
    model,
    verified: result.success === true,
    error: result.error,
    usage,
    profiles: weportAiService.listProviderProfiles().map((profile) => ({ id: profile.id, name: profile.name, model: profile.model })),
  }
  try { writeFileSync(join(outDir, 'setup.json'), JSON.stringify(payload, null, 2), 'utf8') } catch { /* noop */ }
  log(`${result.success ? 'PASS' : 'FAIL'} (out: ${outDir})`)
  isAppQuitting = true
  try { chatService.close() } catch { /* noop */ }
  try { await wcdbService.shutdown() } catch { /* noop */ }
  try { mainWindow?.destroy() } catch { /* noop */ }
  mainWindow = null
  app.exit(result.success ? 0 : 1)
}

// ---------------------------------------------------------------------------
// TUI 引擎模式（`--cli`）：把服务层接到 stdio 上，供 packages/weport-tui 驱动
//
// 通道用 Node 的 IPC（`process.send`/`message`）而不是管道 JSON：Windows 上
// Electron 主进程的 stdin 会立刻 EOF（见 AGENTS.md），只有 IPC channel 稳定。
// 握手用一次性令牌（`--weport-token` + 环境变量比对），所以终端进程能确认自己
// 连上的是同一个会话里启动的引擎，而不是碰巧占了这条通道的别的东西。
// ---------------------------------------------------------------------------
async function runCliHost() {
  const hostPath = join(app.getPath('userData'), 'weport-cli-host.json')
  const envToken = String(process.env.WEPORT_CLI_TOKEN || '').trim()
  const argToken = (() => {
    const index = process.argv.indexOf('--weport-token')
    return index >= 0 ? String(process.argv[index + 1] || '') : ''
  })()
  const expected = envToken || argToken
  let handshaken = expected.length === 0
  let shuttingDown = false

  registerCliCommands()

  const shutdown = (code: number) => {
    if (shuttingDown) return
    shuttingDown = true
    try { rmSync(hostPath, { force: true }) } catch { /* noop */ }
    isAppQuitting = true
    // Tear down the services the engine started for the terminal session: leaving the
    // MCP/HTTP listeners and the WCDB host behind would keep a second, invisible
    // Weport alive for every TUI run.
    try { mcpService.stop() } catch { /* noop */ }
    try { httpService.stop() } catch { /* noop */ }
    try { chatService.close() } catch { /* noop */ }
    void (async () => {
      try { await wcdbService.shutdown() } catch { /* noop */ }
      app.exit(code)
    })()
    // 兜底：宿主进程卡在原生调用里时也要退出，否则终端会一直挂着
    setTimeout(() => app.exit(code), 4000).unref?.()
  }

  const send = (payload: Record<string, unknown>) => {
    try { process.send?.(payload) } catch { /* channel closed */ }
  }

  process.on('message', (raw: unknown) => {
    void (async () => {
      const message = raw as { id?: string; kind?: string; command?: string; args?: Record<string, unknown>; token?: string }
      if (!message || typeof message !== 'object') return
      if (message.kind === 'hello') {
        if (expected && message.token !== expected) {
          send({ kind: 'error', error: '令牌不匹配：终端进程与引擎会话不一致' })
          shutdown(3)
          return
        }
        handshaken = true
        send({ kind: 'ready', version: APP_VERSION, pid: process.pid, dbPath: String(configService?.get('dbPath') || '') })
        return
      }
      if (!handshaken) {
        send({ id: message.id, kind: 'result', success: false, error: '尚未完成握手' })
        return
      }
      if (message.kind === 'bye') {
        send({ id: message.id, kind: 'result', success: true })
        shutdown(0)
        return
      }
      if (message.kind !== 'call') return
      const result = await runCommand(String(message.command || ''), message.args || {}, { origin: 'cli' })
      send({ id: message.id, kind: 'result', ...result })
    })()
  })

  // 通道断开（终端被关掉/被 kill）= 引擎没有主人在等，直接退出，避免留下
  // 一个连着微信库、会弹通知的隐形进程。
  process.on('disconnect', () => shutdown(0))
  process.on('SIGINT', () => shutdown(0))
  process.on('SIGTERM', () => shutdown(0))

  try {
    writeFileSync(hostPath, JSON.stringify({ version: APP_VERSION, pid: process.pid, startedAt: Date.now() }, null, 2), 'utf8')
  } catch { /* noop */ }
  console.log(`[weport] TUI 引擎已就绪 (pid ${process.pid})`)
  // 引擎只服务于终端界面：没有窗口、没有托盘，所以不注册 window-all-closed 的
  // "全部窗口关闭即退出"逻辑（这条日志之后主进程会一直等到 bye/disconnect）。
  if (mainWindow) {
    try { mainWindow.destroy() } catch { /* noop */ }
    mainWindow = null
  }
}

async function runAiProbe() {
  const outDir = process.env.WEPORT_AI_PROBE_OUT || join(app.getPath('temp'), 'weport-ai-probe')
  try { mkdirSync(outDir, { recursive: true }) } catch { /* noop */ }
  const logFile = join(outDir, 'probe.log')
  const log = (msg: string) => {
    const line = `${new Date().toISOString()} ${msg}`
    console.log(line)
    try { appendFileSync(logFile, line + '\n') } catch { /* noop */ }
  }

  const consumer = (String(process.env.WEPORT_AI_PROBE_CONSUMER || 'chat').trim() || 'chat') as 'chat' | 'weclone' | 'webot'
  const useTools = process.env.WEPORT_AI_PROBE_TOOLS !== '0'
  const turns = Math.max(1, Math.min(40, Number(process.env.WEPORT_AI_PROBE_TURNS) || 3))

  const rawTasks = String(process.env.WEPORT_AI_PROBE_TASKS || '').trim()
  let tasks: string[] = []
  if (rawTasks) {
    try {
      const parsed = JSON.parse(rawTasks)
      if (Array.isArray(parsed)) tasks = parsed.map((t) => String(t))
    } catch {
      tasks = rawTasks.split('|').map((t) => t.trim()).filter(Boolean)
    }
  }
  if (tasks.length === 0) {
    tasks = [
      '用一句话说明你现在能做什么。不要调用任何工具。',
      '把刚才那句话改得更短一些，仍然不要调用工具。',
      '用三条要点总结你上一个回答的重点，不要调用工具。',
      '再用一句话补充：这些要点里哪一条最重要，为什么。',
    ]
  }

  // 只读摘要：providerId / model / baseUrl / 是否配了密钥（永不打印密钥本身）
  const profiles = weportAiService.listProviderProfiles()
  const activeProfileId = weportAiService.getActiveProfileId()
  const assignments = weportAiService.getConsumerAssignments()
  const active = profiles.find((p) => p.id === activeProfileId) || null
  const summary = {
    consumer,
    tools: useTools,
    activeProfileId,
    active: active
      ? { id: active.id, name: active.name, providerId: active.providerId, model: active.model, baseUrl: active.baseUrl, protocol: active.protocol, hasApiKey: active.hasApiKey }
      : null,
    profiles: profiles.map((p) => ({ id: p.id, name: p.name, providerId: p.providerId, model: p.model, baseUrl: p.baseUrl, protocol: p.protocol, hasApiKey: p.hasApiKey })),
    consumerAssignment: assignments.find((c) => c.consumer === consumer)?.profileId || '',
    turns: [] as Array<Record<string, unknown>>,
    discovery: null as { profileId: string; models: string[]; error: string } | null,
  }
  log(`profiles = ${JSON.stringify(summary.profiles)}`)
  log(`active  = ${JSON.stringify(summary.active)}`)
  const override = weportAiService.probeOverrideState()
  if (override.model) log(`model override = ${JSON.stringify(override)}`)
  if (process.env.WEPORT_AI_PROBE_MODELS === '1') {
    // 网关的 /models 是权威清单：配置里存在的模型不等于账号/地区可用。
    const target = summary.active || summary.profiles[0] || null
    if (target) {
      const discovery = await weportAiService.discoverModelsForProfile(target.id)
      summary.discovery = { profileId: target.id, ...discovery }
      log(`discovery(${target.providerId}) models=${discovery.models.length} error=${discovery.error || ''}`)
      log(`discovery list = ${JSON.stringify(discovery.models)}`)
    }
  }

  const chat = weportAiService.createChat('[ai-probe]')
  log(`chat = ${chat.id}`)

  let doneResolve: ((value: { usage?: Record<string, unknown>; context?: Record<string, unknown> }) => void) | null = null
  weportAiService.setEventEmitter((ev) => {
    if (ev.type === 'done' && doneResolve) {
      const resolve = doneResolve
      doneResolve = null
      resolve({ usage: ev.usage as unknown as Record<string, unknown>, context: ev.context as unknown as Record<string, unknown> })
    }
  })

  const runTurns = async (label: string, count: number, targetChatId: string) => {
    for (let i = 0; i < count; i += 1) {
      const task = tasks[i % tasks.length]
      const startedAt = Date.now()
      const completion = new Promise<{ usage?: Record<string, unknown>; context?: Record<string, unknown> }>((resolve) => {
        doneResolve = resolve
        const timer = setTimeout(() => {
          doneResolve = null
          resolve({})
        }, 300000)
        timer.unref?.()
      })
      const result = await weportAiService.runChat(targetChatId, task, { consumer, tools: useTools } as never)
      const done = await completion
      const elapsedMs = Date.now() - startedAt
      const usage = done.usage || {}
      const context = done.context || {}
      const promptTokens = Number(usage.promptTokens) || 0
      const cacheHit = Number((usage as Record<string, unknown>).promptCacheHitTokens) || 0
      summary.turns.push({
        profile: label,
        index: i + 1,
        task: task.slice(0, 120),
        success: result.success === true,
        error: result.error || undefined,
        elapsedMs,
        promptTokens,
        completionTokens: Number(usage.completionTokens) || 0,
        reasoningTokens: Number(usage.reasoningTokens) || 0,
        promptCacheHitTokens: cacheHit,
        cacheHitRate: promptTokens > 0 ? Math.round((cacheHit / promptTokens) * 10000) / 100 : null,
        contextPromptTokens: Number(context.promptTokens) || 0,
        contextCacheHitTokens: Number(context.cacheHitTokens) || 0,
        contextRecentRate: Number(context.recentRate) || 0,
        contextWindow: Number(context.contextWindow) || 0,
      })
      log(`[${label}] turn ${i + 1}: ok=${result.success === true} ${elapsedMs}ms prompt=${promptTokens} cacheHit=${cacheHit} rate=${summary.turns.at(-1)!.cacheHitRate}${result.error ? ` error=${result.error}` : ''}`)
    }
  }

  // 目标 profile：默认用当前激活的那个；'all' 逐个试探 —— 网关会按地区拒绝模型，
  // "配置里存在"不等于"这台机器调得通"，所以需要一个能自己找出可用模型的模式。
  const target = String(process.env.WEPORT_AI_PROBE_PROFILE || 'active').trim()
  const originalActiveId = activeProfileId
  const batches: Array<Record<string, unknown>> = []
  let ok = true
  if (target === 'all') {
    const perProfileTurns = Math.max(1, Math.min(5, Number(process.env.WEPORT_AI_PROBE_ALL_TURNS) || 1))
    for (const profile of summary.profiles) {
      const activated = weportAiService.activateProviderProfile(profile.id)
      if (!activated.success) {
        log(`[${profile.model}] activate failed: ${activated.error}`)
        continue
      }
      // 每个 profile 一条独立对话：不把上一个模型的上下文带过去
      const scoped = weportAiService.createChat(`[ai-probe] ${profile.model}`)
      const before = summary.turns.length
      try {
        await runTurns(profile.model || profile.id, perProfileTurns, scoped.id)
      } finally {
        weportAiService.deleteChat(scoped.id)
      }
      batches.push({ profileId: profile.id, model: profile.model, providerId: profile.providerId, turns: summary.turns.slice(before) })
    }
    if (originalActiveId) weportAiService.activateProviderProfile(originalActiveId)
    ok = batches.some((b) => (b.turns as Array<Record<string, unknown>>).some((t) => t.success === true))
  } else {
    if (target && target !== 'active') {
      const match = summary.profiles.find((p) => p.id === target || p.name.includes(target) || p.model.includes(target))
      if (match) weportAiService.activateProviderProfile(match.id)
    }
    const label = weportAiService.getActiveProfileId() || 'active'
    await runTurns(label, turns, chat.id)
    ok = summary.turns.every((t) => t.success === true)
  }

  const rates = summary.turns.map((t) => Number(t.cacheHitRate)).filter((n) => Number.isFinite(n))
  const steady = rates.slice(1)
  const payload = {
    ...summary,
    batches,
    steadyStateCacheHitRate: steady.length > 0 ? Math.round((steady.reduce((a, b) => a + b, 0) / steady.length) * 100) / 100 : null,
    averageLatencyMs: Math.round(summary.turns.reduce((a, t) => a + Number(t.elapsedMs || 0), 0) / Math.max(1, summary.turns.length)),
    restoredActiveProfileId: weportAiService.getActiveProfileId(),
  }
  try {
    writeFileSync(join(outDir, 'probe.json'), JSON.stringify(payload, null, 2), 'utf8')
  } catch { /* noop */ }
  log(`steadyStateCacheHitRate = ${payload.steadyStateCacheHitRate}% averageLatencyMs = ${payload.averageLatencyMs}`)
  for (const batch of batches) {
    const first = (batch.turns as Array<Record<string, unknown>>)[0]
    log(`model ${String(batch.model)} [${String(batch.providerId)}] -> ok=${String(first?.success)} ${String(first?.error || '')}`)
  }

  weportAiService.deleteChat(chat.id)
  log(`${ok ? 'PASS' : 'FAIL'} (out: ${outDir})`)
  isAppQuitting = true
  try { chatService.close() } catch { /* noop */ }
  try { await wcdbService.shutdown() } catch { /* noop */ }
  try { mainWindow?.destroy() } catch { /* noop */ }
  mainWindow = null
  app.exit(ok ? 0 : 1)
}

function startApp() {
  installMainProcessErrorHandlers()
  const aiSelfTest = process.env.WEPORT_AI_SELFTEST === '1'
  const aiProbe = process.env.WEPORT_AI_PROBE === '1'
  if (process.platform !== 'win32' && process.platform !== 'darwin' && process.platform !== 'linux') {
    console.warn('[Weport] 当前平台未受支持（仅支持 Windows / macOS / Linux）')
  }

  // ---------------------------------------------------------------------------
  // Chromium 内存调优（v0.9.3，须在 app ready 前生效）
  // - js-flags: V8 堆封顶（默认按进程 ~2GB old space，384MB 足够本应用，
  //   提前触发 GC 降低稳态内存；4MB 半空间对渲染层/主进程均合适）
  // - disk-cache-size: HTTP 磁盘/内存缓存上限（头像已走 avatarCacheService
  //   本地磁盘缓存，CDN 缓存仅需极少量兜底）
  // 注意：不要用 appendSwitch('disable-features', …) 追加特性裁剪 ——
  // AppendSwitch 会整体覆盖 Electron 自身的默认 disable-features（含
  // SpareRendererForSitePerProcess 等），可能反而多出一个备用渲染进程。
  // ---------------------------------------------------------------------------
  try {
    app.commandLine.appendSwitch('js-flags', '--max-old-space-size=384 --max-semi-space-size=4')
    app.commandLine.appendSwitch('disk-cache-size', '16777216')
  } catch { /* noop */ }

  // 静默启动（--background 托盘常驻）无窗口渲染需求：关闭硬件加速，
  // 省掉 GPU 进程（实测 ~130MB 工作集 / ~312MB 私有提交）。
  // 窗口显示走软件光栅（文本/列表/ECharts 足够流畅）；通知弹窗在
  // Windows 走原生玻璃面板（D3D11 在原生侧，不受 Chromium GPU 影响）。
  if (startHidden) {
    try {
      app.disableHardwareAcceleration()
    } catch { /* noop */ }
  }
  // CI/无 GPU 会话下截图模式需要软件渲染（必须在 ready 前生效）。
  // 例外：桌面采集（WGC）在软件渲染下会以 E_ACCESSDENIED 失败，弹窗玻璃只能退回
  // 静态快照。要验证实时玻璃，用 WEPORT_SCREENSHOT_KEEP_GPU=1 保留 GPU。
  if (process.env.WEPORT_SCREENSHOT_POPUP === '1' && process.env.WEPORT_SCREENSHOT_KEEP_GPU !== '1') {
    try {
      app.commandLine.appendSwitch('disable-gpu')
    } catch { /* noop */ }
  }

  const gotLock = app.requestSingleInstanceLock()
  if (!gotLock) {
    app.quit()
    return
  }

  app.on('second-instance', (_event, argv) => {
    // 静默启动（--background）时忽略第二实例：开机自启的双实例竞争
    // （历史版本残留多个 Run 键）曾通过这里把隐藏的主窗口带出来。
    // 若用户已手动打开过窗口，则仅聚焦不重复显示。
    // 注意：startHidden 是本进程启动时的常量；用户在后台实例已运行时
    // 手动双击启动 Weport，新实例的 argv 没有 --background —— 此时必须
    // 把后台窗口带出来，否则用户的启动看起来毫无反应。
    const newInstanceIsBackground = Array.isArray(argv) && argv.includes('--background')
    if (startHidden && newInstanceIsBackground) {
      if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible()) {
        mainWindow.focus()
      }
      return
    }
    showMainWindow()
  })

  // 任务栏图标/分组标识（不设置时任务栏可能显示默认图标）
  try {
    app.setAppUserModelId('com.weport.desktop')
  } catch { /* noop */ }

  app.whenReady().then(async () => {
    // 环境标记：WCDB 宿主进程的 dev 模式判定
    process.env.WEPORT_DEV_MODE = app.isPackaged ? '' : '1'
    process.env.WEPORT_RESOURCES_PATH = resolveResourcesPath()
    process.env.WEPORT_USER_DATA_PATH = app.getPath('userData')

    configService = ConfigService.getInstance()

    // 头像本地磁盘缓存（weport-media:// 协议提供本地即时读取）
    avatarCacheService.init(configService.getCacheBasePath())

    // 视频背景的降采样缓存：把 4K 壁纸转成显示尺寸那一版，省下大部分解码。
    backgroundVideoService = new BackgroundVideoService(configService.getCacheBasePath())

    // weport-media://local/<encodeURIComponent(绝对路径)>：本地媒体只读协议
    // （仅允许文件存在时返回；用于朋友圈视频/图片预览 + 头像磁盘缓存）
    try {
      protocol.handle('weport-media', async (request) => {
        try {
          const url = new URL(request.url)
          const rawPath = decodeURIComponent(url.pathname.replace(/^\/+/, ''))
          if (!rawPath || !existsSync(rawPath)) {
            return new Response('Not Found', { status: 404 })
          }
          const fileUrl = pathToFileURL(rawPath).toString()
          return await net.fetch(fileUrl, { bypassCustomProtocolHandlers: true })
        } catch {
          return new Response('Not Found', { status: 404 })
        }
      })
    } catch (e) {
      console.warn('[Weport] 注册本地媒体协议失败:', e)
    }

    // One-time key bootstrap is needed by both the normal UI and the isolated
    // AI harness. It stays local and never writes the secret to diagnostics.
    const bootstrapKey = String(process.env.WEPORT_AI_BOOTSTRAP_KEY || '').trim()
    if (bootstrapKey && !String(configService?.get('weportAiApiKey') || '').trim()) {
      try {
        configService?.set('weportAiApiKey', bootstrapKey)
        console.log('[WeportAI] API 密钥已通过引导环境变量写入本地配置')
      } catch (e) {
        console.warn('[WeportAI] API 密钥引导写入失败:', e)
      }
    }

    const resourcesPath = resolveResourcesPath()
    const userDataPath = app.getPath('userData')
    wcdbService.setPaths(resourcesPath, userDataPath)
    wcdbService.setLogEnabled(configService.get('logEnabled') === true)

    // True headless path: no BrowserWindow, tray, notification monitor, updater,
    // registry synchronization, or visible renderer. Windows Electron can quit
    // a zero-window process while the WCDB host is active, so retain one hidden
    // 1x1 keep-alive window for the duration of the self-test only.
    if (aiSelfTest || aiProbe) {
      app.on('window-all-closed', () => { /* self-test owns explicit shutdown */ })
      mainWindow = new BrowserWindow({
        width: 1,
        height: 1,
        show: false,
        frame: false,
        skipTaskbar: true,
        focusable: false,
      })
      await (aiProbe ? runAiProbe() : runAiSelfTest())
      return
    }

    migrateLegacySettings()
    syncLaunchAtStartupPreference()
    cleanupLegacyAutostartEntries()
    applyUpdaterChannel()
    // 本地 HTTP API：配置开启时随应用启动（只读接口，默认仅 127.0.0.1）
    if (configService.get('httpApiEnabled') === true) {
      const port = Number(configService.get('httpApiPort') || 5031)
      const host = String(configService.get('httpApiHost') || '127.0.0.1')
      void httpService.start(port, host)
    }
    // 本地 MCP 服务（v0.9.5）：只读工具，Bearer token 认证，默认仅 127.0.0.1
    if (configService.get('mcpEnabled') !== false) {
      const port = Number(configService.get('mcpPort') || 5032)
      const host = String(configService.get('mcpHost') || '127.0.0.1')
      void mcpService.start(port, host)
    }

    registerIpcHandlers()
    setupNotificationPipeline()

    // TUI 引擎：不建窗口、不建托盘，`weport` 在终端里通过 stdio 驱动服务层。
    if (isCliMode) {
      await runCliHost()
      return
    }

    // 一次性服务配置（引导 / 密钥轮换）。放在窗口创建前，因为它要么改配置要么退出。
    if (process.env.WEPORT_AI_SETUP === '1') {
      await runAiSetup()
      return
    }

    // 模型元数据（models.dev）后台刷新：只在 TTL 过期时发一次条件 GET，304
    // 是 0 字节；失败只降级到磁盘缓存 + 内置快照，不影响任何 UI 路径。
    void refreshModelRegistry()

    // WeBot 调度器：启动时立刻 tick 一次，把应用未运行期间错过的任务按各自
    // 的补偿策略补上（见 services/weBotSchedule.ts）。
    ensureWeBotService().start()
    // 注册到只读 registry，供 HTTP API 与 MCP 对外暴露笔记/任务（单向依赖）。
    setWeBotService(ensureWeBotService())

    // WeportAI 事件 → 渲染进程（流式状态/工具执行/结果）
    weportAiService.setEventEmitter((event) => {
      try {
        mainWindow?.webContents.send('ai:event', event)
      } catch { /* noop */ }
    })

    // 后台预热联系人显示名/头像（不阻塞窗口显示；仅虚构演示截图跳过）。
    // 仅当需要常驻数据库连接（消息推送开启）或用户主动启动（非静默）时执行；
    // 静默启动时跳过可避免开机即拉起 WCDB 宿主进程与全部微信库连接（约 900MB），
    // 改为窗口打开时由 showMainWindow 按需预热
    if (!isDemoScreenshotMode && (configService.get('messagePushEnabled') === true || !startHidden)) {
      void warmupContactNames()
    } else if (!isDemoScreenshotMode && startHidden) {
      contactWarmupDeferred = true
    }

    // 微信 CDN 头像/图片请求头（否则弹窗头像 403 → 占位）。
    // 延迟到首次创建窗口 / 弹窗时注册（幂等，见 createWindow / onPush），
    // 避免静默启动时过早初始化网络栈而无谓拉起网络服务子进程

    // 主窗口：仅非静默启动时创建。--background 下不创建窗口，
    // 由托盘点击 / 通知点击经 showMainWindow() 按需创建，
    // 省掉隐藏的渲染/GPU/网络子进程约 1GB 常驻内存
    if (!startHidden) {
      mainWindow = createWindow(true)
    }

    createTray()

    // 通知服务：推送开关开启时启动（连接数据库并开启监控管道）
    if (configService.get('messagePushEnabled') || configService.get('antiRevokeAutoApplyNewGroups')) {
      messagePushService?.start()
    }

    // QA 模式统一跳过更新检查：演示/转储必须离线且不能让 updater 的
    // 网络错误污染渲染断言或用户的桌面。
    // 静默启动也跳过：无主窗口时横幅无处可送，等首次打开窗口再检查
    if (!isAnyQaMode && !startHidden) {
      checkForUpdatesOnStartup()
    }

    if (process.env.WEPORT_SCREENSHOT_POPUP === '1') {
      await runScreenshotMode()
      return
    }

    if (process.env.WEPORT_SELFTEST === '1') {
      await runSelfTest()
      return
    }

    if (process.env.WEPORT_UI_DUMP === '1') {
      await runUiDumpMode()
      return
    }

    if (process.env.WEPORT_V09_DUMP === '1') {
      await runV09DumpMode()
      return
    }

    // 真实数据转储：读取真实配置与真实数据库做只读验证（无任何演示数据）
    if (process.env.WEPORT_REAL_DUMP === '1') {
      await runRealDataDump()
      return
    }

    // 备份自检：连接真实库并把核心表快照打包到临时目录（只读验证 + 写临时文件）
    if (process.env.WEPORT_BACKUPTEST === '1') {
      const outDir = process.env.WEPORT_BACKUPTEST_OUT || join(app.getPath('temp'), 'weport-backuptest')
      try { mkdirSync(outDir, { recursive: true }) } catch { /* noop */ }
      const logFile = join(outDir, 'backup-test.log')
      const log = (msg: string) => {
        const line = `${new Date().toISOString()} ${msg}`
        console.log(line)
        try { appendFileSync(logFile, line + '\n') } catch { /* noop */ }
      }
      try {
        const connectResult = await chatService.connect()
        if (!connectResult.success) {
          log(`FAIL: connect -> ${connectResult.error}`)
          app.exit(1)
          return
        }
        const archive = join(outDir, 'backup-test.zip')
        const r = await backupService.createBackup(archive, { includeImages: false, includeVideos: false, includeFiles: false })
        log(`create = ${JSON.stringify(r)}`)
        if (!r.success) {
          app.exit(1)
          return
        }
        const inspect = await backupService.inspectBackup(archive)
        log(`inspect = ${JSON.stringify(inspect)}`)
        app.exit(inspect.success ? 0 : 1)
      } catch (e) {
        log(`FAIL: ${String(e)}`)
        app.exit(1)
      }
      return
    }

    // 更新器自检：拉取更新源 latest.yml 并报告结果（用于发布前验证管道）。
    // WEPORT_UPDATETEST_INSTALL=1 时继续走完整下载 → 安装 → 自动重启流程
    // （本地测试源 + 同版本安装包模拟；验证 quitAndInstall 全链路）。
    if (process.env.WEPORT_UPDATETEST === '1') {
      const result = await checkForUpdatesManual()
      console.log('[updatetest] feed =', getUpdaterFeedUrl())
      console.log('[updatetest] version =', APP_VERSION)
      console.log('[updatetest] result =', JSON.stringify(result))
      const writeLog = (extra: Record<string, unknown> = {}) => {
        try {
          const { appendFileSync } = require('fs')
          appendFileSync(
            process.env.WEPORT_UPDATETEST_OUT || join(app.getPath('temp'), 'weport-updatetest.log'),
            JSON.stringify({ appVersion: APP_VERSION, feed: getUpdaterFeedUrl(), result, ...extra, at: new Date().toISOString() }) + '\n',
          )
        } catch { /* noop */ }
      }
      if (process.env.WEPORT_UPDATETEST_INSTALL === '1') {
        if (!result.hasUpdate) {
          writeLog({ install: 'skipped-no-update' })
          isAppQuitting = true
          app.exit(2)
          return
        }
        // 走完整下载流程；完成后 downloadAndInstall 内部会触发 quitAndInstall
        // （退出 → 静默安装 → --force-run 重启），此处不 app.exit，交给更新器
        console.log('[updatetest] starting download+install...')
        const dl = await downloadAndInstall()
        writeLog({ install: dl })
        if (!dl.success) {
          isAppQuitting = true
          app.exit(3)
        }
        return
      }
      writeLog()
      isAppQuitting = true
      app.exit(result.hasUpdate ? 0 : 2)
      return
    }

    app.on('activate', () => {
      showMainWindow()
    })
  })

  app.on('before-quit', () => {
    void shutdownAppServices()
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      if (!isAppQuitting && tray) {
        // 托盘模式：窗口全关不等于退出（正常流程走 hide，这里兜底）
        return
      }
      app.quit()
    }
  })
}

const shutdownAppServices = async (): Promise<void> => {
  if (shutdownPromise) return shutdownPromise
  shutdownPromise = (async () => {
    isAppQuitting = true
    if (updateCheckTimer) clearTimeout(updateCheckTimer)
try { tray?.destroy() } catch { /* noop */ }
    tray = null
    destroyNotificationWindow()
    try { await httpService.stop() } catch { /* noop */ }
    try { await mcpService.stop() } catch { /* noop */ }
    // WeBot：先停调度再中止对话，避免退出过程中又派发新任务。
    try { weBotService?.stop() } catch { /* noop */ }
    // WeClone：中止正在进行的克隆生成
    try { weCloneService.cancel() } catch { /* noop */ }
    messagePushService?.stop()
    for (const chatId of weportAiService.listChats().map((c) => c.id)) {
      weportAiService.abort(chatId)
    }
    const forceExitTimer = setTimeout(() => {
      console.warn('[Weport] Force exit after timeout')
      // app.exit 会等待 IPC 子进程（WCDB 宿主）回收；先强杀宿主再退出
      try { wcdbService.killHostNow() } catch { /* noop */ }
      app.exit(0)
    }, 5000)
    forceExitTimer.unref()
    try { chatService.close() } catch { /* noop */ }
    try { await wcdbService.shutdown() } catch { /* noop */ }
  })()
  return shutdownPromise
}

export { startApp }

