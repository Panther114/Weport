/// <reference types="vite/client" />

// ---------------------------------------------------------------------------
// WeBot（v1.0 定时任务与笔记板）
//
// 这些形状与主进程的 electron/services/weBotSchedule.ts 和 weBotService.ts
// 一一对应。渲染层不能直接 import electron/ 下的模块（两个 tsconfig 分开），
// 因此这里复制一份声明；改主进程时务必同步改这里。
// ---------------------------------------------------------------------------

type WeBotSchedule =
  | { kind: 'daily'; hour: number; minute: number }
  | { kind: 'weekly'; weekday: number; hour: number; minute: number }
  | { kind: 'monthly'; day: number; hour: number; minute: number }
  | { kind: 'interval'; everyMinutes: number; anchorMs: number }

/** 错过执行时间时的补偿策略：跳过 / 只补最近一次 / 全部补齐（有上限）。 */
type WeBotCatchUp = 'skip' | 'once' | 'all'

interface WeBotReference {
  id: string
  label: string
  kind: 'group' | 'private' | 'official'
}

interface WeBotTask {
  id: string
  title: string
  description: string
  schedule: WeBotSchedule
  catchUp: WeBotCatchUp
  enabled: boolean
  references: WeBotReference[]
  allowParallel: boolean
  createdAt: number
  updatedAt: number
  nextRunAt: number | null
  lastRunAt: number | null
}

type WeBotRunStatus = 'running' | 'ok' | 'error' | 'skipped'

interface WeBotRun {
  id: string
  taskId: string
  taskTitle: string
  scheduledAt: number
  startedAt: number
  finishedAt?: number
  status: WeBotRunStatus
  error?: string
  noteId?: string
  durationMs?: number
}

interface WeBotNote {
  version: 1
  id: string
  taskId: string
  taskTitle: string
  runId: string
  createdAt: number
  title: string
  summary: string
  status: 'ok' | 'error'
  references: WeBotReference[]
  read: boolean
  pinned: boolean
}


interface WeCloneMetaInfo {
  id: string
  wxid: string
  displayName: string
  knowledgeCutoff: string
  messageCount: number
  sessionCount: number
  chunkCount: number
  generatedAt: string
  piiHits?: number
  truncated?: boolean
}
/**
 * Connector types (v1.0). Mirrors electron/services/connectors/types.ts — the main
 * process is the source of truth; these declarations exist so the settings panel
 * can be typed without importing electron code into the renderer.
 */
type ConnectorPriority = 'none' | 'low' | 'medium' | 'high' | 'urgent'
interface ConnectorDescriptor {
  id: string
  name: string
  description: string
  authKind: 'token' | 'oauth'
  capabilities: { read: boolean; write: boolean; hasTargets: boolean }
  credentialUrl: string
  credentialHelp: string[]
  credentialPlaceholder: string
}
interface ConnectorConnectionState {
  id: string
  connected: boolean
  credentialHint?: string
  connectedAt?: number
  lastCheck?: { at: number; ok: boolean; error?: string; accountName?: string }
}
interface ConnectorView extends ConnectorConnectionState {
  descriptor: ConnectorDescriptor
}
interface ConnectorTarget {
  id: string
  name: string
  kind: 'project' | 'label' | 'inbox'
}
interface ConnectorTaskInput {
  content: string
  description?: string
  dueDate?: string
  dueDatetime?: string
  dueText?: string
  dueLang?: string
  priority?: ConnectorPriority
  labels?: string[]
  targetId?: string
  parentId?: string
}
interface ConnectorTaskResult {
  id: string
  content: string
  url?: string
  dueText?: string
  priority?: ConnectorPriority
  targetName?: string
}
interface ExportRequest {
  format: 'chatlab' | 'chatlab-jsonl' | 'json' | 'arkme-json' | 'html' | 'markdown' | 'txt' | 'excel' | 'weclone' | 'sql'
  contentType?: 'text' | 'voice' | 'image' | 'video' | 'emoji' | 'file'
  dateRange?: { start: number; end: number } | null
  senderUsername?: string
  fileNameSuffix?: string
  fileNamingMode?: 'classic' | 'date-range'
  exportConflictStrategy?: 'incremental' | 'overwrite' | 'rename'
  exportMedia?: boolean
  exportAvatars?: boolean
  exportImages?: boolean
  exportVoices?: boolean
  exportVideos?: boolean
  exportEmojis?: boolean
  exportFiles?: boolean
  maxFileSizeMb?: number
  exportVoiceAsText?: boolean
  exportPathStyle?: 'auto' | 'posix' | 'windows'
  excelCompactColumns?: boolean
  txtColumns?: string[]
  sessionLayout?: 'shared' | 'per-session'
  exportWriteLayout?: 'A' | 'B' | 'C'
  sessionNameWithTypePrefix?: boolean
  displayNamePreference?: 'group-nickname' | 'remark' | 'nickname'
  exportConcurrency?: number
  sessionIds?: string[]
}

