/**
 * WeClone 人格克隆 — 渲染进程侧类型（与 src/vite-env.d.ts 的 ElectronApi.weclone
 * 及 electron/services/weCloneService.ts 保持一致）。
 */

export type WeCloneVisibility = 'private' | 'public' | 'link'

export type WeCloneStage = 'scan' | 'generate' | 'filter' | 'upload' | 'done'

export interface WeCloneProgressInfo {
  stage: WeCloneStage
  /** 总进度 0-100 */
  progress: number
  message: string
}

/** WeCloneMetaInfo 来自 vite-env.d.ts（全局接口） */
export interface WeCloneListItem extends WeCloneMetaInfo {
  source: 'local' | 'remote' | 'both'
  shareUrl?: string
}

export type WeCloneMdsPreview = Partial<
  Record<'profile' | 'relationships' | 'knowledge' | 'timeline' | 'language', string>
>

export interface WeCloneServerStatusInfo {
  configured: boolean
  enabled: boolean
  baseUrl: string
  hasToken: boolean
  online?: boolean
  version?: string
  error?: string
}
