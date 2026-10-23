export type ArchiveMediaPolicy = 'best-available' | 'original-only'
export type ArchiveMediaStatus = 'original' | 'display' | 'thumbnail' | 'available' | 'missing-locally' | 'decryption-failed' | 'unsupported' | 'original-unavailable' | 'not-requested'
export interface ArchiveMediaOutcome { status: ArchiveMediaStatus; kind: string; relativePath?: string }
export interface ArchiveFile { path: string; bytes: number; sha256: string }
export interface ArchiveSession extends ArchiveFile { id: string; name: string; count: number; firstAt: number; lastAt: number }
export interface ArchiveManifest {
  schema: 'weport-archive'; version: 1; archiveId: string; accountHash: string; createdAt: number
  sourceFingerprint: string; dateRange?: { start: number; end: number }; mediaPolicy: ArchiveMediaPolicy; includesMedia: boolean
  sessions: ArchiveSession[]; media: ArchiveFile[]; mediaOutcomes: Record<string, number>
  annotations: 'bookmarks.json'; scheduleId?: string
}
export interface ArchiveBookmark { sessionId: string; sourceIdentityHash?: string; kind: 'favorite' | 'mark'; note?: string; at: number; resolved: boolean; original?: Record<string, unknown> }
export interface ArchiveAnnotations { version: 1; archiveId: string; accountHash: string; bookmarks: ArchiveBookmark[]; tags: Record<string, string[]> }
export interface ArchiveInventory { files: ArchiveFile[]; directories: string[] }
export interface ArchiveCleanupJournal { archiveId: string; survivorId: string; destination: string; inventory: ArchiveInventory; survivorInventory: ArchiveInventory; proofFiles: Record<string, string[]> }
export interface ArchiveEntry { archiveId: string; accountHash: string; path: string; createdAt: number; sessions: number; messages: number; scheduleId?: string; managed: boolean; inventory?: ArchiveInventory; retentionState?: 'protected' | 'cleaning'; retentionReason?: string }
export interface ArchiveRequest { destination: string; sessionIds: string[]; includeMedia: boolean; mediaPolicy: ArchiveMediaPolicy; accountId: string; dateRange?: { start: number; end: number } }
export interface ArchiveJob { id: string; request: ArchiveRequest; accountHash: string; sourceFingerprint: string; staging: string; finalPath: string; state: 'running' | 'waiting' | 'done' | 'failed' | 'aborted' | 'interrupted'; stage: string; lastProgressAt: number; cursor?: string; error?: string; scheduleId?: string }
export interface ArchiveSchedule { id: string; accountHash: string; request: ArchiveRequest; enabled: boolean; everyMinutes: number; keep: number; nextRunAt: number; lastRunAt?: number; lastError?: string }
export interface ArchivePreflight { ok: boolean; errors: string[]; warnings: string[]; freeBytes?: number; estimatedBytes?: number; sourceFingerprint?: string; sourceCapability: 'live' | 'history-snapshot' | 'unavailable' }
export interface ArchiveMessage { sourceIdentityHash: string; localType: number; createTime: number; content: string; senderDisplayName?: string; senderUsername?: string; rawContent?: string; sourceIdentity?: { db: string; table: string; localId: string }; mediaOutcome?: ArchiveMediaOutcome; [key: string]: unknown }
