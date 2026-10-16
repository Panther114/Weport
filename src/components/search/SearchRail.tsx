import { useMemo, useState } from 'react'
import { Download, FolderOpen, Pencil, Play, Plus, Star, Tag, Trash2, X } from 'lucide-react'
import { entryKey, formatRelative, tagTone } from './searchQuery'
import { EXPORT_FORMATS, type UseAnnotationsExportResult, type UseAnnotationsResult } from '../../hooks/useAnnotations'
import { tagRows as buildTagRows } from './searchAnnotations'

/**
 * 右侧注解栏（v1.2 §6）：标签 / 收藏 / 保存搜索 / 导出。
 *
 * 设计要点：
 *
 * - **标签是"虚拟文件夹"**：点一下就是一次筛选（写进查询条件与 URL），所以标签
 *   按钮是 `aria-pressed` 的开关，不是链接。
 * - **计数来自 store 本身**（`tags[tag].length`），不是界面自己数的 —— 界面数出来
 *   的数字在主进程拒绝过一次写入之后就会开始骗人。
 * - 三个区块各自可折叠，折叠状态留在本机 state：栏本身常常一屏放不下，
 *   而"我只看收藏"是高频动作。
 */
export interface SearchRailProps {
  annotations: UseAnnotationsResult
  exportState: UseAnnotationsExportResult
  /** 正在生效的标签条件（高亮用） */
  activeTags: string[]
  /** 当前筛选命中的会话 id（"给当前结果打标签"用；空数组表示没有来源） */
  resultSessionIds: string[]
  /** 编辑中的收藏备注（受控，便于取消） */
  onToggleFavoriteNote: (entry: AnnotationEntry, note: string) => void
  onOpenEntry: (entry: AnnotationEntry) => void
  onToggleTag: (tag: string) => void
  onAddTag: (name: string, sessionIds: string[]) => void
  onRunSearch: (search: SavedSearch) => void
  onRenameSearch: (id: string, name: string) => void
  onRemoveSearch: (id: string) => void
}

type SectionId = 'tags' | 'favorites' | 'searches'

