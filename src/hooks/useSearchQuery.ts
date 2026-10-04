/**
 * 搜索结果的取数与持有（v1.2 §6）。
 *
 * ## 为什么结果存在一个 store 里，而不是 useState 数组
 *
 * 结果列表用 react-virtuoso 虚拟化，它的 `itemContent` 是**按 index 取数据**的
 * 回调。数据本体若是 React state 数组，每次状态变化都会让回调闭包换新引用，
 * 虚拟列表就得重算可见区间、重建行组件 —— 正是 `npm run bench` 的
 * `over50 == 0` / `longTasks == 0` 会抓到的抖动。
 *
 * 所以：数据放在不可变 store 里，`itemContent` 永远只认 (index)，行内容由行组件
 * 自己订阅（`useHitAt`）。滚动零 React 更新，新结果回来只有变化的行重渲染。
 *
 * ## 并发语义
 *
 * IPC 请求没有 abort（主进程照样跑完），能做的只有"晚到的答案不覆盖新问题"：
 * 自增 requestId，回来时对不上就丢弃。这就是输入即搜不会出现"结果跳回上一个
 * 关键词"的原因。翻页则用另一个标志位（`loadingMore`），不与首屏抢 id。
 */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { buildEngineQuery, normalizeResultPage, type QueryParams } from '../components/search/searchQuery'

/** 每页条数：50 条 ≈ 一屏半，滚到底再取下一页。 */
export const PAGE_SIZE = 50

/** 输入防抖默认值：打字停一下（≈120ms）就出结果，再短就被 IPC 淹没。 */
export const DEFAULT_DEBOUNCE_MS = 120

export interface SearchRequestState {
  /** 引擎通道是否可用。缺失时是 false，界面显示"搜索通道不可用"而不是空结果 */
  available: boolean
  /** 首屏加载中（界面用骨架屏，不用转圈） */
  loadingFirst: boolean
  loadingMore: boolean
  error: string | null
  total: number
  elapsedMs: number
  truncated: boolean
  hasMore: boolean
  /** 是否已经发出过至少一次查询（区分"还没搜"与"搜了没结果"） */
  searched: boolean
}

/**
 * 结果数据。
 *
 * `subscribe` **必须**在所有版本之间保持同一个函数引用：`useSyncExternalStore`
 * 在 `subscribe` 变化时会重订阅，而重订阅与"快照取新值"发生在同一次 effect 里，
 * 于是 React 可能整帧都拿着旧快照 —— 表现是"结果到了但列表始终是空的"（这个坑
 * 实测踩过：`data-count=3` 而一个行都不渲染）。所以订阅函数挂在闭包外的固定对象上，
 * 只有 `get` 随数据版本更新。
 */
export interface HitsStore {
  subscribe: (listener: () => void) => () => void
  /** 按**显示顺序**取第 index 条 */
  get: (index: number) => SearchHit | undefined
  readonly size: number
}

interface StoreCore {
  listeners: Set<() => void>
  emit: () => void
}

function createStoreCore(): StoreCore {
  const listeners = new Set<() => void>()
  return {
    listeners,
    emit: () => {
      for (const listener of listeners) listener()
    },
  }
}

function createStableSubscribe(core: StoreCore) {
  return (listener: () => void) => {
    core.listeners.add(listener)
    return () => {
      core.listeners.delete(listener)
    }
  }
}

/** 订阅 store 里的一行：只有这一行的数据变化时它才重渲染（配合 memo 的行组件）。 */
export function useHitAt(store: HitsStore, index: number): SearchHit | undefined {
  return useSyncExternalStore(
    store.subscribe,
    () => store.get(index),
    () => undefined,
  )
}

/**
 * 把"引擎给的结果数组 + 显示顺序"包成一个 store。
 *
 * 顺序在 store 内部生效（`get(index)` 返回显示顺序上第 index 条），所以排序切换
 * 不需要重建 store、也不需要让任何订阅者重新订阅 —— 只是同一个 index 指向了
 * 另一条数据。
 */
