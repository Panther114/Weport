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
    /**
     * 上报卡片尺寸 + 滑动信息。
     *
     * `settled` = 入场动画是否已落定：false 时主进程会把窗口按 `room` 往滑动方向
     * 多留一段（那段在屏幕外，卡片才有地方从屏幕外滑进来），true 时收回成卡片大小
     * —— 屏幕上多出来的每个像素都会拦截桌面点击。
     */
    resize: (width: number, height: number, options?: { slideFrom?: string; room?: number; settled?: boolean }) =>
      ipcRenderer.send('notification:resize', { width, height, ...(options || {}) }),
    glassRect: (payload: any) => ipcRenderer.send('notification:glassRect', payload),
    glassHide: () => ipcRenderer.send('notification:glassHide'),
    showTest: () => ipcRenderer.invoke('notification:showTest'),
    /**
     * 退场前的准备：请主进程按滑动方向把窗口重新放开一段。
     *
     * 必须等它落地再让卡片开始滑 —— 窗口不放开，卡片滑向屏幕外的那一半会被窗口
     * 边界裁掉（看起来是"退场一顿"。见 NotificationToast.dismiss 的顺序）。
     */
    prepareExit: () => ipcRenderer.invoke('notification:prepare-exit'),
    getMuteReport: () => ipcRenderer.invoke('notification:getMuteReport'),
    onLuma: (callback: (bands: any) => void) => subscribe('notification:luma', callback),
    // 主进程的定帧折射：弹窗可见期间持续推新的桌面帧（约 3fps，按实测帧成本自适应）
    onBackdrop: (callback: (frame: any) => void) => subscribe('notification:backdrop', callback),
    // 渲染层的 WGC 视频流已接管折射，主进程可以停掉抓帧
    setGlassMode: (mode: string) => ipcRenderer.send('notification:glassMode', { mode }),
    onShow: (callback: (event: any, data: any) => void) => subscribe('notification:show', callback),
    /** 窗口真正显示出来了（主进程在 showInactive 之后发）：入场动画的起跑信号。 */
    onShown: (callback: (event: any, data: any) => void) => subscribe('notification:shown', callback),
    /** 窗口收回后主进程下发的**新窗口几何**（主题采样按它把取样点挪出窗口）。 */
    onGeometry: (callback: (event: any, data: any) => void) => subscribe('notification:geometry', callback)
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
    getChangelog: () => ipcRenderer.invoke('app:getChangelog'),
    /** 背景平均亮度（0-1），用于「明暗跟随背景」；拿不到时 luminance 为 null */
    backgroundLuminance: (path: string) => ipcRenderer.invoke('appearance:backgroundLuminance', path),
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

  // MCP 服务（v0.9.5）。客户端配置整段由主进程拼好，token 不必进入渲染进程。
  mcp: {
    getStatus: () => ipcRenderer.invoke('mcp:getStatus'),
    getClientConfig: () => ipcRenderer.invoke('mcp:getClientConfig')
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
    getTimeDistribution: (force?: boolean) => ipcRenderer.invoke('analytics:getTimeDistribution', force),
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
    getConsumerAssignments: () => ipcRenderer.invoke('ai:getConsumerAssignments'),
    assignConsumer: (consumer: string, profileId: string) => ipcRenderer.invoke('ai:assignConsumer', consumer, profileId),
    testProfile: (input: any) => ipcRenderer.invoke('ai:testProfile', input),
    setSetup: (patch: any) => ipcRenderer.invoke('ai:setSetup', patch),
    listChats: () => ipcRenderer.invoke('ai:listChats'),
    createChat: (title?: string) => ipcRenderer.invoke('ai:createChat', title),
    renameChat: (chatId: string, title: string) => ipcRenderer.invoke('ai:renameChat', chatId, title),
    reorderChats: (orderedIds: string[]) => ipcRenderer.invoke('ai:reorderChats', orderedIds),
    deleteChat: (chatId: string) => ipcRenderer.invoke('ai:deleteChat', chatId),
    getChat: (chatId: string) => ipcRenderer.invoke('ai:getChat', chatId),
    compactChat: (chatId: string) => ipcRenderer.invoke('ai:compactChat', chatId),
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

  // WeBot（v1.0 定时任务与笔记板）
  weBot: {
    listTasks: () => ipcRenderer.invoke('webot:listTasks'),
    createTask: (input: any) => ipcRenderer.invoke('webot:createTask', input),
    updateTask: (id: string, patch: any) => ipcRenderer.invoke('webot:updateTask', id, patch),
    deleteTask: (id: string) => ipcRenderer.invoke('webot:deleteTask', id),
    runNow: (id: string) => ipcRenderer.invoke('webot:runNow', id),
    listRuns: (taskId?: string) => ipcRenderer.invoke('webot:listRuns', taskId),
    listNotes: (options?: { taskId?: string; limit?: number }) => ipcRenderer.invoke('webot:listNotes', options),
    getNote: (id: string) => ipcRenderer.invoke('webot:getNote', id),
    /** 置顶是笔记唯一的状态：已读/未读整条功能在 v1.0.1 删除。 */
    updateNote: (id: string, patch: { pinned?: boolean }) => ipcRenderer.invoke('webot:updateNote', id, patch),
    /** 逐条删除（卡片右上角的 ✕）。 */
    deleteNote: (id: string) => ipcRenderer.invoke('webot:deleteNote', id),
    clearNotes: () => ipcRenderer.invoke('webot:clearNotes'),
    /** 任务成功时的通知（主进程弹卡片后也会广播到这里）。 */
    onNote: (callback: (note: any) => void) => subscribe('webot:note', callback),
    onRunStarted: (callback: (run: any) => void) => subscribe('webot:runStarted', callback),
    /** 运行结束（成功/失败都有）：渲染层据此把「运行中」那一行换成终态。 */
    onRunFinished: (callback: (run: any) => void) => subscribe('webot:runFinished', callback)
  },

  // macOS 能力诊断（v1.0）：仅在 darwin 上返回真实结果
  diagnostics: {
    collectMac: () => ipcRenderer.invoke('diagnostics:collectMac')
  },

  // 连接器（第三方工具，v1.0）。`connect` 收明文令牌，其余接口只出掩码。
  connectors: {
    list: () => ipcRenderer.invoke('connectors:list'),
    connect: (id: string, token: string) => ipcRenderer.invoke('connectors:connect', id, token),
    disconnect: (id: string) => ipcRenderer.invoke('connectors:disconnect', id),
    verify: (id: string) => ipcRenderer.invoke('connectors:verify', id),
    listTargets: (id: string) => ipcRenderer.invoke('connectors:listTargets', id),
    createTask: (id: string, input: any) => ipcRenderer.invoke('connectors:createTask', id, input),
    getAgentSettings: () => ipcRenderer.invoke('connectors:getAgentSettings'),
    setAgentSettings: (patch: { allowAgentWrite?: boolean }) => ipcRenderer.invoke('connectors:setAgentSettings', patch)
  },

  weclone: {
    generate: (opts?: { redact?: boolean }) => ipcRenderer.invoke('weclone:generate', opts),
    list: () => ipcRenderer.invoke('weclone:list'),
    get: (id: string) => ipcRenderer.invoke('weclone:get', id),
    /** 导出（生成）时的脱敏开关，持久化在配置里 */
    getRedact: () => ipcRenderer.invoke('weclone:getRedact'),
    setRedact: (enabled: boolean) => ipcRenderer.invoke('weclone:setRedact', enabled),
    // 纯本地：删除就是删掉本机目录，没有 remote 参数
    delete: (id: string) => ipcRenderer.invoke('weclone:delete', id),
    // on-device 对话：人格档案 + 本地检索都在主进程完成，不上传
    chat: (cloneId: string, message: string, history?: Array<{ role: string; content: string }>) =>
      ipcRenderer.invoke('weclone:chat', cloneId, message, history),
    cancel: () => ipcRenderer.invoke('weclone:cancel'),
    // 对话历史（本机文件）：回看 / 改标题 / 删除都走这几个通道
    listChats: (cloneId: string) => ipcRenderer.invoke('weclone:listChats', cloneId),
    getChat: (cloneId: string, chatId: string) => ipcRenderer.invoke('weclone:getChat', cloneId, chatId),
    saveChat: (payload: { cloneId: string; chatId?: string; turns: Array<{ role: 'user' | 'assistant'; content: string; at?: number }>; title?: string }) =>
      ipcRenderer.invoke('weclone:saveChat', payload),
    renameChat: (cloneId: string, chatId: string, title: string) => ipcRenderer.invoke('weclone:renameChat', cloneId, chatId, title),
    deleteChat: (cloneId: string, chatId: string) => ipcRenderer.invoke('weclone:deleteChat', cloneId, chatId),
    onProgress: (callback: (payload: any) => void) => subscribe('weclone:progress', callback),
    /**
     * 每个克隆自己的设置（v1.0.1）：拒答行为、脱敏开关等。
     * 存在克隆目录里的 settings.json —— 和它的档案、语料同生共死。
     */
    getSettings: (cloneId: string) => ipcRenderer.invoke('weclone:getSettings', cloneId),
    setSettings: (cloneId: string, patch: { refusal?: string }) =>
      ipcRenderer.invoke('weclone:setSettings', cloneId, patch)
  },

  /**
   * 长任务状态快照（v1.0.1）。
   *
   * 渲染进程可能被整个销毁重建（托盘隐藏销毁窗口 / 最小化 unload），而克隆
   * 生成、导出、连接都跑在主进程里。新文档启动时调一次 `status()` 就能把进度、
   * 日志、开始时间原样拿回来 —— 否则重建后的界面看起来像什么都没发生过。
   */
  task: {
    status: () => ipcRenderer.invoke('task:status')
  },

  process: {
    platform: process.platform,
    arch: process.arch
  }
})
