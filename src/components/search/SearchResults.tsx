import { useCallback, useEffect, useMemo, useRef } from 'react'
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso'
import { AlertTriangle, SearchX } from 'lucide-react'
import { EmptyState } from '../EmptyState'
import { SearchResultRow } from './SearchResultRow'
import { useHitAt, type HitsStore, type SearchRequestState } from '../../hooks/useSearchQuery'
import { entryKey } from './searchQuery'

/**
 * 结果列表（v1.2 §6）。
 *
 * 三条性能纪律，缺一条都会在 `npm run bench` 的切页/长任务指标上现形：
 *
 * 1. **虚拟化**：结果可能几万条，只渲染可见区间（`Virtuoso`）。
 * 2. **`itemContent` 引用稳定**：它只依赖 store（模块外的不可变数据）与一组
 *    `useCallback` 稳定回调。只要它换引用，Virtuoso 就会重建可见区间。
 * 3. **行自己订阅自己**：`itemContent` 里不读任何 React state，只把 index 交给
 *    行组件，行的数据变化才重渲染它自己。
 */
export interface SearchResultsProps {
  store: HitsStore
  state: SearchRequestState
  /** 高亮行下标（键盘导航用；-1 表示没有） */
  activeIndex: number
  /** 行被点击/回车 → 交给页面（"就地打开"回调） */
  onOpen: (hit: SearchHit) => void
  onCreatePoster?: (hit: SearchHit) => void
  /** sessionId → 标签列表（本机注解） */
  tagsBySession: Map<string, string[]>
  /** 收藏判定：`sessionId::localId` */
  favoriteKeys: Set<string>
  onToggleFavorite: (hit: SearchHit) => void
  onTagClick: (tag: string) => void
  /** 滚到底取下一页 */
  onLoadMore: () => void
  /** 打开浮层（筛选）时把焦点让出去 */
  listRef?: React.RefObject<HTMLDivElement | null>
}

/** 骨架屏：行形状与真结果一致，切到真数据时不跳布局。 */
function ResultSkeleton() {
  return (
    <div className="sp-skeleton" aria-hidden>
      {[0, 1, 2, 3, 4].map((row) => (
        <div className="sp-skeleton-row" key={row}>
          <div className="sp-skeleton-line" style={{ width: `${38 + ((row * 7) % 22)}%` }} />
          <div className="sp-skeleton-line is-thin" style={{ width: `${64 + ((row * 11) % 30)}%` }} />
          <div className="sp-skeleton-line is-thin" style={{ width: '24%' }} />
        </div>
      ))}
    </div>
  )
}

