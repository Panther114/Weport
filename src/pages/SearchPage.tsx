import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, FolderPlus, Save } from 'lucide-react'
import SearchBar from '../components/search/SearchBar'
import FilterChips from '../components/search/FilterChips'
import ScopePanel from '../components/search/ScopePanel'
import SearchResults from '../components/search/SearchResults'
import SearchRail from '../components/search/SearchRail'
import { sessionsForSearchScope, sessionsForTags, tagsBySession as buildTagsBySession } from '../components/search/searchAnnotations'
import { EmptyIndexState, IndexStatusBar } from '../components/search/IndexState'
import {
  EMPTY_SCOPE,
  hasAnyCondition,
  entryKey,
  paramsFromQuery,
  paramsFromSavedSearch,
  queryFromParams,
  type QueryParams,
  type ScopeParams,
} from '../components/search/searchQuery'
import { loadRecentSessions, loadSessionCandidates, rememberRecentSession, type SessionCandidate } from '../components/search/searchData'
import { useAnnotations, useAnnotationsExport } from '../hooks/useAnnotations'
import { useDebouncedValue, useHitsStore, useSearchQuery, type HitsStore } from '../hooks/useSearchQuery'
import { loadMessageByIdentity } from '../components/reader/readerSource'
import type { ReaderPosterRequest } from './ReaderPage'
import { annotationIdentityFields } from '../utils/annotationIdentity'
import '../styles/search.scss'

/**
 * 全局搜索页（v1.2 §6）。
 *
 * ## 这一页的三条主线
 *
 * 1. **输入即搜**：输入框 -> 120ms 防抖 -> 稳定查询 -> 引擎。索引没建好时不发请求。
 * 2. **条件可分享**：所有条件都能回到查询串（`标签:x 会话:y 类型:图片`），而查询串
 *    又能序列化进 `#/search?...` —— 刷新、复制给别人、加书签都能还原同一次搜索。
 * 3. **注解是外挂的**：标签 / 收藏 / 保存搜索存在主进程（`annotations:*`），
 *    这一页只负责让它们**看得见、点得动**，不自己推演状态。
 *
 * 命中项通过 onOpen 交给外壳切到阅读器；query 一并传出，阅读器可以高亮命中词。
 */
export interface SearchPageProps {
  /** 打开命中位置；查询词用于阅读器高亮。 */
  onOpen?: (hit: SearchHit, query?: string) => void
  /** 精确读取并把命中消息送入海报工作室。 */
  onCreatePoster?: (request: ReaderPosterRequest) => void
  /** 初始查询串（外壳从 `#/search?...` 之外的地方传进来时用） */
  initialQuery?: string
}

type SortOrder = 'relevance' | 'newest'
const SORT_KEY = 'weport.search.sort'
const EMPTY_HITS_STORE: HitsStore = {
  subscribe: () => () => undefined,
  get: () => undefined,
  size: 0,
}

function readStoredSort(): SortOrder {
  try {
    const raw = window.localStorage?.getItem(SORT_KEY)
    return raw === 'newest' ? 'newest' : 'relevance'
  } catch {
    return 'relevance'
  }
}

