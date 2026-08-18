import { useCallback, useEffect, useMemo, useState } from 'react'
import ReactECharts from 'echarts-for-react'
import { Loader2, Medal, RefreshCw, Search, UserMinus, X, MessageSquareText, Image as ImageIcon, Mic, Clapperboard, Smile, MoreHorizontal, MessageSquare, Send, Inbox, CalendarDays, CloudFog } from 'lucide-react'
import { Avatar } from '../../components/Avatar'
import { CountUp } from '../../components/CountUp'
import { AnalyticsWordCloud } from '../../components/analytics/AnalyticsWordCloud'
import { useColorMode } from '../../utils/colorMode'
import { blueRamp, blueVerticalGradient, BLUE_STACK, MONO_STACK, CHART_TEXT, CHART_TEXT_DIM, CHART_GRID } from '../../utils/echartsTheme'
import { animationCommon, axisCommon, baseChartTheme, tooltipCommon } from '../../utils/echartsTheme'
import { useMeasuredBarWidth } from './chartSizing'

interface ChatStatistics {
  totalMessages: number
  textMessages: number
  imageMessages: number
  voiceMessages: number
  videoMessages: number
  emojiMessages: number
  otherMessages: number
  sentMessages: number
  receivedMessages: number
  firstMessageTime: number | null
  lastMessageTime: number | null
  activeDays: number
  messageTypeCounts: Record<number, number>
}

interface TimeDistribution {
  hourlyDistribution: Record<number, number>
  weekdayDistribution: Record<number, number>
  monthlyDistribution: Record<string, number>
}

interface SelfSentDaily {
  unit: 'day'
  dailyDistribution: Record<string, number>
  totalMessages: number
  firstMessageTime: number | null
  lastMessageTime: number | null
  beginTimestamp: number
  endTimestamp: number
}

interface ContactRanking {
  username: string
  displayName: string
  avatarUrl?: string
  wechatId?: string
  messageCount: number
  sentCount: number
  receivedCount: number
  lastMessageTime: number | null
}

interface DailyActivity {
  daily: Record<string, number>
  sentDaily: Record<string, number>
}

interface WordFreqItem {
  word: string
  count: number
}

const WEEKDAY_LABELS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
const MEDIA_LABELS: Array<{ key: keyof ChatStatistics; label: string; icon: React.ComponentType<{ size?: number | string }>; color: string }> = [
  { key: 'textMessages', label: '文字', icon: MessageSquareText, color: 'var(--accent)' },
  { key: 'imageMessages', label: '图片', icon: ImageIcon, color: 'var(--accent-2)' },
  { key: 'voiceMessages', label: '语音', icon: Mic, color: 'var(--accent-3)' },
  { key: 'videoMessages', label: '视频', icon: Clapperboard, color: 'var(--accent-4)' },
  { key: 'emojiMessages', label: '表情', icon: Smile, color: 'var(--accent-5)' },
  { key: 'otherMessages', label: '其他', icon: MoreHorizontal, color: 'var(--accent-6)' },
]

const formatDate = (ts: number | null) => {
  if (!ts) return '–'
  return new Date(ts * 1000).toLocaleDateString('zh-CN', { year: 'numeric', month: 'short', day: 'numeric' })
}

const formatNumber = (n: number) => (n >= 10000 ? `${(n / 10000).toFixed(1)} 万` : String(n))

