import { app, BrowserWindow, ipcMain, shell, dialog } from 'electron'
import { join, dirname, resolve } from 'path'
import { mkdirSync } from 'fs'

// Set the portable profile before importing services with module singletons.
const root = resolve(process.env.PORTABLE_EXECUTABLE_DIR || (app.isPackaged ? dirname(app.getPath('exe')) : join(process.cwd(), 'release', 'flash-data')))
const dataDir = join(root, 'data')
mkdirSync(dataDir, { recursive: true })
app.setPath('userData', dataDir)
app.setName('WeportFlash')
const ownsProfile = app.requestSingleInstanceLock()
if (!ownsProfile) app.quit()

type FlashWorkflow = Awaited<ReturnType<typeof import('./flash/workflow').createFlashWorkflow>>

let win: BrowserWindow | null = null
let workflow: FlashWorkflow | null = null
let workflowPromise: Promise<FlashWorkflow> | null = null
let windowCreated = false
const probe = process.env.WEPORT_PROBE_OFFSCREEN === '1'

const getWorkflow = (): Promise<FlashWorkflow> => {
  if (!workflowPromise) {
    workflowPromise = import('./flash/workflow')
      .then(({ createFlashWorkflow }) => createFlashWorkflow(root, (channel, payload) => {
        if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
      }))
      .then((created) => {
        workflow = created
        return created
      })
  }
  return workflowPromise
}

function reportWorkflowStartupError(error: unknown): void {
  const detail = error instanceof Error ? error.message : String(error)
  console.error('[WeportFlash] 引擎初始化失败:', detail)
  const current = win
  if (!current || current.isDestroyed()) return
  const notify = () => {
    if (!current.isDestroyed()) {
      current.webContents.send('flash:error', {
        message: `引擎初始化失败：${detail}`,
        next: '检查便携包是否完整、程序目录是否可写，然后重新启动。',
      })
    }
  }
  if (current.webContents.isLoading()) current.webContents.once('did-finish-load', notify)
  else notify()
}

if (ownsProfile) {
  // The shell is available before any engine import, so cold engine startup cannot
  // delay the first window or leave Windows Electron with zero BrowserWindows.
  app.on('before-quit', () => workflow?.close())
  void app.whenReady().then(async () => {
    ipcMain.handle('flash:info', () => ({ version: app.getVersion(), exportRoot: join(root, 'exports'), dataDir }))
    ipcMain.handle('flash:accounts', async () => (await getWorkflow()).accounts())
    ipcMain.handle('flash:chooseDirectory', async () => {
      if (!win || win.isDestroyed()) return { success: false }
      const active = await getWorkflow()
      if (active.busy()) return { success: false, error: '请等待导出结束' }
      const result = await dialog.showOpenDialog(win, { title: '选择微信 xwechat_files 目录', properties: ['openDirectory'] })
      if (result.canceled || !result.filePaths[0]) return { success: false }
      return active.setDbPath(result.filePaths[0])
    })
    ipcMain.handle('flash:start', async (_event, skipMedia: unknown, account: unknown) => {
      const active = await getWorkflow()
      return active.run(skipMedia === true, typeof account === 'string' ? account : undefined)
    })
    ipcMain.handle('flash:openFolder', async () => {
      const output = workflow?.lastOutputDir()
      if (output) return shell.openPath(output)
      return ''
    })

    win = new BrowserWindow({ width: 580, height: 340, minWidth: 500, minHeight: 300,
      ...(probe ? { x: -4000, y: 0 } : {}), show: false, autoHideMenuBar: true,
      webPreferences: { preload: join(import.meta.dirname, 'flashPreload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true } })
    windowCreated = true
    win.once('ready-to-show', () => probe ? win?.showInactive() : win?.show())
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    win.webContents.on('will-navigate', event => event.preventDefault())
    win.on('close', event => { if (workflow?.busy()) event.preventDefault() })

    const pageLoad = win.loadFile(join(import.meta.dirname, 'flash', 'index.html'))
    void getWorkflow().catch(reportWorkflowStartupError)
    await pageLoad
  }).catch(error => {
    console.error('[WeportFlash] 初始化失败:', error instanceof Error ? error.message : String(error))
    if (process.env.WEPORT_PROBE_OFFSCREEN !== '1') dialog.showErrorBox('WeportFlash 无法启动', '请将程序放在可写目录，并确认便携包完整。')
    app.exit(1)
  })
}

// Ignore any startup zero-window notification. The first real window is created
// synchronously in the whenReady callback; after it exists, closing it quits Flash.
app.on('window-all-closed', () => { if (windowCreated) app.quit() })
