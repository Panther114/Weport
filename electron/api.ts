import { app } from 'electron'
import { Worker } from 'worker_threads'
import { join } from 'path'
import { existsSync } from 'fs'
import { ConfigService } from './services/config'
import { dbPathService } from './services/dbPathService'
import { wcdbService } from './services/wcdbService'
import { chatService } from './services/chatService'
import { exportService, type ExportOptions, type ExportProgress } from './services/export'
import { exportTaskControlService } from './services/exportTaskControlService'
import { KeyService } from './services/keyService'
import { KeyServiceLinux } from './services/keyServiceLinux'
import { KeyServiceMac } from './services/keyServiceMac'

export type { ExportOptions, ExportProgress }

export interface ExtractorConfigInput {
  dbPath?: string
  decryptKey?: string
  wxid?: string
  imageXorKey?: number | string
  imageAesKey?: string
  cachePath?: string
  exportPath?: string
  logEnabled?: boolean
}

export interface SessionInfo {
  username: string
  type: number
  summary: string
  sortTimestamp: number
  lastTimestamp: number
  lastMsgType: number
  messageCountHint?: number
  displayName?: string
  avatarUrl?: string
}

function createKeyService() {
  if (process.platform === 'darwin') return new KeyServiceMac()
  if (process.platform === 'linux') return new KeyServiceLinux()
  return new KeyService()
}

export class WeChatExtractor {
  private configService: ConfigService
  private keyService = createKeyService()
  private activeExportWorkers = new Map<string, Worker>()
  private initialized = false

  constructor() {
    this.configService = new ConfigService()
  }

  /** Resolve native resource directory (wcdb / key / welive / wedecrypt). */
  resolveResourcesPath(): string {
    const candidate = app.isPackaged
      ? join(process.resourcesPath, 'resources')
      : join(app.getAppPath(), 'resources')
    const fallback = join(process.cwd(), 'resources')
    return existsSync(candidate) ? candidate : fallback
  }

  /** One-time path wiring for WCDB worker. Safe to call multiple times. */
  init(): void {
    if (this.initialized) return
    const resourcesPath = this.resolveResourcesPath()
    const userDataPath = app.getPath('userData')
    wcdbService.setPaths(resourcesPath, userDataPath)
    wcdbService.setLogEnabled(this.configService.get('logEnabled') === true)
    this.initialized = true
  }

  getConfig<T = unknown>(key: string): T {
    return this.configService.get(key as any) as T
  }

  setConfig(key: string, value: unknown): void {
    this.configService.set(key as any, value as any)
  }

  async configure(input: ExtractorConfigInput): Promise<void> {
    this.init()
    if (input.dbPath != null) this.configService.set('dbPath', String(input.dbPath).trim())
    if (input.decryptKey != null) this.configService.set('decryptKey', String(input.decryptKey).trim())
    if (input.wxid != null) this.configService.set('myWxid', String(input.wxid).trim())
    if (input.cachePath != null) this.configService.set('cachePath', String(input.cachePath).trim())
    if (input.exportPath != null) this.configService.set('exportPath', String(input.exportPath).trim())
    if (input.logEnabled != null) {
      this.configService.set('logEnabled', Boolean(input.logEnabled))
      wcdbService.setLogEnabled(Boolean(input.logEnabled))
    }
    if (input.imageXorKey != null && String(input.imageXorKey).trim() !== '') {
      const n = Number(input.imageXorKey)
      if (Number.isFinite(n)) this.configService.set('imageXorKey', n)
    }
    if (input.imageAesKey != null) {
      this.configService.set('imageAesKey', String(input.imageAesKey).trim())
    }
  }

  async detectDbPath(): Promise<{ success: boolean; path?: string; error?: string }> {
    this.init()
    return dbPathService.autoDetect()
  }

  async getDefaultDbPath(): Promise<string | null> {
    this.init()
    return dbPathService.getDefaultPath()
  }

  async scanAccounts(rootPath: string) {
    this.init()
    return dbPathService.scanWxidCandidates(rootPath)
  }

  async getDbKey(
    onStatus?: (message: string, level: number) => void,
    timeoutMs = 180_000
  ): Promise<{ success: boolean; key?: string; error?: string; logs?: string[] }> {
    this.init()
    return this.keyService.autoGetDbKey(timeoutMs, onStatus)
  }

