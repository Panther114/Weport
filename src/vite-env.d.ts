/// <reference types="vite/client" />

interface ElectronApi {
  config: {
    get: (key: string) => Promise<any>
    set: (key: string, value: any) => Promise<{ success: boolean }>
    clear: () => Promise<{ success: boolean }>
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
    onLuma: (callback: (bands: any) => void) => () => void
    onShow: (callback: (event: any, data: any) => void) => () => void
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
    downloadAndInstall: () => Promise<{ success: boolean; error?: string }>
    ignoreUpdate: (version: string) => Promise<{ success: boolean }>
    onDownloadProgress: (callback: (progress: any) => void) => () => void
    onUpdateAvailable: (callback: (info: { version: string; releaseNotes: string }) => void) => () => void
  }
  dbPath: {
    autoDetect: () => Promise<{ success: boolean; path?: string; error?: string }>
    scanWxids: (rootPath: string) => Promise<Array<{ wxid: string; modifiedTime: number; nickname?: string; avatarUrl?: string }>>
    getDefault: () => Promise<string>
  }
  key: {
    autoGetDbKey: () => Promise<{ success: boolean; key?: string; error?: string; logs?: string[] }>
    onDbKeyStatus: (callback: (payload: { message: string; level: number }) => void) => () => void
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
    exportSessions: (outputRoot: string, options?: any) => Promise<any>
    cancelTask: (taskId: string) => Promise<{ success: boolean }>
    getExportLog: (outputRoot: string) => Promise<{ path: string; txt: string | null; json: string | null; exists: boolean }>
    clearLibrary: (outputRoot: string) => Promise<{ success: boolean; removed: string[]; error?: string }>
    onProgress: (callback: (payload: any) => void) => () => void
  }
  ai: {
    getSetup: () => Promise<{
      hasApiKey: boolean
      baseUrl: string
      model: string
      maxTokens: number
      reasoningEffort: string
      maxSteps: number
      customPrompt: string
      workspaceRoot: string
      exportPath: string
      dbReady: boolean
      disabledTools: string[]
      maxToolChars: number
      conversationLimit: number
    }>
    setSetup: (patch: any) => Promise<{ success: boolean }>
    listChats: () => Promise<{ chats: Array<{ id: string; title: string; createdAt: number; updatedAt: number }> }>
    createChat: (title?: string) => Promise<{ chat: { id: string; title: string; createdAt: number; updatedAt: number } }>
    renameChat: (chatId: string, title: string) => Promise<{ success: boolean }>
    reorderChats: (orderedIds: string[]) => Promise<{ success: boolean }>
    deleteChat: (chatId: string) => Promise<{ success: boolean }>
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
  process: {
    platform: string
    arch: string
  }
}

interface Window {
  electronAPI: ElectronApi
}