export default function SearchPage({ onOpen, onCreatePoster, initialQuery }: SearchPageProps) {
  // ---- 输入与条件 ----------------------------------------------------------
  /**
   * 初始查询串。
   *
   * 顺序是 **URL 片段 -> prop -> 空**：片段优先是因为"刷新页面 / 别人把链接发给你"
   * 必须还原同一次搜索，而 `initialQuery` 只是外壳的兜底入口。注意这里在
   * `useState` 的惰性初始化里读，不是在 effect 里补 —— 挂载后再补会先渲染一帧
   * 空结果，看上去像"链接点了没反应"。
   */
  const [input, setInput] = useState(() => readHashQuery() ?? initialQuery ?? '')
  const [params, setParams] = useState<QueryParams>(() => paramsFromQuery(readHashQuery() ?? initialQuery ?? ''))
  const debouncedInput = useDebouncedValue(input, 120)
  const inputRef = useRef<HTMLInputElement | null>(null)

  // 输入变化 -> 条件（防抖后再解析：解析本身很便宜，但状态更新会触发重渲染）
  useEffect(() => {
    const next = paramsFromQuery(debouncedInput)
    setParams((prev) =>
      prev.text === next.text && JSON.stringify(prev.scope) === JSON.stringify(next.scope) ? prev : next,
    )
  }, [debouncedInput])

  const query = useMemo(() => queryFromParams(params), [params])

  // ---- URL 片段（可分享 / 可还原） ---------------------------------------
  const [sort, setSort] = useState<SortOrder>(() => readHashSort() ?? readStoredSort())
  const lastWrittenHash = useRef('')
  useEffect(() => {
    const next = `#/search?${new URLSearchParams({ q: query, sort }).toString()}`
    if (window.location.hash === next || lastWrittenHash.current === next) return
    lastWrittenHash.current = next
    // replaceState：搜索是高频操作，不能把浏览历史塞满（Electron 下也没有"后退"可点）
    window.history.replaceState(null, '', next)
  }, [query, sort])

  useEffect(() => {
    const onHashChange = () => {
      if (window.location.hash === lastWrittenHash.current) return
      const fromUrl = readHashQuery()
      if (fromUrl === null) return
      setInput(fromUrl)
      setParams(paramsFromQuery(fromUrl))
    }
    window.addEventListener('hashchange', onHashChange)
    return () => window.removeEventListener('hashchange', onHashChange)
  }, [])

  useEffect(() => {
    try {
      window.localStorage?.setItem(SORT_KEY, sort)
    } catch {
      /* 偏好写不进去不影响搜索 */
    }
  }, [sort])

  // ---- 索引状态 -----------------------------------------------------------
  const [index, setIndex] = useState<SearchIndexStatus | null>(null)
  const [indexLoading, setIndexLoading] = useState(true)
  const [indexError, setIndexError] = useState<string | null>(null)
  const indexRequestId = useRef(0)

  const refreshIndex = useCallback(() => {
    const api = typeof window !== 'undefined' ? window.electronAPI : undefined
    if (!api?.search?.indexStatus) {
      setIndex(null)
      setIndexLoading(false)
      setIndexError('搜索通道不可用')
      return
    }
    const requestId = ++indexRequestId.current
    setIndexLoading(true)
    api.search
      .indexStatus()
      .then((status) => {
        if (indexRequestId.current !== requestId) return
        setIndex(status ?? null)
        setIndexError(null)
      })
      .catch((error: unknown) => {
        if (indexRequestId.current !== requestId) return
        setIndex(null)
        setIndexError(error instanceof Error ? error.message : String(error))
      })
      .finally(() => {
        if (indexRequestId.current === requestId) setIndexLoading(false)
      })
  }, [])

  useEffect(() => {
    refreshIndex()
  }, [refreshIndex])

  // ---- 注解（标签 / 收藏 / 保存搜索） ------------------------------------
  const annotations = useAnnotations()
  const annotationStore = annotations.data
  const exportState = useAnnotationsExport()

  // ---- 会话候选（筛选面板用） --------------------------------------------
  const [candidates, setCandidates] = useState<SessionCandidate[]>([])
  const [candidatesError, setCandidatesError] = useState<string | undefined>(undefined)
  const [recentSessions, setRecentSessions] = useState<string[]>(() => loadRecentSessions())
  useEffect(() => {
    let alive = true
    void loadSessionCandidates().then((result) => {
      if (!alive) return
      setCandidates(result.list)
      setCandidatesError(result.error)
    })
    return () => {
      alive = false
    }
  }, [])
  const sessionNames = useMemo(() => new Map(candidates.map((item) => [item.username, item.displayName])), [candidates])

  /**
   * 标签 -> 会话 id。标签是本机注解，引擎的作用域只认会话 id，所以带标签条件时
   * 两边都要参与：**引擎按会话收窄**（快，且不把全库倒出来），界面再按标签过一遍
   * （精确）。标签对应不到任何会话时引擎侧条件为空，结果为空是诚实的。
   */
  const tagSessionIds = useMemo(
    () => sessionsForTags(annotationStore, params.scope.tags),
    [params.scope.tags, annotationStore],
  )
  const tagFiltersActive = params.scope.tags.length > 0
  const tagScopePending = tagFiltersActive && !annotationStore && annotations.loading
  const tagScopeUnavailable = tagFiltersActive && !annotationStore && !annotations.loading
  const tagScopeMatches = useMemo(
    () => sessionsForSearchScope(params.scope.sessionIds, tagSessionIds),
    [params.scope.sessionIds, tagSessionIds],
  )
  // An unresolved or empty tag scope must never be omitted from the engine request:
  // an omitted sessionIds filter would silently broaden the result to every session.
  const tagScopeEmpty = tagFiltersActive && (tagScopeUnavailable || (!tagScopePending && tagScopeMatches.length === 0))

  const engineParams = useMemo<QueryParams>(() => {
    if (!tagFiltersActive) return params
    return { text: params.text, scope: { ...params.scope, sessionIds: tagScopeMatches } }
  }, [params, tagFiltersActive, tagScopeMatches])

  const tagMap = useMemo(() => buildTagsBySession(annotationStore), [annotationStore])
  const taggedSessions = useMemo(() => new Set(tagMap.keys()), [tagMap])
  const tagsBySession = tagMap

  const indexReady = Boolean(index?.ready)

  // ---- 搜索结果 ----------------------------------------------------------
  const search = useSearchQuery(engineParams, { enabled: indexReady && !tagScopePending && !tagScopeEmpty })
  const searchState = tagScopePending
    ? { ...search, loadingFirst: true, searched: false }
    : tagScopeUnavailable
      ? { ...search, loadingFirst: false, searched: true, error: annotations.error || '标签数据暂不可用，已停止搜索以避免扩大结果范围。' }
      : tagScopeEmpty
        ? { ...search, loadingFirst: false, searched: true, error: null, total: 0 }
        : search

  const hits = search.store
  /**
   * 显示顺序（下标数组）。
   *
   * 排序是"同一个 store 的另一种读法"，不是另一份数据：换序只改这个数组，
   * 行组件与虚拟列表都不需要重新订阅（见 `useHitsStore`）。默认相关度 =
   * 引擎给的顺序，直接用 0..n-1。
   */
  const order = useMemo(() => {
    const count = hits.size
    const indices = Array.from({ length: count }, (_, index) => index)
    if (sort === 'newest') indices.sort((a, b) => Number(hits.get(b)?.ts || 0) - Number(hits.get(a)?.ts || 0))
    return indices
  }, [hits, sort, search.loadingFirst])

  const displayStore = useHitsStore(hits, order)
  const visibleStore = tagScopePending || tagScopeUnavailable || tagScopeEmpty ? EMPTY_HITS_STORE : displayStore

  useEffect(() => {
    setActiveIndex((prev) => (prev >= order.length ? order.length - 1 : prev))
  }, [order.length])

  const favoriteKeys = useMemo(() => {
    const set = new Set<string>()
    if (!annotationStore) return set
    for (const entry of annotationStore.favorites) {
      if (entry.messageId) set.add(entryKey(entry))
    }
    return set
  }, [annotationStore])

  // ---- 键盘：结果高亮 ----------------------------------------------------
  const [activeIndex, setActiveIndex] = useState(-1)
  const [posterError, setPosterError] = useState('')
  useEffect(() => {
    setActiveIndex(-1)
  }, [query, sort])

  const openHit = useCallback(
    (hit: SearchHit) => {
      if (onOpen) onOpen(hit, params.text)
      else window.dispatchEvent(new CustomEvent('weport:open-message', { detail: { hit, query: params.text } }))
      setRecentSessions(rememberRecentSession(hit.sessionId))
    },
    [onOpen, params.text],
  )

  const createPoster = useCallback((hit: SearchHit) => {
    setPosterError('')
    void loadMessageByIdentity({
      sessionId: hit.sessionId,
      localId: hit.localId,
      idKind: hit.idKind,
      ts: hit.ts,
      db: hit.db,
      table: hit.table,
    }).then((result) => {
      if (!result.message) {
        setPosterError(result.error || '读取这条消息失败，无法制作海报。')
        return
      }
      const request: ReaderPosterRequest = {
        sessionId: hit.sessionId,
        sessionName: hit.sessionName || hit.sessionId,
        messages: [result.message],
      }
      if (onCreatePoster) onCreatePoster(request)
      else window.dispatchEvent(new CustomEvent('weport:create-poster', { detail: request }))
    }).catch((error: unknown) => {
      setPosterError(error instanceof Error ? error.message : String(error))
    })
  }, [onCreatePoster])

  const moveResult = useCallback(
    (delta: 1 | -1) => {
      const count = visibleStore.size
      if (count === 0) return
      setActiveIndex((prev) => Math.min(count - 1, Math.max(0, prev < 0 ? (delta > 0 ? 0 : count - 1) : prev + delta)))
    },
    [visibleStore],
  )

  const openResult = useCallback(() => {
    const hit = visibleStore.get(activeIndex)
    if (hit) openHit(hit)
  }, [visibleStore, activeIndex, openHit])

  // ---- 前缀联想 ----------------------------------------------------------
  const [suggestions, setSuggestions] = useState<string[]>([])
  const suggestRequestId = useRef(0)
  useEffect(() => {
    const prefix = input.trim()
    /**
     * 带操作符的查询串不做前缀联想。
     *
     * 两个理由：一是 `标签:客户 合同` 这种东西本来就没有"前缀补全"可言；二是
     * 下拉会盖住下面的条件 chips，用户想点"清空全部"却被联想词挡住 —— 覆盖层
     * 吞掉点击是实打实的问题，不只是测试里的假警报。
     */
    const hasOperator = /[:：]/.test(prefix)
    if (prefix.length < 1 || prefix.length > 40 || hasOperator) {
      setSuggestions([])
      return
    }
    const api = typeof window !== 'undefined' ? window.electronAPI : undefined
    if (!api?.search?.suggest) {
      setSuggestions([])
      return
    }
    const requestId = ++suggestRequestId.current
    const timer = window.setTimeout(() => {
      api.search
        .suggest({ prefix, limit: 6 })
        .then((res) => {
          if (suggestRequestId.current !== requestId) return
          setSuggestions(Array.isArray(res?.suggestions) ? res.suggestions.slice(0, 6) : [])
        })
        .catch(() => {
          /* 联想失败是"少一个便利功能"，不该弹错误 */
          if (suggestRequestId.current === requestId) setSuggestions([])
        })
    }, 160)
    return () => window.clearTimeout(timer)
  }, [input])

  // ---- 条件编辑 ----------------------------------------------------------
  const applyScope = useCallback((next: ScopeParams) => {
    setParams((prev) => {
      const merged = { text: prev.text, scope: next }
      setInput(queryFromParams(merged))
      return merged
    })
  }, [])

  const patchScope = useCallback((patch: Partial<ScopeParams>) => {
    setParams((prev) => {
      const merged = { text: prev.text, scope: { ...prev.scope, ...patch } }
      setInput(queryFromParams(merged))
      return merged
    })
  }, [])

  const clearAll = useCallback(() => {
    setInput('')
    setParams({ text: '', scope: EMPTY_SCOPE })
    setSuggestions([])
  }, [])

  const toggleTag = useCallback(
    (tag: string) => {
      setParams((prev) => {
        const tags = prev.scope.tags.includes(tag) ? prev.scope.tags.filter((item) => item !== tag) : [...prev.scope.tags, tag]
        const merged = { text: prev.text, scope: { ...prev.scope, tags } }
        setInput(queryFromParams(merged))
        return merged
      })
    },
    [],
  )

  const [panelOpen, setPanelOpen] = useState(false)
  const panelAnchor = useRef<HTMLButtonElement | null>(null)

  // ---- 收藏 / 保存搜索 ---------------------------------------------------
  const toggleFavorite = useCallback(
    (hit: SearchHit) => {
      const identity = annotationIdentityFields(hit)
      const ref = { sessionId: hit.sessionId, ...identity }
      if (favoriteKeys.has(entryKey(hit))) annotations.removeFavorite(ref)
      else annotations.addFavorite(ref)
    },
    [annotations, favoriteKeys],
  )

  const [saveDialogOpen, setSaveDialogOpen] = useState(false)
  const [saveName, setSaveName] = useState('')
  const saveCurrent = useCallback(() => {
    const fallback = params.text.trim() || queryFromParams(params) || '未命名搜索'
    setSaveName(fallback.slice(0, 40))
    setSaveDialogOpen(true)
  }, [params])

  const commitSave = useCallback(() => {
    annotations.saveSearch({ name: saveName, text: params.text, scope: params.scope })
    setSaveDialogOpen(false)
  }, [annotations, saveName, params])

  const runSavedSearch = useCallback((saved: SavedSearch) => {
    const next = paramsFromSavedSearch(saved.query || '', saved.scope)
    setParams(next)
    setInput(queryFromParams(next))
  }, [])

  const resultSessionIds = useMemo(() => {
    const ids = new Set<string>()
    for (let i = 0; i < visibleStore.size; i += 1) {
      const hit = visibleStore.get(i)
      if (hit) ids.add(hit.sessionId)
    }
    return [...ids]
  }, [visibleStore])

  /**
   * 结果区键盘：↑/↓ 移动、Enter 打开。
   *
   * 只在焦点不在输入框/按钮上时接管 —— 否则侧栏里按箭头也会让结果高亮乱跳。
   * 输入框自己的箭头行为在 SearchBar 里（先走联想，再交回这里）。
   */
  const onResultKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      const target = event.target as HTMLElement | null
      const tag = target?.tagName?.toLowerCase()
      if (tag === 'input' || tag === 'textarea' || tag === 'select' || tag === 'button') return
      /**
       * `defaultPrevented` 是这里的关键：输入框自己也处理 ↑/↓/Enter（先联想、
       * 再交给结果），而它**在同一个 React 树的上方** —— 事件会继续冒泡到这里。
       * 不看这个标记的话，按一次 ↓ 会移动两行、按一次 Enter 会打开两次（这个
       * double-fire 实测踩过：`opened=2`）。
       */
      if (event.defaultPrevented) return
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault()
        moveResult(event.key === 'ArrowDown' ? 1 : -1)
        return
      }
      if (event.key === 'Enter') {
        event.preventDefault()
        openResult()
      }
    },
    [moveResult, openResult],
  )

  const meta =
    searchState.loadingFirst ? null : searchState.error ? null : searchState.searched ? (
      <>
        {searchState.total.toLocaleString('zh-CN')} 条
        {searchState.elapsedMs ? ` · ${searchState.elapsedMs}ms` : ''}
      </>
    ) : null

  return (
    <section className="sp-page" aria-label="全局搜索">
      <header className="sp-head">
        <div className="sp-head-row">
          <SearchBar
            value={input}
            onChange={setInput}
            suggestions={suggestions}
            inputRef={inputRef}
            onMoveResult={moveResult}
            onOpenResult={openResult}
            onClear={clearAll}
            meta={meta}
          />
          <div className="sp-head-actions">
            <div className="seg sp-sort" role="group" aria-label="结果排序">
              <button
                type="button"
                data-active={sort === 'relevance'}
                onClick={() => setSort('relevance')}
                title="按引擎给出的相关度排序"
              >
                相关度
              </button>
              <button type="button" data-active={sort === 'newest'} onClick={() => setSort('newest')} title="按时间倒序">
                最新
              </button>
            </div>
            <button
              type="button"
              className="secondary-btn"
              onClick={saveCurrent}
              disabled={!hasAnyCondition(params)}
              title="把当前关键词与筛选条件存成一个「保存搜索」"
            >
              <Save size={13} aria-hidden />
              保存搜索
            </button>
          </div>
        </div>

        <FilterChips
          scope={params.scope}
          sessionNames={sessionNames}
          onRemove={patchScope}
          onClearAll={clearAll}
          onOpenPanel={() => setPanelOpen((open) => !open)}
          panelOpen={panelOpen}
          anchorRef={panelAnchor}
          trailing={
            searchState.truncated ? (
              <span className="sp-truncated" title="引擎只返回了前若干条，请细化关键词或条件">
                <AlertTriangle size={11} aria-hidden />
                结果已截断
              </span>
            ) : null
          }
        />

        <IndexStatusBar index={index} indexLoading={indexLoading} indexError={indexError} onRefresh={refreshIndex} />
      </header>

      <div className="sp-body">
        <div className="sp-main" role="group" aria-label="搜索结果" onKeyDown={onResultKeyDown}>
          {posterError ? <div className="sp-poster-error" role="alert">制作海报失败：{posterError}</div> : null}
          {indexReady ? (
            <SearchResults
              store={visibleStore}
              state={searchState}
              activeIndex={activeIndex}
              onOpen={openHit}
              onCreatePoster={createPoster}
              tagsBySession={tagMap}
              favoriteKeys={favoriteKeys}
              onToggleFavorite={toggleFavorite}
              onTagClick={toggleTag}
              onLoadMore={search.loadMore}
            />
          ) : (
            <EmptyIndexState index={index} indexLoading={indexLoading} indexError={indexError} onRefresh={refreshIndex} />
          )}
        </div>
        <SearchRail
          annotations={annotations}
          exportState={exportState}
          activeTags={params.scope.tags}
          resultSessionIds={resultSessionIds}
          onToggleFavoriteNote={(entry, note) =>
            annotations.addFavorite({ sessionId: entry.sessionId, ...annotationIdentityFields(entry), note })
          }
          onOpenEntry={(entry) =>
            openHit({
              sessionId: entry.sessionId,
              sessionName: sessionNames.get(entry.sessionId) || entry.sessionId,
              localId: entry.messageId || String(entry.localId ?? ''),
              idKind: entry.idKind,
              db: entry.db,
              table: entry.table,
              ts: entry.ts,
              senderUsername: '',
              senderName: '',
              kind: 'text',
              snippet: entry.note || '',
              highlights: [],
              score: 0,
            })
          }
          onToggleTag={toggleTag}
          onAddTag={annotations.addTag}
          onRunSearch={runSavedSearch}
          onRenameSearch={annotations.renameSearch}
          onRemoveSearch={annotations.removeSearch}
        />
      </div>

      <ScopePanel
        open={panelOpen}
        anchor={panelAnchor}
        scope={params.scope}
        candidates={candidates}
        candidatesError={candidatesError}
        taggedSessions={taggedSessions.size ? taggedSessions : undefined}
        recentSessions={recentSessions}
        onApply={(next) => {
          applyScope(next)
          setPanelOpen(false)
        }}
        onClear={() => {
          clearAll()
          setPanelOpen(false)
        }}
        onClose={() => setPanelOpen(false)}
      />

      {saveDialogOpen && (
        <div className="sp-save-mask" role="dialog" aria-modal="true" aria-label="保存搜索">
          <div className="sp-save">
            <h3 className="sp-save-title">
              <FolderPlus size={14} aria-hidden />
              保存这次搜索
            </h3>
            <p className="sp-save-sub">
              条件：<span className="sp-mono">{queryFromParams(params) || '（无条件）'}</span>
            </p>
            <input
              className="sp-rail-input"
              type="text"
              value={saveName}
              autoFocus
              onChange={(event) => setSaveName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  commitSave()
                }
                if (event.key === 'Escape') setSaveDialogOpen(false)
              }}
              aria-label="保存搜索的名称"
            />
            <div className="sp-save-actions">
              <button type="button" className="ghost-btn" onClick={() => setSaveDialogOpen(false)}>
                取消
              </button>
              <button type="button" className="primary-btn" disabled={!saveName.trim()} onClick={commitSave}>
                保存
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  )
}

// ---------------------------------------------------------------------------
// URL 片段
// ---------------------------------------------------------------------------

/** `#/search?q=...&sort=...` -> 查询串。不是搜索片段时返回 null（调用方保留现状）。 */
function readHashQuery(): string | null {
  const hash = window.location.hash || ''
  if (!hash.startsWith('#/search')) return null
  const question = hash.indexOf('?')
  if (question < 0) return ''
  const params = new URLSearchParams(hash.slice(question + 1))
  return params.get('q') ?? ''
}

function readHashSort(): SortOrder | null {
  const hash = window.location.hash || ''
  if (!hash.startsWith('#/search')) return null
  const question = hash.indexOf('?')
  if (question < 0) return null
  const value = new URLSearchParams(hash.slice(question + 1)).get('sort')
  return value === 'newest' ? 'newest' : value === 'relevance' ? 'relevance' : null
}