  async getImageKey(
    options?: { manualDir?: string; wxid?: string; onStatus?: (message: string) => void }
  ): Promise<{ success: boolean; xorKey?: number; aesKey?: string; verified?: boolean; error?: string }> {
    this.init()
    return this.keyService.autoGetImageKey(
      options?.manualDir,
      options?.onStatus,
      options?.wxid || this.configService.getMyWxidCleaned() || undefined
    )
  }

  async testConnection(
    dbPath?: string,
    hexKey?: string,
    wxid?: string
  ): Promise<{ success: boolean; error?: string; sessionCount?: number }> {
    this.init()
    const path = String(dbPath || this.configService.get('dbPath') || '').trim()
    const key = String(hexKey || this.configService.get('decryptKey') || '').trim()
    const id = String(wxid || this.configService.get('myWxid') || '').trim()
    const accountDir = this.configService.getAccountDir(path, id)
    if (!accountDir) return { success: false, error: '未找到账号目录' }
    return wcdbService.testConnection(accountDir, key)
  }

  async connect(): Promise<{ success: boolean; error?: string }> {
    this.init()
    return chatService.connect()
  }

  async listSessions(options?: { enrichNames?: boolean }): Promise<{
    success: boolean
    sessions?: SessionInfo[]
    error?: string
  }> {
    this.init()
    const result = await chatService.getSessions()
    if (!result?.success || !Array.isArray(result.sessions)) {
      return { success: false, error: result?.error || '加载会话失败' }
    }

    if (options?.enrichNames !== false) {
      const usernames = result.sessions
        .map((s: any) => String(s?.username || '').trim())
        .filter(Boolean)
        .slice(0, 800)
      if (usernames.length > 0) {
        try {
          await chatService.enrichSessionsContactInfo(usernames)
          const refreshed = await chatService.getSessions()
          if (refreshed?.success && Array.isArray(refreshed.sessions)) {
            return { success: true, sessions: refreshed.sessions as SessionInfo[] }
          }
        } catch {
          // enrichment is best-effort
        }
      }
    }

    return { success: true, sessions: result.sessions as SessionInfo[] }
  }

  private getExportRuntime() {
    const cfg = this.configService
    const dbPath = String(cfg.get('dbPath') || '').trim()
    const decryptKey = String(cfg.get('decryptKey') || '').trim()
    const myWxid = String(cfg.getMyWxidCleaned() || '').trim()
    const imageKeys = cfg.getImageKeysForCurrentWxid()
    const accountDir = cfg.getAccountDir(dbPath, String(cfg.get('myWxid') || '').trim()) || undefined
    const cachePath = String(cfg.get('cachePath') || '').trim()
    const emojiCacheDir = cachePath
      ? join(cachePath, 'Emojis')
      : join(app.getPath('documents'), 'WeFlow', 'Emojis')

    return {
      dbPath,
      decryptKey,
      myWxid,
      imageKeys,
      accountDir,
      cachePath,
      emojiCacheDir,
      resourcesPath: this.resolveResourcesPath(),
      userDataPath: app.getPath('userData'),
      logEnabled: cfg.get('logEnabled') === true,
      isPackaged: app.isPackaged
    }
  }

