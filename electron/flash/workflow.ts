import { app } from 'electron'
import { join } from 'path'
import { existsSync } from 'fs'
import { promises as fs } from 'fs'
import { ConfigService } from '../services/config'
import { avatarCacheService } from '../services/avatarCacheService'
import { dbPathService } from '../services/dbPathService'
import { KeyService } from '../services/keyService'
import { KeyHealthService, validateAccountKeyAgainstDbs, hasDbStorageFiles } from '../services/keyHealthService'
import { acquireDbKeyViaOrchestrator, createWindowsKeyDriver } from '../services/keyAcquisition'
import { chatService } from '../services/chatService'
import { wcdbService } from '../services/wcdbService'
import { exportService } from '../services/export'

/** Same resource lookup as appMain's shared bootstrap, without importing its GUI entrypoint. */
function resolveFlashResourcesPath(): string {
  const candidate = app.isPackaged
    ? join(process.resourcesPath, 'resources')
    : join(app.getAppPath(), 'resources')
  return existsSync(candidate) ? candidate : join(process.cwd(), 'resources')
}

export async function createFlashWorkflow(root: string, send: (channel: string, payload: unknown) => void) {
  // Flash needs the shared config, avatar cache, and WCDB paths, but not the
  // desktop app's IPC, protocol, tray, scheduler, or network bootstrap.
  const resourcesPath = resolveFlashResourcesPath()
  const userDataPath = app.getPath('userData')
  process.env.WEPORT_DEV_MODE = app.isPackaged ? '' : '1'
  process.env.WEPORT_RESOURCES_PATH = resourcesPath
  process.env.WEPORT_USER_DATA_PATH = userDataPath
  const config = ConfigService.getInstance()
  avatarCacheService.init(config.getCacheBasePath())
  wcdbService.setPaths(resourcesPath, userDataPath)
  wcdbService.setLogEnabled(config.get('logEnabled') === true)
  const health = new KeyHealthService()
  let running = false
  let output = ''
  const availableAccounts = async () => {
    const detected = await dbPathService.autoDetect()
    const dbPath = String(config.get('dbPath') || detected.path || dbPathService.getDefaultPath())
    return { dbPath, accounts: dbPathService.scanWxids(dbPath) }
  }
  return {
    busy: () => running,
    lastOutputDir: () => output,
    close: () => { void wcdbService.close() },
    accounts: async () => (await availableAccounts()).accounts.map(a => ({ wxid: a.wxid, name: a.nickname || a.wxid })),
    setDbPath: (dbPath: string) => {
      if (running) return { success: false, error: '请等待导出结束' }
      const accounts = dbPathService.scanWxids(dbPath)
      if (!accounts.length) return { success: false, error: '该目录没有有效微信账号，请选择 xwechat_files 目录' }
      chatService.close()
      config.set('dbPath', dbPath)
      config.set('myWxid', '')
      config.set('decryptKey', '')
      return { success: true }
    },
    async run(skipMedia: boolean, selectedAccount?: string) {
      if (running) return { success: false, error: '已有导出任务正在运行' }
      running = true
      const started = Date.now()
      try {
        if (process.platform !== 'win32') throw new Error('WeportFlash 目前仅支持 Windows')
        const { dbPath, accounts } = await availableAccounts()
        const selected = selectedAccount || String(config.get('myWxid') || '')
        const account = accounts.find(a => a.wxid === selected) || (accounts.length === 1 ? accounts[0] : null)
        if (!account) throw new Error(accounts.length ? '请选择要导出的账号' : '没有找到有效微信账号，请先登录微信并下载聊天记录')
        if (String(config.get('myWxid') || '') !== account.wxid) config.set('decryptKey', '')
        config.set('dbPath', dbPath)
        config.set('myWxid', account.wxid)
        const accountDir = config.getAccountDir()
        if (!accountDir) throw new Error('无法定位账号目录')
        const acquisition = await acquireDbKeyViaOrchestrator({
          driver: createWindowsKeyDriver(new KeyService()), accountDir,
          storedKey: { hexKey: String(config.get('decryptKey') || '') || null, source: 'config' },
          validateStoredKey: async (key, dir) => validateAccountKeyAgainstDbs(dir, key),
          hasDbFiles: async dir => hasDbStorageFiles(dir),
          persistKeys: async (dir, keys) => { health.mergeScannedKeys(dir, keys) },
          onStatus: message => send('key:dbKeyStatus', { message }),
          onScanProgress: message => send('key:dbKeyStatus', { message }),
        }, 'auto')
        if (!acquisition.success) throw new Error(acquisition.error || '密钥获取失败')
        if (acquisition.key) config.set('decryptKey', acquisition.key)
        const connected = await chatService.connect()
        if (!connected.success) throw new Error(connected.error || '数据库连接失败')
        const sessions = await chatService.getSessions()
        if (!sessions.success) throw new Error(sessions.error || '会话读取失败')
        const ids = (sessions.sessions || []).map(session => session.username)
        if (!ids.length) throw new Error('没有可导出的会话')
        output = join(root, 'exports', new Date().toISOString().replace(/[:.]/g, '-'))
        exportService.setRuntimeConfig({ dbPath, myWxid: account.wxid, decryptKey: config.get('decryptKey') || '', resourcesPath: process.env.WEPORT_RESOURCES_PATH, appPath: app.getAppPath(), isPackaged: app.isPackaged })
        const common = { exportMedia: !skipMedia, exportAvatars: !skipMedia, exportConflictStrategy: 'overwrite' as const, sessionLayout: 'per-session' as const, exportConcurrency: 1 }
        const html = await exportService.exportSessions(ids, output, { ...common, format: 'html' }, p => send('export:progress', p))
        if (!html.success || html.failCount) throw new Error(html.error || `${html.failCount} 个会话导出失败`)
        send('flash:note', { message: '正在写入结构化消息清单…' })
        const structured = await exportService.exportSessions(ids, output, { ...common, exportMedia: false, exportAvatars: false, format: 'chatlab-jsonl' }, p => send('export:progress', p))
        if (!structured.success || structured.failCount) throw new Error(structured.error || '结构化消息清单导出失败')
        let files = 0, bytes = 0
        const pending = [output]
        while (pending.length) {
          const directory = pending.pop()!
          for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
            const full = join(directory, entry.name)
            if (entry.isDirectory()) pending.push(full)
            else if (entry.isFile()) { files++; bytes += (await fs.stat(full)).size }
          }
        }
        send('flash:result', { outputDir: output, exportedSessions: html.successCount, sessions: ids.length, files, bytes, elapsedMs: Date.now() - started, skipMedia })
        return { success: true }
      } catch (error) {
        send('flash:error', { message: error instanceof Error ? error.message : String(error), next: '检查微信登录状态、数据目录和密钥覆盖；已完成的文件保留在 exports 目录' })
        return { success: false }
      } finally { running = false }
    },
  }
}