export function useHitsStore(rawHits: HitsStore, order: number[]): HitsStore {
  const core = useMemo(createStoreCore, [])
  const subscribe = useMemo(() => createStableSubscribe(core), [core])
  const rawRef = useRef(rawHits)
  rawRef.current = rawHits
  const orderRef = useRef(order)
  orderRef.current = order

  return useMemo<HitsStore>(
    () => ({
      subscribe,
      get: (index) => rawRef.current.get(orderRef.current[index] ?? -1),
      get size() {
        return orderRef.current.length
      },
    }),
    [subscribe, rawHits, order],
  )
}

/** 防抖一个值（页面把「输入框里的字」变成「稳定查询」用它）。 */
export function useDebouncedValue<T>(value: T, delayMs = DEFAULT_DEBOUNCE_MS): T {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delayMs)
    return () => window.clearTimeout(timer)
  }, [value, delayMs])
  return debounced
}

const INITIAL_STATE: SearchRequestState = {
  available: true,
  loadingFirst: false,
  loadingMore: false,
  error: null,
  total: 0,
  elapsedMs: 0,
  truncated: false,
  hasMore: false,
  searched: false,
}

export interface UseSearchQueryOptions {
  debounceMs?: number
  /**
   * 是否允许查询。
   *
   * 索引还没建好时必须是 false：引擎侧"空条件查询"等价于扫全库，为了一个还没建索引
   * 的库付一次全表扫描的代价，正是"切页卡顿"的来源。关掉之后 hook 不碰 IPC。
   */
  enabled?: boolean
  /**
   * 本机筛选模式：引擎通道缺失时按关键词在会话名/发送者里筛（只能筛出会话，
   * 不能筛消息内容）。此时**不会**尝试调用不存在的通道。
   */
  localFilter?: (params: QueryParams) => SearchHit[] | null
}

export interface UseSearchQueryResult extends SearchRequestState {
  store: HitsStore
  /** 滚到底取下一页（引用稳定，可以直接进 Virtuoso 的 endReached） */
  loadMore: () => void
}

