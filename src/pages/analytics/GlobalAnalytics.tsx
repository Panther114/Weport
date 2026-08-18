import { useCallback, useEffect, useMemo, useState } from 'react'
import ReactECharts from 'echarts-for-react'
import 'echarts-wordcloud'
import { Loader2, Medal, RefreshCw, Search, UserMinus, X, MessageSquareText, Image as ImageIcon, Mic, Clapperboard, Smile, MoreHorizontal, MessageSquare, Send, Inbox, CalendarDays, Radar as RadarIcon, CloudFog } from 'lucide-react'
import { Avatar } from '../../components/Avatar'
import { CountUp } from '../../components/CountUp'
import { useColorMode } from '../../utils/colorMode'
import { blueRamp, blueVerticalGradient, BLUE_STACK, MONO_STACK, CHART_TEXT, CHART_TEXT_DIM, CHART_GRID } from '../../utils/echartsTheme'
import { animationCommon, axisCommon, baseChartTheme, tooltipCommon } from '../../utils/echartsTheme'

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

export const GlobalAnalytics: React.FC<{ annualOpen: boolean; onAnnualClose: () => void }> = () => {
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
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const loadAll = useCallback(async (force = false) => {
    setLoading(true)
    setError(null)
    try {
      const [statsRes, timeRes, selfRes, rankRes, exclRes, candRes, dailyRes, wordRes] = await Promise.all([
        window.electronAPI.analytics.getOverallStatistics(force),
        window.electronAPI.analytics.getTimeDistribution(),
        window.electronAPI.analytics.getSelfSentDailyDistribution(undefined, undefined, force),
        window.electronAPI.analytics.getContactRankings(20, 0, 0),
        window.electronAPI.analytics.getExcludedUsernames(),
        window.electronAPI.analytics.getExcludeCandidates(),
        window.electronAPI.analytics.getDailyActivity(force),
        window.electronAPI.analytics.getWordFrequency(60, force),
      ])
      if (statsRes.success && statsRes.data) setStats(statsRes.data)
      else if (statsRes.error) setError(statsRes.error)
      if (timeRes.success) setTimeDist(timeRes.data)
      if (selfRes.success) setSelfSent(selfRes.data)
      if (rankRes.success) setRankings(rankRes.data || [])
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
  }, [])

  useEffect(() => {
    void loadAll()
  }, [loadAll])

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
          barMaxWidth: 14,
        },
      ],
    }
  }, [timeDist, colorMode])

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
          barMaxWidth: 18,
        },
      ],
    }
  }, [timeDist, colorMode])

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
    return {
      ...baseChartTheme(colorMode),
      tooltip: { ...tooltipCommon, trigger: 'axis' as const },
      grid: { left: 40, right: 12, top: 24, bottom: 24 },
      xAxis: { type: 'category' as const, data: days, ...axisCommon },
      yAxis: { type: 'value' as const, ...axisCommon },
      series: [
        {
          type: 'line' as const,
          data,
          smooth: true,
          symbol: 'none',
          lineStyle: { color: blueRamp(0.45, colorMode), width: 1.5 },
          areaStyle: { color: blueVerticalGradient(colorMode) },
        },
      ],
    }
  }, [selfSent, colorMode])

  // ------------------------------------------------------------ 交流画像（雷达）
  const radarOption = useMemo(() => {
    if (!stats || !timeDist) return null
    const total = Math.max(1, stats.totalMessages)
    const typeCounts = stats.messageTypeCounts || {}
    const share = (count: number) => Math.round((count / total) * 1000) / 10
    const lateNight = [23, 0, 1, 2, 3, 4, 5].reduce((sum, h) => sum + (timeDist.hourlyDistribution[h] || 0), 0)
    const indicators = [
      { name: '文字', max: 100 },
      { name: '图片', max: 100 },
      { name: '语音', max: 100 },
      { name: '视频', max: 100 },
      { name: '表情', max: 100 },
      { name: '深夜活跃', max: 100 },
    ]
    const values = [
      share(typeCounts[1] || 0),
      share(typeCounts[3] || 0),
      share(typeCounts[34] || 0),
      share(typeCounts[43] || 0),
      share(typeCounts[47] || 0),
      Math.round((lateNight / total) * 1000) / 10,
    ]
    const fill = blueVerticalGradient(colorMode)
    return {
      ...baseChartTheme(colorMode),
      tooltip: {
        ...tooltipCommon,
        formatter: (params: any) => {
          const p = params as { name: string; value: number }
          return `${p.name}：<b>${p.value}%</b>`
        },
      },
      radar: {
        indicator: indicators,
        radius: '64%',
        center: ['50%', '54%'],
        splitNumber: 4,
        axisName: { color: CHART_TEXT, fontSize: 11 },
        splitLine: { lineStyle: { color: CHART_GRID } },
        splitArea: { areaStyle: { color: ['rgba(30,63,138,0.04)', 'rgba(30,63,138,0.08)'] } },
        axisLine: { lineStyle: { color: CHART_GRID } },
      },
      series: [
        {
          type: 'radar' as const,
          symbol: 'circle',
          symbolSize: 4,
          lineStyle: { color: blueRamp(0.35, colorMode), width: 2 },
          itemStyle: { color: blueRamp(0.5, colorMode) },
          areaStyle: { color: fill },
          data: [{ name: '消息构成', value: values }],
        },
      ],
    }
  }, [stats, timeDist, colorMode])

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

  // ------------------------------------------------------------ 高频词云
  const wordCloudOption = useMemo(() => {
    const max = Math.max(1, ...wordFreq.map((w) => w.count))
    return {
      ...baseChartTheme(colorMode),
      tooltip: {
        ...tooltipCommon,
        formatter: (params: any) => {
          const p = params as { name: string; value: number }
          return `<b>${p.name}</b>：${p.value} 次`
        },
      },
      series: [
        {
          type: 'wordCloud' as const,
          shape: 'circle' as const,
          gridSize: 8,
          sizeRange: [12, 42],
          rotationRange: [0, 0],
          rotationStep: 0,
          width: '100%',
          height: '100%',
          drawOutOfBound: false,
          textStyle: {
            fontFamily: 'inherit',
            fontWeight: 'bold' as const,
            color: (word: any) => blueRamp((word.value || 0) / max, colorMode),
          },
          emphasis: {
            textStyle: {
              color: colorMode === 'mono' ? '#f4f4f5' : '#ffffff',
              textShadowBlur: 8,
              textShadowColor: 'rgba(0,0,0,0.5)',
            },
          },
          data: wordFreq.map((w) => ({ name: w.word, value: w.count })),
        },
      ],
    }
  }, [wordFreq, colorMode])

  const toggleExclude = async (username: string) => {
    const next = excluded.includes(username) ? excluded.filter((u) => u !== username) : [...excluded, username]
    setExcluded(next)
    const r = await window.electronAPI.analytics.setExcludedUsernames(next)
    if (r.success) {
      setExcluded(r.data || [])
      void loadAll(true)
    }
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
      <div className="v09-toolbar-sub">
        <button type="button" className="chip" onClick={() => void loadAll(true)}>
          <RefreshCw size={13} />
          刷新统计
        </button>
        <span className="v09-sub">
          统计范围：{formatDate(stats.firstMessageTime)} 至 {formatDate(stats.lastMessageTime)} · {stats.activeDays} 个活跃日
        </span>
      </div>

      {/* 统计卡片 */}
      <div className="stat-cards">
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
      </div>

{/* 媒体构成 */}
      <div className="v09-panel">
        <div className="v09-panel-head">
          <h3>消息类型构成</h3>
          <span className="v09-sub">按消息类型统计</span>
        </div>
        <div className="media-type-row">
          {MEDIA_LABELS.map((m) => {
            const Icon = m.icon
            return (
              <div key={m.key} className="media-type-cell" style={{ ['--type-color' as string]: m.color }}>
                <div className="media-type-head">
                  <Icon size={14} />
                  {m.label}
                </div>
                <b>{formatNumber(stats[m.key] as number)}</b>
                <div className="progress-track">
                  <div
                    className="progress-fill"
                    style={{ width: `${stats.totalMessages > 0 ? (Number(stats[m.key]) / stats.totalMessages) * 100 : 0}%` }}
                  />
                </div>
              </div>
            )
          })}
        </div>
      </div>

      {/* 交流画像 + 全年活跃热力图 */}
      <div className="chart-grid-2">
        <div className="v09-panel">
          <div className="v09-panel-head">
            <h3>
              <RadarIcon size={14} />
              交流画像
            </h3>
            <span className="v09-sub">消息构成占比 · 深夜为 23:00–05:59</span>
          </div>
          {radarOption ? (
            <ReactECharts option={radarOption} style={{ height: 240 }} notMerge />
          ) : (
            <div className="wp-loading" style={{ height: 240 }}>暂无数据</div>
          )}
        </div>
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
      </div>

      {/* 高频词云 */}
      <div className="v09-panel">
        <div className="v09-panel-head">
          <h3>
            <CloudFog size={14} />
            高频词云
          </h3>
          <span className="v09-sub">
            文本消息热词 · 扫描 {wordFreqMeta ? formatNumber(wordFreqMeta.scannedMessages) : '–'} 条
          </span>
        </div>
        {wordFreq.length > 0 ? (
          <ReactECharts option={wordCloudOption} style={{ height: 300 }} notMerge />
        ) : (
          <div className="wp-loading" style={{ height: 300 }}>暂无文本消息</div>
        )}
      </div>

      {/* 时段分布 */}
      <div className="chart-grid-2">
        <div className="v09-panel">
          <div className="v09-panel-head">
            <h3>24 小时活跃分布</h3>
            <span className="v09-sub">消息量随时间的变化</span>
          </div>
          <ReactECharts option={hourlyOption} style={{ height: 220 }} notMerge />
        </div>
        <div className="v09-panel">
          <div className="v09-panel-head">
            <h3>星期活跃分布</h3>
            <span className="v09-sub">一周内每天的活跃度</span>
          </div>
          <ReactECharts option={weekdayOption} style={{ height: 220 }} notMerge />
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
          <ReactECharts option={selfSentOption} style={{ height: 220 }} notMerge />
        </div>
      </div>

      {/* 联系排行榜 */}
      <div className="v09-panel">
        <div className="v09-panel-head">
          <h3>
            <Medal size={14} />
            联系排行榜 Top {rankings.length}
          </h3>
          <span className="v09-sub">按消息总量排序 · 排除列表内联系人</span>
        </div>
        <div className="ranking-list">
          {rankings.map((r, i) => (
            <div key={r.username} className="ranking-row">
              <span className={`ranking-no ${i < 3 ? 'ranking-top' : ''}`}>{i + 1}</span>
              <Avatar src={r.avatarUrl} name={r.displayName} size={30} shape="rounded" />
              <div className="ranking-info">
                <span className="ranking-name">{r.displayName}</span>
                <span className="ranking-sub">
                  发送 {r.sentCount} · 接收 {r.receivedCount}
                </span>
              </div>
              <div className="ranking-bar">
                <div className="progress-fill" style={{ width: `${(r.messageCount / maxRank) * 100}%` }} />
              </div>
              <b className="ranking-count">{formatNumber(r.messageCount)}</b>
            </div>
          ))}
        </div>
      </div>

      {/* 排除管理 */}
      <div className="v09-panel">
        <div className="v09-panel-head">
          <h3>
            <UserMinus size={14} />
            统计排除名单
          </h3>
          <span className="v09-sub">排除后统计与排行榜即时重算（公众号 / 广告账号等）</span>
        </div>
        <div className="exclude-box">
          <div className="exclude-search">
            <Search size={13} />
            <input value={excludeSearch} placeholder="搜索联系人…" onChange={(e) => setExcludeSearch(e.target.value)} />
          </div>
          <div className="exclude-list">
            {filteredCandidates.length === 0 && <div className="wp-empty">没有可排除的联系人</div>}
            {filteredCandidates.map((c) => {
              const isExcluded = excluded.includes(c.username)
              return (
                <button key={c.username} type="button" className={`exclude-item ${isExcluded ? 'exclude-item-active' : ''}`} onClick={() => void toggleExclude(c.username)}>
                  <Avatar src={c.avatarUrl} name={c.displayName} size={22} shape="circle" />
                  <span>{c.displayName}</span>
                  {isExcluded ? (
                    <span className="exclude-badge">
                      <X size={11} />
                      已排除
                    </span>
                  ) : (
                    <span className="exclude-add">排除</span>
                  )}
                </button>
              )
            })}
          </div>
        </div>
      </div>
    </div>
  )
}


