import { useEffect, useMemo, useState } from 'react'
import { Loader2, MessageSquare, RefreshCw, Search, Users2 } from 'lucide-react'
import type { PosterSession, PosterSourceKind } from './posterTypes.ts'
import type { PosterChannelStatus } from './posterSource.ts'

/**
 * 内容来源选择（v1.2 §4）。
 *
 * 三个来源：**会话**（+ 时间范围 / 条数 / 只看我的 / 只看文本）、**朋友圈**、
 * **手写引用**。通道缺失时把缺的名字列出来（`chat:getSessions` 之类），而不是显示
 * 一个空列表 —— 空列表会被理解成"我最近没聊过天"。
 */
export interface PosterSessionFilters {
    /** 'YYYY-MM-DD' 或空 */
    startDate: string
    endDate: string
    limit: number
    onlyMine: boolean
    onlyText: boolean
}

export interface PosterSourcePanelProps {
    source: PosterSourceKind
    onSourceChange: (source: PosterSourceKind) => void
    searchValue?: string
    onSearchChange?: (value: string) => void
    sessions: PosterSession[]
    sessionsLoading: boolean
    sessionsError?: string | null
    channel: PosterChannelStatus
    activeSessionId: string | null
    onSelectSession: (session: PosterSession) => void
    onReloadSessions: () => void
    filters: PosterSessionFilters
    onFilterChange: (patch: Partial<PosterSessionFilters>) => void
    onLoadSession: () => void
    loadingItems: boolean
    /** 朋友圈 */
    snsUsername: string
    onSnsUsernameChange: (value: string) => void
    snsKeyword: string
    onSnsKeywordChange: (value: string) => void
    onLoadSns: () => void
    /** 手写引用 */
    manualText: string
    onManualTextChange: (value: string) => void
    manualSender: string
    onManualSenderChange: (value: string) => void
    onAddManualQuote: () => void
    itemCount: number
}

/** 会话列表渐进渲染的每页条数（见组件里 limit 的说明）。 */
const SESSION_PAGE_SIZE = 40

