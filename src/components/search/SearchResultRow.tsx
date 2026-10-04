import { memo } from 'react'
import { FileText, Image as ImageIcon, ImagePlus, Link2, MessageSquareText, Mic, Paperclip, Smile, Video } from 'lucide-react'
import { formatHitTime, kindLabel, segmentsFromHighlights, tagTone } from './searchQuery'

/**
 * 单条结果行（v1.2 §6）。
 *
 * 行是 `memo` 的，并且**只订阅自己那一条数据**（见 `useHitAt`）：滚动时零 React
 * 更新，新结果回来时只有变化的行重渲染。这是 `npm run bench` 的 over50 / longTasks
 * 门限能守住的原因 —— 一个 4 万条结果集的页面，任何"整列表重渲染"都会当场变成长任务。
 */
export interface SearchResultRowProps {
  hit: SearchHit
  selected: boolean
  /** 这条命中的会话带哪些标签（没有注解数据时是 undefined，不显示标签区） */
  tags?: string[]
  /** 星标状态（本机收藏） */
  favorite?: boolean
  onOpen: (hit: SearchHit) => void
  onCreatePoster?: (hit: SearchHit) => void
  onToggleFavorite?: (hit: SearchHit) => void
  /** 点标签 -> 追加标签筛选 */
  onTagClick?: (tag: string) => void
}

const KIND_ICONS: Record<string, typeof MessageSquareText> = {
  text: MessageSquareText,
  image: ImageIcon,
  voice: Mic,
  video: Video,
  file: Paperclip,
  link: Link2,
  emoji: Smile,
  system: FileText,
}

function SearchResultRowInner({ hit, selected, tags, favorite, onOpen, onCreatePoster, onToggleFavorite, onTagClick }: SearchResultRowProps) {
  const Icon = KIND_ICONS[String(hit.kind || '').toLowerCase()] || MessageSquareText
  /**
   * 高亮必须走 React 片段。`dangerouslySetInnerHTML` 在这里是**数据注入**：
   * snippet 是聊天正文，里面一定有 `<` 和 `&`。
   */
  const segments = segmentsFromHighlights(hit.snippet || '', hit.highlights)
  const time = formatHitTime(hit.ts)

  return (
    <div
      className={`sp-row${selected ? ' is-selected' : ''}`}
      role="option"
      aria-selected={selected}
      tabIndex={-1}
      onClick={() => onOpen(hit)}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          onOpen(hit)
        }
      }}
    >
      <div className="sp-row-head">
        <span className="sp-row-session" title={hit.sessionId}>
          {hit.sessionName || hit.sessionId}
        </span>
        <span className="sp-row-kind" title={kindLabel(hit.kind)}>
          <Icon size={11} aria-hidden />
          {kindLabel(hit.kind)}
        </span>
        {time && <time className="sp-row-time">{time}</time>}
        {onToggleFavorite && (
          <button
            type="button"
            className={`sp-row-star${favorite ? ' is-on' : ''}`}
            aria-pressed={Boolean(favorite)}
            aria-label={favorite ? '取消收藏这条消息' : '收藏这条消息'}
            title={favorite ? '取消收藏' : '收藏（可在右侧栏查看）'}
            onClick={(event) => {
              event.stopPropagation()
              onToggleFavorite(hit)
            }}
          >
            {favorite ? '★' : '☆'}
          </button>
        )}
        {onCreatePoster && (
          <button
            type="button"
            className="sp-row-star sp-row-poster"
            aria-label="用这条消息制作海报"
            title="用这条消息制作海报"
            onClick={(event) => {
              event.stopPropagation()
              onCreatePoster(hit)
            }}
          >
            <ImagePlus size={13} aria-hidden />
          </button>
        )}
      </div>
      <div className="sp-row-snippet">
        {segments.map((segment, index) =>
          segment.hit ? (
            <mark className="sp-hit" key={index}>
              {segment.text}
            </mark>
          ) : (
            <span key={index}>{segment.text}</span>
          ),
        )}
      </div>
      <div className="sp-row-foot">
        <span className="sp-row-sender" title={hit.senderUsername}>
          {hit.senderName || hit.senderUsername || '未知发送者'}
        </span>
        {tags && tags.length > 0 && (
          <span className="sp-row-tags">
            {tags.map((tag) => (
              <button
                key={tag}
                type="button"
                className="sp-tag"
                data-tone={tagTone(tag)}
                title={`按标签「${tag}」筛选`}
                onClick={(event) => {
                  event.stopPropagation()
                  onTagClick?.(tag)
                }}
              >
                {tag}
              </button>
            ))}
          </span>
        )}
      </div>
    </div>
  )
}

export const SearchResultRow = memo(SearchResultRowInner)
