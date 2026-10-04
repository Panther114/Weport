/**
 * 内置聊天浏览器 / 阅读器（v1.2 §3，决策 D14）。
 *
 * ## 这一页是什么
 *
 * 不导出、不装插件，把本地聊天当**档案**读：翻会话、搜关键词、看图看视频听语音、
 * 定位到某一天。只读：**绝不修改微信数据**；可写的只有本机注解（标记 / 备注 /
 * 标签 / 收藏，走 `annotations:mutate`，见 `src/hooks/useAnnotations.ts`）。
 * 不提供与微信窗口联动跳转（D14），也不碰 WeChat 进程。
 *
 * ## 引擎通道
 *
 * 历史消息走 `chat:getMessages` 分页；跨页搜索命中走 `chat:getMessageByIdentity`，
 * 同时传数据库、表、时间戳和消息 id，避免不同分片里 local id 相同导致跳错行。
 * 图片、语音、视频和文件按需读取。缺少任一通道时显示明确说明，不拿
 * `chat:getNewMessages` 冒充历史。
 *
 * ## 性能
 *
 * - 列表两侧都虚拟化（`react-virtuoso`）：会话 10 万级、消息 5 万级都是常量 DOM；
 * - 行是 `React.memo` 且只收原始值 props；日期分隔由行自己渲染，双向插入时
 *   `firstItemIndex` 的锚点才精确（见 `readerWindow.ts` 顶部注释）；
 * - 图片视口内才解密 + 按字节封顶的 LRU；图片查看器 `lazy()` 加载；
 * - 页面不订阅导出进度（铁律 3），切页不会丢进度也不会重渲染。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, Search } from 'lucide-react'
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso'
import { useAnnotations } from '../hooks/useAnnotations'
import { copyTextToClipboard } from '../utils/clipboard'
import { MessageRow } from '../components/reader/MessageRow'
import { ReaderImageViewer } from '../components/reader/ReaderImageViewer'
import { ReaderToolbar } from '../components/reader/ReaderToolbar'
import { SessionRail } from '../components/reader/SessionRail'
import { exportReaderSession } from '../components/reader/readerExport'
import {
  READER_PAGE_SIZE,
  channelGapText,
  loadMessageByIdentity,
  loadMessagePage,
  loadReaderSessions,
  readerChannels,
  searchSession,
  type ReaderChannelStatus,
} from '../components/reader/readerSource'
import type { ReaderMessage, ReaderSearchHit, ReaderSession, ReaderSessionKind } from '../components/reader/readerTypes'
import { dayKeyOf, dayRangeFromInput, formatDateTime, messageToPlainText, rangeToPlainText } from '../components/reader/readerMessage'
import { annotationIdentityFields } from '../utils/annotationIdentity'
import {
  INITIAL_FIRST_ITEM_INDEX,
  mergeMessages,
  messageAnnotation,
  prependOlderPage,
  replaceMessages,
  sessionTags,
  unreadAnchorKey,
} from '../components/reader/readerWindow'
import '../styles/reader.scss'

interface HeaderContext {
  loading: boolean
  hasMore: boolean
  channelMissing: boolean
}

export interface ReaderOpenRequest {
  requestId: number
  sessionId: string
  sessionName?: string
  localId: string | number
  localIdNumber?: number
  idKind?: 'local' | 'server'
  ts: number
  db?: string
  table?: string
  snippet?: string
  query?: string
}

export interface ReaderPosterRequest {
  sessionId: string
  sessionName: string
  messages: ReaderMessage[]
}

export interface ReaderPageProps {
  openRequest?: ReaderOpenRequest
  onCreatePoster?: (request: ReaderPosterRequest) => void
}

function targetMilliseconds(value: number): number {
  return Number.isFinite(value) && value > 0 ? (value < 1e12 ? Math.round(value * 1000) : Math.round(value)) : 0
}

/** 列表顶部：加载更早消息的可见入口（也是"已到顶"的说明）。 */
function OlderHeader({ context }: { context?: HeaderContext }) {
  const state = context || { loading: false, hasMore: false, channelMissing: false }
  return (
    <div className="reader-older" data-state={state.loading ? 'loading' : state.hasMore ? 'more' : 'end'}>
      {state.channelMissing
        ? '引擎未提供历史分页通道'
        : state.loading
          ? '正在加载更早的消息…'
          : state.hasMore
            ? '上滑加载更早的消息'
            : '已经到最早了'}
    </div>
  )
}

