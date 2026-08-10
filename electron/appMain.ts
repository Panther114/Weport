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
} from 'electron'
import { autoUpdater } from 'electron-updater'
import { dirname, join } from 'path'
import { appendFileSync, existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'fs'
import { ConfigService } from './services/config'
import { chatService } from './services/chatService'
import { wcdbService } from './services/wcdbService'
import { exportService } from './services/export'
import { exportTaskControlService } from './services/exportTaskControlService'
import { dbPathService } from './services/dbPathService'
import { KeyService } from './services/keyService'
import { MessagePushService } from './services/messagePushService'
import { weportAiService } from './services/weportAiService'
import {
  registerNotificationHandlers,
  destroyNotificationWindow,
  showNotification,
  setNotificationNavigateHandler,
} from './windows/notificationWindow'
import type { MessagePushPayload } from './services/messagePushService'

const isDev = !!process.env.VITE_DEV_SERVER_URL
const APP_VERSION = app.getVersion()

let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
let isAppQuitting = false
let mainWindowReady = false
let configService: ConfigService | null = null
let messagePushService: MessagePushService | null = null
let shutdownPromise: Promise<void> | null = null
/** 是否以静默方式启动（开机自启 Run 键带 --background，主窗口保持隐藏） */
const startHidden = process.argv.includes('--background')
/** QA 截图模式（scripts/capture-ui.ps1 驱动）：全程使用脱敏演示数据，不读取真实配置 */
const isScreenshotMode = process.env.WEPORT_SCREENSHOT_POPUP === '1'

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
// 开机自启（直接写 HKCU Run 键 —— Electron 的 setLoginItemSettings 在本构建
// 上静默失效，且旧版 Rust 应用就是写注册表，保持同一机制）
// ---------------------------------------------------------------------------
const RUN_KEY_PATH = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'
const RUN_VALUE_NAME = 'Weport'

const getLaunchAtStartupUnsupportedReason = (): string | null => {
  if (!app.isPackaged) return '仅安装后的版本支持开机自启动'
  return null
}

const getSystemLaunchAtStartup = (): boolean => {
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

const setSystemLaunchAtStartup = (enabled: boolean): { success: boolean; enabled: boolean; error?: string } => {
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

/** 读取当前 Run 键的启动命令值（不含则返回 null） */
const getRunKeyValue = (): string | null => {
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
  // 已开启时：不仅要保证 Run 键存在，还要保证命令行参数与 silentStartup 一致
  // （否则「启动时隐藏到托盘」勾选开启但开机仍然弹窗——只有再点一次开关才会生效）
  const desired = `"${process.execPath}"${silent ? ' --background' : ''}`
  if (getRunKeyValue() === desired) return
  setSystemLaunchAtStartup(true)
}

/**
 * 清理历史版本（v0.7.x 早期用 setLoginItemSettings）残留的 electron.app.* Run 值：
 * - `electron.app.Electron` 可能指向开发目录的 node_modules\electron，开机时会把
 *   裸 Electron 一起拉起（表现为开机多出一个 "Electron" 窗口）；
 * - `electron.app.Weport` 与当前 `Weport` 值重复，会造成开机双实例竞争，触发
 *   second-instance 把静默启动（--background）的主窗口带出来。
 */
const cleanupLegacyAutostartEntries = () => {
  const { execFileSync } = require('child_process') as typeof import('child_process')
  const cmd = process.env.ComSpec || 'cmd.exe'
  for (const name of ['electron.app.Weport', 'electron.app.Electron']) {
    try {
      const stdout = execFileSync(cmd, ['/c', 'reg', 'query', RUN_KEY_PATH, '/v', name], {
        encoding: 'utf8',
        windowsHide: true,
      })
      const line = stdout.split(/\r?\n/).map((l) => l.trim()).find((l) => l.includes('REG_SZ'))
      if (!line) continue
      const target = line.slice(line.indexOf('REG_SZ') + 6).trim().replace(/^"|"$/g, '')
      const isOurs = target.includes('Weport') || target.toLowerCase().includes('node_modules\\electron')
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
let isDownloadInProgress = false
let updateCheckTimer: NodeJS.Timeout | null = null

const getUpdaterFeedUrl = (): string => {
  // WEPORT_UPDATE_URL 可覆盖更新源（测试镜像/自建源）；默认 GitHub Releases
  const override = process.env.WEPORT_UPDATE_URL
  if (override && /^https?:\/\//.test(override)) return override
  return 'https://github.com/Panther114/Weport/releases/latest/download'
}

const applyUpdaterChannel = () => {
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.disableDifferentialDownload = true
  try {
    autoUpdater.setFeedURL({ provider: 'generic', url: getUpdaterFeedUrl() })
  } catch (e) {
    console.warn('[Weport] 设置更新源失败:', e)
  }
}

// 简单 semver 比较（a > b 返回 true）
function isNewerVersion(a: string, b: string): boolean {
  const pa = String(a || '').split('.').map((x) => parseInt(x, 10) || 0)
  const pb = String(b || '').split('.').map((x) => parseInt(x, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const va = pa[i] || 0
    const vb = pb[i] || 0
    if (va > vb) return true
    if (va < vb) return false
  }
  return false
}

async function checkForUpdatesManual(): Promise<{
  hasUpdate: boolean
  version?: string
  releaseNotes?: string
  error?: string
}> {
  if (!app.isPackaged) return { hasUpdate: false, error: '开发模式不检查更新' }
  applyUpdaterChannel()
  try {
    const result = await autoUpdater.checkForUpdates()
    const info = result?.updateInfo
    if (!info || !isNewerVersion(String(info.version || ''), APP_VERSION)) return { hasUpdate: false }
    const ignored = configService?.get('ignoredUpdateVersion')
    if (ignored && ignored === info.version) return { hasUpdate: false }
    return { hasUpdate: true, version: info.version, releaseNotes: String(info.releaseNotes || '') }
  } catch (e) {
    return { hasUpdate: false, error: String((e as Error)?.message || e) }
  }
}

function checkForUpdatesOnStartup() {
  if (!app.isPackaged) return
  const ignored = configService?.get('ignoredUpdateVersion')
  updateCheckTimer = setTimeout(async () => {
    try {
      const result = await autoUpdater.checkForUpdates()
      const info = result?.updateInfo
      if (!info || !isNewerVersion(String(info.version || ''), APP_VERSION)) return
      if (ignored && ignored === info.version) return
      mainWindow?.webContents.send('app:updateAvailable', {
        version: info.version,
        releaseNotes: String(info.releaseNotes || ''),
      })
    } catch (e) {
      console.warn('[Weport] 启动更新检查失败:', e)
    }
  }, 3000)
  updateCheckTimer.unref?.()
}

async function downloadAndInstall(): Promise<{ success: boolean; error?: string }> {
  if (!app.isPackaged) return { success: false, error: '开发模式不可更新' }
  if (isDownloadInProgress) return { success: false, error: '正在下载中' }
  applyUpdaterChannel()
  isDownloadInProgress = true
  try {
    return await new Promise((resolve) => {
      const onProgress = (info: { percent?: number; transferred?: number; total?: number }) => {
        mainWindow?.webContents.send('app:downloadProgress', info)
      }
      autoUpdater.on('download-progress', onProgress)
      autoUpdater.once('update-downloaded', () => {
        autoUpdater.removeListener('download-progress', onProgress)
        resolve({ success: true })
      })
      autoUpdater.once('error', (e) => {
        autoUpdater.removeListener('download-progress', onProgress)
        resolve({ success: false, error: String(e?.message || e) })
      })
      void autoUpdater.downloadUpdate().catch((e) => {
        resolve({ success: false, error: String(e?.message || e) })
      })
    })
  } finally {
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
    void showNotification(buildPopupData(payload))
  })
  setNotificationNavigateHandler(() => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (!mainWindow.isVisible()) mainWindow.show()
      mainWindow.focus()
    }
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
  } catch (e) {
    console.warn('[Weport] 联系人预热失败:', e)
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
    },
  })

  win.once('ready-to-show', () => {
    mainWindowReady = true
    if (autoShow) win.show()
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

  if (isDev) {
    win.loadURL(process.env.VITE_DEV_SERVER_URL!)
  } else {
    win.loadFile(join(__dirname, '../dist/index.html'))
  }
  return win
}

/** 隐藏到托盘：必须同时移除任务栏按钮，否则关闭后窗口仍留在任务栏 */
function hideMainWindowToTray() {
  if (!mainWindow || mainWindow.isDestroyed()) return
  try {
    mainWindow.setSkipTaskbar(true)
  } catch { /* noop */ }
  mainWindow.hide()
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    mainWindow = createWindow(true)
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
// IPC
// ---------------------------------------------------------------------------
function registerIpcHandlers() {
  void registerNotificationHandlers()

  ipcMain.on('notification-clicked', (_event, _payload) => {
    showMainWindow()
  })

  // 配置
  ipcMain.handle('config:get', (_e, key: string) => (configService as any)?.get(key))
  ipcMain.handle('config:set', async (_e, key: string, value: unknown) => {
    (configService as any)?.set(key, value)
    if (key === 'launchAtStartup') {
      applyLaunchAtStartupPreference(value === true)
    }
    if (key === 'silentStartup' && configService?.get('launchAtStartup')) {
      applyLaunchAtStartupPreference(true)
    }
    if (['messagePushEnabled', 'notificationEnabled', 'dbPath', 'decryptKey', 'myWxid'].includes(key)) {
      if (configService?.get('messagePushEnabled')) messagePushService?.start()
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

  // 对话框 / 外壳
  ipcMain.handle('dialog:openDirectory', (_e, options?: any) =>
    dialog.showOpenDialog(mainWindow!, {
      properties: ['openDirectory'],
      ...(options || {}),
    }).then((r) => (r.canceled ? null : r.filePaths[0])))
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

  // 数据库路径
  ipcMain.handle('dbpath:autoDetect', () => dbPathService.autoDetect())
  ipcMain.handle('dbpath:scanWxids', (_e, rootPath: string) => dbPathService.scanWxids(String(rootPath || '')))
  ipcMain.handle('dbpath:getDefault', () => dbPathService.getDefaultPath())

  // 密钥
  ipcMain.handle('key:autoGetDbKey', async () => {
    const keyService = new KeyService()
    const result = await keyService.autoGetDbKey(180_000, (message, level) => {
      mainWindow?.webContents.send('key:dbKeyStatus', { message, level })
    })
    return result
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
    let sessionIds = (sessionsResult.sessions as Array<{ username: string }>)
      .map((s) => String(s?.username || '').trim())
      .filter(Boolean)

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
      mainWindow?.webContents.send('export:progress', progress)
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
      }
    } catch (e) {
      return { success: false, successCount: 0, failCount: sessionIds.length, error: String((e as Error)?.message || e) }
    } finally {
      exportTaskControlService.releaseTask(taskId)
    }
  })
  ipcMain.handle('export:cancelTask', (_e, taskId: string) => {
    exportTaskControlService.cancelTask(String(taskId || ''))
    return { success: true }
  })
  ipcMain.handle('export:getExportLog', (_e, outputRoot: string) => readExportLog(String(outputRoot || '')))
  ipcMain.handle('export:clearLibrary', (_e, outputRoot: string) => clearExportLibrary(String(outputRoot || '')))

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

  // -------------------------------------------------------------------------
  // WeportAI（v0.8 聊天历史分析助手）
  // -------------------------------------------------------------------------
  ipcMain.handle('ai:getSetup', () => weportAiService.getSetup())
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

  // 截图模式：用演示数据覆盖会暴露个人信息的通道（真实配置/微信数据绝不进截图）
  if (isScreenshotMode) installScreenshotDemoHandlers()
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
    case 'messagePushEnabled':
      return true
    case 'notificationEnabled':
      return false
    default:
      return (configService as any)?.get(key)
  }
}

function demoAiSetup() {
  return {
    hasApiKey: true,
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-v4-flash',
    maxTokens: 32768,
    reasoningEffort: 'high',
    maxSteps: 48,
    customPrompt: '',
    workspaceRoot: DEMO_WORKSPACE,
    exportPath: DEMO_EXPORT_PATH,
    dbReady: true,
    disabledTools: [],
    maxToolChars: 12000,
    conversationLimit: 60,
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
  const override = (channel: string, handler: (...args: any[]) => unknown) => {
    ipcMain.removeHandler(channel)
    ipcMain.handle(channel, handler)
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
}

// ---------------------------------------------------------------------------
// QA 截图模式（capture-ui.ps1 驱动）
// ---------------------------------------------------------------------------
async function runScreenshotMode() {
  const outDir = process.env.WEPORT_SCREENSHOT_OUT || join(app.getPath('temp'), 'weport-screenshots')
  try {
    mkdirSync(outDir, { recursive: true })
  } catch { /* noop */ }

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
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

  // 等待渲染进程加载完成
  for (let i = 0; i < 30; i += 1) {
    if (mainWindow && !mainWindow.webContents.isLoading()) break
    await sleep(250)
  }
  // 等「找到 N 个账号」之类的 toast 过期 + 字体/首屏稳定，避免入画
  await sleep(4000)

  // 稳定帧捕获：轮询直到画面非空，再隔 400ms 复拍一帧；
  // 两帧 PNG 字节完全一致 = 画面已静止（入场动画/滚动/渐隐/半透明帧都会失败重试）。
  // 这样 README 里的截图永远不会是淡出中的残影帧
  const saveStable = async (win: BrowserWindow, file: string, threshold = 12, maxAttempts = 24) => {
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

  const clickTab = (label: string) =>
    (mainWindow?.webContents
      .executeJavaScript(
        `(() => { const b = Array.from(document.querySelectorAll('.tab')).find((el) => el.textContent.includes(${JSON.stringify(label)})); if (b) { b.click(); return true } return false })()`,
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
      await saveStable(mainWindow, 'main.png')
      await dumpRects('main-rects.json', [
        '.tab', '.primary-btn', '.account-item', '.callout', '.toast', '.path-input', '.checklist',
      ])
    } catch (e) {
      console.warn('[screenshot] main capture failed:', e)
    }
  }

  // 2) 导出数据页
  if (mainWindow && !mainWindow.isDestroyed()) {
    try {
      await clickTab('导出数据')
      if (await waitForDom('.format-grid')) {
        await sleep(500)
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
        console.warn('[screenshot] export tab did not render')
      }
    } catch (e) {
      console.warn('[screenshot] export capture failed:', e)
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
        console.warn('[screenshot] antirecall tab did not render')
      }
    } catch (e) {
      console.warn('[screenshot] antirecall capture failed:', e)
    }
  }

  // 4) 消息通知页（打开监听开关 → 绿色呼吸状态点）
  if (mainWindow && !mainWindow.isDestroyed()) {
    try {
      await clickTab('消息通知')
      if (await waitForDom('.checklist')) {
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
          '.switch-label', '.status-dot', '.check-row', '.checklist', '.setting-row',
        ])
      } else {
        console.warn('[screenshot] notifications tab did not render')
      }
    } catch (e) {
      console.warn('[screenshot] notifications capture failed:', e)
    }
  }

  // 5) WeportAI 页（演示会话由截图演示处理器注入，含工具调用与笔记面板）
  if (mainWindow && !mainWindow.isDestroyed()) {
    try {
      await clickTab('WeportAI')
      if ((await waitForDom('.ai-shell')) && (await waitForDom('.ai-msg'))) {
        await sleep(500)
        await saveStable(mainWindow, 'ai.png', 12, 30)
        await dumpRects('ai-rects.json', [
          '.ai-input', '.ai-send', '.ai-chat-item', '.ai-ws-note', '.ai-ws-usage', '.ai-msg', '.ai-ws-body',
        ])
      } else {
        console.warn('[screenshot] AI tab did not render')
      }
    } catch (e) {
      console.warn('[screenshot] AI capture failed:', e)
    }
  }

  // 6) 通知弹窗（persistent：卡片不自动淡出，稳定帧捕获必然拿到完整不透明卡片）
  try {
    const payload = {
      sessionId: 'family@chatroom',
      channel: 'message',
      title: '一家人 · Max Shuang',
      content: '晚上一起吃饭？6 点老地方见',
      avatarUrl: process.env.WEPORT_SCREENSHOT_AVATAR_URL || '',
      timestamp: Math.floor(Date.now() / 1000),
      persistent: true,
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
      // 内容保护会排除该窗口被采集（含 capturePage），截图模式临时关闭
      try {
        popup.setContentProtection(false)
      } catch { /* noop */ }

      // 等待渲染器加载完成
      for (let i = 0; i < 30 && popup.webContents.isLoading(); i += 1) {
        await sleep(250)
      }
      // 等卡片入场动画 + 玻璃面板就绪；若指定了真实头像，多等 CDN 加载完成
      await sleep(payload.avatarUrl ? 5000 : 1500)
      await saveStable(popup, 'popup.png', 40, 40)
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
    } else {
      console.warn('[screenshot] popup window not found')
    }
  } catch (e) {
    console.warn('[screenshot] popup capture failed:', e)
  }

  console.log('[screenshot] captures done, shutting down services...')
  try { messagePushService?.stop() } catch { /* noop */ }
  try { chatService.close() } catch { /* noop */ }
  // 不 await 完整 shutdown（宿主调用可能卡住 180s）——直接强杀宿主后退出
  try { wcdbService.killHostNow() } catch { /* noop */ }
  console.log('[screenshot] services stopped, exiting...')
  await sleep(200)
  console.log('[screenshot] calling app.exit(0)')
  isAppQuitting = true
  app.exit(0)
  console.log('[screenshot] app.exit returned, forcing process.exit')
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
      const buttons = Array.from(document.querySelectorAll('.tab'));
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
function startApp() {
  if (process.platform !== 'win32') {
    console.warn('[Weport] 当前仅支持 Windows')
  }

  const aiSelfTest = process.env.WEPORT_AI_SELFTEST === '1'
  if (aiSelfTest) {
    // Electron otherwise shows one modal dialog per uncaught main-process
    // exception. A headless harness must fail once and leave a searchable log,
    // never spray JavaScript error popups onto the user's desktop.
    const fatalLog = join(
      process.env.WEPORT_AI_SELFTEST_OUT || app.getPath('temp'),
      'fatal.log',
    )
    const recordFatal = (kind: string, error: unknown) => {
      try {
        mkdirSync(dirname(fatalLog), { recursive: true })
        appendFileSync(fatalLog, `${new Date().toISOString()} ${kind}: ${String((error as Error)?.stack || error)}\n`, 'utf8')
      } catch { /* noop */ }
    }
    const isBrokenPipe = (error: unknown) => (error as NodeJS.ErrnoException)?.code === 'EPIPE'
    // Packaged Electron detaches from the launching shell on Windows. Any later
    // console output can then target a closed stdout/stderr pipe; that is a
    // transport condition, not an application failure and must never produce a
    // JavaScript modal or terminate a long-running agent test.
    process.stdout?.on('error', (error) => {
      if (!isBrokenPipe(error)) recordFatal('stdout', error)
    })
    process.stderr?.on('error', (error) => {
      if (!isBrokenPipe(error)) recordFatal('stderr', error)
    })
    process.on('uncaughtException', (error) => {
      if (isBrokenPipe(error)) return
      recordFatal('uncaughtException', error)
      isAppQuitting = true
      app.exit(1)
    })
    process.on('unhandledRejection', (error) => recordFatal('unhandledRejection', error))
  }

  // CI/无 GPU 会话下截图模式需要软件渲染（必须在 ready 前生效）
  if (process.env.WEPORT_SCREENSHOT_POPUP === '1') {
    try {
      app.commandLine.appendSwitch('disable-gpu')
    } catch { /* noop */ }
  }

  const gotLock = app.requestSingleInstanceLock()
  if (!gotLock) {
    app.quit()
    return
  }

  app.on('second-instance', () => {
    // 静默启动（--background）时忽略第二实例：开机自启的双实例竞争
    // （历史版本残留多个 Run 键）曾通过这里把隐藏的主窗口带出来。
    // 若用户已手动打开过窗口，则仅聚焦不重复显示。
    if (startHidden) {
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
    if (aiSelfTest) {
      app.on('window-all-closed', () => { /* self-test owns explicit shutdown */ })
      mainWindow = new BrowserWindow({
        width: 1,
        height: 1,
        show: false,
        frame: false,
        skipTaskbar: true,
        focusable: false,
      })
      await runAiSelfTest()
      return
    }

    migrateLegacySettings()
    syncLaunchAtStartupPreference()
    cleanupLegacyAutostartEntries()
    applyUpdaterChannel()

    registerIpcHandlers()
    setupNotificationPipeline()

    // WeportAI 事件 → 渲染进程（流式状态/工具执行/结果）
    weportAiService.setEventEmitter((event) => {
      try {
        mainWindow?.webContents.send('ai:event', event)
      } catch { /* noop */ }
    })

    // 后台预热联系人显示名/头像（不阻塞窗口显示；截图模式跳过：演示数据无真实会话）
    if (!isScreenshotMode) {
      void warmupContactNames()
    }

    // 微信 CDN 头像/图片请求头（否则弹窗头像 403 → 占位）
    ensureWeChatRequestHeaderInterceptor()

    // 主窗口（托盘隐藏/静默启动时先建后隐藏）
    mainWindow = createWindow(!startHidden)

    createTray()

    // 通知服务：推送开关开启时启动（连接数据库并开启监控管道）
    if (configService.get('messagePushEnabled')) {
      messagePushService?.start()
    }

    // 截图模式：跳过更新检查（避免更新横幅入画）
    if (!isScreenshotMode) {
      checkForUpdatesOnStartup()
    }

    if (startHidden && mainWindow) {
      mainWindow.hide()
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

    // 更新器自检：拉取更新源 latest.yml 并报告结果（用于发布前验证管道）
    if (process.env.WEPORT_UPDATETEST === '1') {
      const result = await checkForUpdatesManual()
      console.log('[updatetest] feed =', getUpdaterFeedUrl())
      console.log('[updatetest] version =', APP_VERSION)
      console.log('[updatetest] result =', JSON.stringify(result))
      try {
        const { appendFileSync } = require('fs')
        appendFileSync(
          process.env.WEPORT_UPDATETEST_OUT || join(app.getPath('temp'), 'weport-updatetest.log'),
          JSON.stringify({ appVersion: APP_VERSION, feed: getUpdaterFeedUrl(), result, at: new Date().toISOString() }) + '\n',
        )
      } catch { /* noop */ }
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