export default function SearchRail(props: SearchRailProps) {
  const {
    annotations,
    exportState,
    activeTags,
    resultSessionIds,
    onToggleFavoriteNote,
    onOpenEntry,
    onToggleTag,
    onAddTag,
    onRunSearch,
    onRenameSearch,
    onRemoveSearch,
  } = props
  const [collapsed, setCollapsed] = useState<Record<SectionId, boolean>>({ tags: false, favorites: false, searches: false })
  const [newTag, setNewTag] = useState('')
  const [noteFor, setNoteFor] = useState<string | null>(null)
  const [noteDraft, setNoteDraft] = useState('')
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameDraft, setRenameDraft] = useState('')

  const store = annotations.data
  const tagRows = useMemo(() => {
    return buildTagRows(store)
  }, [store])

  const favorites = store?.favorites ?? []
  const searches = useMemo(() => {
    const list = store?.savedSearches ?? []
    return [...list].sort((a, b) => (b.lastRunAt || b.createdAt) - (a.lastRunAt || a.createdAt))
  }, [store])

  const toggleSection = (id: SectionId) => setCollapsed((prev) => ({ ...prev, [id]: !prev[id] }))

  const submitNewTag = () => {
    const name = newTag.trim()
    if (!name || resultSessionIds.length === 0) return
    onAddTag(name, resultSessionIds)
    setNewTag('')
  }

  return (
    <aside className="sp-rail" aria-label="标签、收藏与保存搜索">
      {annotations.error && (
        <p className="sp-rail-error" role="status">
          {annotations.error}
        </p>
      )}

      {/* ---------------- 标签 ---------------- */}
      <section className="sp-rail-sec">
        <button type="button" className="sp-rail-head" aria-expanded={!collapsed.tags} onClick={() => toggleSection('tags')}>
          <Tag size={13} aria-hidden />
          <span>标签</span>
          <span className="sp-rail-count">{tagRows.length}</span>
        </button>
        {!collapsed.tags && (
          <div className="sp-rail-body">
            {annotations.loading && !store ? (
              <div className="sp-rail-skeleton" aria-hidden>
                <div className="sp-skeleton-line is-thin" />
                <div className="sp-skeleton-line is-thin" />
              </div>
            ) : tagRows.length === 0 ? (
              <p className="sp-rail-empty">还没有标签。给当前结果的会话打一个，之后就是"虚拟文件夹"。</p>
            ) : (
              <ul className="sp-tag-list">
                {tagRows.map((row) => {
                  const on = activeTags.includes(row.name)
                  return (
                    <li key={row.name}>
                      <button
                        type="button"
                        className={`sp-tag-row${on ? ' is-on' : ''}`}
                        aria-pressed={on}
                        onClick={() => onToggleTag(row.name)}
                        title={on ? `取消按「${row.name}」筛选` : `按「${row.name}」筛选`}
                      >
                        <span className="sp-tag-dot" data-tone={tagTone(row.name)} aria-hidden />
                        <span className="sp-tag-name">{row.name}</span>
                        <span className="sp-tag-count">{row.count}</span>
                      </button>
                      <button
                        type="button"
                        className="sp-icon-btn"
                        aria-label={`删除标签「${row.name}」`}
                        title="删除这个标签"
                        onClick={() => annotations.removeTag(row.name)}
                      >
                        <X size={11} aria-hidden />
                      </button>
                    </li>
                  )
                })}
              </ul>
            )}

            <div className="sp-rail-add">
              <input
                className="sp-rail-input"
                type="text"
                value={newTag}
                onChange={(event) => setNewTag(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault()
                    submitNewTag()
                  }
                }}
                placeholder={resultSessionIds.length ? '新标签名，回车加到当前结果' : '先在左侧搜出结果，再加标签'}
                aria-label="新建标签"
                disabled={resultSessionIds.length === 0}
              />
              <button
                type="button"
                className="sp-icon-btn"
                aria-label="创建标签"
                title={resultSessionIds.length ? `给 ${resultSessionIds.length} 个会话打标签` : '先搜出结果'}
                disabled={!newTag.trim() || resultSessionIds.length === 0}
                onClick={submitNewTag}
              >
                <Plus size={12} aria-hidden />
              </button>
            </div>
          </div>
        )}
      </section>

      {/* ---------------- 收藏 ---------------- */}
      <section className="sp-rail-sec">
        <button
          type="button"
          className="sp-rail-head"
          aria-expanded={!collapsed.favorites}
          onClick={() => toggleSection('favorites')}
        >
          <Star size={13} aria-hidden />
          <span>收藏</span>
          <span className="sp-rail-count">{favorites.length}</span>
        </button>
        {!collapsed.favorites && (
          <div className="sp-rail-body">
            {favorites.length === 0 ? (
              <p className="sp-rail-empty">还没有收藏。结果行右侧的 ☆ 可以把一条消息收进来。</p>
            ) : (
              <ul className="sp-fav-list">
                {favorites.map((entry) => {
                  const key = entryKey(entry)
                  const editing = noteFor === key
                  return (
                    <li key={key} className="sp-fav">
                      <div className="sp-fav-main">
                        <button type="button" className="sp-fav-open" onClick={() => onOpenEntry(entry)} title="在结果里查看/打开">
                          <span className="sp-fav-title">{entry.messageId || entry.localId ? '消息' : '会话'}</span>
                          <span className="sp-fav-sub" title={entry.sessionId}>
                            {entry.sessionId}
                          </span>
                        </button>
                        <span className="sp-fav-time">{formatRelative(entry.at || entry.ts)}</span>
                        <button
                          type="button"
                          className="sp-icon-btn"
                          aria-label={editing ? '取消编辑备注' : '编辑备注'}
                          title="备注"
                          onClick={() => {
                            if (editing) {
                              setNoteFor(null)
                              return
                            }
                            setNoteFor(key)
                            setNoteDraft(entry.note || '')
                          }}
                        >
                          <Pencil size={11} aria-hidden />
                        </button>
                        <button
                          type="button"
                          className="sp-icon-btn"
                          aria-label="取消收藏"
                          title="取消收藏"
                          onClick={() => annotations.removeFavorite({
                            sessionId: entry.sessionId,
                            localId: String(entry.localId ?? ''),
                            messageId: entry.messageId,
                            idKind: entry.idKind,
                            ts: entry.ts,
                            db: entry.db,
                            table: entry.table,
                          })}
                        >
                          <Trash2 size={11} aria-hidden />
                        </button>
                      </div>
                      {entry.note && !editing && <p className="sp-fav-note">{entry.note}</p>}
                      {editing && (
                        <div className="sp-fav-note-edit">
                          <input
                            className="sp-rail-input"
                            type="text"
                            value={noteDraft}
                            autoFocus
                            onChange={(event) => setNoteDraft(event.target.value)}
                            onKeyDown={(event) => {
                              if (event.key === 'Enter') {
                                event.preventDefault()
                                onToggleFavoriteNote(entry, noteDraft)
                                setNoteFor(null)
                              }
                              if (event.key === 'Escape') setNoteFor(null)
                            }}
                            placeholder="写一句备注，回车保存"
                            aria-label="收藏备注"
                          />
                          <button
                            type="button"
                            className="sp-icon-btn"
                            aria-label="保存备注"
                            onClick={() => {
                              onToggleFavoriteNote(entry, noteDraft)
                              setNoteFor(null)
                            }}
                          >
                            <Plus size={12} aria-hidden />
                          </button>
                        </div>
                      )}
                    </li>
                  )
                })}
              </ul>
            )}
          </div>
        )}
      </section>

      {/* ---------------- 保存搜索 ---------------- */}
      <section className="sp-rail-sec">
        <button
          type="button"
          className="sp-rail-head"
          aria-expanded={!collapsed.searches}
          onClick={() => toggleSection('searches')}
        >
          <FolderOpen size={13} aria-hidden />
          <span>保存搜索</span>
          <span className="sp-rail-count">{searches.length}</span>
        </button>
        {!collapsed.searches && (
          <div className="sp-rail-body">
            {searches.length === 0 ? (
              <p className="sp-rail-empty">还没有保存的搜索。把当前条件存下来，下次一键复现。</p>
            ) : (
              <ul className="sp-search-list">
                {searches.map((item) => (
                  <li key={item.id} className="sp-saved">
                    {renamingId === item.id ? (
                      <input
                        className="sp-rail-input"
                        type="text"
                        value={renameDraft}
                        autoFocus
                        onChange={(event) => setRenameDraft(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') {
                            event.preventDefault()
                            onRenameSearch(item.id, renameDraft)
                            setRenamingId(null)
                          }
                          if (event.key === 'Escape') setRenamingId(null)
                        }}
                        aria-label="重命名保存的搜索"
                      />
                    ) : (
                      <button type="button" className="sp-saved-run" onClick={() => onRunSearch(item)} title={item.query || '（无关键词）'}>
                        <span className="sp-saved-name">{item.name}</span>
                        <span className="sp-saved-sub">
                          {item.query || '（仅筛选条件）'}
                          {typeof item.lastCount === 'number' ? ` · ${item.lastCount} 条` : ''}
                        </span>
                      </button>
                    )}
                    <button
                      type="button"
                      className="sp-icon-btn"
                      aria-label={`运行「${item.name}」`}
                      title="运行"
                      onClick={() => onRunSearch(item)}
                    >
                      <Play size={11} aria-hidden />
                    </button>
                    <button
                      type="button"
                      className="sp-icon-btn"
                      aria-label={`重命名「${item.name}」`}
                      title="重命名"
                      onClick={() => {
                        setRenamingId(item.id)
                        setRenameDraft(item.name)
                      }}
                    >
                      <Pencil size={11} aria-hidden />
                    </button>
                    <button
                      type="button"
                      className="sp-icon-btn"
                      aria-label={`删除「${item.name}」`}
                      title="删除"
                      onClick={() => onRemoveSearch(item.id)}
                    >
                      <Trash2 size={11} aria-hidden />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </section>

      {/* ---------------- 导出 ---------------- */}
      <section className="sp-rail-sec">
        <div className="sp-rail-head is-static">
          <Download size={13} aria-hidden />
          <span>导出注解</span>
        </div>
        <div className="sp-rail-body">
          <div className="sp-export-row">
            {EXPORT_FORMATS.map((format) => (
              <button
                key={format.value}
                type="button"
                className="ghost-btn sp-export-btn"
                title={format.hint}
                disabled={exportState.busy || !store}
                onClick={() => exportState.exportAs(format.value)}
              >
                {format.label}
              </button>
            ))}
          </div>
          {exportState.busy && <p className="sp-rail-empty">正在导出…</p>}
          {exportState.lastPath && !exportState.busy && (
            <p className="sp-rail-ok" role="status">
              已导出到 <span className="sp-mono">{exportState.lastPath}</span>
            </p>
          )}
          {exportState.error && (
            <p className="sp-rail-error" role="alert">
              导出失败：{exportState.error}
            </p>
          )}
        </div>
      </section>
    </aside>
  )
}
