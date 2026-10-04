/**
 * 标签 / 收藏 / 标记 / 保存搜索的本机注解（v1.2 §6）。
 *
 * 两条纪律：
 *
 * 1. **界面不自己推演新状态**。所有写操作都发给主进程（校验、重名、落盘都在那边），
 *    拿回来的整份 store 就是新的真相。乐观更新在这里是负收益：注解是"用户相信它
 *    已经记住了"的东西，猜错一次（比如重名被拒但界面显示成功）比慢 100ms 糟得多。
 *
 * 2. **写操作串行**。用户快速点五次标签就是五个 IPC；并发发出时主进程回的顺序不
 *    保证，界面就会停在中间某一版。这里用一条 promise 链把它们排成一队。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ScopeParams } from '../components/search/searchQuery'
import { dateToEpoch, queryFromParams } from '../components/search/searchQuery'

export interface AnnotationsApiState {
  data: AnnotationsStore | null
  loading: boolean
  /** 通道缺失或读取失败的原因（界面显示"注解不可用"，其余功能不受影响） */
  error: string | null
  saving: boolean
}

type AnnotationReference = Pick<AnnotationEntry, 'sessionId' | 'localId'> &
  Partial<Pick<AnnotationEntry, 'messageId' | 'idKind' | 'db' | 'table' | 'ts'>>

export interface AnnotationsActions {
  addTag: (tag: string, sessionIds: string[]) => void
  removeTag: (tag: string, sessionIds?: string[]) => void
  addFavorite: (entry: AnnotationEntry) => void
  removeFavorite: (ref: AnnotationReference) => void
  addMark: (entry: AnnotationEntry) => void
  removeMark: (ref: AnnotationReference) => void
  saveSearch: (input: { name: string; text: string; scope: ScopeParams }) => void
  removeSearch: (id: string) => void
  renameSearch: (id: string, name: string) => void
  /** 手动重读（引擎侧改了东西，或第一次读失败后重试） */
  reload: () => void
}

export interface UseAnnotationsResult extends AnnotationsApiState, AnnotationsActions {}

const EMPTY_STORE: AnnotationsStore = { tags: {}, favorites: [], marks: [], savedSearches: [] }

/** 缺字段的 store 补成完整形状：引擎刚接线时只回 `{ tags }` 也不该让界面炸。 */
function normalizeStore(raw: unknown): AnnotationsStore {
  const value = (raw || {}) as Partial<AnnotationsStore>
  return {
    tags: value.tags && typeof value.tags === 'object' ? value.tags : {},
    tagIndex: value.tagIndex && typeof value.tagIndex === 'object' ? value.tagIndex : undefined,
    favorites: Array.isArray(value.favorites) ? value.favorites.filter(Boolean) : [],
    marks: Array.isArray(value.marks) ? value.marks.filter(Boolean) : [],
    savedSearches: Array.isArray(value.savedSearches) ? value.savedSearches.filter(Boolean) : [],
  }
}