interface ElectronApi {
  config: {
    get: (key: string) => Promise<any>
    set: (key: string, value: any) => Promise<{ success: boolean }>
    clear: () => Promise<{ success: boolean }>
    updateWxidEntry: (wxid: string, patch: Record<string, unknown>) => Promise<{ success: boolean; error?: string }>
  }
  notification: {
    show: (data: any) => Promise<void>
    close: () => Promise<void>
    click: (payload: any) => void
    ready: () => void
    resize: (width: number, height: number) => void
    glassRect: (payload: any) => void
    glassHide: () => void
    showTest: () => Promise<{ success: boolean }>
    getMuteReport: () => Promise<{
      success: boolean
      sessionCount: number
      sessionFlagMutedCount: number
      mutedCount: number
      flagBefore: number
      flagAfter: number
      unknownStatusCount: number
      nativeRawKeyCount: number
      foldedCount: number
      nativeAvailable: boolean
      returnedKeyCount: number
      returnedKeysSample: string[]
      missingKeys: number
      muted: Array<{ username: string; displayName: string; isMuted: boolean; isFolded: boolean }>
      all: Array<{ username: string; displayName: string; isMuted: boolean; isFolded: boolean }>
      error?: string
    }>
    onLuma: (callback: (bands: any) => void) => () => void
    onShow: (callback: (event: any, data: any) => void) => () => void
    /** 主进程的定帧折射帧（弹窗可见期间约 3fps） */
    onBackdrop: (callback: (frame: { seq: number; dataUrl: string; winX: number; winY: number; width: number; height: number }) => void) => () => void
    /** 通知主进程：渲染层的实时视频流已接管折射，不必再抓帧 */
    setGlassMode: (mode: 'stream' | 'frames' | 'native') => void
  }
  dialog: {
    openDirectory: (options?: any) => Promise<string | null>
    openFile: (options?: any) => Promise<string | null>
  }
  shell: {
    openPath: (path: string) => Promise<string>
    openExternal: (url: string) => Promise<void>
  }
  app: {
    getVersion: () => Promise<string>
    getLaunchAtStartupStatus: () => Promise<{ enabled: boolean; supported: boolean; reason?: string }>
    setLaunchAtStartup: (enabled: boolean) => Promise<any>
    checkForUpdates: () => Promise<{ hasUpdate: boolean; version?: string; releaseNotes?: string; error?: string }>
    getChangelog: () => Promise<{ success: boolean; version?: string; content?: string; error?: string }>
    /** 背景平均亮度（0=黑，1=白），用于「明暗跟随背景」。拿不到时 success=false。 */
    backgroundLuminance: (path: string) => Promise<{ success: boolean; luminance: number | null }>
    downloadAndInstall: () => Promise<{ success: boolean; restarting?: boolean; error?: string }>
    ignoreUpdate: (version: string) => Promise<{ success: boolean }>
    onDownloadProgress: (callback: (progress: any) => void) => () => void
    onUpdateDownloaded: (callback: () => void) => () => void
    onUpdateAvailable: (callback: (info: { version: string; releaseNotes: string }) => void) => () => void
  }
  backup: {
    create: (payload: { outputPath: string; options?: { includeImages?: boolean; includeVideos?: boolean; includeFiles?: boolean } }) => Promise<{ success: boolean; filePath?: string; error?: string }>
    inspect: (archivePath: string) => Promise<{ success: boolean; meta?: any; error?: string }>
    restore: (archivePath: string) => Promise<{ success: boolean; error?: string }>
  }
  http: {
    start: () => Promise<{ success: boolean; port?: number; error?: string }>
    stop: () => Promise<void>
    getStatus: () => Promise<{ running: boolean; port: number; host: string }>
  }
  mcp: {
    getStatus: () => Promise<{ running: boolean; port: number; host: string; tokenConfigured: boolean }>
    getClientConfig: () => Promise<{
      running: boolean
      port: number
      host: string
      tokenConfigured: boolean
      bridgePath: string
      json: string
    }>
  }
  auth: {
    verifyHello: (message?: string) => Promise<{ success: boolean; error?: string }>
  }
  dbPath: {
    autoDetect: () => Promise<{ success: boolean; path?: string; error?: string }>
    scanWxids: (rootPath: string) => Promise<Array<{ wxid: string; modifiedTime: number; nickname?: string; avatarUrl?: string }>>
    getDefault: () => Promise<string>
  }
  key: {
    autoGetDbKey: () => Promise<{ success: boolean; key?: string; error?: string; logs?: string[] }>
    onDbKeyStatus: (callback: (payload: { message: string; level: number }) => void) => () => void
    autoGetImageKey: (manualDir?: string, wxid?: string) => Promise<{ success: boolean; xorKey?: number; aesKey?: string; verified?: boolean; error?: string }>
    scanImageKeyFromMemory: (userDir: string) => Promise<{ success: boolean; xorKey?: number; aesKey?: string; error?: string }>
    onImageKeyStatus: (callback: (payload: { message: string }) => void) => () => void
  }
  wcdb: {
    testConnection: (dbPath: string, hexKey: string, wxid: string) => Promise<{ success: boolean; error?: string; sessionCount?: number }>
  }
  chat: {
    connect: () => Promise<{ success: boolean; error?: string }>
    close: () => Promise<{ success: boolean }>
    getSessions: () => Promise<{ success: boolean; sessions?: any[]; error?: string }>
    markAllSessionsRead: () => Promise<{ success: boolean; error?: string }>
    getContactAvatar: (username: string, chatroomId?: string) => Promise<{ avatarUrl?: string; displayName?: string } | null>
    enrichSessionsContactInfo: (usernames: string[], options?: any) => Promise<any>
    getSessionStatuses: (usernames: string[]) => Promise<{ map?: Record<string, { isFolded: boolean; isMuted: boolean }> }>
    getNewMessages: (sessionId: string, minTime: number, limit?: number) => Promise<{ success: boolean; messages?: any[]; error?: string }>
    getAntiRevokeSessions: () => Promise<{ success: boolean; sessions?: any[]; error?: string }>
    checkAntiRevokeTriggers: (sessionIds: string[]) => Promise<{ success: boolean; rows?: Array<{ sessionId: string; success: boolean; installed?: boolean; error?: string }>; error?: string }>
    installAntiRevokeTriggers: (sessionIds: string[]) => Promise<{ success: boolean; rows?: Array<{ sessionId: string; success: boolean; alreadyInstalled?: boolean; error?: string }>; error?: string }>
    uninstallAntiRevokeTriggers: (sessionIds: string[]) => Promise<{ success: boolean; rows?: Array<{ sessionId: string; success: boolean; error?: string }>; error?: string }>
  }
  export: {
    exportSessions: (outputRoot: string, options?: ExportRequest) => Promise<any>
    cancelTask: (taskId: string) => Promise<{ success: boolean }>
    getExportLog: (outputRoot: string) => Promise<{ path: string; txt: string | null; json: string | null; exists: boolean }>
    clearLibrary: (outputRoot: string) => Promise<{ success: boolean; removed: string[]; error?: string }>
    onProgress: (callback: (payload: any) => void) => () => void
  }
  ai: {
    getSetup: () => Promise<{
      hasApiKey: boolean
      baseUrl: string
      baseUrlError?: string
      model: string
      reasoningEffort: string
      customPrompt: string
      workspaceRoot: string
      exportPath: string
      dbReady: boolean
      disabledTools: string[]
      activeProfileId: string
      profiles: Array<{
        id: string
        name: string
        displayName: string
        providerId: string
        protocol: string
        baseUrl: string
        model: string
        hasApiKey: boolean
        apiKeyHint: string
        updatedAt: number
        discovery?: { models: string[]; fetchedAt: number; error?: string }
        /** Per-model metadata resolved by the provider layer (models.dev + live /models). */
        modelContextWindow?: number
        modelMaxOutputTokens?: number
        modelProtocol?: string
        /** USD per million tokens. Absent means unknown — render `N/A`, never `$0.00`. */
        modelCost?: { input?: number; output?: number; reasoning?: number; cacheRead?: number; cacheWrite?: number }
        modelCapabilities?: {
          attachment: boolean
          reasoning: boolean
          toolCall: boolean
          chatCapable: boolean
          modalities: { input: string[]; output: string[] }
        }
        modelReasoningOptions?: Array<{ type: string; values?: string[]; min?: number; max?: number }>
        modelMetadataSource?: string
      }>
      catalog: Array<{
        id: string
        name: string
        description: string
        protocol: string
        baseUrl: string
        defaultModel: string
        models: string[]
        allowCustomBaseUrl?: boolean
        protocolOptions?: string[]
        apiKeyOptional?: boolean
        /** models.dev provider id used for per-model protocol / cost / limits lookup. */
        registryProviderId?: string
      }>
    }>
    setSetup: (patch: any) => Promise<{ success: boolean }>
    listProviders: () => Promise<{ providers: any[] }>
    fetchModels: (input: { providerId: string; protocol?: string; baseUrl?: string; apiKey?: string }) => Promise<{ success: boolean; models?: string[]; status?: number; error?: string }>
    saveProfile: (input: any) => Promise<{ success: boolean; profile?: any; error?: string }>
    activateProfile: (id: string) => Promise<{ success: boolean; error?: string }>
    deleteProfile: (id: string) => Promise<{ success: boolean; error?: string }>
    getConsumerAssignments: () => Promise<{
      success: boolean
      consumers: Array<{
        consumer: 'chat' | 'weclone' | 'webot'
        profileId: string
        profileName: string
        followsDefault: boolean
        providerId: string
        model: string
      }>
      profiles: Array<{ id: string; name: string; providerId: string; model: string; hasApiKey: boolean; apiKeyHint?: string }>
      activeProfileId: string
    }>
    assignConsumer: (consumer: string, profileId: string) => Promise<{ success: boolean; error?: string }>
    testProfile: (input: { providerId: string; protocol?: string; baseUrl?: string; apiKey?: string }) => Promise<{ success: boolean; models?: string[]; status?: number; error?: string }>
    listChats: () => Promise<{ chats: Array<{ id: string; title: string; createdAt: number; updatedAt: number }> }>
    createChat: (title?: string) => Promise<{ chat: { id: string; title: string; createdAt: number; updatedAt: number } }>
    renameChat: (chatId: string, title: string) => Promise<{ success: boolean }>
    reorderChats: (orderedIds: string[]) => Promise<{ success: boolean }>
    deleteChat: (chatId: string) => Promise<{ success: boolean }>
    /** 手动压缩上下文：`changed: false` 表示还没到阈值，未做改动。 */
    compactChat: (chatId: string) => Promise<{
      success: boolean
      changed: boolean
      reason?: 'below-threshold' | 'not-found'
      dropped?: number
      kept?: number
      digestChars?: number
      error?: string
    }>
    getChat: (chatId: string) => Promise<{
      chat: { id: string; title: string; createdAt: number; updatedAt: number }
      workspaceDir: string
      memoryDir: string
      messages: Array<{
        id: string
        role: 'user' | 'assistant' | 'tool'
        content: string
        reasoning?: string
        toolCalls?: Array<{ id: string; name: string; args: Record<string, unknown>; friendly: string; ok: boolean; result?: string }>
        createdAt: number
        /** 本轮解码计时（ttft / decode / output tokens），用于消息尾部 tok/s 读数 */
        timing?: { ttftMs: number; decodeMs: number; outputTokens: number }
      }>
      lastRun?: {
        usage?: { totalTokens?: number; promptTokens?: number; completionTokens?: number; reasoningTokens?: number; promptCacheHitTokens?: number }
        context?: { promptTokens?: number; cacheHitTokens?: number; lastRequestTokens?: number; recentRate?: number; contextWindow?: number }
      }
    } | null>
    listNotes: (chatId: string) => Promise<{ notes: Array<{ path: string; bytes: number; mtime: number; scope: 'memory' | 'notes' }> }>
    readNoteFile: (chatId: string, path: string) => Promise<{ content: string | null }>
    deleteNoteFile: (chatId: string, path: string) => Promise<{ success: boolean }>
    clearMemory: () => Promise<{ success: boolean; removed: number; error?: string }>
    getDebugLog: (limit?: number) => Promise<{ lines: string[] }>
    clearDebugLog: () => Promise<{ success: boolean }>
    listActions: () => Promise<{ actions: Array<{ id: string; name: string; prompt: string }> }>
    saveActions: (actions: Array<{ id: string; name: string; prompt: string }>) => Promise<{ success: boolean }>
    send: (chatId: string, text: string) => Promise<{ success: boolean; error?: string }>
    abort: (chatId: string) => Promise<{ success: boolean }>
    onEvent: (callback: (event: any) => void) => () => void
  }
  sns: {
    getTimeline: (limit: number, offset: number, usernames?: string[], keyword?: string, startTime?: number, endTime?: number) => Promise<{ success: boolean; timeline?: any[]; error?: string }>
    getSnsUsernames: () => Promise<{ success: boolean; usernames?: string[]; error?: string }>
    getUserPostCounts: (options?: { preferCache?: boolean; forceRefresh?: boolean }) => Promise<{ success: boolean; counts?: Record<string, number>; error?: string }>
    getExportStats: (options?: { allowTimelineFallback?: boolean; preferCache?: boolean; forceRefresh?: boolean }) => Promise<{ success: boolean; data?: { totalPosts: number; totalFriends: number; myPosts: number | null }; error?: string }>
    getExportStatsFast: () => Promise<{ success: boolean; data?: { totalPosts: number; totalFriends: number; myPosts: number | null }; error?: string }>
    getUserPostStats: (username: string) => Promise<{ success: boolean; data?: { username: string; totalPosts: number }; error?: string }>
    debugResource: (url: string) => Promise<{ success: boolean; status?: number; headers?: any; error?: string }>
    proxyImage: (payload: string | { url: string; key?: string | number; skipFailedCache?: boolean }) => Promise<{ success: boolean; dataUrl?: string; videoPath?: string; cachePath?: string; status?: number; error?: string }>
    warmupTimeline: () => Promise<void>
    peekNewestTimeline: () => Promise<{ success: boolean; newestId?: string; newestTime?: number; error?: string }>
    downloadImage: (payload: { url: string; key?: string | number }) => Promise<{ success: boolean; filePath?: string; error?: string }>
    exportTimeline: (options: any) => Promise<{ success: boolean; filePath?: string; postCount?: number; mediaCount?: number; paused?: boolean; stopped?: boolean; error?: string }>
    selectExportDir: () => Promise<{ canceled: boolean; filePath?: string }>
    installBlockDeleteTrigger: () => Promise<{ success: boolean; alreadyInstalled?: boolean; error?: string }>
    uninstallBlockDeleteTrigger: () => Promise<{ success: boolean; error?: string }>
    checkBlockDeleteTrigger: () => Promise<{ success: boolean; installed?: boolean; error?: string }>
    deleteSnsPost: (postId: string) => Promise<{ success: boolean; error?: string }>
    downloadEmoji: (params: { url: string; encryptUrl?: string; aesKey?: string }) => Promise<{ success: boolean; localPath?: string; error?: string }>
    getCacheMigrationStatus: () => Promise<{ success: boolean; needed: boolean; inProgress: boolean; totalFiles: number; items?: Array<{ label: string; fileCount: number }>; error?: string }>
    startCacheMigration: () => Promise<{ success: boolean; copied?: number; skipped?: number; totalFiles?: number; error?: string }>
    onExportProgress: (callback: (payload: any) => void) => () => void
    onCacheMigrationProgress: (callback: (payload: any) => void) => () => void
  }
  analytics: {
    getOverallStatistics: (force?: boolean) => Promise<{ success: boolean; data?: any; error?: string }>
    getContactRankings: (limit?: number, beginTimestamp?: number, endTimestamp?: number, options?: { includeGroupChats?: boolean }) => Promise<{ success: boolean; data?: any[]; error?: string }>
    getTimeDistribution: (force?: boolean) => Promise<{ success: boolean; data?: any; error?: string }>
    getSelfSentDailyDistribution: (beginTimestamp?: number, endTimestamp?: number, force?: boolean) => Promise<{ success: boolean; data?: any; error?: string }>
    getExcludedUsernames: () => Promise<{ success: boolean; data?: string[]; error?: string }>
    setExcludedUsernames: (usernames: string[]) => Promise<{ success: boolean; data?: string[]; error?: string }>
    getExcludeCandidates: (options?: { includeGroupChats?: boolean }) => Promise<{ success: boolean; data?: Array<{ username: string; displayName: string; avatarUrl?: string }>; error?: string }>
    getDailyActivity: (force?: boolean) => Promise<{ success: boolean; data?: { daily: Record<string, number>; sentDaily: Record<string, number> }; error?: string }>
    getWordFrequency: (limit?: number, force?: boolean) => Promise<{ success: boolean; data?: { items: Array<{ word: string; count: number }>; scannedMessages: number; textMessages: number }; error?: string }>
    clearCache: () => Promise<{ success: boolean; error?: string }>
  }
  groupAnalytics: {
    getGroupChats: () => Promise<{ success: boolean; data?: Array<{ username: string; displayName: string; memberCount: number; messageCount: number; avatarUrl?: string }>; error?: string }>
    getGroupMembers: (chatroomId: string) => Promise<{ success: boolean; data?: any[]; error?: string }>
    getGroupMembersPanelData: (chatroomId: string, options?: any) => Promise<{ success: boolean; data?: any[]; error?: string }>
    getGroupMessageRanking: (chatroomId: string, limit?: number, startTime?: number, endTime?: number) => Promise<{ success: boolean; data?: any[]; error?: string }>
    getGroupActiveHours: (chatroomId: string, startTime?: number, endTime?: number) => Promise<{ success: boolean; data?: { hourlyDistribution: Record<number, number> }; error?: string }>
    getGroupMediaStats: (chatroomId: string, startTime?: number, endTime?: number) => Promise<{ success: boolean; data?: any; error?: string }>
    getGroupActivityHeatmap: (chatroomId: string, startTime?: number, endTime?: number) => Promise<{ success: boolean; data?: { data: number[][]; total: number }; error?: string }>
    getGroupMemberAnalytics: (chatroomId: string, memberUsername: string, startTime?: number, endTime?: number) => Promise<{ success: boolean; data?: any; error?: string }>
    getGroupMemberMessages: (chatroomId: string, memberUsername: string, options?: any) => Promise<{ success: boolean; data?: { messages: any[]; hasMore: boolean; nextCursor: number }; error?: string }>
    exportGroupMembers: (chatroomId: string, outputPath: string) => Promise<{ success: boolean; filePath?: string; error?: string }>
    exportGroupMemberMessages: (chatroomId: string, memberUsername: string, outputPath: string, startTime?: number, endTime?: number) => Promise<{ success: boolean; filePath?: string; error?: string }>
  }
  annualReport: {
    getAvailableYears: () => Promise<{ success: boolean; data?: number[]; error?: string; meta?: any }>
    startAvailableYearsLoad: () => Promise<{ success: boolean; taskId?: string; reused?: boolean; snapshot?: any; error?: string }>
    cancelAvailableYearsLoad: (taskId: string) => Promise<{ success: boolean; error?: string }>
    generateReport: (year: number) => Promise<{ success: boolean; data?: any; error?: string }>
    exportImages: (payload: { baseDir: string; folderName: string; images: Array<{ name: string; dataUrl: string }> }) => Promise<{ success: boolean; dir?: string; error?: string }>
    captureCurrentWindow: () => Promise<{ success: boolean; dataUrl?: string; size?: number[]; error?: string }>
    onProgress: (callback: (payload: any) => void) => () => void
    onAvailableYearsProgress: (callback: (payload: any) => void) => () => void
  }
  dualReport: {
    generateReport: (friendUsername: string, year: number) => Promise<{ success: boolean; data?: any; error?: string }>
    onProgress: (callback: (payload: any) => void) => () => void
  }
  /**
   * WeBot（v1.0 定时任务与笔记板）。
   *
   * 字段与主进程 electron/services/weBotService.ts 的 WeBotTask / WeBotRun /
   * WeBotNote 保持一致（该文件是唯一真源）。
   */
  weBot: {
    listTasks: () => Promise<WeBotTask[]>
    createTask: (input: Partial<WeBotTask> & { title: string; schedule: WeBotSchedule }) => Promise<WeBotTask>
    updateTask: (id: string, patch: Partial<WeBotTask>) => Promise<WeBotTask | null>
    deleteTask: (id: string) => Promise<boolean>
    runNow: (id: string) => Promise<{ success: boolean; error?: string }>
    listRuns: (taskId?: string) => Promise<WeBotRun[]>
    listNotes: (options?: { taskId?: string; unreadOnly?: boolean; limit?: number }) => Promise<WeBotNote[]>
    getNote: (id: string) => Promise<WeBotNote | null>
    updateNote: (id: string, patch: { read?: boolean; pinned?: boolean }) => Promise<WeBotNote | null>
    unreadCount: () => Promise<number>
    clearNotes: () => Promise<number>
    onNote: (callback: (note: WeBotNote) => void) => () => void
    onRunStarted: (callback: (run: WeBotRun) => void) => () => void
  }
  /**
   * macOS 能力诊断（v1.0）。非 darwin 平台返回 supported:false，
   * 界面据此隐藏入口。字段与 electron/services/macDiagnosticsService.ts 对应。
   */
  diagnostics: {
    collectMac: () => Promise<{
      supported: boolean
      collectedAt: number
      platform: string
      appVersion: string
      arch: string
      checks: Array<{ id: string; label: string; state: 'ok' | 'warn' | 'fail' | 'unknown'; detail: string; raw?: string }>
      summary: string
    }>
  }
  /**
   * 连接器（第三方工具，v1.0）。字段与 electron/services/connectors/types.ts 对应；
   * 令牌只在 `connect` 单向流入主进程，读接口永远只返回 `····9f2c` 掩码。
   */
  connectors: {
    list: () => Promise<ConnectorView[]>
    connect: (id: string, token: string) => Promise<{ success: boolean; data?: ConnectorView; error?: string }>
    disconnect: (id: string) => Promise<{ success: boolean; data?: ConnectorView; error?: string }>
    verify: (id: string) => Promise<{ success: boolean; data?: ConnectorView; error?: string }>
    listTargets: (id: string) => Promise<{ success: boolean; data?: ConnectorTarget[]; error?: string }>
    createTask: (id: string, input: ConnectorTaskInput) => Promise<{ success: boolean; data?: ConnectorTaskResult; error?: string }>
    getAgentSettings: () => Promise<{ allowAgentWrite: boolean }>
    setAgentSettings: (patch: { allowAgentWrite?: boolean }) => Promise<{ allowAgentWrite: boolean }>
  }
  weclone: {
    /**
     * 和分身对话 —— **完全在本机完成**（人格档案 + 本地检索 + 用户自己的模型 API）。
     * `hint` 是给用户看的下一步指引（还没生成过克隆 / 模型 key 不可用）。
     */
    chat: (cloneId: string, message: string, history?: Array<{ role: string; content: string }>) => Promise<{
      success: boolean
      reply?: string
      elapsedMs?: number
      error?: string
      hint?: string
      meta?: {
        cloneId: string
        displayName: string
        retrievedChunks: number
        corpusHits: number
        retrieveCostMs: number
        /** 实际回答的模型 / 提供商：界面上要显示"是哪个服务答的"。 */
        model: string
        providerId: string
      }
    }>
    generate: () => Promise<{
      success: boolean
      clone?: WeCloneMetaInfo
      aborted?: boolean
      error?: string
    }>
    list: () => Promise<{
      success: boolean
      clones: Array<WeCloneMetaInfo & { source: 'local' }>
      error?: string
    }>
    get: (id: string) => Promise<{
      success: boolean
      clone?: WeCloneMetaInfo
      mds?: Partial<Record<'profile' | 'relationships' | 'knowledge' | 'timeline' | 'language', string>>
      error?: string
    }>
    delete: (id: string) => Promise<{ success: boolean; error?: string }>
    cancel: () => Promise<{ success: boolean }>
    onProgress: (callback: (payload: { stage: 'scan' | 'generate' | 'filter' | 'done'; progress: number; message: string; detail?: any }) => void) => () => void
  }
  process: {
    platform: string
    arch: string
  }
}

interface Window {
  electronAPI: ElectronApi
}