export function PosterSourcePanel(props: PosterSourcePanelProps) {
    const [localSearch, setLocalSearch] = useState('')
    const search = props.searchValue ?? localSearch
    const setSearch = props.onSearchChange ?? setLocalSearch
    const keyword = search.trim().toLowerCase()
    const visible = useMemo(() => {
        if (!keyword) return props.sessions
        return props.sessions.filter(
            (session) => session.name.toLowerCase().includes(keyword) || session.id.toLowerCase().includes(keyword)
        )
    }, [props.sessions, keyword])

    /**
     * 渐进渲染：先给 40 个，其余按需再加。
     *
     * 这一页以前在打开时把**全部**会话一次性挂上（本机 265 个 = 265 个按钮），实测首次切换那一帧
     * 91 ms（trace：Layout 25 ms + Commit 21 ms + 一段 React 任务）—— 所有页面里最慢的一次首挂载。
     * 会话本来就可搜索，"先看前 40 个 + 能继续展开"相比"一次挂 265 个"没有实际损失。
     * 搜索词或会话数变化时回到 40。
     */
    const [limit, setLimit] = useState(SESSION_PAGE_SIZE)
    useEffect(() => {
        setLimit(SESSION_PAGE_SIZE)
    }, [keyword, props.sessions.length])
    const shown = visible.slice(0, limit)
    const hidden = visible.length - shown.length

    const active = props.sessions.find((session) => session.id === props.activeSessionId) ?? null

    return (
        <aside className="poster-src v09-panel" aria-label="内容来源">
            <div className="v09-panel-head">
                <h3>内容</h3>
                <span className="v09-sub">{props.itemCount} 条</span>
            </div>

            <div className="poster-src-tabs" role="tablist" aria-label="来源">
                {(
                    [
                        { id: 'session', label: '聊天会话', icon: MessageSquare },
                        { id: 'sns', label: '朋友圈', icon: Users2 },
                        { id: 'manual', label: '手写引用', icon: MessageSquare },
                    ] as const
                ).map((tab) => (
                    <button
                        key={tab.id}
                        type="button"
                        role="tab"
                        aria-selected={props.source === tab.id}
                        className="chip"
                        data-active={props.source === tab.id}
                        data-source={tab.id}
                        onClick={() => props.onSourceChange(tab.id)}
                    >
                        <tab.icon size={12} />
                        {tab.label}
                    </button>
                ))}
            </div>

            {props.channel.missing.length > 0 ? (
                <div className="poster-warn">
                    当前来源暂不可用，请先连接微信。仍可使用手写引用。
                </div>
            ) : null}

            {props.source === 'session' ? (
                <>
                    <div className="poster-filter-row">
                        <Search size={12} />
                        <input
                            className="pp-input"
                            type="text"
                            value={search}
                            placeholder="筛选会话"
                            aria-label="筛选会话"
                            onChange={(event) => setSearch(event.target.value)}
                        />
                        <button type="button" className="poster-mini-btn" onClick={props.onReloadSessions} disabled={props.sessionsLoading} aria-label="重新读取会话">
                            {props.sessionsLoading ? <Loader2 size={11} className="spin" /> : <RefreshCw size={11} />}
                        </button>
                    </div>

                    {props.sessionsError ? <div className="poster-error">{props.sessionsError}</div> : null}

                    <div className="poster-session-list" role="listbox" aria-label="会话列表">
                        {shown.map((session) => (
                            <button
                                key={session.id}
                                type="button"
                                role="option"
                                aria-selected={session.id === props.activeSessionId}
                                className="poster-session-row"
                                data-active={session.id === props.activeSessionId}
                                onClick={() => props.onSelectSession(session)}
                            >
                                <span className="poster-session-name">{session.name}</span>
                                <span className="poster-session-meta">
                                    {session.kind === 'group' ? '群' : session.kind === 'official' ? '公众号' : '私聊'}
                                    {session.messageCount ? ` · ${session.messageCount}` : ''}
                                </span>
                            </button>
                        ))}
                        {visible.length === 0 && !props.sessionsLoading ? (
                            <span className="poster-redaction-note">
                                {props.sessions.length === 0 ? '没有读到会话（通道缺失或微信未连接）。' : '筛选没有命中。'}
                            </span>
                        ) : null}
                        {hidden > 0 ? (
                            <button
                                type="button"
                                className="ghost-btn poster-more-sessions"
                                onClick={() => setLimit((current) => current + SESSION_PAGE_SIZE)}
                            >
                                再显示 {Math.min(hidden, SESSION_PAGE_SIZE)} 个（还有 {hidden} 个）· 也可以直接搜索
                            </button>
                        ) : null}
                    </div>

                    <details className="poster-advanced-filters">
                    <summary>
                        筛选 · 最多 {props.filters.limit} 条
                        {props.filters.startDate || props.filters.endDate ? ' · 日期' : ''}
                        {props.filters.onlyMine ? ' · 我发的' : ''}
                        {props.filters.onlyText ? ' · 文本' : ''}
                    </summary>
                    <div className="poster-filters">
                        <label className="poster-filter-row">
                            起
                            <input
                                className="pp-input"
                                type="date"
                                value={props.filters.startDate}
                                aria-label="起始日期"
                                onChange={(event) => props.onFilterChange({ startDate: event.target.value })}
                            />
                        </label>
                        <label className="poster-filter-row">
                            止
                            <input
                                className="pp-input"
                                type="date"
                                value={props.filters.endDate}
                                aria-label="结束日期"
                                onChange={(event) => props.onFilterChange({ endDate: event.target.value })}
                            />
                        </label>
                    </div>
                    <div className="poster-filters">
                        <label className="poster-filter-row">
                            条数上限
                            <input
                                className="pp-input"
                                type="number"
                                min={1}
                                max={300}
                                value={props.filters.limit}
                                aria-label="条数上限"
                                style={{ width: 72 }}
                                onChange={(event) => props.onFilterChange({ limit: Math.max(1, Math.min(300, Number(event.target.value) || 60)) })}
                            />
                        </label>
                        <label className="poster-filter-row">
                            <input
                                type="checkbox"
                                checked={props.filters.onlyMine}
                                onChange={(event) => props.onFilterChange({ onlyMine: event.target.checked })}
                            />
                            只看我发的
                        </label>
                        <label className="poster-filter-row">
                            <input
                                type="checkbox"
                                checked={props.filters.onlyText}
                                onChange={(event) => props.onFilterChange({ onlyText: event.target.checked })}
                            />
                            只看文本
                        </label>
                    </div>
                    </details>

                    <button type="button" className="ghost-btn" disabled={!active || props.loadingItems} onClick={props.onLoadSession} title={active ? `载入「${active.name}」的消息` : undefined}>
                        {props.loadingItems ? <Loader2 size={13} className="spin" /> : <MessageSquare size={13} />}
                        <span className="poster-load-label">{active ? `载入「${active.name}」的消息` : '先选一个会话'}</span>
                    </button>
                </>
            ) : null}

            {props.source === 'sns' ? (
                <>
                    <div className="poster-filter-row">
                        <input
                            className="pp-input"
                            type="text"
                            value={props.snsUsername}
                            placeholder="wxid（留空=时间线全部）"
                            aria-label="朋友圈作者 wxid"
                            onChange={(event) => props.onSnsUsernameChange(event.target.value)}
                        />
                    </div>
                    <div className="poster-filter-row">
                        <input
                            className="pp-input"
                            type="text"
                            value={props.snsKeyword}
                            placeholder="关键词（可选）"
                            aria-label="朋友圈关键词"
                            onChange={(event) => props.onSnsKeywordChange(event.target.value)}
                        />
                    </div>
                    <button type="button" className="ghost-btn" disabled={props.loadingItems} onClick={props.onLoadSns}>
                        {props.loadingItems ? <Loader2 size={13} className="spin" /> : <Users2 size={13} />}
                        载入朋友圈动态
                    </button>
                    <span className="poster-redaction-note">
                        朋友圈图片会经 `sns:proxyImage` 落成 data URL 再画进海报（跨源图片画进 canvas 会让导出失败）。
                    </span>
                </>
            ) : null}

            {props.source === 'manual' ? (
                <>
                    <textarea
                        className="pp-input"
                        rows={6}
                        value={props.manualText}
                        placeholder="粘贴一段话，做成引用卡"
                        aria-label="引用文本"
                        onChange={(event) => props.onManualTextChange(event.target.value)}
                    />
                    <div className="poster-filter-row">
                        <input
                            className="pp-input"
                            type="text"
                            value={props.manualSender}
                            placeholder="署名（默认「我」）"
                            aria-label="引用署名"
                            onChange={(event) => props.onManualSenderChange(event.target.value)}
                        />
                    </div>
                    <button type="button" className="ghost-btn" disabled={props.manualText.trim().length === 0} onClick={props.onAddManualQuote}>
                        加入海报
                    </button>
                    <span className="poster-redaction-note">手写引用同样走自动打码：号码与昵称在预览里就会被遮住。</span>
                </>
            ) : null}
        </aside>
    )
}