export function useAnnotations(): UseAnnotationsResult {
  const [state, setState] = useState<AnnotationsApiState>({ data: null, loading: true, error: null, saving: false })
  const [reloadToken, setReloadToken] = useState(0)
  const queue = useRef<Promise<unknown>>(Promise.resolve())

  useEffect(() => {
    let alive = true
    const api = typeof window !== 'undefined' ? window.electronAPI : undefined
    const annotations = api?.annotations
    if (!annotations?.list) {
      setState({ data: null, loading: false, error: '注解通道不可用', saving: false })
      return
    }
    setState((prev) => ({ ...prev, loading: true, error: null }))
    annotations
      .list()
      .then((raw: unknown) => {
        if (!alive) return
        const payload = raw as { error?: unknown } | null
        const problem = typeof payload?.error === 'string' && payload.error.trim() ? payload.error : null
        setState({ data: problem ? null : normalizeStore(raw), loading: false, error: problem, saving: false })
      })
      .catch((error: unknown) => {
        if (!alive) return
        setState({ data: null, loading: false, error: error instanceof Error ? error.message : String(error), saving: false })
      })
    return () => {
      alive = false
    }
  }, [reloadToken])

  const mutate = useCallback((mutation: AnnotationsMutation) => {
    const api = typeof window !== 'undefined' ? window.electronAPI : undefined
    const annotations = api?.annotations
    if (!annotations?.mutate) {
      setState((prev) => ({ ...prev, error: '注解通道不可用' }))
      return
    }
    setState((prev) => (prev.saving ? prev : { ...prev, saving: true }))
    queue.current = queue.current
      .then(() => annotations.mutate(mutation))
      .then((raw: unknown) => {
        // 引擎侧把"写盘失败"也放在这个对象里（success:false + error），不是 reject。
        // 以前这里一律当成功：内存里的改动进了 state，界面显示"已收藏"，
        // 重启后收藏消失，**全程没有任何提示**。现在把它的 error 端出来。
        const payload = raw as { error?: string } | null
        const problem = payload && typeof payload.error === 'string' && payload.error.trim() ? payload.error : null
        setState({ data: normalizeStore(raw), loading: false, error: problem, saving: false })
      })
      .catch((error: unknown) => {
        setState((prev) => ({ ...prev, saving: false, error: error instanceof Error ? error.message : String(error) }))
      })
  }, [])

  const actions = useMemo<AnnotationsActions>(
    () => ({
      addTag: (tag, sessionIds) => {
        const name = tag.trim()
        if (!name || sessionIds.length === 0) return
        mutate({ op: 'tag.add', payload: { tag: name, sessionIds } })
      },
      removeTag: (tag, sessionIds) => mutate({ op: 'tag.remove', payload: sessionIds && sessionIds.length ? { tag, sessionIds } : { tag } }),
      addFavorite: (entry) => mutate({ op: 'fav.add', payload: entry }),
      removeFavorite: (ref) => mutate({ op: 'fav.remove', payload: ref }),
      addMark: (entry) => mutate({ op: 'mark.add', payload: entry }),
      removeMark: (ref) => mutate({ op: 'mark.remove', payload: ref }),
      saveSearch: ({ name, text, scope }) => {
        const label = name.trim() || queryFromParams({ text, scope }) || '未命名搜索'
        mutate({
          op: 'search.save',
          payload: {
            name: label,
            query: queryFromParams({ text, scope }),
            scope: {
              sessionIds: scope.sessionIds,
              senders: scope.senders,
              from: scope.from ? dateToEpoch(scope.from, 'start') : undefined,
              to: scope.to ? dateToEpoch(scope.to, 'end') : undefined,
              kinds: scope.kinds,
            },
          },
        })
      },
      removeSearch: (id) => mutate({ op: 'search.remove', payload: { id } }),
      renameSearch: (id, name) => {
        const label = name.trim()
        if (!label) return
        mutate({ op: 'search.rename', payload: { id, name: label } })
      },
      reload: () => setReloadToken((token) => token + 1),
    }),
    [mutate],
  )

  const data = state.data ?? (state.error ? null : EMPTY_STORE)
  return { ...state, data, ...actions }
}

// ---------------------------------------------------------------------------
// 导出
// ---------------------------------------------------------------------------

export const EXPORT_FORMATS: Array<{ value: AnnotationsExportFormat; label: string; ext: string; hint: string }> = [
  { value: 'json', label: 'JSON', ext: 'json', hint: '完整结构，可再次导入' },
  { value: 'md', label: 'Markdown', ext: 'md', hint: '给人读的清单' },
  { value: 'csv', label: 'CSV', ext: 'csv', hint: '表格工具打开' },
]

export interface UseAnnotationsExportResult {
  busy: boolean
  /** 最近一次成功导出的完整路径（界面上显示它，而不是只弹个"成功"） */
  lastPath: string | null
  error: string | null
  exportAs: (format: AnnotationsExportFormat) => void
  dismiss: () => void
}

/**
 * 导出注解。
 *
 * 契约里 `annotations:export` 要一个 `path`。宿主没有"保存文件"对话框（只有
 * `dialog:openDirectory` / `openFile`），所以流程是：选目录 -> 拼一个带扩展名的
 * 文件名 -> 交给引擎写。名字带日期，重复导出不会互相覆盖。
 */
export function useAnnotationsExport(): UseAnnotationsExportResult {
  const [busy, setBusy] = useState(false)
  const [lastPath, setLastPath] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const exportAs = useCallback((format: AnnotationsExportFormat) => {
    const api: ElectronApi | undefined = typeof window !== 'undefined' ? window.electronAPI : undefined
    const annotations = api?.annotations
    if (!annotations?.export) {
      setError('导出通道不可用')
      return
    }
    const meta = EXPORT_FORMATS.find((item) => item.value === format)
    if (!meta) return
    setBusy(true)
    setError(null)
    void (async () => {
      try {
        const dir = await api?.dialog?.openDirectory?.({ title: '选择注解导出目录' })
        if (!dir) {
          setBusy(false)
          return
        }
        const stamp = new Date().toISOString().slice(0, 10)
        const sep = dir.includes('\\') && !dir.includes('/') ? '\\' : '/'
        const base = dir.endsWith(sep) ? dir.slice(0, -1) : dir
        const target = `${base}${sep}weport-annotations-${stamp}.${meta.ext}`
        const res = await annotations.export({ format, path: target })
        if (res?.success) setLastPath(res.path || target)
        else setError(res?.error || '导出失败')
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      } finally {
        setBusy(false)
      }
    })()
  }, [])

  return { busy, lastPath, error, exportAs, dismiss: () => { setError(null); setLastPath(null) } }
}
