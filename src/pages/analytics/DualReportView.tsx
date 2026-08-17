import { useCallback, useEffect, useMemo, useState } from 'react'
import ReactECharts from 'echarts-for-react'
import { ChevronLeft, Flame, Loader2, MessageSquare, Search, Sparkles, Users } from 'lucide-react'
import { Avatar } from '../../components/Avatar'
import { CountUp } from '../../components/CountUp'
import { useColorMode } from '../../utils/colorMode'
import { axisCommon, baseChartTheme, blueRamp, tooltipCommon } from '../../utils/echartsTheme'

interface ContactRanking {
  username: string
  displayName: string
  avatarUrl?: string
  wechatId?: string
  messageCount: number
  sentCount: number
  receivedCount: number
  lastMessageTime?: number | null
}

interface DualReportData {
  year: number
  selfName: string
  selfAvatarUrl?: string
  friendUsername: string
  friendName: string
  friendAvatarUrl?: string
  firstChat: { createTime: number; createTimeStr: string; content: string; isSentByMe: boolean; senderUsername?: string } | null
  yearFirstChat?: {
    createTime: number
    createTimeStr: string
    content: string
    isSentByMe: boolean
    friendName: string
    firstThreeMessages: Array<{ content: string; isSentByMe: boolean; createTime: number; createTimeStr: string }>
  } | null
  stats: {
    totalMessages: number
    totalWords: number
    imageCount: number
    voiceCount: number
    emojiCount: number
  }
  topPhrases: Array<{ phrase: string; count: number }>
  myExclusivePhrases: Array<{ phrase: string; count: number }>
  friendExclusivePhrases: Array<{ phrase: string; count: number }>
  heatmap?: number[][]
  initiative?: { initiated: number; received: number }
  response?: { avg: number; fastest: number; count: number }
  monthly?: Record<string, number>
  streak?: { days: number; startDate: string; endDate: string }
}

const formatNum = (n: number) => (n >= 10000 ? `${(n / 10000).toFixed(1)} 万` : String(n))
const formatDuration = (seconds: number): string => {
  if (seconds < 60) return `${seconds} 秒`
  if (seconds < 3600) return `${Math.round(seconds / 60)} 分钟`
  return `${(seconds / 3600).toFixed(1)} 小时`
}

const heatmapToEcharts = (data: number[][]) => {
  const values: Array<[string, number, number]> = []
  for (let day = 0; day < data.length; day++) {
    for (let hour = 0; hour < (data[day]?.length || 0); hour++) {
      values.push([`${hour}时`, day, data[day][hour]])
    }
  }
  return values
}

