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
  /** 只可能是 `ok`：失败的运行从 v1.0.1 起不再产生笔记。 */
  status: 'ok' | 'error'
  references: WeBotReference[]
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
  /** 语料最早一条消息的日期（ISO），v1.0.1 */
  corpusStart?: string
  /** 生成时是否做了敏感信息脱敏 */
  redacted?: boolean
  /** 生成时实际用了几段时间切片（分片提炼） */
  shardCount?: number
  /** 分片提炼里失败的片数（失败片用本地统计兜底） */
  shardFailures?: number
  tokensIn?: number
  tokensOut?: number
  elapsedMs?: number
}

/**
 * 单个克隆自己的设置（v1.0.1）。
 *
 * `refusal` 决定 system prompt 里有没有"有些事你不说"这一节：
 * `character` = 以本人的方式带过去（默认）；`off` = 完全不设限。
 */
type WeCloneRefusalMode = 'character' | 'off'
interface WeCloneSettings {
  refusal: WeCloneRefusalMode
}

/**
 * 长任务状态快照（v1.0.1，`api.task.status()`）。
 *
 * 渲染进程可能被整个销毁重建（托盘隐藏销毁窗口 / 最小化 unload），
 * 而任务跑在主进程里 —— 这是它把进度、日志、开始时间还回来的通道。
 */
