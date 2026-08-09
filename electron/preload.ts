import { contextBridge, ipcRenderer } from 'electron'

// 暴露给渲染进程的 API（Weport 精简版，模式与 WeFlow preload 一致）
contextBridge.exposeInMainWorld('electronAPI', {
  // 配置
  config: {
    get: (key: string) => ipcRenderer.invoke('config:get', key),
    set: (key: string, value: any) => ipcRenderer.invoke('config:set', key, value),
    clear: () => ipcRenderer.invoke('config:clear')
  },

  // 通知
  notification: {
    show: (data: any) => ipcRenderer.invoke('notification:show', data),
    close: () => ipcRenderer.invoke('notification:close'),
    click: (payload: any) => ipcRenderer.send('notification-clicked', payload),
    ready: () => ipcRenderer.send('notification:ready'),
    resize: (width: number, height: number) => ipcRenderer.send('notification:resize', { width, height }),
    glassRect: (payload: any) => ipcRenderer.send('notification:glassRect', payload),
    glassHide: () => ipcRenderer.send('notification:glassHide'),
    showTest: () => ipcRenderer.invoke('notification:showTest'),
    onLuma: (callback: (bands: any) => void) => {
      const listener = (_: any, bands: any) => callback(bands)
      ipcRenderer.on('notification:luma', listener)
      return () => ipcRenderer.removeListener('notification:luma', listener)
    },
    onShow: (callback: (event: any, data: any) => void) => {
      ipcRenderer.on('notification:show', callback)
      return () => ipcRenderer.removeAllListeners('notification:show')
    }
  },

  // 对话框
  dialog: {
    openDirectory: (options?: any) => ipcRenderer.invoke('dialog:openDirectory', options),
    openFile: (options?: any) => ipcRenderer.invoke('dialog:openFile', options)
  },

  // 外壳
  shell: {
    openPath: (path: string) => ipcRenderer.invoke('shell:openPath', path),
    openExternal: (url: string) => ipcRenderer.invoke('shell:openExternal', url)
  },

  // 应用
  app: {
    getVersion: () => ipcRenderer.invoke('app:getVersion'),
    getLaunchAtStartupStatus: () => ipcRenderer.invoke('app:getLaunchAtStartupStatus'),
    setLaunchAtStartup: (enabled: boolean) => ipcRenderer.invoke('app:setLaunchAtStartup', enabled),
    checkForUpdates: () => ipcRenderer.invoke('app:checkForUpdates'),
    downloadAndInstall: () => ipcRenderer.invoke('app:downloadAndInstall'),
    ignoreUpdate: (version: string) => ipcRenderer.invoke('app:ignoreUpdate', version),
    onDownloadProgress: (callback: (progress: any) => void) => {
      ipcRenderer.on('app:downloadProgress', (_: any, progress: any) => callback(progress))
      return () => ipcRenderer.removeAllListeners('app:downloadProgress')
    },
    onUpdateAvailable: (callback: (info: { version: string; releaseNotes: string }) => void) => {
      ipcRenderer.on('app:updateAvailable', (_: any, info: { version: string; releaseNotes: string }) => callback(info))
      return () => ipcRenderer.removeAllListeners('app:updateAvailable')
    }
  },

  // 数据库路径
  dbPath: {
    autoDetect: () => ipcRenderer.invoke('dbpath:autoDetect'),
    scanWxids: (rootPath: string) => ipcRenderer.invoke('dbpath:scanWxids', rootPath),
    getDefault: () => ipcRenderer.invoke('dbpath:getDefault')
  },

  // 密钥
  key: {
    autoGetDbKey: () => ipcRenderer.invoke('key:autoGetDbKey'),
    onDbKeyStatus: (callback: (payload: { message: string; level: number }) => void) => {
      ipcRenderer.on('key:dbKeyStatus', (_: any, payload: { message: string; level: number }) => callback(payload))
      return () => ipcRenderer.removeAllListeners('key:dbKeyStatus')
    }
  },

  // WCDB
  wcdb: {
    testConnection: (dbPath: string, hexKey: string, wxid: string) =>
      ipcRenderer.invoke('wcdb:testConnection', dbPath, hexKey, wxid)
  },

  // 聊天
  chat: {
    connect: () => ipcRenderer.invoke('chat:connect'),
    close: () => ipcRenderer.invoke('chat:close'),
    getSessions: () => ipcRenderer.invoke('chat:getSessions'),
    markAllSessionsRead: () => ipcRenderer.invoke('chat:markAllSessionsRead'),
    getContactAvatar: (username: string, chatroomId?: string) =>
      ipcRenderer.invoke('chat:getContactAvatar', username, chatroomId),
    enrichSessionsContactInfo: (usernames: string[], options?: any) =>
      ipcRenderer.invoke('chat:enrichSessionsContactInfo', usernames, options),
    getSessionStatuses: (usernames: string[]) => ipcRenderer.invoke('chat:getSessionStatuses', usernames),
    getNewMessages: (sessionId: string, minTime: number, limit?: number) =>
      ipcRenderer.invoke('chat:getNewMessages', sessionId, minTime, limit),
    getAntiRevokeSessions: () => ipcRenderer.invoke('chat:getAntiRevokeSessions'),
    checkAntiRevokeTriggers: (sessionIds: string[]) => ipcRenderer.invoke('chat:checkAntiRevokeTriggers', sessionIds),
    installAntiRevokeTriggers: (sessionIds: string[]) => ipcRenderer.invoke('chat:installAntiRevokeTriggers', sessionIds),
    uninstallAntiRevokeTriggers: (sessionIds: string[]) => ipcRenderer.invoke('chat:uninstallAntiRevokeTriggers', sessionIds)
  },

  // 导出
  export: {
    exportSessions: (outputRoot: string, options?: any) =>
      ipcRenderer.invoke('export:exportSessions', outputRoot, options),
    cancelTask: (taskId: string) => ipcRenderer.invoke('export:cancelTask', taskId),
    getExportLog: (outputRoot: string) => ipcRenderer.invoke('export:getExportLog', outputRoot),
    clearLibrary: (outputRoot: string) => ipcRenderer.invoke('export:clearLibrary', outputRoot),
    onProgress: (callback: (payload: any) => void) => {
      ipcRenderer.on('export:progress', (_: any, payload: any) => callback(payload))
      return () => ipcRenderer.removeAllListeners('export:progress')
    }
  },

  // WeportAI（v0.8 聊天历史分析助手）
  ai: {
    getSetup: () => ipcRenderer.invoke('ai:getSetup'),
    setSetup: (patch: any) => ipcRenderer.invoke('ai:setSetup', patch),
    listChats: () => ipcRenderer.invoke('ai:listChats'),
    createChat: (title?: string) => ipcRenderer.invoke('ai:createChat', title),
    renameChat: (chatId: string, title: string) => ipcRenderer.invoke('ai:renameChat', chatId, title),
    reorderChats: (orderedIds: string[]) => ipcRenderer.invoke('ai:reorderChats', orderedIds),
    deleteChat: (chatId: string) => ipcRenderer.invoke('ai:deleteChat', chatId),
    getChat: (chatId: string) => ipcRenderer.invoke('ai:getChat', chatId),
    listNotes: (chatId: string) => ipcRenderer.invoke('ai:listNotes', chatId),
    readNoteFile: (chatId: string, path: string) => ipcRenderer.invoke('ai:readNoteFile', chatId, path),
    deleteNoteFile: (chatId: string, path: string) => ipcRenderer.invoke('ai:deleteNoteFile', chatId, path),
    clearMemory: () => ipcRenderer.invoke('ai:clearMemory'),
    getDebugLog: (limit?: number) => ipcRenderer.invoke('ai:getDebugLog', limit),
    clearDebugLog: () => ipcRenderer.invoke('ai:clearDebugLog'),
    listActions: () => ipcRenderer.invoke('ai:listActions'),
    saveActions: (actions: any) => ipcRenderer.invoke('ai:saveActions', actions),
    send: (chatId: string, text: string) => ipcRenderer.invoke('ai:send', chatId, text),
    abort: (chatId: string) => ipcRenderer.invoke('ai:abort', chatId),
    onEvent: (callback: (event: any) => void) => {
      ipcRenderer.on('ai:event', (_: any, event: any) => callback(event))
      return () => ipcRenderer.removeAllListeners('ai:event')
    }
  },

  process: {
    platform: process.platform,
    arch: process.arch
  }
})