export default function ReaderPage({ openRequest, onCreatePoster }: ReaderPageProps) {
  const virtuosoRef = useRef<VirtuosoHandle | null>(null)
  const [channels, setChannels] = useState<ReaderChannelStatus>(() => readerChannels())

  // ---- 会话栏 ----
  const [sessions, setSessions] = useState<ReaderSession[]>([])
  const [sessionsLoading, setSessionsLoading] = useState(true)
  const [sessionsError, setSessionsError] = useState<string | undefined>(undefined)
  const [kind, setKind] = useState<'all' | ReaderSessionKind>('all')
  const [sessionKeyword, setSessionKeyword] = useState('')
  const [selectedId, setSelectedId] = useState('')

  // ---- 消息窗口 ----
  const [messages, setMessages] = useState<ReaderMessage[]>([])
  const [firstItemIndex, setFirstItemIndex] = useState(INITIAL_FIRST_ITEM_INDEX)
  const [nextOffset, setNextOffset] = useState(0)
  const [hasMore, setHasMore] = useState(false)
  const [loadingOlder, setLoadingOlder] = useState(false)
  const [loadingWindow, setLoadingWindow] = useState(false)
  const [messagesError, setMessagesError] = useState<string | undefined>(undefined)
  const [channelMissing, setChannelMissing] = useState(false)
  /** 时间窗（毫秒）对；null = 最新。跳日期与"跳到搜索命中"都用它。 */
  const [timeWindow, setTimeWindow] = useState<{ start: number; end: number } | null>(null)
  const [jumpDate, setJumpDate] = useState('')

  /**
   * 请求序号 + 存活标记：切会话、跳时间窗、切页都会让"上一次还在飞的请求"作废。
   *
   * 没有它时的症状是**错位而不是报错**：慢的 A 会话在快的 B 之后落地，`messages` 变成 A 的
   * 内容而标题栏写着 B（`selectedId` 已经是 B），用户看到的是"这个会话的消息不对"。
   * 用序号而不是 `cancelled` 布尔，是为了同时挡住"同页内连点两个会话"这种情况。
   */
  const loadSeqRef = useRef(0)
  const aliveRef = useRef(true)
  /** `loadOlder` 的在飞标记：状态版在两次 startReached 之间读到的还是旧值。 */
  const loadingOlderRef = useRef(false)
  /** 会话内搜索自己的序号：和消息加载的计数器**必须分开**，
   *  否则"清空搜索词"为了作废在飞搜索而去动消息加载的序号，会把正在加载的消息页一起作废。 */
  const searchSeqRef = useRef(0)
  const handledOpenRequestRef = useRef<number | null>(null)
  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
      // 让在飞的请求立刻作废（不用等它回来才判过期）
      loadSeqRef.current += 1
    }
  }, [])

  // ---- 搜索 / 多选 / 灯箱 ----
  const [searchKeyword, setSearchKeyword] = useState('')
  const [hits, setHits] = useState<ReaderSearchHit[]>([])
  const [searching, setSearching] = useState(false)
  const [hitsNote, setHitsNote] = useState('')
  const [activeHitKey, setActiveHitKey] = useState('')
  const [pickMode, setPickMode] = useState(false)
  const [picked, setPicked] = useState<string[]>([])
  const [viewerIndex, setViewerIndex] = useState(-1)
  const [exportState, setExportState] = useState<{ busy: boolean; message?: string; error?: string }>({ busy: false })

  const annotations = useAnnotations()
  const annotationsReady = annotations.error === null
  const store = annotations.data

  const selected = useMemo(() => sessions.find((session) => session.id === selectedId) || null, [sessions, selectedId])

  const filteredSessions = useMemo(() => {
    const needle = sessionKeyword.trim().toLowerCase()
    return sessions.filter((session) => {
      if (kind !== 'all' && session.kind !== kind) return false
      if (!needle) return true
      return `${session.name} ${session.id} ${session.summary}`.toLowerCase().includes(needle)
    })
  }, [sessions, kind, sessionKeyword])

  /**
   * 会话栏角标（标签 / 标记数 / 收藏）。
   *
   * 以前每个会话都现算一遍：一次 `sessionTags`（扫全部标签）+ 一次 `marks.filter` + 一次
   * `favorites.some` —— 合起来是 O(会话数 × (标签 + 标记 + 收藏))，而这一页在会话多的时候是
   * 十万量级；每改一次注解就重算一遍。改成**先把注解索引成 Map，再每个会话查一次**：
   * O(注解总量 + 会话数)。行为一样（同一份 store 变一次算一次）。
   */
  const badges = useMemo(() => {
    const map: Record<string, { tags: string[]; marks: number; favorite: boolean }> = {}
    if (!store) return map
    const marksBySession = new Map<string, number>()
    for (const entry of store.marks) {
      if (!entry || !entry.sessionId) continue
      marksBySession.set(entry.sessionId, (marksBySession.get(entry.sessionId) ?? 0) + 1)
    }
    const favoriteSessions = new Set<string>()
    for (const entry of store.favorites) {
      if (entry && entry.sessionId && !entry.localId && !entry.messageId) favoriteSessions.add(entry.sessionId)
    }
    for (const session of sessions) {
      const tags = sessionTags(store, session.id)
      const marks = marksBySession.get(session.id) ?? 0
      const favorite = favoriteSessions.has(session.id)
      if (tags.length || marks || favorite) map[session.id] = { tags, marks, favorite }
    }
    return map
  }, [store, sessions])

  // ---- 会话列表 ----
  const refreshSessions = useCallback(async () => {
    setSessionsLoading(true)
    const result = await loadReaderSessions()
    setSessions(result.sessions)
    setSessionsError(result.error)
    setSessionsLoading(false)
  }, [])

  useEffect(() => {
    setChannels(readerChannels())
    void refreshSessions()
  }, [refreshSessions])

  // ---- 消息加载 ----
  const loadFirstPage = useCallback(
    async (sessionId: string, range: { start: number; end: number } | null, jump?: ReaderOpenRequest) => {
      const seq = (loadSeqRef.current += 1)
      const stale = () => seq !== loadSeqRef.current || !aliveRef.current
      setLoadingWindow(true)
      setMessagesError(undefined)
      const result = await loadMessagePage({
        sessionId,
        offset: 0,
        limit: READER_PAGE_SIZE,
        startTime: range?.start,
        endTime: range?.end,
      })
      // 作废的响应：连同它的 loading 收尾一起丢掉，别去覆盖新会话的界面
      if (stale()) return
      if (result.channelMissing) {
        setChannelMissing(true)
        setMessages([])
        setMessagesError(result.error)
        setHasMore(false)
        setNextOffset(0)
        setLoadingWindow(false)
        return
      }
      setChannelMissing(false)
      if (result.error) {
        setMessagesError(result.error)
        setMessages([])
        setHasMore(false)
        setLoadingWindow(false)
        return
      }
      let windowMessages = result.messages || []
      let identityError: string | undefined
      let exactMessageKey: string | undefined
      if (jump) {
        const exact = await loadMessageByIdentity({
          sessionId: jump.sessionId,
          localId: jump.localId,
          ts: jump.ts,
          db: jump.db,
          table: jump.table,
          idKind: jump.idKind,
        })
        if (stale()) return
        identityError = exact.error
        if (exact.message) {
          exactMessageKey = exact.message.key
          windowMessages = mergeMessages(windowMessages, [exact.message])
        }
      }
      const initial = replaceMessages(windowMessages)
      setMessages(initial.messages)
      setFirstItemIndex(initial.firstItemIndex)
      setHasMore(result.hasMore === true)
      setNextOffset(result.nextOffset || 0)
      setPicked([])
      let targetIndex = -1
      if (jump) {
        targetIndex = exactMessageKey ? initial.messages.findIndex((message) => message.key === exactMessageKey) : -1
        setActiveHitKey(targetIndex >= 0 ? initial.messages[targetIndex].key : '')
        if (targetIndex < 0) setMessagesError(identityError || '已载入附近消息，但没有匹配到搜索命中；索引可能已过期。')
      } else {
        setActiveHitKey('')
      }
      setLoadingWindow(false)
      // 首屏落在最新一条（V12 §3：新消息在下）。
      // **绝对下标**：react-virtuoso 在设了 `firstItemIndex` 之后，`scrollToIndex` 与
      // `itemContent` 收到的都是**绝对**下标（数据下标 + firstItemIndex）。传数据下标的后果
      // 不是报错而是"滚到看着挺像但其实错的那一行"—— 只有当 firstItemIndex 恰好回到 0 附近
      // 才会看起来是对的。
      window.requestAnimationFrame(() => {
        // 延后一帧执行，期间用户可能已经切了会话/切了页 —— 过期就不再滚
        if (stale()) return
        // 数据下标（见 itemContent 上面的说明），不是绝对下标
        virtuosoRef.current?.scrollToIndex?.({
          index: targetIndex >= 0 ? targetIndex : Math.max(0, windowMessages.length - 1),
          align: targetIndex >= 0 ? 'center' : 'end',
        })
      })
    },
    [],
  )

  const openSession = useCallback(
    (session: ReaderSession) => {
      setSelectedId(session.id)
      setTimeWindow(null)
      setJumpDate('')
      setSearchKeyword('')
      setHits([])
      setHitsNote('')
      setPickMode(false)
      setViewerIndex(-1)
      setExportState({ busy: false })
      void loadFirstPage(session.id, null)
    },
    [loadFirstPage],
  )

  useEffect(() => {
    if (!openRequest || sessionsLoading || handledOpenRequestRef.current === openRequest.requestId) return
    handledOpenRequestRef.current = openRequest.requestId
    let session = sessions.find((item) => item.id === openRequest.sessionId)
    if (!session) {
      session = {
        id: openRequest.sessionId,
        name: openRequest.sessionName || openRequest.sessionId,
        kind: openRequest.sessionId.endsWith('@chatroom') ? 'group' : 'private',
        lastAt: targetMilliseconds(openRequest.ts),
        messageCount: null,
        unreadCount: 0,
        summary: openRequest.snippet || '',
      }
      setSessions((current) => current.some((item) => item.id === session!.id) ? current : [...current, session!])
    }
    const target = targetMilliseconds(openRequest.ts)
    const range = { start: Math.max(0, target - 30_000), end: target + 30_000 }
    setSelectedId(session.id)
    setTimeWindow(range)
    setJumpDate('')
    setSearchKeyword(openRequest.query || '')
    setHits([])
    setHitsNote('')
    setPickMode(false)
    setPicked([])
    setViewerIndex(-1)
    setExportState({ busy: false })
    void loadFirstPage(session.id, range, openRequest)
  }, [openRequest, sessionsLoading, sessions, loadFirstPage])

  const loadOlder = useCallback(async () => {
    // 在飞标记用 ref 而不是 `loadingOlder` 状态：`startReached` 在 React 重渲染之前可能连着
    // 触发两次，两次都读到同一个旧 state → 两次都通过判断 → 同一页被请求两遍，
    // 而第二次合并用的是**上一次闭包里的** messages/nextOffset。
    if (loadingOlderRef.current || loadingWindow || !selectedId || !hasMore || channelMissing) return
    loadingOlderRef.current = true
    setLoadingOlder(true)
    const seq = loadSeqRef.current
    const result = await loadMessagePage({
      sessionId: selectedId,
      offset: nextOffset,
      limit: READER_PAGE_SIZE,
      startTime: timeWindow?.start,
      endTime: timeWindow?.end,
    })
    // 会话/时间窗已经换过（或页面卸载了）：这一页不属于现在的视图，丢掉
    if (seq !== loadSeqRef.current || !aliveRef.current) {
      loadingOlderRef.current = false
      return
    }
    if (!result.error && result.messages) {
      // 两次 setState 在同一个事件里会被批处理成一次提交：中间不会出现
      // "行数变了、锚点没变"的一帧（那一帧虚拟列表会先跳一下再回来）。
      const merged = prependOlderPage({ messages, firstItemIndex }, result.messages)
      setMessages(merged.messages)
      setFirstItemIndex(merged.firstItemIndex)
      setHasMore(result.hasMore === true)
      setNextOffset(result.nextOffset || nextOffset)
    }
    loadingOlderRef.current = false
    setLoadingOlder(false)
  }, [channelMissing, firstItemIndex, hasMore, loadingWindow, messages, nextOffset, selectedId, timeWindow])

  const handleJumpDate = useCallback(
    (value: string) => {
      setJumpDate(value)
      const range = dayRangeFromInput(value)
      if (!range || !selectedId) return
      setTimeWindow(range)
      void loadFirstPage(selectedId, range)
    },
    [loadFirstPage, selectedId],
  )

  const handleResetWindow = useCallback(() => {
    if (!selectedId) return
    setTimeWindow(null)
    setJumpDate('')
    void loadFirstPage(selectedId, null)
  }, [loadFirstPage, selectedId])

  // ---- 会话内搜索 ----
  useEffect(() => {
    if (!selectedId) return
    const needle = searchKeyword.trim()
    if (!needle) {
      // 作废在飞的搜索：否则慢的那次会在清空之后把 hits 又填回来
      searchSeqRef.current += 1
      setHits([])
      setHitsNote('')
      setSearching(false)
      return
    }
    setSearching(true)
    const seq = (searchSeqRef.current += 1)
    const timer = window.setTimeout(() => {
      void searchSession(selectedId, needle, messages).then((result) => {
        // 慢的一次搜索可能后到。清空关键词或切会话之后不该再把 hits 填回来。
        if (seq !== searchSeqRef.current || !aliveRef.current) return
        setHits(result.hits)
        setSearching(false)
        setHitsNote(
          result.engineSearch
            ? `引擎搜索命中 ${result.hits.length} 处`
            : `引擎未提供会话内搜索通道（chat:searchMessages），仅在已加载的 ${messages.length} 条里找到 ${result.hits.length} 处`,
        )
      })
    }, 260)
    return () => window.clearTimeout(timer)
  }, [searchKeyword, selectedId, messages])

  const handleHit = useCallback(
    (hit: ReaderSearchHit) => {
      setActiveHitKey(hit.key)
      if (hit.index >= 0) {
        // 数据下标（见 itemContent 上面的说明）
        virtuosoRef.current?.scrollToIndex?.({ index: hit.index, align: 'center' })
        return
      }
      // 引擎搜索的命中不在已加载窗口里：把窗口挪到那一刻（start = 命中时间）。
      if (!selectedId) return
      const target = targetMilliseconds(hit.ts)
      const range = { start: Math.max(0, target - 30_000), end: target + 30_000 }
      setTimeWindow(range)
      const identity: ReaderOpenRequest | undefined = hit.localId !== undefined || hit.serverId
        ? {
            requestId: Date.now(),
            sessionId: selectedId,
            localId: hit.idKind === 'server' ? hit.serverId || '' : hit.localId || 0,
            idKind: hit.idKind,
            ts: hit.ts,
            db: hit.db,
            table: hit.table,
            snippet: hit.excerpt,
            query: searchKeyword,
          }
        : undefined
      void loadFirstPage(selectedId, range, identity)
    },
    [loadFirstPage, searchKeyword, selectedId],
  )

  // ---- 注解（全部写操作都发给主进程，界面不自己推演） ----
  const toggleMark = useCallback(
    (message: ReaderMessage) => {
      if (!annotationsReady) return
      const state = messageAnnotation(store, message)
      const identity = annotationIdentityFields(message)
      if (state.marked) annotations.removeMark({ sessionId: message.sessionId, ...identity })
      else annotations.addMark({ sessionId: message.sessionId, ...identity, note: state.note })
    },
    [annotations, annotationsReady, store],
  )

  const editNote = useCallback(
    (message: ReaderMessage, note: string) => {
      if (!annotationsReady) return
      const identity = annotationIdentityFields(message)
      if (!note) {
        annotations.removeMark({ sessionId: message.sessionId, ...identity })
        return
      }
      annotations.addMark({ sessionId: message.sessionId, ...identity, note })
    },
    [annotations, annotationsReady],
  )

  const toggleFavorite = useCallback(() => {
    if (!selected || !annotationsReady) return
    const favorite = badges[selected.id]?.favorite === true
    if (favorite) annotations.removeFavorite({ sessionId: selected.id, localId: '' })
    else annotations.addFavorite({ sessionId: selected.id, localId: '', ts: selected.lastAt })
  }, [annotations, annotationsReady, badges, selected])

  const copyMessage = useCallback((message: ReaderMessage) => {
    void copyTextToClipboard(messageToPlainText(message))
  }, [])

  const copyPicked = useCallback(() => {
    const chosen = messages.filter((message) => picked.includes(message.key))
    if (chosen.length === 0) return
    void copyTextToClipboard(rangeToPlainText(chosen))
    setPickMode(false)
    setPicked([])
  }, [messages, picked])

  const onPick = useCallback((message: ReaderMessage) => {
    setPicked((previous) =>
      previous.includes(message.key) ? previous.filter((key) => key !== message.key) : [...previous, message.key],
    )
  }, [])

  // ---- 灯箱 ----
  const imageMessages = useMemo(() => messages.filter((message) => message.kind === 'image'), [messages])
  const openImage = useCallback(
    (message: ReaderMessage) => {
      const index = imageMessages.findIndex((item) => item.key === message.key)
      setViewerIndex(index >= 0 ? index : 0)
    },
    [imageMessages],
  )

  // ---- 导出本会话 ----
  const runExport = useCallback(() => {
    if (!selected) return
    setExportState({ busy: true })
    void exportReaderSession(selected).then((result) => {
      setExportState(result.ok ? { busy: false, message: result.message } : { busy: false, error: result.error })
    })
  }, [selected])

  const createPoster = useCallback(() => {
    if (!selected || !onCreatePoster) return
    const chosen = messages.filter((message) => picked.includes(message.key))
    if (chosen.length === 0) return
    onCreatePoster({ sessionId: selected.id, sessionName: selected.name, messages: chosen })
  }, [messages, onCreatePoster, picked, selected])

  // ---- 行渲染所需的派生数据 ----
  const dayFlags = useMemo(() => {
    const flags = new Array<boolean>(messages.length)
    let previous = ''
    for (let index = 0; index < messages.length; index += 1) {
      const key = dayKeyOf(messages[index].ts)
      flags[index] = index === 0 || key !== previous
      previous = key
    }
    return flags
  }, [messages])

  const unreadKey = useMemo(
    () => (timeWindow ? null : unreadAnchorKey(messages, selected?.unreadCount || 0)),
    [messages, selected, timeWindow],
  )

  const blockActions = useMemo(() => ({ onOpenImage: openImage, onCopy: copyMessage }), [openImage, copyMessage])
  const headerContext = useMemo<HeaderContext>(
    () => ({ loading: loadingOlder, hasMore, channelMissing }),
    [loadingOlder, hasMore, channelMissing],
  )

  const gapText = channelGapText(channels)

  return (
    <div className="v09-page reader-page" aria-label="聊天阅读器">
      <SessionRail
        sessions={filteredSessions}
        loading={sessionsLoading}
        error={sessionsError}
        kind={kind}
        keyword={sessionKeyword}
        selectedId={selectedId}
        badges={badges}
        annotationsReady={annotationsReady}
        onKind={setKind}
        onKeyword={setSessionKeyword}
        onSelect={openSession}
      />

      <div className="reader-main">
        <ReaderToolbar
          session={selected}
          channels={channels}
          annotationsReady={annotationsReady}
          favorite={selected ? badges[selected.id]?.favorite === true : false}
          tags={selected ? sessionTags(store, selected.id) : []}
          onToggleFavorite={toggleFavorite}
          onAddTag={(tag) => {
            if (selected && tag.trim()) annotations.addTag(tag.trim(), [selected.id])
          }}
          onRemoveTag={(tag) => {
            if (selected) annotations.removeTag(tag, [selected.id])
          }}
          keyword={searchKeyword}
          onKeyword={setSearchKeyword}
          hits={hits}
          hitsNote={hitsNote}
          activeHitKey={activeHitKey}
          searching={searching}
          onHit={handleHit}
          jumpDate={jumpDate}
          onJumpDate={handleJumpDate}
          onResetWindow={handleResetWindow}
          loadingWindow={loadingWindow}
          exporting={exportState}
          onExport={runExport}
          onCreatePoster={createPoster}
          posterEnabled={Boolean(onCreatePoster && picked.length > 0)}
          pickMode={pickMode}
          pickedCount={picked.length}
          onTogglePickMode={() => {
            setPickMode((value) => !value)
            setPicked([])
          }}
          onCopyPicked={copyPicked}
          onClearPicked={() => setPicked([])}
        />

        {!selected && (
          <div className="reader-empty">
            <Search size={22} />
            <div className="reader-empty-title">选一个会话开始读</div>
            <div className="reader-empty-hint">
              左列是全部会话（可搜索、可按群聊/私聊/公众号筛选）。阅读器只读本地数据，不会修改微信里的任何东西。
            </div>
            {gapText && <div className="reader-empty-gap">{gapText}</div>}
          </div>
        )}

        {selected && channelMissing && (
          <div className="reader-gap" role="alert">
            <AlertTriangle size={18} />
            <div>
              <div className="reader-gap-title">引擎尚未接入消息分页通道</div>
              <div className="reader-gap-body">
                阅读器需要 `chat:getMessages(sessionId, offset, limit, startTime?, endTime?)`
                （对应 `chatService.getMessages`，`electron/services/chatService.ts:2613`）才能翻历史。
                在它接线之前，这一页不会拿 `chat:getNewMessages` 冒充历史 —— 那个通道给的是"某个时间点
                之后的前 N 条"，不是最新的一批。
              </div>
              {messagesError && <div className="reader-gap-error">{messagesError}</div>}
              <button type="button" className="secondary-btn" onClick={() => void loadFirstPage(selected.id, null)}>
                重试
              </button>
            </div>
          </div>
        )}

        {selected && !channelMissing && (
          <>
            {timeWindow && (
              <div className="reader-window-banner" role="status">
                <span>
                  {timeWindow.end
                    ? `正在查看 ${formatDateTime(timeWindow.start).slice(0, 10)} 这一天的消息`
                    : `已定位到 ${formatDateTime(timeWindow.start)}`}
                </span>
                <button type="button" className="ghost-btn" onClick={handleResetWindow}>
                  回到最新
                </button>
              </div>
            )}
            {messagesError && <div className="reader-gap-error">{messagesError}</div>}
            <Virtuoso<ReaderMessage, HeaderContext>
              key={selected.id}
              ref={virtuosoRef}
              className="reader-messages"
              data={messages}
              firstItemIndex={firstItemIndex}
              // 数据下标（见 itemContent 上面的说明）：消息列表的新消息在下，首屏落在最后一条
              initialTopMostItemIndex={Math.max(0, messages.length - 1)}
              startReached={() => void loadOlder()}
              computeItemKey={(_, message) => message.key}
              context={headerContext}
              components={{ Header: OlderHeader }}
              increaseViewportBy={{ top: 400, bottom: 400 }}
              itemContent={(index, message) => {
                // **这里收到的是数据下标**（0 = `messages[0]`），不是"绝对下标"。试过按
                // `index - firstItemIndex` 减一次：Virtuoso 给的就是 0..n-1，减完变成 -100000
                // 起步，日期分隔线一条都不出（实测 0 条）。三个下标入口（itemContent /
                // initialTopMostItemIndex / scrollToIndex）在这套配置下一律用**数据下标**。
                const annotation = messageAnnotation(store, message)
                return (
                  <MessageRow
                    message={message}
                    group={selected.kind === 'group'}
                    showDay={dayFlags[index] === true}
                    showUnreadAnchor={unreadKey === message.key}
                    marked={annotation.marked}
                    note={annotation.note}
                    annotationsReady={annotationsReady}
                    highlight={searchKeyword.trim()}
                    imageChannel={channels.imageData}
                    videoChannel={channels.videoData}
                    voiceChannel={channels.voiceData}
                    fileChannel={channels.fileData}
                    active={activeHitKey === message.key}
                    pickable={pickMode}
                    picked={picked.includes(message.key)}
                    onPick={onPick}
                    onToggleMark={toggleMark}
                    onEditNote={editNote}
                    onCopy={copyMessage}
                    actions={blockActions}
                  />
                )
              }}
            />
          </>
        )}
      </div>

      {viewerIndex >= 0 && imageMessages.length > 0 && (
        <ReaderImageViewer
          images={imageMessages}
          index={viewerIndex}
          onIndex={setViewerIndex}
          onClose={() => setViewerIndex(-1)}
        />
      )}
    </div>
  )
}