export const GlobalAnalytics: React.FC = () => {
  const colorMode = useColorMode()
  const [stats, setStats] = useState<ChatStatistics | null>(null)
  const [timeDist, setTimeDist] = useState<TimeDistribution | null>(null)
  const [selfSent, setSelfSent] = useState<SelfSentDaily | null>(null)
  const [rankings, setRankings] = useState<ContactRanking[]>([])
  const [excluded, setExcluded] = useState<string[]>([])
  const [excludeCandidates, setExcludeCandidates] = useState<Array<{ username: string; displayName: string; avatarUrl?: string }>>([])
  const [dailyActivity, setDailyActivity] = useState<DailyActivity | null>(null)
  const [wordFreq, setWordFreq] = useState<WordFreqItem[]>([])
  const [wordFreqMeta, setWordFreqMeta] = useState<{ scannedMessages: number; textMessages: number } | null>(null)
  const [excludeSearch, setExcludeSearch] = useState('')
  const [excludeDialogOpen, setExcludeDialogOpen] = useState(false)
  const [draftExcluded, setDraftExcluded] = useState<string[]>([])
  const [rankingLimit, setRankingLimit] = useState(20)
  const [includeGroups, setIncludeGroups] = useState(false)
  const [rankingLoading, setRankingLoading] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const hourlyBarSizing = useMeasuredBarWidth(24)
  const weekdayBarSizing = useMeasuredBarWidth(7)
  const dailyBarCount = Object.keys(selfSent?.dailyDistribution || {}).length || 1
  const dailyBarSizing = useMeasuredBarWidth(dailyBarCount)

  const loadRankings = useCallback(async (limit: number, withGroups: boolean) => {
    setRankingLoading(true)
    try {
      const result = await window.electronAPI.analytics.getContactRankings(limit, 0, 0, { includeGroupChats: withGroups })
      if (!result.success) {
        setError(result.error || '加载联系人排行失败')
        return
      }
      setRankings((result.data || []) as ContactRanking[])
      const candidates = await window.electronAPI.analytics.getExcludeCandidates({ includeGroupChats: withGroups })
      if (candidates.success) setExcludeCandidates(candidates.data || [])
    } finally {
      setRankingLoading(false)
    }
  }, [])

  const loadAll = useCallback(async (force = false) => {
    setLoading(true)
    setError(null)
    try {
      const [statsRes, timeRes, selfRes, exclRes, candRes, dailyRes, wordRes] = await Promise.all([
        window.electronAPI.analytics.getOverallStatistics(force),
        window.electronAPI.analytics.getTimeDistribution(),
        window.electronAPI.analytics.getSelfSentDailyDistribution(undefined, undefined, force),
        window.electronAPI.analytics.getExcludedUsernames(),
        window.electronAPI.analytics.getExcludeCandidates({ includeGroupChats: includeGroups }),
        window.electronAPI.analytics.getDailyActivity(force),
        window.electronAPI.analytics.getWordFrequency(60, force),
      ])
      if (statsRes.success && statsRes.data) setStats(statsRes.data)
      else if (statsRes.error) setError(statsRes.error)
      if (timeRes.success) setTimeDist(timeRes.data)
      if (selfRes.success) setSelfSent(selfRes.data)
      if (exclRes.success) setExcluded(exclRes.data || [])
      if (candRes.success) setExcludeCandidates(candRes.data || [])
      if (dailyRes.success && dailyRes.data) setDailyActivity(dailyRes.data)
      if (wordRes.success && wordRes.data) {
        setWordFreq(wordRes.data.items || [])
        setWordFreqMeta({ scannedMessages: wordRes.data.scannedMessages, textMessages: wordRes.data.textMessages })
      }
    } catch (e) {
      setError(String(e))
    } finally {
      setLoading(false)
    }
  }, [includeGroups])

  useEffect(() => {
    void loadAll()
  }, [loadAll])

  useEffect(() => {
    if (stats && !loading) void loadRankings(rankingLimit, includeGroups)
  }, [includeGroups, loading, rankingLimit, loadRankings, stats])

  // ---------------------------------------------------------------- 图表配置
  const hourlyOption = useMemo(() => {
    const data = Array.from({ length: 24 }, (_, h) => timeDist?.hourlyDistribution[h] || 0)
    return {
      ...baseChartTheme(colorMode),
      animation: animationCommon.animationDuration > 0,
      tooltip: { ...tooltipCommon, trigger: 'axis' as const },
      grid: { left: 36, right: 12, top: 24, bottom: 24 },
      xAxis: { type: 'category' as const, data: data.map((_, i) => `${i}时`), ...axisCommon },
      yAxis: { type: 'value' as const, ...axisCommon },
      series: [
        {
          type: 'bar' as const,
          data,
          itemStyle: { color: '#f4f4f5', borderRadius: [3, 3, 0, 0] },
          barWidth: hourlyBarSizing.barWidth,
          barCategoryGap: hourlyBarSizing.barCategoryGap,
        },
      ],
    }
  }, [hourlyBarSizing.barWidth, timeDist, colorMode])

  const weekdayOption = useMemo(() => {
    const data = WEEKDAY_LABELS.map((_, i) => timeDist?.weekdayDistribution[i] || 0)
    const max = Math.max(1, ...data)
    return {
      ...baseChartTheme(colorMode),
      tooltip: { ...tooltipCommon, trigger: 'axis' as const },
      grid: { left: 36, right: 12, top: 24, bottom: 24 },
      xAxis: { type: 'category' as const, data: WEEKDAY_LABELS, ...axisCommon },
      yAxis: { type: 'value' as const, ...axisCommon },
      series: [
        {
          type: 'bar' as const,
          data,
          itemStyle: {
            color: (params: any) => blueRamp(params.value / max, colorMode),
            borderRadius: [3, 3, 0, 0],
          },
          barWidth: weekdayBarSizing.barWidth,
          barCategoryGap: weekdayBarSizing.barCategoryGap,
        },
      ],
    }
  }, [timeDist, weekdayBarSizing.barWidth, colorMode])

  const monthlyOption = useMemo(() => {
    const months = Object.keys(timeDist?.monthlyDistribution || {}).sort()
    const data = months.map((m) => timeDist!.monthlyDistribution[m])
    return {
      ...baseChartTheme(colorMode),
      tooltip: { ...tooltipCommon, trigger: 'axis' as const },
      grid: { left: 40, right: 12, top: 24, bottom: 24 },
      xAxis: { type: 'category' as const, data: months, ...axisCommon },
      yAxis: { type: 'value' as const, ...axisCommon },
      series: [
        {
          type: 'line' as const,
          data,
          smooth: true,
          symbol: 'circle',
          symbolSize: 5,
          lineStyle: { color: blueRamp(0.35, colorMode), width: 2 },
          itemStyle: { color: blueRamp(0.5, colorMode) },
          areaStyle: { color: blueVerticalGradient(colorMode) },
        },
      ],
    }
  }, [timeDist, colorMode])

  const selfSentOption = useMemo(() => {
    const days = Object.keys(selfSent?.dailyDistribution || {}).sort()
    const data = days.map((d) => selfSent!.dailyDistribution[d])
    const max = Math.max(1, ...data)
    return {
      ...baseChartTheme(colorMode),
      tooltip: { ...tooltipCommon, trigger: 'axis' as const },
      grid: { left: 40, right: 12, top: 24, bottom: 24 },
      xAxis: { type: 'category' as const, data: days, ...axisCommon },
      yAxis: { type: 'value' as const, ...axisCommon },
      series: [
        {
          type: 'bar' as const,
          data: data.map((value) => ({
            value,
            itemStyle: { color: blueRamp(value / max, colorMode), borderRadius: [4, 4, 0, 0] },
          })),
          barWidth: dailyBarSizing.barWidth,
          barCategoryGap: dailyBarSizing.barCategoryGap,
        },
      ],
    }
  }, [dailyBarSizing.barWidth, selfSent, colorMode])

  // ------------------------------------------------------------ 全年活跃热力图
  const calendarOption = useMemo(() => {
    if (!dailyActivity || !stats) return null
    const days = Object.keys(dailyActivity.daily).sort()
    if (days.length === 0) return null
    const values: Array<[string, number]> = days.map((d) => [d, dailyActivity.daily[d]])
    const max = Math.max(1, ...values.map((v) => v[1]))

    const end = new Date((stats.lastMessageTime || Math.floor(Date.now() / 1000)) * 1000)
    end.setHours(0, 0, 0, 0)
    const start = new Date(end)
    start.setMonth(start.getMonth() - 11)
    start.setDate(1)
    const first = new Date(days[0])
    const rangeStart = first < start ? first : start

    const heatColors = colorMode === 'mono' ? MONO_STACK : BLUE_STACK
    return {
      ...baseChartTheme(colorMode),
      tooltip: {
        ...tooltipCommon,
        formatter: (params: any) => {
          const p = params as { value: [string, number] }
          return `${p.value[0]}：<b>${p.value[1]}</b> 条`
        },
      },
      calendar: {
        range: [rangeStart.getFullYear() + '-' + (rangeStart.getMonth() + 1), end.getFullYear() + '-' + (end.getMonth() + 1)],
        top: 28,
        left: 48,
        right: 16,
        cellSize: ['auto', 13],
        itemStyle: { color: 'rgba(30,63,138,0.06)', borderColor: CHART_GRID, borderWidth: 1 },
        splitLine: { lineStyle: { color: CHART_GRID } },
        dayLabel: { color: CHART_TEXT_DIM, fontSize: 10 },
        monthLabel: { color: CHART_TEXT, fontSize: 11 },
        yearLabel: { color: CHART_TEXT, fontSize: 11 },
      },
      visualMap: {
        min: 0,
        max,
        calculable: false,
        orient: 'horizontal',
        left: 'center',
        bottom: 0,
        textStyle: { color: CHART_TEXT_DIM, fontSize: 10 },
        inRange: { color: heatColors },
      },
      series: [
        {
          type: 'heatmap' as const,
          coordinateSystem: 'calendar',
          data: values,
          itemStyle: { borderColor: CHART_GRID, borderWidth: 1, borderRadius: 2 },
        },
      ],
    }
  }, [dailyActivity, stats, colorMode])

  const toggleExclude = (username: string) => {
    setDraftExcluded((current) => current.includes(username) ? current.filter((u) => u !== username) : [...current, username])
  }

  const openExcludeDialog = () => {
    setDraftExcluded(excluded)
    setExcludeSearch('')
    setExcludeDialogOpen(true)
  }

  const applyExclusions = async () => {
    const result = await window.electronAPI.analytics.setExcludedUsernames(draftExcluded)
    if (!result.success) {
      setError(result.error || '更新排除名单失败')
      return
    }
    setExcluded(result.data || draftExcluded)
    setExcludeDialogOpen(false)
    await loadAll(true)
  }

  const filteredCandidates = excludeCandidates.filter(
    (c) => !excludeSearch || c.displayName.toLowerCase().includes(excludeSearch.toLowerCase()) || c.username.toLowerCase().includes(excludeSearch.toLowerCase()),
  )

  if (loading && !stats) {
    return (
      <div className="wp-loading page-loading">
        <Loader2 className="spin" size={20} />
        正在统计全部聊天记录…
      </div>
    )
  }

  if (error) {
    return (
      <div className="wp-error page-loading">
        {error}
        <button className="ghost-btn" onClick={() => void loadAll(true)}>
          重试
        </button>
      </div>
    )
  }

  if (!stats) return null

  const maxRank = Math.max(1, ...rankings.map((r) => r.messageCount))

  return (
    <div className="analytics-global">
      <div className="v09-toolbar-sub analytics-toolbar-sub">
        <button type="button" className="chip" onClick={() => void loadAll(true)}>
          <RefreshCw size={13} />
          刷新统计
        </button>
        <span className="v09-sub">
          统计范围：{formatDate(stats.firstMessageTime)} 至 {formatDate(stats.lastMessageTime)} · {stats.activeDays} 个活跃日
        </span>
      </div>

      {/* KPI 与消息类型：保持一条信息带，避免摘要被拆成两层 */}
      <div className="analytics-summary-strip">
        <div className="stat-card stat-card-hero">
          <span className="stat-label">
            <MessageSquare size={11} /> 总消息数
          </span>
          <b>
            <CountUp value={stats.totalMessages} format={formatNumber} />
          </b>
          <span className="stat-sub">日均 {stats.activeDays > 0 ? Math.round(stats.totalMessages / stats.activeDays) : 0} 条</span>
        </div>
        <div className="stat-card">
          <span className="stat-label">
            <Send size={11} /> 我发送
          </span>
          <b>
            <CountUp value={stats.sentMessages} format={formatNumber} />
          </b>
          <span className="stat-sub">占比 {stats.totalMessages > 0 ? Math.round((stats.sentMessages / stats.totalMessages) * 100) : 0}%</span>
        </div>
        <div className="stat-card">
          <span className="stat-label">
            <Inbox size={11} /> 我接收
          </span>
          <b>
            <CountUp value={stats.receivedMessages} format={formatNumber} />
          </b>
          <span className="stat-sub">占比 {stats.totalMessages > 0 ? Math.round((stats.receivedMessages / stats.totalMessages) * 100) : 0}%</span>
        </div>
        <div className="stat-card">
          <span className="stat-label">
            <CalendarDays size={11} /> 活跃天数
          </span>
          <b>
            <CountUp value={stats.activeDays} />
          </b>
          <span className="stat-sub">首次 {formatDate(stats.firstMessageTime)}</span>
        </div>
        <div className="analytics-summary-types" aria-label="消息类型构成">
          {MEDIA_LABELS.map((m) => {
            const Icon = m.icon
            return (
              <div key={m.key} className="media-type-cell" style={{ ['--type-color' as string]: m.color }}>
                <div className="media-type-head">
                  <Icon size={14} />
                  {m.label}
                </div>
                <b>{formatNumber(stats[m.key] as number)}</b>
              </div>
            )
          })}
        </div>
      </div>

      {/* 活跃日历与词云：保留并置 seam，词云数据/组件可独立替换 */}
      <div className="chart-grid-2 analytics-insight-grid">
        <div className="v09-panel">
          <div className="v09-panel-head">
            <h3>
              <CalendarDays size={14} />
              活跃日历
            </h3>
            <span className="v09-sub">每日消息量 · 最多展示近 12 个月</span>
          </div>
          {calendarOption ? (
            <ReactECharts option={calendarOption} style={{ height: 280 }} notMerge />
          ) : (
            <div className="wp-loading" style={{ height: 280 }}>暂无数据</div>
          )}
        </div>
        <div className="v09-panel">
          <div className="v09-panel-head">
            <h3>
              <CloudFog size={14} />
              高频词云
            </h3>
            <span className="v09-sub">文本消息热词 · 扫描 {wordFreqMeta ? formatNumber(wordFreqMeta.scannedMessages) : '–'} 条</span>
          </div>
          {wordFreq.length > 0 ? (
            <AnalyticsWordCloud
              words={wordFreq}
              maxWords={48}
              label="高频词云"
              listLabel="查看高频词列表"
              formatTooltip={(item) => `${item.word}：${item.count} 次`}
            />
          ) : (
            <div className="wp-loading" style={{ height: 280 }}>暂无文本消息</div>
          )}
        </div>
      </div>

      {/* 时段分布 */}
      <div className="chart-grid-2">
        <div className="v09-panel">
          <div className="v09-panel-head">
            <h3>24 小时活跃分布</h3>
            <span className="v09-sub">消息量随时间的变化</span>
          </div>
          <div ref={hourlyBarSizing.ref} className="analytics-chart-frame">
            <ReactECharts option={hourlyOption} style={{ height: 220 }} notMerge />
          </div>
        </div>
        <div className="v09-panel">
          <div className="v09-panel-head">
            <h3>星期活跃分布</h3>
            <span className="v09-sub">一周内每天的活跃度</span>
          </div>
          <div ref={weekdayBarSizing.ref} className="analytics-chart-frame">
            <ReactECharts option={weekdayOption} style={{ height: 220 }} notMerge />
          </div>
        </div>
      </div>

      <div className="chart-grid-2">
        <div className="v09-panel">
          <div className="v09-panel-head">
            <h3>月度消息趋势</h3>
            <span className="v09-sub">按自然月统计</span>
          </div>
          <ReactECharts option={monthlyOption} style={{ height: 220 }} notMerge />
        </div>
        <div className="v09-panel">
          <div className="v09-panel-head">
            <h3>我的每日消息</h3>
            <span className="v09-sub">我发送的消息 · {selfSent ? formatNumber(selfSent.totalMessages) : '–'} 条</span>
          </div>
          <div ref={dailyBarSizing.ref} className="analytics-chart-frame">
            <ReactECharts option={selfSentOption} style={{ height: 220 }} notMerge />
          </div>
        </div>
      </div>

      {/* 联系排行榜 */}
      <div className="v09-panel">
          <div className="v09-panel-head ranking-panel-head">
            <h3>
              <Medal size={14} />
              联系排行榜 Top {rankingLimit}
            </h3>
            <div className="ranking-controls">
              <div className="ranking-limit-segment" role="group" aria-label="排行榜数量">
                {[10, 20, 50, 100].map((limit) => (
                  <button key={limit} type="button" className={rankingLimit === limit ? 'is-active' : ''} onClick={() => setRankingLimit(limit)}>{limit}</button>
                ))}
              </div>
              <label className="ranking-toggle">
                <input type="checkbox" checked={includeGroups} onChange={(e) => setIncludeGroups(e.target.checked)} />
                <span>包含群聊</span>
              </label>
              <button type="button" className="chip ranking-exclude-btn" onClick={openExcludeDialog}>
                <UserMinus size={13} />
                统计排除名单{excluded.length > 0 ? ` · ${excluded.length}` : ''}
              </button>
            </div>
          </div>
        <div className={`ranking-list ${rankingLoading ? 'is-loading' : ''}`}>
          {rankings.map((r, i) => (
            <div key={r.username} className="ranking-row" style={{ ['--rank-color' as string]: blueRamp(1 - i / Math.max(1, rankings.length - 1), colorMode) }}>
              <span className={`ranking-no ${i < 3 ? 'ranking-top' : ''}`}>{i + 1}</span>
              <Avatar src={r.avatarUrl} name={r.displayName} size={30} shape="rounded" />
              <div className="ranking-info">
                <span className="ranking-name">{r.displayName}</span>
                <span className="ranking-sub">
                  发送 {r.sentCount} · 接收 {r.receivedCount}
                </span>
              </div>
              <div className="ranking-bar">
                <div className="progress-fill" style={{ width: `${(r.messageCount / maxRank) * 100}%`, background: 'var(--rank-color)' }} />
              </div>
              <b className="ranking-count">{formatNumber(r.messageCount)}</b>
            </div>
          ))}
        </div>
      </div>

      {excludeDialogOpen && (
        <div className="wp-overlay" role="presentation" onClick={() => setExcludeDialogOpen(false)}>
          <div className="wp-dialog exclude-dialog" role="dialog" aria-modal="true" aria-labelledby="exclude-dialog-title" onClick={(e) => e.stopPropagation()}>
            <div className="wp-dialog-head">
              <UserMinus size={16} />
              <h3 id="exclude-dialog-title">统计排除名单</h3>
              <button type="button" className="icon-btn-ghost" onClick={() => setExcludeDialogOpen(false)} aria-label="关闭">
                <X size={16} />
              </button>
            </div>
            <p className="exclude-dialog-note">排除公众号、广告号等联系人；应用后统计和排行榜会重新计算。</p>
            <div className="exclude-search">
              <Search size={13} />
              <input value={excludeSearch} placeholder="搜索联系人…" onChange={(e) => setExcludeSearch(e.target.value)} autoFocus />
            </div>
            <div className="exclude-list exclude-dialog-list">
              {filteredCandidates.length === 0 && <div className="wp-empty">没有可排除的联系人</div>}
              {filteredCandidates.map((c) => {
                const isExcluded = draftExcluded.includes(c.username)
                return (
                  <button key={c.username} type="button" className={`exclude-item ${isExcluded ? 'exclude-item-active' : ''}`} onClick={() => toggleExclude(c.username)}>
                    <Avatar src={c.avatarUrl} name={c.displayName} size={22} shape="circle" />
                    <span>{c.displayName}</span>
                    <span className="exclude-add">{isExcluded ? '已排除' : '排除'}</span>
                  </button>
                )
              })}
            </div>
            <div className="exclude-dialog-footer">
              <span className="v09-sub">已排除 {draftExcluded.length} 人</span>
              <div className="exclude-dialog-actions">
                <button type="button" className="chip" onClick={() => setExcludeDialogOpen(false)}>取消</button>
                <button type="button" className="chip chip-active" onClick={() => void applyExclusions()}>应用</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}


