import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import ReactECharts from 'echarts-for-react'
import { ChevronLeft, Crown, Flame, Loader2, MessageSquare, Search, Sparkles, Users, CalendarDays, BarChart3, Clock3, Image as ImageIcon, Mic, Smile } from 'lucide-react'
import { Avatar } from '../../components/Avatar'
import { CountUp } from '../../components/CountUp'
import { useColorMode } from '../../utils/colorMode'
import { animationCommon, axisCommon, baseChartTheme, blueRamp, tooltipCommon } from '../../utils/echartsTheme'
import { useMeasuredBarWidth } from './chartSizing'
import { EmptyState } from '../../components/EmptyState'

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
  const monthlyBarSizing = useMeasuredBarWidth(12, 1, 20, 64)
  const heatmapRef = useRef<HTMLDivElement>(null)

  const yearLabel = year === 0 ? '全部时间' : `${year}年`
  const yearOptions = useMemo(() => {
    const nowY = new Date().getFullYear()
    const base = [2026, 2025, 2024, 2023, 2022].filter((y) => y <= nowY)
    const unique = Array.from(new Set(base)).slice(0, 5)
    return [0, ...unique]
  }, [])

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
    return rankings.filter((r) => r.displayName.toLowerCase().includes(q) || (r.wechatId || '').toLowerCase().includes(q) || r.username.toLowerCase().includes(q))
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
    if (!report) return null
    // 兼容多种 key 形态： "01"/"1"/1/"01月"/"1月"/"2025-01"/"2025-1"
    const getMonthValue = (m1: number): number => {
      const m = report.monthly
      if (!m || typeof m !== 'object') return 0
      const pad = String(m1).padStart(2, '0')
      const plain = String(m1)
      const candidates: Array<string | number> = [
        pad,
        plain,
        Number(m1),
        `${pad}月`,
        `${plain}月`,
      ]
      for (const k of candidates) {
        const v = (m as any)[k]
        if (typeof v === 'number' && Number.isFinite(v)) return v
        if (typeof v === 'string' && v !== '' && Number.isFinite(Number(v))) return Number(v)
      }
      // YYYY-MM 形态：取所有以 -MM / -M 结尾的值求和（全部时间模式）
      let sum = 0
      let found = false
      for (const [key, val] of Object.entries(m as Record<string, any>)) {
        const num = typeof val === 'number' ? val : Number(val)
        if (!Number.isFinite(num) || num <= 0) continue
        const kk = String(key).trim()
        if (kk === pad || kk === plain) continue // 已尝试
        if (kk.endsWith(`-${pad}`) || kk.endsWith(`-${plain}`) || kk.endsWith(`${pad}月`) || kk.endsWith(`${plain}月`)) {
          sum += num
          found = true
        }
      }
      if (found) return sum
      // 最后兜底：若键为 0-11 索引
      const zeroIdx = (m as any)[m1 - 1]
      if (typeof zeroIdx === 'number' && Number.isFinite(zeroIdx)) return zeroIdx
      return 0
    }
    const months = Array.from({ length: 12 }, (_, i) => i + 1)
    const data = months.map((m) => getMonthValue(m))
    const hasAny = data.some((v) => v > 0) || !!report.monthly
    if (!hasAny) {
      // 无数据时仍展示空图表，避免面板“消失”让人以为 broken
    }
    const max = Math.max(1, ...data)
    return {
      ...baseChartTheme(colorMode),
      ...animationCommon,
      animationDelay: (idx: number) => idx * 40,
      tooltip: { ...tooltipCommon, trigger: 'axis' as const },
      grid: { left: 36, right: 12, top: 16, bottom: 24 },
      xAxis: { type: 'category' as const, data: months.map((m) => `${String(m).padStart(2, '0')}月`), ...axisCommon },
      yAxis: { type: 'value' as const, ...axisCommon },
      series: [
        {
          type: 'bar' as const,
          data,
          itemStyle: { color: (params: any) => blueRamp((params.value || 0) / max, colorMode), borderRadius: [3, 3, 0, 0] },
          barWidth: monthlyBarSizing.barWidth,
          barCategoryGap: monthlyBarSizing.barCategoryGap,
          animationDelay: (idx: number) => idx * 40,
        },
      ],
    }
  }, [monthlyBarSizing.barWidth, report, colorMode])

  const heatmapOption = useMemo(() => {
    if (!report?.heatmap) return null
    const values = heatmapToEcharts(report.heatmap)
    const max = Math.max(1, ...values.map((v) => v[2]))
    // gradient restored — hidden legend (show:false) still drives color mapping
    const heatColors = colorMode === 'mono' ? ['#17171b', '#9a9aa4', '#d4d4da', '#f4f4f5'] : ['#0b1220', '#1e3a8a', '#3b82f6', '#93c5fd', '#dbeafe']
    return {
      ...baseChartTheme(colorMode),
      animation: false,
      tooltip: { ...tooltipCommon, position: 'top' as const, formatter: (p: any) => `${['周日','周一','周二','周三','周四','周五','周六'][p.value[1]]} ${p.value[0]}：<b>${p.value[2]}</b> 条` },
      grid: { left: 44, right: 12, top: 12, bottom: 20 },
      xAxis: { type: 'category' as const, data: Array.from({ length: 24 }, (_, h) => `${h}时`), ...axisCommon },
      yAxis: { type: 'category' as const, data: Array.from({ length: 7 }, (_, d) => ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][d]), ...axisCommon },
      visualMap: { show: false, min: 0, max, inRange: { color: heatColors } },
      series: [
        {
          type: 'heatmap' as const,
          data: values,
          itemStyle: { borderColor: 'rgba(0,0,0,0.18)', borderWidth: 1, borderRadius: 2 },
        },
      ],
    }
  }, [report, colorMode])

  // ── 选人阶段 ──
  if (!selected) {
    return (
      <div className="v09-page dual-report-page dual-report-picker">
        <div className="v09-toolbar">
          <button type="button" className="chip" onClick={onBack}>
            <ChevronLeft size={14} />
            返回选择
          </button>
          <span className="v09-sub">双人年度报告 · {yearLabel}</span>
        </div>

        <div className="dual-report-picker-layout">
          <div className="v09-panel dual-report-controls">
            <div className="v09-panel-head">
              <h3><Users size={14} /> 选择好友</h3>
              <span className="v09-sub">生成你们的专属聊天报告</span>
            </div>
            <div className="dual-report-year-row">
              {yearOptions.map((y) => (
                <button key={y} type="button" className={`chip ${year === y ? 'chip-active' : ''}`} onClick={() => setYear(y)}>
                  {y === 0 ? '全部时间' : `${y} 年`}
                </button>
              ))}
            </div>
            <label className="dual-report-search">
              <Search size={14} />
              <input value={keyword} placeholder="搜索好友（昵称 / 微信号）" onChange={(e) => setKeyword(e.target.value)} spellCheck={false} />
              {keyword && <button type="button" className="dual-report-search-clear" onClick={() => setKeyword('')}>×</button>}
            </label>
            {!rankingsLoading && <span className="v09-sub dual-report-count">{filtered.length} 位好友 · 按消息量排序</span>}
          </div>

          <div className="v09-panel dual-report-rankings-panel">
            {rankingsLoading && <div className="wp-loading page-loading" style={{ padding: 32 }}><Loader2 className="spin" size={18} />正在加载好友列表…</div>}
            {!rankingsLoading && error && <div className="wp-error">{error}</div>}
            {!rankingsLoading && !error && filtered.length === 0 && <EmptyState icon={Search} title="没有匹配的好友" hint="换个关键词试试" />}
            {!rankingsLoading && !error && filtered.length > 0 && (
              <div className="dual-report-rankings">
                {filtered.map((item, index) => (
                  <button key={item.username} type="button" className="dual-report-friend" onClick={() => void generate(item)}>
                    <span className={`dual-report-rank ${index < 3 ? 'top' : ''}`}>{index + 1}</span>
                    <Avatar src={item.avatarUrl} name={item.displayName} size={32} shape="circle" />
                    <span className="dual-report-friend-main">
                      <span className="dual-report-friend-name">{item.displayName}</span>
                      <span className="dual-report-friend-id">{item.wechatId || item.username}</span>
                    </span>
                    <span className="dual-report-friend-count">
                      <b>{formatNum(item.messageCount)}</b>
                      <span>条</span>
                    </span>
                    <ChevronLeft size={14} style={{ transform: 'rotate(180deg)', opacity: 0.35, flexShrink: 0 }} />
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    )
  }

  // ── 生成中 ──
  if (generating || (!report && !error)) {
    return (
      <div className="v09-page dual-report-page">
        <div className="v09-toolbar">
          <button type="button" className="chip" onClick={() => setSelected(null)}>
            <ChevronLeft size={14} />
            返回选择
          </button>
          <span className="v09-sub">双人报告 · {selected.displayName}</span>
        </div>
        <div className="v09-panel" style={{ padding: '64px 24px', textAlign: 'center' }}>
          <Loader2 className="spin" size={28} style={{ margin: '0 auto', display: 'block', color: 'var(--accent)' }} />
          <p className="hint" style={{ marginTop: 14, fontSize: 13 }}>{progress || '正在生成双人报告…'}</p>
          <p className="v09-sub" style={{ marginTop: 6 }}>首次生成可能需要数秒，正在本地统计中</p>
        </div>
      </div>
    )
  }

  if (error && !report) {
    return (
      <div className="v09-page dual-report-page">
        <div className="v09-toolbar">
          <button type="button" className="chip" onClick={() => setSelected(null)}>
            <ChevronLeft size={14} />
            返回选择
          </button>
        </div>
        <div className="v09-panel" style={{ padding: 24, textAlign: 'center' }}>
          <div className="wp-error" style={{ justifyContent: 'center' }}>{error}</div>
          <button type="button" className="ghost-btn" style={{ marginTop: 12 }} onClick={() => void generate(selected)}>重试</button>
        </div>
      </div>
    )
  }

  if (!report) return null

  const initiativeTotal = (report.initiative?.initiated || 0) + (report.initiative?.received || 0)
  const initiativeMePct = initiativeTotal > 0 ? Math.round((report.initiative!.initiated / initiativeTotal) * 100) : 50

  return (
    <div className="v09-page dual-report-page dual-report-result">
      <div className="v09-toolbar">
        <button type="button" className="chip" onClick={() => setSelected(null)}>
          <ChevronLeft size={14} />
          更换好友
        </button>
        <span className="v09-sub">双人报告 · {yearLabel} · {report.friendName}</span>
        <span className="v09-sub" style={{ marginLeft: 'auto' }}>{formatNum(report.stats.totalMessages)} 条消息</span>
      </div>

      {/* Hero */}
      <div className="v09-panel dual-report-hero">
        <div className="dual-report-hero-avatars">
          <Avatar src={report.selfAvatarUrl} name={report.selfName} size={52} shape="circle" />
          <span className="dual-report-hero-x"><Sparkles size={16} /></span>
          <Avatar src={report.friendAvatarUrl} name={report.friendName} size={52} shape="circle" />
        </div>
        <h2>{report.selfName} <span className="dual-report-hero-times">×</span> {report.friendName}</h2>
        <p className="v09-sub">
          {yearLabel === '全部时间' ? '你们从相识至今的对话' : `${yearLabel}里你们的对话`}
          {report.streak && <> · 最长连续 <b style={{ color: 'var(--text)' }}>{report.streak.days} 天</b>（{report.streak.startDate} 至 {report.streak.endDate}）</>}
        </p>

        <div className="dual-report-stat-grid">
          <div className="dual-report-stat-card">
            <span className="dual-report-stat-icon"><MessageSquare size={13} /></span>
            <b><CountUp value={report.stats.totalMessages} format={formatNum} /></b>
            <span>总消息</span>
          </div>
          <div className="dual-report-stat-card">
            <span className="dual-report-stat-icon"><BarChart3 size={13} /></span>
            <b><CountUp value={report.stats.totalWords} format={formatNum} /></b>
            <span>总字数</span>
          </div>
          <div className="dual-report-stat-card">
            <span className="dual-report-stat-icon"><ImageIcon size={13} /></span>
            <b>{formatNum(report.stats.imageCount)}</b>
            <span>图片</span>
          </div>
          <div className="dual-report-stat-card">
            <span className="dual-report-stat-icon"><Mic size={13} /></span>
            <b>{formatNum(report.stats.voiceCount)}</b>
            <span>语音</span>
          </div>
          <div className="dual-report-stat-card">
            <span className="dual-report-stat-icon"><Smile size={13} /></span>
            <b>{formatNum(report.stats.emojiCount)}</b>
            <span>表情</span>
          </div>
        </div>
      </div>

      {/* 年度第一句 */}
      {report.yearFirstChat && (
        <div className="v09-panel">
          <div className="v09-panel-head"><h3><Flame size={14} /> 年度第一句</h3><span className="v09-sub">{report.yearFirstChat.createTimeStr}</span></div>
          <div className="dual-report-firstchat">
            <span className="dual-report-firstchat-who">{report.yearFirstChat.isSentByMe ? report.selfName : report.friendName}</span>
            <p>「{report.yearFirstChat.content}」</p>
          </div>
          {report.yearFirstChat.firstThreeMessages.length > 0 && (
            <div className="dual-report-chat-mini">
              {report.yearFirstChat.firstThreeMessages.map((m, i) => (
                <div key={i} className={`chat-mini-line ${m.isSentByMe ? 'me' : ''}`}>
                  <span>{m.isSentByMe ? report.selfName : report.friendName}</span>
                  <p>{m.content}</p>
                  <span className="chat-mini-time">{m.createTimeStr}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* 月度分布 & 热力图 */}
      <div className="chart-grid-2">
        {monthlyOption && (
          <div className="v09-panel">
            <div className="v09-panel-head"><h3><CalendarDays size={14} /> 月度消息分布</h3></div>
            <div ref={monthlyBarSizing.ref} className="analytics-chart-frame">
              <ReactECharts option={monthlyOption} style={{ height: 220 }} notMerge />
            </div>
          </div>
        )}
        {heatmapOption && (
          <div className="v09-panel">
            <div className="v09-panel-head"><h3><Clock3 size={14} /> 7×24 活跃热力图</h3></div>
            <div ref={heatmapRef}>
              <ReactECharts option={heatmapOption} style={{ height: 260 }} notMerge />
            </div>
          </div>
        )}
      </div>

      {/* 谁更主动 + 响应 */}
      {report.initiative && (
        <div className="chart-grid-2">
          <div className="v09-panel">
            <div className="v09-panel-head"><h3><Crown size={14} /> 谁更主动</h3></div>
            <div className="dual-report-initiative">
              <div className="dual-report-initiative-bar">
                <div className="dual-report-initiative-fill" style={{ width: `${initiativeMePct}%` }} />
              </div>
              <div className="dual-report-initiative-labels">
                <span><b>{report.initiative.initiated}</b> {report.selfName}</span>
                <span><b>{report.initiative.received}</b> {report.friendName}</span>
              </div>
              <span className="v09-sub" style={{ textAlign: 'center', display: 'block', marginTop: 6 }}>{report.selfName} 主动 {initiativeMePct}% · {report.friendName} 主动 {100 - initiativeMePct}%</span>
            </div>
          </div>
          {report.response && (
            <div className="v09-panel">
              <div className="v09-panel-head"><h3>响应速度</h3><span className="v09-sub">{report.response.count} 次对话</span></div>
              <div className="dual-report-response">
                <div><span>平均回复</span><b>{formatDuration(report.response.avg)}</b></div>
                <div><span>最快回复</span><b>{formatDuration(report.response.fastest)}</b></div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* 高频口头禅 */}
      {report.topPhrases.length > 0 && (
        <div className="v09-panel">
          <div className="v09-panel-head"><h3><MessageSquare size={14} /> 你们最常说</h3></div>
          <div className="dual-report-phrases">
            {report.topPhrases.slice(0, 16).map((p) => (
              <span key={p.phrase} className="dual-report-phrase">
                {p.phrase}
                <i>{p.count}</i>
              </span>
            ))}
          </div>
        </div>
      )}

      {(report.myExclusivePhrases.length > 0 || report.friendExclusivePhrases.length > 0) && (
        <div className="chart-grid-2">
          {report.myExclusivePhrases.length > 0 && (
            <div className="v09-panel">
              <div className="v09-panel-head"><h3>{report.selfName} 的专属</h3></div>
              <div className="dual-report-phrases">
                {report.myExclusivePhrases.slice(0, 10).map((p) => (
                  <span key={p.phrase} className="dual-report-phrase me">
                    {p.phrase}
                    <i>{p.count}</i>
                  </span>
                ))}
              </div>
            </div>
          )}
          {report.friendExclusivePhrases.length > 0 && (
            <div className="v09-panel">
              <div className="v09-panel-head"><h3>{report.friendName} 的专属</h3></div>
              <div className="dual-report-phrases">
                {report.friendExclusivePhrases.slice(0, 10).map((p) => (
                  <span key={p.phrase} className="dual-report-phrase friend">
                    {p.phrase}
                    <i>{p.count}</i>
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