export default function SearchResults(props: SearchResultsProps) {
  const { store, state, activeIndex, onOpen, onCreatePoster, tagsBySession, favoriteKeys, onToggleFavorite, onTagClick, onLoadMore, listRef } = props
  const virtuosoRef = useRef<VirtuosoHandle | null>(null)
  const lastScrolled = useRef(-1)

  /**
   * 行渲染：**不读 state**。`tagsBySession` / `favoriteKeys` 是 Map/Set 引用，
   * 只有注解真的变了才换（页面里用 useMemo 保证）。`activeIndex` 也一样 —— 它放在
   * `activeIndexRef` 里给 `RowSlot` 自己读：把它放进依赖会让**每按一次方向键**都换一个
   * `itemContent` 回调，react-virtuoso 随即重算可见范围（一次按键 = 一次列表重建）。
   */
  const activeIndexRef = useRef(activeIndex)
  activeIndexRef.current = activeIndex

  const itemContent = useCallback(
    (index: number) => {
      return (
        <RowSlot
          store={store}
          index={index}
          tagsBySession={tagsBySession}
          favoriteKeys={favoriteKeys}
          isActive={index === activeIndexRef.current}
          onOpen={onOpen}
          onCreatePoster={onCreatePoster}
          onToggleFavorite={onToggleFavorite}
          onTagClick={onTagClick}
        />
      )
    },
    [store, onOpen, onCreatePoster, tagsBySession, favoriteKeys, onToggleFavorite, onTagClick],
  )

  const total = store.size
  const empty = total === 0 && !state.loadingFirst

  /**
   * 键盘移动高亮时把它滚进视口。
   *
   * 放在 effect 里而不是渲染期：渲染期读/写 ref 并调用命令式滚动 API，在并发
   * 渲染下会被执行多次（React 允许丢弃渲染），表现为"按一下跳两行"。
   */
  useEffect(() => {
    if (activeIndex < 0 || activeIndex === lastScrolled.current) return
    lastScrolled.current = activeIndex
    virtuosoRef.current?.scrollIntoView({ index: activeIndex, behavior: 'auto', align: 'center' })
  }, [activeIndex])

  const components = useMemo(
    () => ({
      Footer: () =>
        state.loadingMore ? (
          <div className="sp-more-loading" aria-live="polite">
            正在载入更多…
          </div>
        ) : state.hasMore ? (
          <div className="sp-more-hint">滚动到底继续加载</div>
        ) : total > 0 ? (
          <div className="sp-more-end">已到末尾 · 共 {state.total || total} 条</div>
        ) : null,
    }),
    [state.loadingMore, state.hasMore, state.total, total],
  )

  if (state.loadingFirst) return <ResultSkeleton />

  if (state.error) {
    return (
      <div className="wp-error" role="alert">
        <AlertTriangle size={14} aria-hidden />
        <span>搜索失败：{state.error}</span>
      </div>
    )
  }

  if (!state.available) {
    return <EmptyState icon={SearchX} title="搜索通道不可用" hint="当前版本未接入全局搜索，请升级或在设置中检查引擎状态" />
  }

  if (empty) {
    return state.searched ? (
      <EmptyState icon={SearchX} title="没有匹配的结果" hint="试试减少筛选条件，或换一个关键词" />
    ) : (
      <EmptyState icon={SearchX} title="输入关键词开始搜索" hint="支持 标签: / 会话: / 发送者: / 从: / 到: / 类型: 这样的前缀条件" />
    )
  }

  return (
    <div className="sp-list" ref={listRef}>
      <Virtuoso
        ref={virtuosoRef}
        className="sp-list-scroll"
        /**
         * `totalCount`（不是 `data-count`）：数据不在 React state 里，条数由 store
         * 提供。写成 `data-*` 是 HTML 属性，Virtuoso 会读成 `totalCount: undefined`
         * → **一行都不渲染**，而 Footer 照样出现（实测踩过：`data-count="3"` 却
         * `virtuoso-item-list` 是空的，看起来像"结果到了但列表是空白的"）。
         */
        totalCount={total}
        itemContent={itemContent}
        components={components}
        computeItemKey={(index) => index}
        defaultItemHeight={92}
        increaseViewportBy={{ top: 240, bottom: 480 }}
        endReached={() => {
          if (state.hasMore && !state.loadingMore) onLoadMore()
        }}
      />
    </div>
  )
}

/**
 * 单个槽位：把"按 index 取的数据"接到行组件上。
 *
 * 它自己订阅 store，所以 store 变化时只有它重渲染 —— 父级（Virtuoso 的
 * itemContent）不会因此换引用。
 */
function RowSlot(props: {
  store: HitsStore
  index: number
  tagsBySession: Map<string, string[]>
  favoriteKeys: Set<string>
  isActive: boolean
  onOpen: (hit: SearchHit) => void
  onCreatePoster?: (hit: SearchHit) => void
  onToggleFavorite?: (hit: SearchHit) => void
  onTagClick?: (tag: string) => void
}) {
  const { store, index, tagsBySession, favoriteKeys, isActive, onOpen, onCreatePoster, onToggleFavorite, onTagClick } = props
  const hit = useHitAt(store, index)
  if (!hit) return null
  return (
    <SearchResultRow
      hit={hit}
      selected={isActive}
      tags={tagsBySession.get(hit.sessionId)}
      favorite={favoriteKeys.has(entryKey(hit))}
      onOpen={onOpen}
      onCreatePoster={onCreatePoster}
      onToggleFavorite={onToggleFavorite}
      onTagClick={onTagClick}
    />
  )
}