export function useSearchQuery(params: QueryParams, options?: UseSearchQueryOptions): UseSearchQueryResult {
  const debounceMs = options?.debounceMs ?? DEFAULT_DEBOUNCE_MS
  const enabled = options?.enabled !== false
  const localFilter = options?.localFilter

  const core = useMemo(createStoreCore, [])
  const subscribe = useMemo(() => createStableSubscribe(core), [core])
  /** 数据本体与它的版本号：版本号是给行组件用的"通知信号" */
  const itemsRef = useRef<SearchHit[]>([])
  const [version, setVersion] = useState(0)

  const itemsStore = useMemo<HitsStore>(
    () => ({
      subscribe,
      get: (index) => itemsRef.current[index],
      get size() {
        return version >= 0 ? itemsRef.current.length : 0
      },
    }),
    [subscribe, version],
  )

  const replace = useCallback(
    (next: SearchHit[]) => {
      itemsRef.current = next
      setVersion((value) => value + 1)
      core.emit()
    },
    [core],
  )

  const append = useCallback(
    (next: SearchHit[]) => {
      if (!next.length) return
      itemsRef.current = itemsRef.current.concat(next)
      setVersion((value) => value + 1)
      core.emit()
    },
    [core],
  )

  const [state, setState] = useState<SearchRequestState>(INITIAL_STATE)

  const engineQuery = useMemo(() => buildEngineQuery(params, { limit: PAGE_SIZE }), [
    params.text,
    params.scope.tags,
    params.scope.sessionIds,
    params.scope.senders,
    params.scope.from,
    params.scope.to,
    params.scope.kinds,
  ])
  const queryKey = useMemo(
    () => (engineQuery ? JSON.stringify({ text: engineQuery.text, scope: engineQuery.scope }) : ''),
    [engineQuery],
  )

  /**
   * 热状态放 ref：`loadMore` 要读"当前游标、当前查询、是否在翻页"，但它的引用
   * 必须稳定 —— 只要它换引用，Virtuoso 就会重建滚动容器。
   */
  const session = useRef<{ requestId: number; queryKey: string; cursor: string | number | null; appending: boolean; alive: boolean }>({
    requestId: 0,
    queryKey: '',
    cursor: null,
    appending: false,
    alive: true,
  })

  useEffect(() => {
    const sess = session.current
    sess.alive = true
    return () => {
      sess.alive = false
    }
  }, [])

  useEffect(() => {
    const sess = session.current
    sess.requestId += 1
    sess.appending = false
    const requestId = sess.requestId
    const alive = () => sess.alive && sess.requestId === requestId

    const api = typeof window !== 'undefined' ? window.electronAPI : undefined
    const search = api?.search

    // 索引未就绪：不发请求（见 options.enabled 的说明）
    if (!enabled) {
      sess.queryKey = queryKey
      sess.cursor = null
      replace([])
      setState({ ...INITIAL_STATE, available: Boolean(search?.query) })
      return
    }

    // 空条件：不发请求（引擎侧等价于扫全库），界面显示"输入关键词开始搜索"
    if (!engineQuery) {
      sess.queryKey = queryKey
      sess.cursor = null
      replace([])
      setState({ ...INITIAL_STATE, available: Boolean(search?.query) })
      return
    }

    // 通道缺失：不装作搜过了。若页面给了本机筛选就用它，否则如实报不可用。
    if (!search?.query) {
      const local = localFilter ? localFilter(params) : null
      if (local) {
        replace(local)
        setState({
          ...INITIAL_STATE,
          available: true,
          searched: true,
          total: local.length,
          hasMore: false,
        })
      } else {
        replace([])
        setState({ ...INITIAL_STATE, available: false })
      }
      return
    }

    sess.queryKey = queryKey
    sess.cursor = null
    replace([])
    setState({ ...INITIAL_STATE, available: true, loadingFirst: true, searched: true })

    const timer = window.setTimeout(() => {
      search
        .query(engineQuery)
        .then((raw: unknown) => {
          if (!alive()) return
          const page = normalizeResultPage(raw)
          sess.cursor = page.cursor
          replace(page.hits)
          setState({
            available: true,
            loadingFirst: false,
            loadingMore: false,
            // 引擎 per-page 的错误（索引不可用 / 游标对不上）要显示出来。以前这里只认
            // 被 reject 的 promise，于是"索引坏了"和"没搜到"在界面上长得一模一样。
            error: page.error ?? null,
            total: page.total,
            elapsedMs: page.elapsedMs,
            truncated: page.truncated,
            hasMore: Boolean(page.cursor),
            searched: true,
          })
        })
        .catch((error: unknown) => {
          if (!alive()) return
          sess.cursor = null
          replace([])
          setState({
            available: true,
            loadingFirst: false,
            loadingMore: false,
            error: error instanceof Error ? error.message : String(error),
            total: 0,
            elapsedMs: 0,
            truncated: false,
            hasMore: false,
            searched: true,
          })
        })
    }, debounceMs)

    return () => window.clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queryKey, debounceMs, enabled, replace, localFilter])

  const loadMore = useCallback(() => {
    const sess = session.current
    const api = typeof window !== 'undefined' ? window.electronAPI : undefined
    const search = api?.search
    if (!search?.query || !sess.cursor || sess.appending) return
    const cursor = sess.cursor
    sess.appending = true
    setState((prev) => (prev.loadingMore ? prev : { ...prev, loadingMore: true }))
    const requestId = sess.requestId
    search
      .query({ ...buildEngineQuery(params, { limit: PAGE_SIZE, cursor })! })
      .then((raw: unknown) => {
        if (!sess.alive || sess.requestId !== requestId) return
        const page = normalizeResultPage(raw)
        sess.cursor = page.cursor
        append(page.hits)
        setState((prev) => ({
          ...prev,
          loadingMore: false,
          total: page.total || prev.total,
          truncated: prev.truncated || page.truncated,
          hasMore: Boolean(page.cursor),
          // 翻页时的引擎错误同样要显示（游标对不上这类），已到的结果保留
          error: page.error ?? prev.error,
        }))
      })
      .catch((error: unknown) => {
        if (!sess.alive || sess.requestId !== requestId) return
        // 翻页失败只撤掉"还能翻"的假设，已到的结果留在屏幕上
        setState((prev) => ({
          ...prev,
          loadingMore: false,
          hasMore: false,
          error: error instanceof Error ? error.message : String(error),
        }))
      })
      .finally(() => {
        sess.appending = false
      })
  }, [params, append])

  return { ...state, store: itemsStore, loadMore }
}