export const DualReportView: React.FC<{ onBack: () => void; defaultYear: number }> = ({ onBack, defaultYear }) => {
  const colorMode = useColorMode()
  const [year, setYear] = useState(defaultYear > 0 ? defaultYear : 0)
  const [rankings, setRankings] = useState<ContactRanking[]>([])
  const [rankingsLoading, setRankingsLoading] = useState(true)
  const [keyword, setKeyword] = useState('')
  const [selected, setSelected] = useState<ContactRanking | null>(null)
  const [report, setReport] = useState<DualReportData | null>(null)
  const [generating, setGenerating] = useState(false)
  const [progress, setProgress] = useState<string>('')
  const [error, setError] = useState<string | null>(null)

  const yearLabel = year === 0 ? '全部时间' : `${year}年`

  const loadRankings = useCallback(async (reportYear: number) => {
    setRankingsLoading(true)
    setError(null)
    try {
      const begin = reportYear > 0 ? Math.floor(new Date(reportYear, 0, 1).getTime() / 1000) : 0
      const end = reportYear > 0 ? Math.floor(new Date(reportYear, 11, 31, 23, 59, 59).getTime() / 1000) : 0
      const r = await window.electronAPI.analytics.getContactRankings(200, begin, end)
      if (r.success && r.data) setRankings(r.data || [])
      else setError(r.error || '加载好友列表失败')
    } catch (e) {
      setError(String(e))
    } finally {
      setRankingsLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadRankings(year)
  }, [year, loadRankings])

  const filtered = useMemo(() => {
    if (!keyword.trim()) return rankings
    const q = keyword.trim().toLowerCase()
    return rankings.filter((r) => r.displayName.toLowerCase().includes(q) || (r.wechatId || '').toLowerCase().includes(q))
  }, [rankings, keyword])

  const generate = useCallback(
    async (friend: ContactRanking) => {
      setSelected(friend)
      setGenerating(true)
      setReport(null)
      setError(null)
      setProgress('准备生成…')
      let off: (() => void) | undefined
      off = window.electronAPI.dualReport.onProgress((p) => {
        setProgress(p.status || '生成中…')
      })
      try {
        const r = await window.electronAPI.dualReport.generateReport(friend.username, year)
        if (r.success && r.data) setReport(r.data)
        else setError(r.error || '报告生成失败')
      } catch (e) {
        setError(String(e))
      } finally {
        off?.()
        setGenerating(false)
        setProgress('')
      }
    },
    [year],
  )

  const monthlyOption = useMemo(() => {
    if (!report?.monthly) return null
    const months = Array.from({ length: 12 }, (_, i) => String(i + 1).padStart(2, '0'))
    const data = months.map((m) => report.monthly?.[m] || 0)
    const max = Math.max(1, ...data)
    return {
      ...baseChartTheme(colorMode),
      tooltip: { ...tooltipCommon, trigger: 'axis' as const },
      grid: { left: 32, right: 12, top: 16, bottom: 24 },
      xAxis: { type: 'category' as const, data: months.map((m) => `${m}月`), ...axisCommon },
      yAxis: { type: 'value' as const, ...axisCommon },
      series: [
        {
          type: 'bar' as const,
          data,
          itemStyle: { color: (params: any) => blueRamp((params.value || 0) / max, colorMode), borderRadius: [3, 3, 0, 0] },
          barMaxWidth: 18,
        },
      ],
    }
  }, [report, colorMode])

  const heatmapOption = useMemo(() => {
    if (!report?.heatmap) return null
    const values = heatmapToEcharts(report.heatmap)
    const max = Math.max(1, ...values.map((v) => v[2]))
    return {
      ...baseChartTheme(colorMode),
      tooltip: { ...tooltipCommon, position: 'top' as const },
      grid: { left: 40, right: 12, top: 12, bottom: 28 },
      xAxis: { type: 'category' as const, data: Array.from({ length: 24 }, (_, h) => `${h}时`), ...axisCommon },
      yAxis: { type: 'category' as const, data: Array.from({ length: 7 }, (_, d) => ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][d]), ...axisCommon },
      visualMap: {
        min: 0,
        max,
        calculable: true,
        orient: 'horizontal',
        left: 'center',
        bottom: 0,
        inRange: { color: colorMode === 'mono' ? ['#17171b', '#d4d4d8'] : ['#0b1220', '#3b82f6'] },
      },
      series: [
        {
          type: 'heatmap' as const,
          data: values,
          itemStyle: { borderColor: 'rgba(0,0,0,0.2)', borderWidth: 1 },
        },
      ],
    }
  }, [report, colorMode])

  // 选人阶段
  if (!selected) {
    return (
      <div className="v09-page dual-report-page">
        <div className="annual-actions">
          <button type="button" className="chip" onClick={onBack}>
            <ChevronLeft size={13} />
            返回选择
          </button>
          <span className="v09-sub">双人年度报告 · {yearLabel}</span>
        </div>
        <div className="dual-report-header">
          <h2 className="v09-h2">
            <Users size={16} />
            双人年度报告
          </h2>
          <p className="hint">选择一位好友，生成你们的专属聊天报告</p>
          <div className="dual-report-year-row">
            {[0, ...Array.from(new Set([2026, 2025, 2024, 2023, 2022])).filter((y) => y <= new Date().getFullYear())]
              .slice(0, 6)
              .map((y) => (
                <button key={y} type="button" className={`chip ${year === y ? 'chip-active' : ''}`} onClick={() => setYear(y)}>
                  {y === 0 ? '全部时间' : `${y} 年`}
                </button>
              ))}
          </div>
          <div className="dual-report-search">
            <Search size={14} />
            <input value={keyword} placeholder="搜索好友（昵称/微信号）" onChange={(e) => setKeyword(e.target.value)} spellCheck={false} />
          </div>
        </div>
        <div className="dual-report-rankings">
          {rankingsLoading && <div className="wp-loading">正在加载聊天排行…</div>}
          {!rankingsLoading && error && <div className="wp-error">{error}</div>}
          {!rankingsLoading && filtered.length === 0 && !error && <div className="wp-empty">没有匹配的好友</div>}
          {filtered.map((item, index) => (
            <button key={item.username} type="button" className="dual-report-friend" onClick={() => void generate(item)}>
              <span className={`dual-report-rank ${index < 3 ? 'top' : ''}`}>{index + 1}</span>
              <Avatar src={item.avatarUrl} name={item.displayName} size={34} shape="circle" />
              <span className="dual-report-friend-name">{item.displayName}</span>
              <span className="dual-report-friend-id">{item.wechatId || '未设置微信号'}</span>
              <span className="dual-report-friend-count">{formatNum(item.messageCount)} 条</span>
            </button>
          ))}
        </div>
      </div>
    )
  }

  // 报告展示阶段
  if (generating || (!report && !error)) {
    return (
      <div className="v09-page dual-report-page">
        <div className="annual-actions">
          <button type="button" className="chip" onClick={() => setSelected(null)}>
            <ChevronLeft size={13} />
            返回选择
          </button>
        </div>
        <div className="wp-loading" style={{ padding: '80px 0' }}>
          <Loader2 className="spin" size={28} />
          <p style={{ marginTop: 12 }}>{progress || '正在生成双人报告…'}</p>
        </div>
      </div>
    )
  }

  if (error && !report) {
    return (
      <div className="v09-page dual-report-page">
        <div className="annual-actions">
          <button type="button" className="chip" onClick={() => setSelected(null)}>
            <ChevronLeft size={13} />
            返回选择
          </button>
        </div>
        <div className="wp-error" style={{ margin: '40px auto' }}>{error}</div>
      </div>
    )
  }

  if (!report) return null

  const statCards: Array<{ icon: React.ReactNode; label: string; value: string }> = [
    { icon: <MessageSquare size={14} />, label: '总消息', value: formatNum(report.stats.totalMessages) },
    { icon: <Sparkles size={14} />, label: '总字数', value: formatNum(report.stats.totalWords) },
    { icon: <MessageSquare size={14} />, label: '图片', value: String(report.stats.imageCount) },
    { icon: <MessageSquare size={14} />, label: '语音', value: String(report.stats.voiceCount) },
    { icon: <MessageSquare size={14} />, label: '表情', value: String(report.stats.emojiCount) },
  ]

  return (
    <div className="v09-page dual-report-page">
      <div className="annual-actions">
        <button type="button" className="chip" onClick={() => setSelected(null)}>
          <ChevronLeft size={13} />
          更换好友
        </button>
        <span className="v09-sub">双人年度报告 · {yearLabel} · {report.friendName}</span>
      </div>

      <div className="annual-hero dual-report-hero">
        <div className="annual-hero-avatars">
          <Avatar src={report.selfAvatarUrl} name={report.selfName} size={44} shape="circle" />
          <Sparkles size={15} />
          <Avatar src={report.friendAvatarUrl} name={report.friendName} size={44} shape="circle" />
        </div>
        <h2 className="v09-h2">
          {report.selfName} × {report.friendName}
        </h2>
        <p className="hint">
          {yearLabel === '全部时间' ? '你们从相识至今的对话' : `${yearLabel}里你们的对话`}
          {report.streak && (
            <>
              {' · '}最长连续 {report.streak.days} 天
              （{report.streak.startDate} 至 {report.streak.endDate}）
            </>
          )}
        </p>
        <div className="analytics-stat-cards">
          {statCards.map((s, i) => (
            <div className="analytics-big-card" key={i}>
              <span className="card-icon">{s.icon}</span>
              <b>
                <CountUp value={Number(s.value.replace(/[^\d.]/g, '')) || 0} />
                {s.value.includes('万') ? ' 万' : ''}
              </b>
              <span>{s.label}</span>
            </div>
          ))}
        </div>
      </div>

      {report.yearFirstChat && (
        <section className="dual-report-section">
          <h3 className="v09-h3">
            <Flame size={14} />
            年度第一句
          </h3>
          <p className="dual-report-firstchat">
            {report.yearFirstChat.createTimeStr} · {report.yearFirstChat.isSentByMe ? report.selfName : report.friendName}：「
            {report.yearFirstChat.content}
            」
          </p>
          {report.yearFirstChat.firstThreeMessages.length > 0 && (
            <div className="dual-report-chat-mini">
              {report.yearFirstChat.firstThreeMessages.map((m, i) => (
                <div key={i} className={`chat-mini-line ${m.isSentByMe ? 'me' : ''}`}>
                  <span>{m.isSentByMe ? report.selfName : report.friendName}</span>
                  <p>{m.content}</p>
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      {monthlyOption && (
        <section className="dual-report-section">
          <h3 className="v09-h3">月度消息分布</h3>
          <ReactECharts option={monthlyOption} style={{ height: 220 }} />
        </section>
      )}

      {heatmapOption && (
        <section className="dual-report-section">
          <h3 className="v09-h3">7×24 活跃热力图</h3>
          <ReactECharts option={heatmapOption} style={{ height: 220 }} />
        </section>
      )}

      {report.initiative && (
        <section className="dual-report-section">
          <h3 className="v09-h3">谁更主动</h3>
          <div className="dual-report-stats-row">
            <div className="dual-report-stat">
              <b>{report.initiative.initiated}</b>
              <span>{report.selfName} 主动发起</span>
            </div>
            <div className="dual-report-stat">
              <b>{report.initiative.received}</b>
              <span>{report.friendName} 主动发起</span>
            </div>
            {report.response && (
              <div className="dual-report-stat">
                <b>{formatDuration(report.response.avg)}</b>
                <span>平均回复（最快 {formatDuration(report.response.fastest)}）</span>
              </div>
            )}
          </div>
        </section>
      )}

      {report.topPhrases.length > 0 && (
        <section className="dual-report-section">
          <h3 className="v09-h3">你们最常说</h3>
          <div className="annual-phrase-cloud">
            {report.topPhrases.map((p) => (
              <span key={p.phrase} className="phrase-chip">
                {p.phrase}
                <i>{p.count}</i>
              </span>
            ))}
          </div>
        </section>
      )}

      {(report.myExclusivePhrases.length > 0 || report.friendExclusivePhrases.length > 0) && (
        <section className="dual-report-section">
          <h3 className="v09-h3">专属口头禅</h3>
          <div className="dual-report-exclusive">
            {report.myExclusivePhrases.length > 0 && (
              <div>
                <span className="hint">{report.selfName} 的专属</span>
                <div className="annual-phrase-cloud">
                  {report.myExclusivePhrases.slice(0, 8).map((p) => (
                    <span key={p.phrase} className="phrase-chip">
                      {p.phrase}
                      <i>{p.count}</i>
                    </span>
                  ))}
                </div>
              </div>
            )}
            {report.friendExclusivePhrases.length > 0 && (
              <div>
                <span className="hint">{report.friendName} 的专属</span>
                <div className="annual-phrase-cloud">
                  {report.friendExclusivePhrases.slice(0, 8).map((p) => (
                    <span key={p.phrase} className="phrase-chip">
                      {p.phrase}
                      <i>{p.count}</i>
                    </span>
                  ))}
                </div>
              </div>
            )}
          </div>
        </section>
      )}
    </div>
  )
}