type LiveTaskStatusValue = 'idle' | 'running' | 'done' | 'failed' | 'aborted'
interface LiveTaskSnapshot {
  status: LiveTaskStatusValue
  stage?: string
  progress: number
  message: string
  logs: string[]
  startedAt?: number
  finishedAt?: number
  error?: string
  detail?: Record<string, unknown>
}
/** 一条克隆对话里的单轮消息（v1.0.1，本机持久化） */
interface WeCloneChatTurn {
  role: 'user' | 'assistant'
  content: string
  at: number
  error?: boolean
  hint?: string
}
/** 一条克隆对话（一个话题）：可回看、可改标题、可删除 */
interface WeCloneChat {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  turns: WeCloneChatTurn[]
}
interface WeCloneChatSummary {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  turnCount: number
  preview: string
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
    resize: (width: number, height: number, options?: { slideFrom?: string; room?: number; settled?: boolean }) => void
    glassRect: (payload: any) => void
    glassHide: () => void
    showTest: () => Promise<{ success: boolean }>
    /** 退场前把窗口按滑动方向放开一段（等它落地再开始退场动画）。 */
    prepareExit: () => Promise<{ extended: boolean }>
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
    /**
     * 窗口**真正显示出来**了（主进程在 `showInactive` 之后立刻发）。
     * 入场动画门控在它上面：CSS 动画在挂载时就会起跑，而窗口是等渲染层量好
     * 尺寸才显示的 —— 不门控的话用户只能看到滑入动画的后半段。
     */
    onShown: (callback: (event: any, data: { payloadId?: string }) => void) => () => void
    /**
     * 窗口收回（入场动画结束）后主进程下发的**新窗口几何**。
     * 主题采样按"窗口在屏幕上的位置"把取样点挪出窗口，坐标过时就会读到别处的桌面。
     */
    onGeometry: (callback: (event: any, data: { winX: number; winY: number; winW: number; winH: number }) => void) => () => void
    /**
     * 主进程的定帧折射帧。
     *
     * 两种形态（v1.1）：
     *  - 快速路径（koffi BitBlt，只抓卡片附近 ≈5~22ms）：`pixelsBase64` + `frameX/Y/Width/Height`；
     *  - 兜底路径（desktopCapturer 整屏 JPEG ≈150~208ms）：`dataUrl` + `winX/winY/width/height`。
     */
    onBackdrop: (callback: (frame: any) => void) => () => void
    /** 通知主进程：渲染层的实时视频流已接管折射，不必再抓帧 */
    setGlassMode: (mode: 'stream' | 'frames' | 'native') => void
    /** 上报 WGC 采集尝试结果：`ok:false` = 这台机器上采集流起不来，后续通知跳过尝试 */
    reportDesktopStream: (ok: boolean) => void
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
    checkForUpdates: () => Promise<{
    hasUpdate: boolean
    version?: string
    releaseNotes?: string
    error?: string
    /** Compatibility policy is evaluated by the Electron main process. */
    forced?: boolean
    blocked?: boolean
    reason?: string | null
    url?: string | null
    allowReadOnly?: boolean
    minimumSupportedVersion?: string | null
    currentVersion?: string
  }>
    getChangelog: () => Promise<{ success: boolean; version?: string; content?: string; error?: string }>
    /** 背景平均亮度（0=黑，1=白），用于「明暗跟随背景」。拿不到时 success=false。 */
    backgroundLuminance: (path: string) => Promise<{ success: boolean; luminance: number | null }>
    downloadAndInstall: () => Promise<{ success: boolean; restarting?: boolean; error?: string }>
    ignoreUpdate: (version: string) => Promise<{ success: boolean }>
    onDownloadProgress: (callback: (progress: any) => void) => () => void
    onUpdateDownloaded: (callback: () => void) => () => void
    onUpdateAvailable: (callback: (info: { version: string; releaseNotes: string; forced?: boolean; reason?: string | null; url?: string | null; hasUpdate?: boolean; allowReadOnly?: boolean }) => void) => () => void
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
    autoGetDbKey: () => Promise<{
      success: boolean
      key?: string
      error?: string
      logs?: string[]
      /** v1.2 §1：每库 page key（扫描路径的产物） */
      keys?: Array<{ id: string; kind: string; path: string; fingerprint: string; saltHex: string | null; mode: 'raw' | 'passphrase'; source: 'scan' | 'hook' | 'manual' | 'config' }>
      /** 实际生效的那条路 */
      mode?: 'existing' | 'scan' | 'hook' | 'manual'
      /** 逐项自检（§1.5 / D4） */
      prerequisites?: Array<{ id: string; status: 'pass' | 'fail' | 'warn' | 'skip'; message: string; action?: string; detail?: string }>
      prerequisiteSummary?: string
      /** 每条路为什么没成 */
      reasons?: { existing?: string; scan?: string; hook?: string }
      diagnostics?: { platform: string; scanSupported: boolean; elapsedMs: number; scan?: unknown }
    }>
    cancelDbKeyAcquire: () => Promise<{ success: boolean }>
    onDbKeyStatus: (callback: (payload: { message: string; level: number }) => void) => () => void
    autoGetImageKey: (manualDir?: string, wxid?: string) => Promise<{ success: boolean; xorKey?: number; aesKey?: string; verified?: boolean; error?: string }>
    scanImageKeyFromMemory: (userDir: string) => Promise<{ success: boolean; xorKey?: number; aesKey?: string; error?: string }>
    onImageKeyStatus: (callback: (payload: { message: string }) => void) => () => void
  }
  wcdb: {
    testConnection: (dbPath: string, hexKey: string, wxid: string) => Promise<{ success: boolean; error?: string; sessionCount?: number }>
  }
  chat: {
    connect: () => Promise<{ success: boolean; error?: string; readOnlySnapshot?: boolean }>
    onConnectionChanged: (callback: (event: any, data: { readOnlySnapshot: boolean }) => void) => () => void
    close: () => Promise<{ success: boolean }>
    getSessions: () => Promise<{ success: boolean; sessions?: any[]; error?: string }>
    markAllSessionsRead: () => Promise<{ success: boolean; error?: string }>
    getContactAvatar: (username: string, chatroomId?: string) => Promise<{ avatarUrl?: string; displayName?: string } | null>
    enrichSessionsContactInfo: (usernames: string[], options?: any) => Promise<any>
    getSessionStatuses: (usernames: string[]) => Promise<{ map?: Record<string, { isFolded: boolean; isMuted: boolean }> }>
    getNewMessages: (sessionId: string, minTime: number, limit?: number) => Promise<{ success: boolean; messages?: any[]; error?: string }>
    /** v1.2 §3 阅读器：真实分页（offset = 原始行偏移，0 为最近一窗，页内升序） */
    getMessages: (
      sessionId: string,
      offset?: number,
      limit?: number,
      startTime?: number,
      endTime?: number,
      ascending?: boolean
    ) => Promise<{ success: boolean; messages?: any[]; nextOffset?: number; hasMore?: boolean; error?: string }>
    getSessionMessageCounts: (sessionIds: string[], options?: { preferHintCache?: boolean }) => Promise<{
      success: boolean
      counts?: Record<string, number>
      error?: string
    }>
    getMessageDates: (sessionId: string) => Promise<{ success: boolean; dates?: string[]; error?: string }>
    getMessageByIdentity: (identity: { sessionId: string; localId: string | number; ts: number; db?: string; table?: string; idKind?: 'local' | 'server' }) => Promise<{ success: boolean; message?: any; error?: string }>
    searchMessages: (
      keyword: string,
      sessionId?: string,
      limit?: number,
      offset?: number,
      beginTimestamp?: number,
      endTimestamp?: number
    ) => Promise<{ success: boolean; messages?: any[]; error?: string }>
    getVideoData: (identity: { sessionId: string; localId: string | number; ts: number; db?: string; table?: string; idKind?: string }) => Promise<{ success: boolean; localPath?: string; url?: string; mime?: string; error?: string }>
    getImageDataByIdentity: (identity: { sessionId: string; localId: string | number; ts: number; db?: string; table?: string; idKind?: string }, options?: { excludeThumbnail?: boolean }) => Promise<{ success: boolean; data?: string; error?: string }>
    getFileData: (identity: { sessionId: string; localId: string | number; ts: number; db?: string; table?: string; idKind?: string }) => Promise<{ success: boolean; localPath?: string; fileName?: string; error?: string }>
    getImageData: (
      sessionId: string,
      msgId: string,
      options?: { excludeThumbnail?: boolean }
    ) => Promise<{ success: boolean; data?: string; localPath?: string; error?: string }>
    getVoiceData: (
      sessionId: string,
      msgId: string,
      createTime?: number,
      serverId?: string | number,
      senderWxid?: string
    ) => Promise<{ success: boolean; data?: string; localPath?: string; error?: string }>
    getAntiRevokeSessions: () => Promise<{ success: boolean; sessions?: any[]; error?: string }>
    checkAntiRevokeTriggers: (sessionIds: string[]) => Promise<{ success: boolean; rows?: Array<{ sessionId: string; success: boolean; installed?: boolean; error?: string }>; error?: string }>
    installAntiRevokeTriggers: (sessionIds: string[]) => Promise<{ success: boolean; rows?: Array<{ sessionId: string; success: boolean; alreadyInstalled?: boolean; error?: string }>; error?: string }>
    uninstallAntiRevokeTriggers: (sessionIds: string[]) => Promise<{ success: boolean; rows?: Array<{ sessionId: string; success: boolean; error?: string }>; error?: string }>
  }
  export: {
    exportSessions: (outputRoot: string, options?: ExportRequest) => Promise<any>
    cancelTask: (taskId: string) => Promise<{ success: boolean }>
    getExportLog: (outputRoot: string) => Promise<{ path: string; txt: string | null; json: string | null; exists: boolean }>
    /** v1.2 §10.2 ②：导出正确性自检报告（`<格式目录>/integrity-report.json`）。 */
    integrityReport: (outputRoot: string) => Promise<{ success: boolean; report?: any; path?: string; csvPath?: string; error?: string }>
    /** v1.2 §10.2 ②：对已存在的导出目录重跑一次自检（不重新导出）。 */
    runIntegrityCheck: (outputRoot: string) => Promise<{ success: boolean; report?: any; error?: string }>
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
    listNotes: (options?: { taskId?: string; limit?: number }) => Promise<WeBotNote[]>
    getNote: (id: string) => Promise<WeBotNote | null>
    updateNote: (id: string, patch: { pinned?: boolean }) => Promise<WeBotNote | null>
    /** 逐条删除一条笔记（卡片右上角的 ✕）。 */
    deleteNote: (id: string) => Promise<boolean>
    clearNotes: () => Promise<number>
    onNote: (callback: (note: WeBotNote) => void) => () => void
    onRunStarted: (callback: (run: WeBotRun) => void) => () => void
    onRunFinished: (callback: (run: WeBotRun) => void) => () => void
  }
  /**
   * macOS 能力诊断（v1.0）。非 darwin 平台返回 supported:false，
   * 界面据此隐藏入口。字段与 electron/services/macDiagnosticsService.ts 对应。
   */
  diagnostics: {
    monitorSnapshot: () => Promise<import('../electron/services/diagnosticsService').DiagnosticMonitorSnapshot>,
    /** 跨平台诊断（v1.2 §5）：一组检查记录 + 本地诊断包导出，不联网、不上传 */
    collect: (payload?: { full?: boolean }) => Promise<DiagnosticsReport>
    exportBundle: (payload?: { path?: string; includeLogs?: boolean; includeConfig?: boolean }) => Promise<{
      success: boolean
      path?: string
      sizeBytes?: number
      error?: string
    }>
    listLogs: () => Promise<{ files: Array<{ name: string; bytes: number; mtime: number }> }>
    readLog: (payload: { name: string; tailLines?: number }) => Promise<{ content: string }>
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
        /** 本轮判定出来的对方语言：回复应当跟着它走 */
        replyLanguage?: 'zh' | 'en' | 'mixed'
        /** 本轮检索到的本人原话条数（语气样本） */
        voiceSamples?: number
        /** 本轮生效的拒答行为 —— 让"它怎么什么都答"能被解释 */
        refusal?: WeCloneRefusalMode
      }
    }>
    /** 导出（生成）时的脱敏开关，持久化在配置里 */
    getRedact: () => Promise<{ success: boolean; redact: boolean }>
    setRedact: (enabled: boolean) => Promise<{ success: boolean; redact: boolean }>
    /** 单个克隆自己的设置（拒答行为等） */
    getSettings: (cloneId: string) => Promise<{ success: boolean; settings?: WeCloneSettings; error?: string }>
    setSettings: (cloneId: string, patch: { refusal?: WeCloneRefusalMode }) => Promise<{ success: boolean; settings?: WeCloneSettings; error?: string }>
    generate: (opts?: { redact?: boolean }) => Promise<{
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
      /**
       * 五份模型产物，外加两份**算出来的**材料（v1.0.1）：
       * `fingerprint` 是本地统计的说话习惯，`corpus` 是语料处理摘要。
       */
      mds?: Partial<
        Record<'profile' | 'relationships' | 'knowledge' | 'timeline' | 'language' | 'fingerprint' | 'corpus', string>
      >
      error?: string
    }>
    delete: (id: string) => Promise<{ success: boolean; error?: string }>
    cancel: () => Promise<{ success: boolean }>
    onProgress: (callback: (payload: { stage: 'scan' | 'generate' | 'filter' | 'done'; progress: number; message: string; detail?: any }) => void) => () => void
    /**
     * 对话历史（v1.0.1，本机文件 `{userData}/weclone-chats/<cloneId>.json`）。
     * 有了它才谈得上回看、改标题、删除 —— 以前关掉抽屉就什么都不剩。
     */
    listChats: (cloneId: string) => Promise<{ success: boolean; chats: WeCloneChatSummary[] }>
    getChat: (cloneId: string, chatId: string) => Promise<{ success: boolean; chat?: WeCloneChat; error?: string }>
    saveChat: (payload: {
      cloneId: string
      chatId?: string
      turns: Array<{ role: 'user' | 'assistant'; content: string; at?: number }>
      title?: string
    }) => Promise<{ success: boolean; chatId?: string; title?: string; error?: string }>
    renameChat: (cloneId: string, chatId: string, title: string) => Promise<{ success: boolean; title?: string; error?: string }>
    deleteChat: (cloneId: string, chatId: string) => Promise<{ success: boolean; error?: string }>
  }
  /**
   * 长任务状态快照（v1.0.1）。
   *
   * 渲染进程可能被整个销毁重建（托盘隐藏销毁窗口 / 最小化 unload），而克隆
   * 生成、导出、连接都跑在主进程里。新文档启动时调一次 `status()` 就能把进度、
   * 日志、开始时间原样拿回来 —— 否则重建后的界面看起来像什么都没发生过。
   */
  task: {
    status: () => Promise<Record<string, LiveTaskSnapshot>>
    onStatusChanged: (callback: (snapshots: Record<string, LiveTaskSnapshot>) => void) => () => void
  }
  process: {
    platform: string
    arch: string
  }
  /**
   * 密钥健康面板（v1.2 §10.4）。
   *
   * 只出指纹（首 4…末 4）—— 完整密钥永不回到渲染层。写入是合并语义：
   * 某个库保存失败不会覆盖其它库已验证通过的好密钥。
   */
  keyHealth: {
    get: () => Promise<KeyHealthReport>
    rescan: (payload?: { kinds?: string[] }) => Promise<KeyHealthReport>
    paste: (payload: { kind: string; text: string }) => Promise<{ success: boolean; fingerprint?: string; error?: string }>
    clear: (payload: { kind: string }) => Promise<{ success: boolean; error?: string }>
  }
  /** 写操作前的自动快照（v1.2 §10.3）：装触发器 / 删朋友圈之前先备份，可一键回滚 */
  snapshot: {
    list: () => Promise<{ snapshots: Array<{ id: string; reason: string; createdAt: number; files: number; bytes: number }> }>
    restore: (payload: { id: string; verifyOnly?: boolean; confirm?: boolean }) => Promise<{ success: boolean; restored?: string[]; error?: string }>
  }
  /**
   * 跨页搜索（v1.2 §6）。
   *
   * 通道名与载荷与引擎侧一一对应，渲染层只做形状搬运：
   *   search:indexStatus  查看索引是否需要建/重建
   *   search:buildIndex   后台建索引，返回 taskId；**进度不走这里**，
   *                       它由长任务通道（`task:status` 快照 + 进度推送）喂进
   *                       `LIVE_TASK.searchIndex`，页面只订阅 store —— AGENTS.md 铁律 3。
   *   search:query        查询（分页用 cursor）
   *   search:suggest      前缀联想
   *
   * 引擎尚未接线时这几个字段可能不存在，页面必须显示诚实的"通道缺失"而非假结果。
   */
  search: {
    indexStatus: () => Promise<SearchIndexStatus>
    buildIndex: (payload?: { force?: boolean; wxid?: string }) => Promise<{ taskId: string }>
    query: (payload: SearchQueryRequest) => Promise<SearchResultPage>
    suggest: (payload: { prefix: string; limit?: number }) => Promise<{ suggestions: string[] }>
  }
  /**
   * 标签 / 收藏 / 标记 / 保存搜索（v1.2 §6，本机配置，per-wxid）。
   *
   * `mutate` 的返回值**就是更新后的整个 store**：界面不自己推演新状态，
   * 拿主进程回的这份渲染 —— 否则主进程校验（重名、越界、并发）会和界面分歧。
   */
  annotations: {
    list: (options?: { accountId: string }) => Promise<AnnotationsStore & { error?: string }>
    mutate: (payload: AnnotationsMutation, options?: { accountId: string }) => Promise<AnnotationsStore & { error?: string }>
    export: (payload: { format: AnnotationsExportFormat; path: string }) => Promise<{ success: boolean; path?: string; error?: string }>
  }
}