  async exportSessions(
    sessionIds: string[],
    outputDir: string,
    options: ExportOptions,
    handlers?: {
      taskId?: string
      onProgress?: (progress: ExportProgress) => void
    }
  ): Promise<any> {
    this.init()
    const taskId = String(handlers?.taskId || '').trim() || undefined
    if (taskId) exportTaskControlService.createControl(taskId, outputDir)

    const runtime = this.getExportRuntime()
    const workerPath = join(__dirname, 'exportWorker.js')
    const onProgress = handlers?.onProgress

    try {
      const result = await new Promise<any>((resolve, reject) => {
        const worker = new Worker(workerPath, {
          workerData: {
            sessionIds,
            outputDir,
            options,
            taskId,
            dbPath: runtime.dbPath,
            decryptKey: runtime.decryptKey,
            myWxid: runtime.myWxid,
            accountDir: runtime.accountDir,
            imageXorKey: runtime.imageKeys.xorKey,
            imageAesKey: runtime.imageKeys.aesKey,
            resourcesPath: runtime.resourcesPath,
            userDataPath: runtime.userDataPath,
            cachePath: runtime.cachePath,
            emojiCacheDir: runtime.emojiCacheDir,
            logEnabled: runtime.logEnabled,
            isPackaged: runtime.isPackaged
          }
        })

        let settled = false
        if (taskId) this.activeExportWorkers.set(taskId, worker)

        const done = (fn: () => void) => {
          if (settled) return
          settled = true
          if (taskId && this.activeExportWorkers.get(taskId) === worker) {
            this.activeExportWorkers.delete(taskId)
          }
          worker.removeAllListeners()
          void worker.terminate()
          fn()
        }

        worker.on('message', (msg: any) => {
          if (msg?.type === 'export:progress') {
            onProgress?.(msg.data as ExportProgress)
            return
          }
          if (msg?.type === 'export:createdFiles' && taskId) {
            for (const filePath of Array.isArray(msg.filePaths) ? msg.filePaths : []) {
              exportTaskControlService.recordCreatedFile(taskId, String(filePath || ''))
            }
            return
          }
          if (msg?.type === 'export:createdDirs' && taskId) {
            for (const dirPath of Array.isArray(msg.dirPaths) ? msg.dirPaths : []) {
              exportTaskControlService.recordCreatedDir(taskId, String(dirPath || ''))
            }
            return
          }
          if (msg?.type === 'export:createdFile' && taskId) {
            exportTaskControlService.recordCreatedFile(taskId, String(msg.filePath || ''))
            return
          }
          if (msg?.type === 'export:createdDir' && taskId) {
            exportTaskControlService.recordCreatedDir(taskId, String(msg.dirPath || ''))
            return
          }
          if (msg?.type === 'export:result') {
            done(() => resolve(msg.data))
            return
          }
          if (msg?.type === 'export:error') {
            done(() => reject(new Error(String(msg.error || '导出 Worker 执行失败'))))
          }
        })

        worker.on('error', (error) => {
          done(() => reject(error instanceof Error ? error : new Error(String(error))))
        })

        worker.on('exit', (code) => {
          if (settled) return
          if (code === 0) {
            done(() =>
              resolve({
                success: false,
                successCount: 0,
                failCount: 0,
                error: '导出 Worker 未返回结果'
              })
            )
          } else {
            done(() => reject(new Error(`导出 Worker 异常退出: ${code}`)))
          }
        })
      })

      if (taskId) {
        if (result?.success) exportTaskControlService.releaseTask(taskId)
        else await exportTaskControlService.cleanupTask(taskId)
      }
      return result
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      if (taskId) await exportTaskControlService.cleanupTask(taskId)
      return {
        success: false,
        successCount: 0,
        failCount: sessionIds.length,
        failedSessionIds: sessionIds,
        error: errorMessage
      }
    }
  }

  async cancelExport(taskId: string): Promise<{ success: boolean; error?: string }> {
    const id = String(taskId || '').trim()
    if (!id) return { success: false, error: '缺少 taskId' }
    const success = exportTaskControlService.cancelTask(id)
    const worker = this.activeExportWorkers.get(id)
    if (worker) {
      try {
        worker.postMessage({ type: 'export:cancel' })
      } catch {
        // ignore
      }
    }
    return { success }
  }

  async getExportStats(sessionIds: string[], options: ExportOptions) {
    this.init()
    return exportService.getExportStats(sessionIds, options)
  }

  async close(): Promise<void> {
    for (const worker of this.activeExportWorkers.values()) {
      try {
        await worker.terminate()
      } catch {
        // ignore
      }
    }
    this.activeExportWorkers.clear()
    try {
      chatService.close()
    } catch {
      // ignore
    }
    try {
      await wcdbService.close()
    } catch {
      // ignore
    }
  }
}

let singleton: WeChatExtractor | null = null

/** Shared extractor instance for CLI / programmatic use. */
export function getExtractor(): WeChatExtractor {
  if (!singleton) singleton = new WeChatExtractor()
  return singleton
}
