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
import { join } from 'path'
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'fs'
import { ConfigService } from './services/config'
import { chatService } from './services/chatService'
import { wcdbService } from './services/wcdbService'
import { exportService } from './services/export'
import { exportTaskControlService } from './services/exportTaskControlService'
import { dbPathService } from './services/dbPathService'
import { KeyService } from './services/keyService'
import { MessagePushService } from './services/messagePushService'
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

const syncLaunchAtStartupPreference = () => {
  if (!configService) return
  const reason = getLaunchAtStartupUnsupportedReason()
  if (reason) return
  const stored = configService.get('launchAtStartup')
  const system = getSystemLaunchAtStartup()
  if (typeof stored !== 'boolean') {
    configService.set('launchAtStartup', system)
    return
  }
  if (stored === system) return
  const result = setSystemLaunchAtStartup(stored)
  configService.set('launchAtStartup', result.enabled)
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
    for (const name of ['TXT', 'JSON', EXPORT_LOG_NAME]) {
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
  ipcMain.handle('export:exportSessions', async (_e, outputRoot: string, format: string, options?: any) => {
    const root = String(outputRoot || '').trim()
    const fmt = format === 'json' ? 'json' : 'txt'
    if (!root) return { success: false, successCount: 0, failCount: 1, error: '未指定输出目录' }

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
      return { success: true, successCount: 0, failCount: 0, skipped: true, formatFolder: fmt === 'json' ? 'JSON' : 'TXT' }
    }

    const formatFolder = fmt === 'json' ? 'JSON' : 'TXT'
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

    const exportOptions = {
      format: fmt,
      contentType: 'text' as const,
      exportMedia: false,
      sessionLayout: 'shared' as const,
      sessionNameWithTypePrefix: true,
      exportWriteLayout: 'C' as const,
      exportConflictStrategy: 'overwrite' as const,
      displayNamePreference: 'group-nickname' as const,
      exportPathStyle: 'windows' as const,
      ...(options || {}),
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
      writeExportLog(root, fmt, when, result.successCount || 0, result.failCount || 0)
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

  // 等待渲染进程加载完成
  for (let i = 0; i < 30; i += 1) {
    if (mainWindow && !mainWindow.webContents.isLoading()) break
    await sleep(250)
  }
  await sleep(800)

  // 主窗口截图（CI 上首帧可能未就绪：轮询直到非空）
  try {
    if (mainWindow && !mainWindow.isDestroyed()) {
      const isBlank = (buf: Buffer) => {
        if (buf.length < 16) return true
        let min = 255
        let max = 0
        for (let i = 0; i < buf.length; i += 997) {
          const v = buf[i]
          if (v < min) min = v
          if (v > max) max = v
        }
        return max - min < 12
      }
      let saved = false
      for (let attempt = 0; attempt < 20; attempt += 1) {
        const image = await captureWithTimeout(mainWindow, 8000)
        if (image) {
          const png = image.toPNG()
          if (!isBlank(png)) {
            const fs2 = await import('fs')
            fs2.writeFileSync(join(outDir, 'main.png'), png)
            console.log('[screenshot] main.png saved (attempt', attempt + 1, ')')
            saved = true
            break
          }
        }
        await sleep(400)
      }
      if (!saved) console.warn('[screenshot] main capture stayed blank after retries')
    }
  } catch (e) {
    console.warn('[screenshot] main capture failed:', e)
  }

  // 弹窗截图（独立通知窗口）
  try {
    const payload = {
      sessionId: 'weport-test',
      channel: 'message',
      title: 'Weport 测试通知',
      content: '这是一条测试通知 · 独立置顶弹窗',
      timestamp: Math.floor(Date.now() / 1000),
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

      // 轮询捕获直到画面非空（冷启动/字体加载较慢时固定等待会拿到空白帧；
      // 阈值取 40 保证等到的是一张完全渲染的卡片，而非入场渐隐中的半透明帧）
      const isBlank = (buf: Buffer) => {
        if (buf.length < 16) return true
        let min = 255
        let max = 0
        for (let i = 0; i < buf.length; i += 997) {
          const v = buf[i]
          if (v < min) min = v
          if (v > max) max = v
        }
        return max - min < 40
      }
      let saved = false
      for (let attempt = 0; attempt < 30; attempt += 1) {
        const image = await captureWithTimeout(popup, 8000)
        if (image) {
          const png = image.toPNG()
          if (!isBlank(png)) {
            const fs2 = await import('fs')
            fs2.writeFileSync(join(outDir, 'popup.png'), png)
            console.log('[screenshot] popup.png saved (attempt', attempt + 1, ') size =', image.getSize())
            saved = true
            break
          }
        } else {
          console.warn('[screenshot] popup capture attempt', attempt + 1, 'timed out')
        }
        await sleep(300)
      }
      if (!saved) {
        console.warn('[screenshot] popup capture stayed blank after retries')
      }
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
// 启动 / 退出
// ---------------------------------------------------------------------------
function startApp() {
  if (process.platform !== 'win32') {
    console.warn('[Weport] 当前仅支持 Windows')
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
    migrateLegacySettings()
    syncLaunchAtStartupPreference()
    applyUpdaterChannel()

    const resourcesPath = resolveResourcesPath()
    const userDataPath = app.getPath('userData')
    wcdbService.setPaths(resourcesPath, userDataPath)
    wcdbService.setLogEnabled(configService.get('logEnabled') === true)

    registerIpcHandlers()
    setupNotificationPipeline()

    // 微信 CDN 头像/图片请求头（否则弹窗头像 403 → 占位）
    ensureWeChatRequestHeaderInterceptor()

    // 主窗口（托盘隐藏/静默启动时先建后隐藏）
    const startHidden = process.argv.includes('--background')
    mainWindow = createWindow(!startHidden)

    createTray()

    // 通知服务：推送开关开启时启动（连接数据库并开启监控管道）
    if (configService.get('messagePushEnabled')) {
      messagePushService?.start()
    }

    checkForUpdatesOnStartup()

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