/** 搜索范围。字段都按"缺省 = 不限"处理，全部可选。 */
interface SearchScope {
  sessionIds?: string[]
  senders?: string[]
  /** 毫秒时间戳 */
  from?: number
  /** 毫秒时间戳 */
  to?: number
  /** 消息类型（text/image/voice/video/file/link/emoji/system…，引擎侧是唯一真源） */
  kinds?: string[]
}

/** 一个账号的索引状态。 */
interface SearchIndexAccountStatus {
  wxid: string
  docs: number
  lastBuiltAt: number
  stale: boolean
}

interface SearchIndexStatus {
  ready: boolean
  building: boolean
  /** 0..1 */
  progress: number
  stage: string
  docs: number
  lastBuiltAt: number
  accounts: SearchIndexAccountStatus[]
  error?: string
}

interface SearchQueryRequest {
  text: string
  scope?: SearchScope
  limit?: number
  /**
   * 翻页游标：**不透明值，原样回传**。
   *
   * 放宽到 `string | number` 是因为 preload 那边声明的是 `number`：界面不解析、
   * 不加减、不比较大小，只负责把上一页拿到的值原样发回来。
   */
  cursor?: string | number
}

interface SearchHit {
  sessionId: string
  sessionName: string
  /** 精确消息 id（按 idKind 表示 local_id 或 server_id）；标注与阅读器都用此字符串定位。 */
  localId: string
  /** 安全整数兼容字段；精确 id 超出安全整数范围时为 0。 */
  localIdNumber?: number
  /** localId 装的是哪一个：local_id 为 0 的少数消息才回落 server_id（界面自己拼的对象可以不给） */
  idKind?: 'local' | 'server'
  /** 毫秒时间戳 */
  ts: number
  senderUsername: string
  senderName: string
  kind: string
  snippet: string
  /** 命中区间，**相对 snippet 的字符下标**（左闭右开，已按起点排序） */
  highlights: Array<[number, number]>
  score: number
  /** 扩展字段：消息所在库 / 表（会话名缺失时的定位线索，排查也用） */
  db?: string
  table?: string
}

