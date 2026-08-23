import { contextBridge, ipcRenderer } from 'electron'
import type { ExportRequest } from './services/export/types'

// 事件订阅统一模式：返回"只移除本回调"的退订函数。
// 用 removeAllListeners 会把同频道的其他订阅者（多组件）一并清掉。
// 注意：contextBridge 代理的函数 .length 恒为 0，绝不能靠形参个数判断签名。
// 兼容两种回调签名：(payload) 与 (event, payload) —— 同时传 (payload, payload)：
// 1 参回调取第一个参数，2 参回调（如通知弹窗 handleShow(_event, data)）取第二个。
function subscribe(channel: string, callback: (...args: any[]) => void): () => void {
  const listener = (_: unknown, ...args: any[]) => {
    const payload = args[0]
    callback(payload, payload)
  }
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
    clear: () => ipcRenderer.invoke('config:clear'),
    updateWxidEntry: (wxid: string, patch: Record<string, unknown>) => ipcRenderer.invoke('config:updateWxidEntry', wxid, patch)
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
    onShow: (callback: (event: any, data: any) => void) => subscribe('notification:show', callback),
    onNavigate: (callback: (payload: any) => void) => subscribe('notification:navigate', callback),
    onNavigateToSession: (callback: (sessionId: string) => void) => subscribe('navigate-to-session', callback),
    onNavigateToRoute: (callback: (route: string) => void) => subscribe('navigate-to-route', callback)
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
    onUpdateDownloaded: (callback: () => void) => subscribe('app:updateDownloaded', callback),
    onUpdateAvailable: (callback: (info: { version: string; releaseNotes: string }) => void) => subscribe('app:updateAvailable', callback)
  },

  // 数据备份（v0.9.4）
  backup: {
    create: (payload: { outputPath: string; options?: { includeImages?: boolean; includeVideos?: boolean; includeFiles?: boolean } }) =>
      ipcRenderer.invoke('backup:create', payload),
    inspect: (archivePath: string) => ipcRenderer.invoke('backup:inspect', { archivePath }),
    restore: (archivePath: string) => ipcRenderer.invoke('backup:restore', { archivePath })
  },

  // 本地 HTTP API（v0.9.4）
  http: {
    start: () => ipcRenderer.invoke('http:start'),
    stop: () => ipcRenderer.invoke('http:stop'),
    getStatus: () => ipcRenderer.invoke('http:getStatus')
  },

  // Windows Hello（v0.9.4 认证能力）
  auth: {
    verifyHello: (message?: string) => ipcRenderer.invoke('auth:verifyHello', message)
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
    onDbKeyStatus: (callback: (payload: { message: string; level: number }) => void) => subscribe('key:dbKeyStatus', callback),
    autoGetImageKey: (manualDir?: string, wxid?: string) => ipcRenderer.invoke('key:autoGetImageKey', manualDir, wxid),
    scanImageKeyFromMemory: (userDir: string) => ipcRenderer.invoke('key:scanImageKeyFromMemory', userDir),
    onImageKeyStatus: (callback: (payload: { message: string }) => void) => subscribe('key:imageKeyStatus', callback)
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
    exportSessions: (outputRoot: string, options?: ExportRequest) =>
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
    proxyImage: (payload: string | { url: string; key?: string | number; skipFailedCache?: boolean }) =>
      ipcRenderer.invoke('sns:proxyImage', payload),
    warmupTimeline: () => ipcRenderer.invoke('sns:warmupTimeline'),
    peekNewestTimeline: () => ipcRenderer.invoke('sns:peekNewestTimeline'),
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
    getContactRankings: (limit?: number, beginTimestamp?: number, endTimestamp?: number, options?: { includeGroupChats?: boolean }) =>
      ipcRenderer.invoke('analytics:getContactRankings', limit, beginTimestamp, endTimestamp, options),
    getTimeDistribution: () => ipcRenderer.invoke('analytics:getTimeDistribution'),
    getSelfSentDailyDistribution: (beginTimestamp?: number, endTimestamp?: number, force?: boolean) =>
      ipcRenderer.invoke('analytics:getSelfSentDailyDistribution', beginTimestamp, endTimestamp, force),
    getExcludedUsernames: () => ipcRenderer.invoke('analytics:getExcludedUsernames'),
    setExcludedUsernames: (usernames: string[]) => ipcRenderer.invoke('analytics:setExcludedUsernames', usernames),
    getExcludeCandidates: (options?: { includeGroupChats?: boolean }) => ipcRenderer.invoke('analytics:getExcludeCandidates', options),
    getDailyActivity: (force?: boolean) => ipcRenderer.invoke('analytics:getDailyActivity', force),
    getWordFrequency: (limit?: number, force?: boolean) => ipcRenderer.invoke('analytics:getWordFrequency', limit, force),
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
    getGroupActivityHeatmap: (chatroomId: string, startTime?: number, endTime?: number) =>
      ipcRenderer.invoke('groupAnalytics:getGroupActivityHeatmap', chatroomId, startTime, endTime),
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

  // 双人报告（v0.9.4 新增：与好友的年度对话分析）
  dualReport: {
    generateReport: (friendUsername: string, year: number) => ipcRenderer.invoke('dualReport:generateReport', { friendUsername, year }),
    onProgress: (callback: (payload: any) => void) => subscribe('dualReport:progress', callback)
  },

  // WeportAI（v0.8 聊天历史分析助手）
  ai: {
    getSetup: () => ipcRenderer.invoke('ai:getSetup'),
    listProviders: () => ipcRenderer.invoke('ai:listProviders'),
    fetchModels: (input: any) => ipcRenderer.invoke('ai:fetchModels', input),
    saveProfile: (input: any) => ipcRenderer.invoke('ai:saveProfile', input),
    activateProfile: (id: string) => ipcRenderer.invoke('ai:activateProfile', id),
    deleteProfile: (id: string) => ipcRenderer.invoke('ai:deleteProfile', id),
    testProfile: (input: any) => ipcRenderer.invoke('ai:testProfile', input),
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

  // WeClone（v0.9.10 人格克隆）
  weclone: {
    generate: (opts?: { localOnly?: boolean }) => ipcRenderer.invoke('weclone:generate', opts),
    list: () => ipcRenderer.invoke('weclone:list'),
    get: (id: string) => ipcRenderer.invoke('weclone:get', id),
    delete: (id: string, remote?: boolean) => ipcRenderer.invoke('weclone:delete', id, remote),
    setVisibility: (id: string, visibility: string) => ipcRenderer.invoke('weclone:setVisibility', id, visibility),
    getServerStatus: () => ipcRenderer.invoke('weclone:getServerStatus'),
    cancel: () => ipcRenderer.invoke('weclone:cancel'),
    getForcedProviderStatus: () => ipcRenderer.invoke('weclone:getForcedProviderStatus'),
    ensureProvider: (payload?: { apiKey?: string }) => ipcRenderer.invoke('weclone:ensureProvider', payload),
    setForcedApiKey: (payload: { apiKey: string }) => ipcRenderer.invoke('weclone:setForcedApiKey', payload),
    onProgress: (callback: (payload: any) => void) => subscribe('weclone:progress', callback)
  },

  process: {
    platform: process.platform,
    arch: process.arch
  }
})
