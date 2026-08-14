import { useCallback, useEffect, useMemo, useState } from 'react'
import ReactECharts from 'echarts-for-react'
import {
  BarChart3,
  CalendarDays,
  CircleDashed,
  Crown,
  Download,
  FileText,
  Image,
  Inbox,
  Loader2,
  MessageSquare,
  Mic,
  PieChart,
  Search,
  Send,
  Smile,
  Users,
  Video,
  X,
} from 'lucide-react'
import { createPortal } from 'react-dom'
import { Avatar } from '../../components/Avatar'
import { EmptyState } from '../../components/EmptyState'
import { useColorMode } from '../../utils/colorMode'
import { useEscape } from '../../utils/useEscape'
import { animationCommon, axisCommon, baseChartTheme, blueRamp, blueVerticalGradient, mediaTypeColor, tooltipCommon } from '../../utils/echartsTheme'

const MEDIA_TYPE_ICONS: Record<number, React.ComponentType<{ size?: number | string }>> = {
  1: MessageSquare,
  3: Image,
  34: Mic,
  43: Video,
  47: Smile,
  49: FileText,
  [-1]: CircleDashed,
}

interface GroupChatInfo {
  username: string
  displayName: string
  memberCount: number
  messageCount: number
  avatarUrl?: string
}

type GroupSortKey = 'messages' | 'members'

interface GroupMembersPanelEntry {
  username: string
  displayName: string
  avatarUrl?: string
  nickname?: string
  alias?: string
  remark?: string
  groupNickname?: string
  isOwner?: boolean
  isFriend: boolean
  messageCount: number
}

interface GroupMessageRank {
  member: { username: string; displayName: string; avatarUrl?: string }
  messageCount: number
}

interface GroupActiveHours {
  hourlyDistribution: Record<number, number>
}

interface GroupMediaStats {
  typeCounts: Array<{ type: number; name: string; count: number }>
  total: number
}

interface GroupMemberAnalytics {
  statistics: {
    totalMessages: number
    sentMessages: number
    receivedMessages: number
    activeDays: number
    textMessages: number
    imageMessages: number
    voiceMessages: number
    videoMessages: number
  }
  timeDistribution: Record<number, number>
  commonPhrases?: Array<{ phrase: string; count: number }>
  commonEmojis?: Array<{ emoji: string; count: number }>
}

interface MemberMessage {
  localId: number
  createTime: number
  parsedContent: string
  localType: number
}

type GroupTab = 'members' | 'ranking' | 'hours' | 'media'

const formatNum = (n: number) => (n >= 10000 ? `${(n / 10000).toFixed(1)} 万` : String(n))