interface SearchResultPage {
  hits: SearchHit[]
  total: number
  /** 还有下一页时非空。不透明值，界面原样回传（见 SearchQueryRequest.cursor） */
  cursor: string | number | null
  elapsedMs: number
  truncated: boolean
  /**
   * 引擎侧这一页的错误（`索引不可用：…`、游标对不上…）。
   * **不接住它的后果不是报错，而是"0 条结果"** —— 用户会以为是自己关键词打错了。
   */
  error?: string
}

/** 收藏 / 标记一条：sessionId + localId（localId 为空的叫"会话收藏"）。 */
interface AnnotationEntry {
  sessionId: string
  /** Number for a safe local_id, empty for session favorites and server-id messages. */
  localId: string | number
  /** Exact ID stored as text so 64-bit server IDs are never rounded. */
  messageId?: string
  idKind?: 'local' | 'server'
  db?: string
  table?: string
  /** Message timestamp (milliseconds on renderer input; service stores seconds). */
  ts: number
  note?: string
  /** 写入时间（引擎侧口径），界面只展示不解释 */
  at?: number
}

interface SavedSearch {
  id: string
  name: string
  /** 原样保存的查询串（含 `会话:` 之类的前缀操作符） */
  query: string
  scope?: SearchScope
  createdAt: number
  lastRunAt?: number
  lastCount?: number
}

