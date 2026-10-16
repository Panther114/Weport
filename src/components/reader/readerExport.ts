/**
 * 阅读器的"导出本会话"。
 *
 * **不另起一套导出**：参数从 `config` 里读导出页保存过的那份（`exportPath` /
 * `exportFormat` / `exportMedia` / … 见 `src/App.tsx:599-627` 的写入侧），然后调用
 * 同一个 `export:exportSessions`（`src/App.tsx:1299` 是导出页的调用点）。
 *
 * 进度**不走阅读器**：主进程会把进度推到 `export:progress` / 任务快照，
 * `ExportProgressBar` 与 `BackgroundTasks` 会显示它（AGENTS.md 铁律 3：长任务进度
 * 不许存在页面 state 里 —— 切页就丢）。这里只回"已开始 / 失败原因"，让按钮附近
 * 有一句真话。
 */
import type { ReaderSession } from './readerTypes'

interface ExportMediaConfig {
  images?: boolean
  videos?: boolean
  voices?: boolean
  emojis?: boolean
  files?: boolean
  maxFileSizeMb?: number
}

export interface SessionExportResult {
  ok: boolean
  /** 成功时的落点（导出目录）。 */
  outputRoot?: string
  message?: string
  error?: string
}

export async function exportReaderSession(session: ReaderSession): Promise<SessionExportResult> {
  const api = typeof window !== 'undefined' ? window.electronAPI : undefined
  if (!api?.export?.exportSessions) {
    return { ok: false, error: '导出通道不可用（export:exportSessions）' }
  }

  const read = async <T,>(key: string): Promise<T | undefined> => {
    try {
      return (await api.config.get(key)) as T
    } catch {
      return undefined
    }
  }

  let outputRoot = String((await read<string>('exportPath')) || '').trim()
  if (!outputRoot) {
    const picked = await api.dialog?.openDirectory?.({ title: '选择导出目录' })
    outputRoot = String(picked || '').trim()
  }
  if (!outputRoot) return { ok: false, error: '没有选择导出目录（导出页也没有设置默认目录）' }

  const media = (await read<ExportMediaConfig>('exportMedia')) || {}
  const format = String((await read<string>('exportFormat')) || 'txt')
  const avatars = (await read<boolean>('exportAvatars')) === true
  const voiceAsText = (await read<boolean>('exportVoiceAsText')) === true
  const pathStyle = (await read<string>('exportDefaultPathStyle')) || 'auto'
  const conflict = (await read<string>('exportConflictStrategy')) || 'incremental'
  const namePref = (await read<string>('exportDefaultDisplayNamePreference')) || 'remark'
  const concurrency = Number(await read<number>('exportConcurrency')) || undefined
  const layout = (await read<string>('exportWriteLayout')) || 'A'

  const mediaEnabled = Boolean(media.images || media.videos || media.voices || media.emojis || media.files)

  try {
    const result = await api.export.exportSessions(outputRoot, {
      // 只导出这一个会话：引擎侧会拿 `sessionIds` 与会话列表求交，失效会明确报错。
      sessionIds: [session.id],
      format: format as ExportRequest['format'],
      exportImages: media.images === true,
      exportVideos: media.videos === true,
      exportVoices: media.voices === true,
      exportEmojis: media.emojis === true,
      exportFiles: media.files === true,
      exportMedia: mediaEnabled,
      maxFileSizeMb: Number(media.maxFileSizeMb) || 200,
      exportAvatars: avatars,
      exportVoiceAsText: voiceAsText,
      exportPathStyle: pathStyle as ExportRequest['exportPathStyle'],
      exportConflictStrategy: conflict as ExportRequest['exportConflictStrategy'],
      displayNamePreference: namePref as ExportRequest['displayNamePreference'],
      exportConcurrency: concurrency,
      exportWriteLayout: layout as ExportRequest['exportWriteLayout'],
      sessionLayout: layout === 'C' ? 'per-session' : 'shared',
      sessionNameWithTypePrefix: true,
    })
    if (result?.success === false) {
      return { ok: false, error: String(result.error || '导出失败') }
    }
    const skipped = Number(result?.skipped)
    if (skipped > 0 || Number(result?.successCount) === 0) {
      return { ok: false, error: '这个会话没有可导出的消息' }
    }
    return { ok: true, outputRoot, message: `已开始导出到 ${outputRoot}（进度看全局进度条）` }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}
