import { app, dialog, ipcMain, shell } from 'electron'
import { join } from 'path'
import type { ConfigService } from './config'
import { STORAGE_KINDS, cleanupStorageRelocation, discardStorageCleanup, discardStorageRelocation, prepareDerivedStorageCleanup, prepareStorageRelocation, resolveStorageLocation, storageCleanupStatus, storageRelocationStatus, storageUsage, type StorageKind } from './storageLocations'
import { taskStatusService } from './taskStatusService'

export function registerStorageIpc(deps: { config: () => ConfigService; workspace: () => string; aiBusy: () => boolean }): void {
  const profile = () => app.getPath('userData')
  const media = () => String(deps.config().get('cachePath'))
  const exports = () => String(deps.config().get('exportPath') || '')
  const protectedPaths = () => [String(deps.config().get('dbPath') || ''), deps.config().getAccountDir() || ''].filter(Boolean)
  const entries = () => STORAGE_KINDS.map(kind => ({ kind, path: kind === 'cache' ? deps.config().getCacheBasePath()
    : kind === 'media' ? media() : kind === 'exports' ? exports()
    : kind === 'ai-workspace' ? deps.workspace()
    : resolveStorageLocation(profile(), kind, join(profile(), kind === 'ai-data' ? 'weport-ai' : kind)),
    retention: ['search-index', 'model-cache'].includes(kind) ? 'derived-rebuildable' : 'user-managed' }))
  const idle = () => {
    if (deps.aiBusy() || Object.values(taskStatusService.all()).some(task => task.status === 'running')) throw Error('Wait for background tasks to finish before changing storage.')
  }
  ipcMain.handle('storage:status', () => ({ entries: entries(), relocation: storageRelocationStatus(profile()),
    mediaPath: media(), exportPath: exports(), cleanup: storageCleanupStatus(profile()),
  }))
  ipcMain.handle('storage:usage', async (_event, kind: StorageKind) => {
    const entry = entries().find(entry => entry.kind === kind)
    if (!entry?.path) throw Error('Unknown or unconfigured storage category.')
    return storageUsage(entry.path)
  })
  ipcMain.handle('storage:prepare', async (_event, kind: StorageKind) => {
    idle()
    const entry = entries().find(entry => entry.kind === kind)
    if (!entry) throw Error('Unknown storage category.')
    const selection = await dialog.showOpenDialog({ title: '选择独立的存储目标目录', properties: ['openDirectory', 'createDirectory'] })
    if (selection.canceled || !selection.filePaths[0]) return null
    idle(); taskStatusService.begin('storage.relocation', '正在复制并验证存储文件', 'copying')
    try {
      if (!entry.path) throw Error('Choose an export folder before relocating it.')
      const job = await prepareStorageRelocation(profile(), kind, entry.path, selection.filePaths[0], protectedPaths())
      taskStatusService.end('storage.relocation', 'done', { message: '存储副本已验证，重启后再次校验并切换目录' })
      return job
    } catch (error) {
      taskStatusService.end('storage.relocation', 'failed', { message: String(error) })
      throw error
    }
  })
  ipcMain.handle('storage:discard', () => discardStorageRelocation(profile()))
  ipcMain.handle('storage:discardCleanup', () => discardStorageCleanup(profile()))
  ipcMain.handle('storage:cleanup', async (_event, side: 'original' | 'prepared') => {
    idle()
    if (!['original', 'prepared'].includes(side)) throw Error('Unknown cleanup request.')
    const decision = await dialog.showMessageBox({ type: 'warning', title: '清理已验证的重复副本', message: side === 'original' ? '仅删除与当前迁移目录逐文件一致的原目录副本。' : '仅删除原目录仍有完整一致文件的迁移副本。', detail: '发现任何新增或变更文件会拒绝清理。不会递归删除目录；唯一内容、原微信目录和其他活动存储目录受保护。', buttons: ['取消', '校验并清理重复文件'], defaultId: 0, cancelId: 0 })
    if (decision.response !== 1) return null
    idle()
    return cleanupStorageRelocation(profile(), side, [...protectedPaths(), ...entries().map(entry => entry.path).filter(path => path && path !== storageRelocationStatus(profile())?.source && path !== storageRelocationStatus(profile())?.target)])
  })
  ipcMain.handle('storage:clearDerived', async (_event, kind: 'search-index' | 'model-cache') => {
    idle()
    const entry = entries().find(entry => entry.kind === kind)
    if (!entry || !['search-index', 'model-cache'].includes(kind)) throw Error('Only derived search/model metadata may be cleared.')
    const decision = await dialog.showMessageBox({ type: 'warning', title: '重启后清理派生缓存', message: '仅清理可识别的搜索索引或模型列表缓存，重启后需重新构建或获取。', detail: '归档、导出、AI 记忆、OCR 和媒体文件不会被此操作删除；无法识别的文件保留。', buttons: ['取消', '准备清理'], defaultId: 0, cancelId: 0 })
    if (decision.response !== 1) return null
    idle()
    return prepareDerivedStorageCleanup(profile(), kind, entry.path, protectedPaths())
  })
  ipcMain.handle('storage:open', async (_event, kind: StorageKind) => {
    const entry = entries().find(entry => entry.kind === kind)
    if (!entry?.path) throw Error('Unknown or unconfigured storage category.')
    return shell.openPath(entry.path)
  })
  ipcMain.handle('storage:restart', () => {
    idle()
    if (storageRelocationStatus(profile())?.state !== 'ready' && storageCleanupStatus(profile())?.state !== 'ready') throw Error('No verified storage operation is ready to apply.')
    app.relaunch(); app.quit()
  })
}