interface AnnotationsStore {
  /** sessionId → 标签名（去重、排序）。引擎按会话存（重命名要全量生效）。 */
  tags: Record<string, string[]>
  /** 派生视图：tag → sessionId[]（"虚拟文件夹"直接读这一份）。引擎总会给，旧数据/桩里可以没有。 */
  tagIndex?: Record<string, string[]>
  favorites: AnnotationEntry[]
  marks: AnnotationEntry[]
  savedSearches: SavedSearch[]
}

type AnnotationsExportFormat = 'json' | 'csv' | 'md'

/** `annotations:mutate` 的操作。payload 随 op 变化，与引擎契约一致。 */
type AnnotationsMutation =
  | { op: 'tag.add'; payload: { tag: string; sessionIds?: string[]; from?: string } }
  | { op: 'tag.remove'; payload: { tag: string; sessionIds?: string[] } }
  | { op: 'fav.add'; payload: AnnotationEntry }
  | { op: 'fav.remove'; payload: Pick<AnnotationEntry, 'sessionId' | 'localId'> & Partial<Pick<AnnotationEntry, 'messageId' | 'idKind' | 'db' | 'table' | 'ts'>> }
  | { op: 'mark.add'; payload: AnnotationEntry }
  | { op: 'mark.remove'; payload: Pick<AnnotationEntry, 'sessionId' | 'localId'> & Partial<Pick<AnnotationEntry, 'messageId' | 'idKind' | 'db' | 'table' | 'ts'>> }
  | { op: 'search.save'; payload: { name: string; query: string; scope?: SearchScope } }
  | { op: 'search.remove'; payload: { id: string } }
  | { op: 'search.rename'; payload: { id: string; name: string } }

