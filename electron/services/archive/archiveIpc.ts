import { app, dialog, ipcMain } from 'electron'
import { join } from 'node:path'
import { ArchiveLibrary } from './archiveLibrary'
import { exportService } from '../export'
import { exportTaskControlService } from '../exportTaskControlService'
import { chatService } from '../chatService'
import { sourceFingerprint } from '../export/sourceFingerprint'
import { taskStatusService } from '../taskStatusService'
import type { ConfigService } from '../config'
import type { AnnotationsService } from '../annotationsService'
import type { ArchiveRequest } from './types'
import { resolveRelocatedStoragePath, resolveStorageLocation } from '../storageLocations'

export function registerArchiveIpc(deps: { config: () => ConfigService; annotations: () => AnnotationsService; resources: () => string; guardExport: () => Promise<void> }): ArchiveLibrary {
  const account = () => deps.config().getMyWxidCleaned()
  const library = new ArchiveLibrary({
    root: resolveStorageLocation(app.getPath('userData'), 'archive-library', join(app.getPath('userData'), 'archive-library')), currentAccount: account,
    resolvePath: value => resolveRelocatedStoragePath(app.getPath('userData'), value),
    protectedPaths: () => [String(deps.config().get('dbPath') || ''), deps.config().getAccountDir() || ''].filter(Boolean),
    sourceBusy: () => exportTaskControlService.hasActiveTasks() || taskStatusService.get('db.maintenance').status === 'running',
    source: async () => {
      await deps.guardExport()
      const connected = await chatService.connect()
      if (!connected.success) throw Error(connected.error || '连接失败')
      return { fingerprint: await sourceFingerprint(deps.config().getAccountDir() || '', true), capability: chatService.isReadOnlySnapshot() ? 'history-snapshot' : 'live' }
    },
    annotations: () => deps.annotations().list(),
    exportJson: async (request, output, progress, stopped) => {
      const config = deps.config(), taskId = 'archive-' + Date.now()
      exportService.setRuntimeConfig({ dbPath: config.get('dbPath'), decryptKey: config.get('decryptKey'), myWxid: config.get('myWxid'), resourcesPath: deps.resources(), appPath: app.getAppPath(), isPackaged: app.isPackaged })
      const control = exportTaskControlService.createControl(taskId, output)
      try {
        return await exportService.exportSessions(request.sessionIds, output, {
          format: 'json', dateRange: request.dateRange, contentType: 'text', archiveMode: true, mediaPolicy: request.mediaPolicy,
          exportMedia: request.includeMedia, exportImages: request.includeMedia, exportVoices: request.includeMedia,
          exportVideos: request.includeMedia, exportFiles: request.includeMedia,
          // Archives are local-only. Remote emoji downloads are not implied by archive creation.
          exportEmojis: false, exportAvatars: false, exportVoiceAsText: false,
          exportWriteLayout: 'C', sessionLayout: 'per-session', exportConflictStrategy: 'incremental', exportPathStyle: 'posix', verifyAfterExport: false,
        }, value => progress({ stage: value.phaseLabel || value.phase || '导出', cursor: [value.currentSessionId || '', value.collectedMessages || value.exportedMessages || value.current || 0].join(':'), current: value.current, total: value.total }), { ...control, shouldStop: () => stopped() || control.shouldStop?.() === true })
      } finally { exportTaskControlService.releaseTask(taskId) }
    },
    task: { begin: message => taskStatusService.begin('archive', message, 'preflight'), progress: (stage, message, detail, progress) => taskStatusService.progress('archive', { stage, message, detail, progress, log: false }), end: (status, message) => taskStatusService.end('archive', status, { message }) },
  })
  const handle = (name: string, run: (...args: any[]) => unknown) => ipcMain.handle('archive:' + name, async (_event, ...args) => { try { return { success: true, data: await run(...args) } } catch (error) { return { success: false, error: error instanceof Error ? error.message : String(error) } } })
  handle('status', () => library.status())
  handle('chooseDirectory', async () => { const picked = await dialog.showOpenDialog({ title: '选择归档目录', properties: ['openDirectory', 'createDirectory'] }); return picked.canceled ? null : picked.filePaths[0] })
  handle('preflight', (request: ArchiveRequest) => library.preflight(request))
  handle('create', (request: ArchiveRequest, retryId?: string) => library.create(request, retryId))
  handle('cancel', () => library.cancel())
  handle('import', (root: string) => library.import(root))
  handle('open', (id: string) => library.open(id))
  handle('page', (id: string, sessionId: string, offset: number, limit: number, query: string) => library.page(id, sessionId, offset, limit, query))
  handle('media', (id: string, sessionId: string, identity: string) => library.media(id, sessionId, identity))
  handle('evidence', (id: string, sessionId: string, identity: string) => library.evidence(id, sessionId, identity))
  handle('bookmark', (id: string, sessionId: string, identity: string, note: string, remove: boolean) => library.bookmark(id, sessionId, identity, note, remove))
  handle('restore', (id: string, destination: string) => library.restore(id, destination))
  handle('saveSchedule', (value: Parameters<typeof library.saveSchedule>[0]) => library.saveSchedule(value))
  handle('removeSchedule', (id: string) => library.removeSchedule(id))
  library.start()
  return library
}