const MemberAnalyticsDialog: React.FC<{
  chatroomId: string
  member: GroupMembersPanelEntry
  onClose: () => void
}> = ({ chatroomId, member, onClose }) => {
  const colorMode = useColorMode()
  const [data, setData] = useState<GroupMemberAnalytics | null>(null)
  const [messages, setMessages] = useState<MemberMessage[]>([])
  const [hasMore, setHasMore] = useState(false)
  const [cursor, setCursor] = useState<number | undefined>(undefined)
  const [loading, setLoading] = useState(true)
  const [messagesLoading, setMessagesLoading] = useState(false)

  const loadAnalytics = useCallback(async () => {
    setLoading(true)
    try {
      const r = await window.electronAPI.groupAnalytics.getGroupMemberAnalytics(chatroomId, member.username, 0, 0)
      if (r.success && r.data) setData(r.data)
    } finally {
      setLoading(false)
    }
  }, [chatroomId, member.username])

  const loadMessages = useCallback(
    async (nextCursor?: number) => {
      setMessagesLoading(true)
      try {
        const r = await window.electronAPI.groupAnalytics.getGroupMemberMessages(chatroomId, member.username, {
          limit: 30,
          cursor: nextCursor,
        })
        if (r.success && r.data) {
          setMessages((prev) => (nextCursor ? [...prev, ...r.data!.messages] : r.data!.messages))
          setHasMore(r.data.hasMore)
          setCursor(r.data.nextCursor)
        }
      } finally {
        setMessagesLoading(false)
      }
    },
    [chatroomId, member.username],
  )

  useEffect(() => {
    void loadAnalytics()
    void loadMessages(undefined)
  }, [loadAnalytics, loadMessages])

  useEscape(onClose)

  const hourlyOption = useMemo(() => {
    const hours = Array.from({ length: 24 }, (_, h) => data?.timeDistribution[h] || 0)
    return {
      ...baseChartTheme(colorMode),
      tooltip: { ...tooltipCommon, trigger: 'axis' as const },
      grid: { left: 36, right: 12, top: 20, bottom: 24 },
      xAxis: { type: 'category' as const, data: hours.map((_, i) => `${i}时`), ...axisCommon },
      yAxis: { type: 'value' as const, ...axisCommon },
      series: [{ type: 'bar' as const, data: hours, itemStyle: { color: (params: any) => blueRamp((params.value || 0) / Math.max(1, ...hours), colorMode), borderRadius: [3, 3, 0, 0] }, barMaxWidth: 12 }],
    }
  }, [data, colorMode])

  const exportMember = async () => {
    const dir = await window.electronAPI.dialog.openDirectory({ title: '选择导出目录' })
    if (!dir) return
    const file = await window.electronAPI.groupAnalytics.exportGroupMemberMessages(chatroomId, member.username, dir, 0, 0)
    if (file.success) {
      await window.electronAPI.shell.openPath(file.filePath || dir)
    }
  }

  return createPortal(
    <div className="wp-overlay" onClick={onClose}>
      <div className="wp-dialog member-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="wp-dialog-head">
          <Avatar src={member.avatarUrl} name={member.displayName} size={30} shape="rounded" />
          <h3>{member.displayName}</h3>
          {member.isOwner && (
            <span className="member-badge owner">
              <Crown size={11} />
              群主
            </span>
          )}
          {!member.isFriend && <span className="member-badge">非好友</span>}
          <span className="v09-sub">{member.messageCount} 条消息</span>
          <button className="icon-btn-ghost" onClick={onClose}>
            <X size={16} />
          </button>
        </div>

        {loading && <div className="wp-loading">统计中…</div>}
        {!loading && data && (
          <div className="member-analytics-body">
            <div className="stat-cards stat-cards-compact">
              <div className="stat-card">
                <span className="stat-label">
                  <MessageSquare size={11} /> 总消息
                </span>
                <b>{formatNum(data.statistics.totalMessages)}</b>
              </div>
              <div className="stat-card">
                <span className="stat-label">
                  <Send size={11} /> 发送
                </span>
                <b>{formatNum(data.statistics.sentMessages)}</b>
              </div>
              <div className="stat-card">
                <span className="stat-label">
                  <Inbox size={11} /> 接收
                </span>
                <b>{formatNum(data.statistics.receivedMessages)}</b>
              </div>
              <div className="stat-card">
                <span className="stat-label">
                  <CalendarDays size={11} /> 活跃天数
                </span>
                <b>{data.statistics.activeDays}</b>
              </div>
            </div>

            <div className="chart-grid-2">
              <div className="v09-panel">
                <div className="v09-panel-head">
                  <h3>24 小时活跃</h3>
                </div>
                <ReactECharts option={hourlyOption} style={{ height: 180 }} notMerge />
              </div>
              <div className="v09-panel">
                <div className="v09-panel-head">
                  <h3>高频短语</h3>
                </div>
                <div className="phrase-list">
                  {(data.commonPhrases || []).slice(0, 12).map((p, i) => (
                    <div key={i} className="phrase-row">
                      <span className="phrase-text">{p.phrase}</span>
                      <span className="phrase-count">{p.count}</span>
                    </div>
                  ))}
                  {!data.commonPhrases?.length && <div className="wp-empty">暂无数据</div>}
                </div>
              </div>
            </div>

            <div className="v09-panel">
              <div className="v09-panel-head">
                <h3>常用表情</h3>
              </div>
              <div className="emoji-tags">
                {(data.commonEmojis || []).slice(0, 20).map((e, i) => (
                  <span key={i} className="emoji-tag">
                    <Smile size={12} />
                    {e.emoji} ×{e.count}
                  </span>
                ))}
                {!data.commonEmojis?.length && <div className="wp-empty">暂无数据</div>}
              </div>
            </div>

            <div className="v09-panel">
              <div className="v09-panel-head">
                <h3>消息记录</h3>
                <button type="button" className="ghost-btn" onClick={() => void exportMember()}>
                  <Download size={13} />
                  导出 CSV
                </button>
              </div>
              <div className="member-messages">
                {messages.map((m) => (
                  <div key={m.localId} className="member-msg-row">
                    <span className="member-msg-time">
                      {new Date(m.createTime * 1000).toLocaleString('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                    </span>
                    <span className="member-msg-content">{m.parsedContent || `[类型 ${m.localType}]`}</span>
                  </div>
                ))}
                {hasMore && (
                  <button className="ghost-btn load-more-btn" disabled={messagesLoading} onClick={() => void loadMessages(cursor)}>
                    {messagesLoading ? '加载中…' : '加载更多'}
                  </button>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>,
    document.body,
  )
}

export const GroupAnalytics: React.FC = () => {
  const colorMode = useColorMode()
  const [groups, setGroups] = useState<GroupChatInfo[]>([])
  const [search, setSearch] = useState('')
  const [groupSort, setGroupSort] = useState<GroupSortKey>('messages')
  const [selected, setSelected] = useState<GroupChatInfo | null>(null)
  const [tab, setTab] = useState<GroupTab>('members')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [members, setMembers] = useState<GroupMembersPanelEntry[]>([])
  const [membersLoading, setMembersLoading] = useState(false)
  const [ranking, setRanking] = useState<GroupMessageRank[]>([])
  const [hours, setHours] = useState<GroupActiveHours | null>(null)
  const [media, setMedia] = useState<GroupMediaStats | null>(null)
  const [memberDialog, setMemberDialog] = useState<GroupMembersPanelEntry | null>(null)

  const loadGroups = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const r = await window.electronAPI.groupAnalytics.getGroupChats()
      if (r.success) {
        setGroups(r.data || [])
      } else {
        setError(r.error || '加载群聊列表失败')
      }
    } catch (e) {
      setError(String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadGroups()
  }, [loadGroups])

  const loadGroupData = useCallback(
    async (group: GroupChatInfo) => {
      setSelected(group)
      setTab('members')
      setMembersLoading(true)
      setMembers([])
      setRanking([])
      setHours(null)
      setMedia(null)
      try {
        const [membersRes, rankRes, hoursRes, mediaRes] = await Promise.all([
          window.electronAPI.groupAnalytics.getGroupMembersPanelData(group.username, { includeMessageCounts: true }),
          window.electronAPI.groupAnalytics.getGroupMessageRanking(group.username, 20, 0, 0),
          window.electronAPI.groupAnalytics.getGroupActiveHours(group.username, 0, 0),
          window.electronAPI.groupAnalytics.getGroupMediaStats(group.username, 0, 0),
        ])
        if (membersRes.success) setMembers(membersRes.data || [])
        if (rankRes.success) setRanking(rankRes.data || [])
        if (hoursRes.success) setHours(hoursRes.data || null)
        if (mediaRes.success) setMedia(mediaRes.data || null)
      } finally {
        setMembersLoading(false)
      }
    },
    [],
  )

  const filteredGroups = useMemo(() => {
    const filtered = groups.filter((g) => !search || g.displayName.toLowerCase().includes(search.toLowerCase()))
    return filtered.sort((a, b) =>
      groupSort === 'members' ? b.memberCount - a.memberCount : b.messageCount - a.messageCount
    )
  }, [groups, search, groupSort])

  const rankingOption = useMemo(() => {
    const top = ranking.slice(0, 20)
    return {
      ...baseChartTheme(colorMode),
      tooltip: { ...tooltipCommon, trigger: 'axis' as const },
      grid: { left: 90, right: 30, top: 16, bottom: 20 },
      xAxis: { type: 'value' as const, ...axisCommon, splitLine: { lineStyle: { color: '#1c1c21', type: 'dashed' as const } } },
      yAxis: { type: 'category' as const, data: [...top].reverse().map((r) => r.member.displayName), ...axisCommon, axisLabel: { color: '#b0b0b8', fontSize: 11 } },
      series: [
        {
          type: 'bar' as const,
          data: [...top].reverse().map((r) => r.messageCount),
          itemStyle: {
            color: (params: any) => blueRamp(1 - (params.value || 0) / Math.max(1, ...top.map((r) => r.messageCount)), colorMode),
            borderRadius: [0, 3, 3, 0],
          },
          barMaxWidth: 16,
        },
      ],
    }
  }, [ranking, colorMode])

  const hoursOption = useMemo(() => {
    const data = Array.from({ length: 24 }, (_, h) => hours?.hourlyDistribution[h] || 0)
    return {
      ...baseChartTheme(colorMode),
      tooltip: { ...tooltipCommon, trigger: 'axis' as const },
      grid: { left: 36, right: 12, top: 20, bottom: 24 },
      xAxis: { type: 'category' as const, data: data.map((_, i) => `${i}时`), ...axisCommon },
      yAxis: { type: 'value' as const, ...axisCommon },
      series: [{ type: 'bar' as const, data, itemStyle: { color: (params: any) => blueRamp((params.value || 0) / Math.max(1, ...data), colorMode), borderRadius: [3, 3, 0, 0] }, barMaxWidth: 22, barCategoryGap: '8%' }],
    }
  }, [hours, colorMode])

  const mediaOption = useMemo(() => {
    const types = media?.typeCounts || []
    return {
      ...baseChartTheme(colorMode),
      tooltip: { ...tooltipCommon, trigger: 'item' as const },
      legend: { bottom: 0, textStyle: { color: '#b0b0b8', fontSize: 11 }, itemWidth: 10, itemHeight: 10 },
      series: [
        {
          type: 'pie' as const,
          radius: ['42%', '68%'],
          center: ['50%', '44%'],
          itemStyle: { borderRadius: 4, borderColor: '#000', borderWidth: 2 },
          label: { color: '#b0b0b8', fontSize: 11 },
          data: types.map((t) => ({ name: t.name, value: t.count, itemStyle: { color: mediaTypeColor(t.type, colorMode) } })),
        },
      ],
    }
  }, [media, colorMode])

  const maxMemberCount = Math.max(1, ...members.map((m) => m.messageCount))

  return (
    <div className="group-analytics">
      {error && <div className="wp-error">{error}</div>}
      <div className="group-layout">
        <aside className="group-list-panel">
          <div className="sns-sidebar-search">
            <Search size={14} />
            <input value={search} placeholder="搜索群聊…" onChange={(e) => setSearch(e.target.value)} />
          </div>
          <div className="group-sort-row">
            <span className="group-sort-label">排序</span>
            <div className="seg" role="radiogroup" aria-label="群聊排序">
              <button type="button" data-active={groupSort === 'messages'} onClick={() => setGroupSort('messages')}>
                消息数
              </button>
              <button type="button" data-active={groupSort === 'members'} onClick={() => setGroupSort('members')}>
                人数
              </button>
            </div>
          </div>
          <div className="group-list">
            {!loading && filteredGroups.length === 0 && (
              <EmptyState icon={Search} title="没有群聊" hint={search ? '换个关键词试试' : '请先连接微信账号'} />
            )}
            {filteredGroups.map((g) => (
              <button
                key={g.username}
                type="button"
                className={`group-item ${selected?.username === g.username ? 'group-item-active' : ''}`}
                onClick={() => void loadGroupData(g)}
              >
                <Avatar src={g.avatarUrl} name={g.displayName} size={32} shape="rounded" />
                <div className="group-item-info">
                  <span className="group-item-name">{g.displayName}</span>
                  <span className="group-item-sub">
                    <MessageSquare size={11} />
                    {formatNum(g.messageCount)} 条
                    <i className="group-item-dot" />
                    <Users size={11} />
                    {g.memberCount} 人
                  </span>
                </div>
              </button>
            ))}
          </div>
        </aside>

        <div className="group-detail">
          <div className="v09-toolbar-sub group-toolbar-sub">
            <span className="v09-sub">选择群聊查看成员构成、活跃排行与媒体统计</span>
            {loading && <Loader2 className="spin" size={14} />}
          </div>

          {!selected && (
            <EmptyState icon={MessageSquare} title="选择一个群聊开始分析" hint="左侧列表来自你本地的群聊会话" />
          )}

          {selected && (
            <>
              <div className="v09-panel group-detail-head">
                <Avatar src={selected.avatarUrl} name={selected.displayName} size={40} shape="rounded" />
                <div className="group-detail-title">
                  <h3>{selected.displayName}</h3>
                  <span className="v09-sub">
                    {selected.memberCount} 名成员 · {members.length > 0 ? `${members.filter((m) => m.isFriend).length} 位好友` : ''}
                  </span>
                </div>
                <div className="group-tabs">
                  {(
                    [
                      { id: 'members', label: '成员', icon: Users },
                      { id: 'ranking', label: '消息排行', icon: BarChart3 },
                      { id: 'hours', label: '活跃时段', icon: MessageSquare },
                      { id: 'media', label: '媒体构成', icon: PieChart },
                    ] as Array<{ id: GroupTab; label: string; icon: React.ComponentType<{ size?: number | string }> }>
                  ).map((t) => {
                    const Icon = t.icon
                    return (
                      <button key={t.id} type="button" className={`chip ${tab === t.id ? 'chip-active' : ''}`} onClick={() => setTab(t.id)}>
                        <Icon size={13} />
                        {t.label}
                      </button>
                    )
                  })}
                </div>
              </div>

              {tab === 'members' && (
                <div className="v09-panel">
                  <div className="v09-panel-head">
                    <h3>成员列表</h3>
                    <span className="v09-sub">点击成员查看画像与消息记录</span>
                  </div>
                  {membersLoading && <div className="wp-loading">加载成员…</div>}
                  {!membersLoading && (
                    <div className="group-member-list">
                      {members.map((m) => (
                        <button key={m.username} type="button" className="group-member-row" onClick={() => setMemberDialog(m)}>
                          <Avatar src={m.avatarUrl} name={m.displayName} size={28} shape="rounded" />
                          <span className="group-member-name">{m.displayName}</span>
                          {m.isOwner && (
                            <span className="member-badge owner">
                              <Crown size={10} />
                              群主
                            </span>
                          )}
                          {!m.isFriend && <span className="member-badge">非好友</span>}
                          <div className="ranking-bar member-bar">
                            <div className="progress-fill" style={{ width: `${(m.messageCount / maxMemberCount) * 100}%` }} />
                          </div>
                          <b className="group-member-count">{formatNum(m.messageCount)}</b>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {tab === 'ranking' && (
                <div className="v09-panel">
                  <div className="v09-panel-head">
                    <h3>消息排行 Top 20</h3>
                    <span className="v09-sub">按群内消息总量排序</span>
                  </div>
                  <ReactECharts option={rankingOption} style={{ height: Math.max(320, ranking.length * 22) }} notMerge />
                </div>
              )}

              {tab === 'hours' && (
                <div className="v09-panel">
                  <div className="v09-panel-head">
                    <h3>24 小时活跃度</h3>
                    <span className="v09-sub">该群消息的时间分布</span>
                  </div>
                  <ReactECharts option={hoursOption} style={{ height: 280 }} notMerge />
                </div>
              )}

              {tab === 'media' && (
                <div className="v09-panel">
                  <div className="v09-panel-head">
                    <h3>媒体构成</h3>
                    <span className="v09-sub">共 {formatNum(media?.total || 0)} 条消息</span>
                  </div>
                  {media && media.total > 0 ? (
                    <div className="chart-grid-2">
                      <ReactECharts option={mediaOption} style={{ height: 300 }} notMerge />
                      <div className="media-type-list">
                        {media.typeCounts.map((t) => {
                          const TypeIcon = MEDIA_TYPE_ICONS[t.type] || Inbox
                          return (
                            <div key={t.type} className="media-type-row">
                              <span className="media-type-icon" style={{ color: mediaTypeColor(t.type, colorMode) }}>
                                <TypeIcon size={13} />
                              </span>
                              <span>{t.name}</span>
                              <b>{formatNum(t.count)}</b>
                              <span className="v09-sub">{media.total > 0 ? Math.round((t.count / media.total) * 100) : 0}%</span>
                            </div>
                          )
                        })}
                      </div>
                    </div>
                  ) : (
                    <div className="wp-empty">暂无媒体数据</div>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {memberDialog && <MemberAnalyticsDialog chatroomId={selected!.username} member={memberDialog} onClose={() => setMemberDialog(null)} />}
    </div>
  )
}