/** 一条诊断检查记录（v1.2 §5，沿用 macOS 能力诊断的词汇：id/label/state/detail/raw）。 */
interface DiagnosticsCheck {
  id: string
  label: string
  state: 'ok' | 'warn' | 'fail' | 'unknown'
  detail: string
  raw?: string
}

interface DiagnosticsReport {
  supported: boolean
  collectedAt: number
  platform: string
  appVersion: string
  arch: string
  checks: DiagnosticsCheck[]
  summary: string
}

/** 密钥健康面板的一份数据库记录（v1.2 §10.4）。`fingerprint` = 首 4…末 4，绝不含完整密钥。 */
interface KeyHealthEntry {
  kind: string
  path: string
  status: 'ok' | 'stale' | 'invalid' | 'missing' | 'unknown'
  source: 'scan' | 'hook' | 'manual' | 'config'
  verifiedAt?: number
  fingerprint?: string
  error?: string
}

interface KeyHealthReport {
  success: boolean
  /** 上一次取到密钥用的模式：scan（内存扫描）/ hook（注入回调）/ manual（手工粘贴） */
  mode?: 'scan' | 'hook' | 'manual' | 'none'
  /** Read-only readiness for complete text-history access from stored per-database keys. */
  connectionReady?: boolean
  connectionCoverage?: {
    required: number
    ready: number
    missing: string[]
    invalid: string[]
    mediaRequired: number
    mediaReady: number
  }
  /** 未满足的前置条件（v1.2 §1 的前置矩阵），空数组表示没有阻塞 */
  blockers?: Array<{ id: string; message: string; actionable: string }>
  databases: KeyHealthEntry[]
  error?: string
}

