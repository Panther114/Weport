import { contextBridge, ipcRenderer } from 'electron'

// 事件订阅统一模式：返回"只移除本回调"的退订函数。
// 用 removeAllListeners 会把同频道的其他订阅者（多组件）一并清掉。
function subscribe(channel: string, callback: (...args: any[]) => void): () => void {
  const listener = (_: unknown, ...args: any[]) => callback(...args)
  ipcRenderer.on(channel, listener)
  return () => {
    ipcRenderer.removeListener(channel, listener)
  }
}

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
    onLuma: (callback: (bands: any) => void) => subscribe('notification:luma', callback),
    onShow: (callback: (event: any, data: any) => void) => subscribe('notification:show', callback)
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
    onDownloadProgress: (callback: (progress: any) => void) => subscribe('app:downloadProgress', callback),
    onUpdateAvailable: (callback: (info: { version: string; releaseNotes: string }) => void) => subscribe('app:updateAvailable', callback)
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
    onDbKeyStatus: (callback: (payload: { message: string; level: number }) => void) => subscribe('key:dbKeyStatus', callback)
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
    onProgress: (callback: (payload: any) => void) => subscribe('export:progress', callback)
  },

  // 朋友圈（v0.9）
  sns: {
    getTimeline: (limit: number, offset: number, usernames?: string[], keyword?: string, startTime?: number, endTime?: number) =>
      ipcRenderer.invoke('sns:getTimeline', limit, offset, usernames, keyword, startTime, endTime),
    getSnsUsernames: () => ipcRenderer.invoke('sns:getSnsUsernames'),
    getUserPostCounts: (options?: { preferCache?: boolean; forceRefresh?: boolean }) =>
      ipcRenderer.invoke('sns:getUserPostCounts', options),
    getExportStats: (options?: { allowTimelineFallback?: boolean; preferCache?: boolean; forceRefresh?: boolean }) =>
      ipcRenderer.invoke('sns:getExportStats', options),
    getExportStatsFast: () => ipcRenderer.invoke('sns:getExportStatsFast'),
    getUserPostStats: (username: string) => ipcRenderer.invoke('sns:getUserPostStats', username),
    debugResource: (url: string) => ipcRenderer.invoke('sns:debugResource', url),
    proxyImage: (payload: string | { url: string; key?: string | number }) =>
      ipcRenderer.invoke('sns:proxyImage', payload),
    downloadImage: (payload: { url: string; key?: string | number }) =>
      ipcRenderer.invoke('sns:downloadImage', payload),
    exportTimeline: (options: any) => ipcRenderer.invoke('sns:exportTimeline', options),
    selectExportDir: () => ipcRenderer.invoke('sns:selectExportDir'),
    installBlockDeleteTrigger: () => ipcRenderer.invoke('sns:installBlockDeleteTrigger'),
    uninstallBlockDeleteTrigger: () => ipcRenderer.invoke('sns:uninstallBlockDeleteTrigger'),
    checkBlockDeleteTrigger: () => ipcRenderer.invoke('sns:checkBlockDeleteTrigger'),
    deleteSnsPost: (postId: string) => ipcRenderer.invoke('sns:deleteSnsPost', postId),
    downloadEmoji: (params: { url: string; encryptUrl?: string; aesKey?: string }) =>
      ipcRenderer.invoke('sns:downloadEmoji', params),
    getCacheMigrationStatus: () => ipcRenderer.invoke('sns:getCacheMigrationStatus'),
    startCacheMigration: () => ipcRenderer.invoke('sns:startCacheMigration'),
    onExportProgress: (callback: (payload: any) => void) => subscribe('sns:exportProgress', callback),
    onCacheMigrationProgress: (callback: (payload: any) => void) => subscribe('sns:cacheMigrationProgress', callback)
  },

  // 全局分析（v0.9）
  analytics: {
    getOverallStatistics: (force?: boolean) => ipcRenderer.invoke('analytics:getOverallStatistics', force),
    getContactRankings: (limit?: number, beginTimestamp?: number, endTimestamp?: number) =>
      ipcRenderer.invoke('analytics:getContactRankings', limit, beginTimestamp, endTimestamp),
    getTimeDistribution: () => ipcRenderer.invoke('analytics:getTimeDistribution'),
    getSelfSentDailyDistribution: (beginTimestamp?: number, endTimestamp?: number, force?: boolean) =>
      ipcRenderer.invoke('analytics:getSelfSentDailyDistribution', beginTimestamp, endTimestamp, force),
    getExcludedUsernames: () => ipcRenderer.invoke('analytics:getExcludedUsernames'),
    setExcludedUsernames: (usernames: string[]) => ipcRenderer.invoke('analytics:setExcludedUsernames', usernames),
    getExcludeCandidates: () => ipcRenderer.invoke('analytics:getExcludeCandidates'),
    clearCache: () => ipcRenderer.invoke('cache:clearAnalytics')
  },

  // 群聊分析（v0.9）
  groupAnalytics: {
    getGroupChats: () => ipcRenderer.invoke('groupAnalytics:getGroupChats'),
    getGroupMembers: (chatroomId: string) => ipcRenderer.invoke('groupAnalytics:getGroupMembers', chatroomId),
    getGroupMembersPanelData: (chatroomId: string, options?: { forceRefresh?: boolean; includeMessageCounts?: boolean } | boolean) =>
      ipcRenderer.invoke('groupAnalytics:getGroupMembersPanelData', chatroomId, options),
    getGroupMessageRanking: (chatroomId: string, limit?: number, startTime?: number, endTime?: number) =>
      ipcRenderer.invoke('groupAnalytics:getGroupMessageRanking', chatroomId, limit, startTime, endTime),
    getGroupActiveHours: (chatroomId: string, startTime?: number, endTime?: number) =>
      ipcRenderer.invoke('groupAnalytics:getGroupActiveHours', chatroomId, startTime, endTime),
    getGroupMediaStats: (chatroomId: string, startTime?: number, endTime?: number) =>
      ipcRenderer.invoke('groupAnalytics:getGroupMediaStats', chatroomId, startTime, endTime),
    getGroupMemberAnalytics: (chatroomId: string, memberUsername: string, startTime?: number, endTime?: number) =>
      ipcRenderer.invoke('groupAnalytics:getGroupMemberAnalytics', chatroomId, memberUsername, startTime, endTime),
    getGroupMemberMessages: (chatroomId: string, memberUsername: string, options?: { startTime?: number; endTime?: number; limit?: number; cursor?: number }) =>
      ipcRenderer.invoke('groupAnalytics:getGroupMemberMessages', chatroomId, memberUsername, options),
    exportGroupMembers: (chatroomId: string, outputPath: string) =>
      ipcRenderer.invoke('groupAnalytics:exportGroupMembers', chatroomId, outputPath),
    exportGroupMemberMessages: (chatroomId: string, memberUsername: string, outputPath: string, startTime?: number, endTime?: number) =>
      ipcRenderer.invoke('groupAnalytics:exportGroupMemberMessages', chatroomId, memberUsername, outputPath, startTime, endTime)
  },

  // 年度报告（v0.9）
  annualReport: {
    getAvailableYears: () => ipcRenderer.invoke('annualReport:getAvailableYears'),
    startAvailableYearsLoad: () => ipcRenderer.invoke('annualReport:startAvailableYearsLoad'),
    cancelAvailableYearsLoad: (taskId: string) => ipcRenderer.invoke('annualReport:cancelAvailableYearsLoad', taskId),
    generateReport: (year: number) => ipcRenderer.invoke('annualReport:generateReport', year),
    exportImages: (payload: { baseDir: string; folderName: string; images: Array<{ name: string; dataUrl: string }> }) =>
      ipcRenderer.invoke('annualReport:exportImages', payload),
    captureCurrentWindow: () => ipcRenderer.invoke('annualReport:captureCurrentWindow'),
    onProgress: (callback: (payload: any) => void) => subscribe('annualReport:progress', callback),
    onAvailableYearsProgress: (callback: (payload: any) => void) => subscribe('annualReport:availableYearsProgress', callback)
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
    onEvent: (callback: (event: any) => void) => subscribe('ai:event', callback)
  },

  process: {
    platform: process.platform,
    arch: process.arch
  }
})