interface Window {
  electronAPI: ElectronApi
}

/**
 * 分享海报工作室（v1.2 §4）的落盘通道。
 *
 * 单独合并进 `ElectronApi`（接口声明合并），不动上面那段既有实现 —— 这里只有
 * 一条通道，而且**必须标成可选**：引擎侧还没接线时 `window.electronAPI.poster`
 * 是 undefined，海报页据此走 `<a download>` 回退并在界面上说明（绝不能报一次
 * 没发生的保存）。
 *
 * 契约：payload 是 1080×N 的 PNG data URL；`directory` 省略时由主进程决定
 * （默认下载目录 / 上次导出目录）。`path` 是**真实写下的绝对路径**；回退路径拿不到
 * 它，所以界面只在有 path 时才显示路径。
 *
 * 渲染层不依赖这条声明才能编译：`posterCapture.ts` 自带一个窄接口 + 运行时
 * `typeof` 判断（这个文件被多个 agent 同时追加过，声明丢过一次）。
 */
interface ElectronApi {
  poster?: {
    saveImage: (payload: { dataUrl: string; fileName: string; directory?: string }) => Promise<{
      success: boolean
      path?: string
      error?: string
    }>
  }
}

interface BugReportImage {
  id: string
  name: string
  sizeBytes: number
  previewDataUrl: string
}

interface BugReportChooseImagesResult {
  canceled: boolean
  images: BugReportImage[]
  errors?: string[]
  error?: string
}

interface ElectronApi {
  bugReport: {
    chooseImages: () => Promise<BugReportChooseImagesResult>
    removeImage: (imageId: string) => Promise<{ success: boolean }>
    clearImages: () => Promise<{ success: boolean }>
    copyImage: (imageId: string) => Promise<{ success: boolean; error?: string }>
    copyDraftText: (payload: { body: string; includeEnvironment: boolean }) => Promise<{ success: boolean; error?: string }>
    openIssue: (payload: { title: string; body: string; includeEnvironment: boolean }) => Promise<{
      success: boolean
      bodyNeedsPaste?: boolean
      error?: string
    }>
  }
}
