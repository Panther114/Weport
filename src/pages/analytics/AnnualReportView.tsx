import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import ReactECharts from 'echarts-for-react'
import { Calendar, CalendarDays, Camera, Download, Flame, Image as ImageIcon, Loader2, MessageSquare, Moon, Sparkles, Trophy, Users, X } from 'lucide-react'
import html2canvas from 'html2canvas'
import { Avatar } from '../../components/Avatar'
import { CountUp } from '../../components/CountUp'
import { useColorMode } from '../../utils/colorMode'
import { useEscape } from '../../utils/useEscape'
import { axisCommon, baseChartTheme, blueRamp, tooltipCommon } from '../../utils/echartsTheme'
import { DualReportView } from './DualReportView'

interface AnnualReportData {
  year: number
  totalMessages: number
  totalFriends: number
  coreFriends: Array<{ username: string; displayName: string; avatarUrl?: string; messageCount: number; sentCount: number; receivedCount: number }>
  monthlyTopFriends: Array<{ month: number; displayName: string; avatarUrl?: string; messageCount: number }>
  peakDay: { date: string; messageCount: number; topFriend?: string; topFriendCount?: number } | null
  longestStreak: { friendName: string; days: number; startDate: string; endDate: string } | null
  activityHeatmap: { data: number[][] }
  midnightKing: { displayName: string; count: number; percentage: number } | null
  mutualFriend: { displayName: string; avatarUrl?: string; sentCount: number; receivedCount: number; ratio: number } | null
  socialInitiative: { initiatedChats: number; receivedChats: number; initiativeRate: number; topInitiatedFriend?: string; topInitiatedCount?: number } | null
  responseSpeed: { avgResponseTime: number; fastestFriend: string; fastestTime: number } | null
  topPhrases: Array<{ phrase: string; count: number }>
  snsStats?: { totalPosts: number; typeCounts?: Record<string, number> }
  lostFriend: { username: string; displayName: string; avatarUrl?: string; earlyCount: number; lateCount: number; periodDesc: string } | null
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

const WEEKDAY_LABELS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

export const AnnualReportView: React.FC<{ onClose: () => void }> = ({ onClose }) => {
  const colorMode = useColorMode()
  const [years, setYears] = useState<number[]>([])
  const [yearsLoading, setYearsLoading] = useState(true)
  const [yearsStatus, setYearsStatus] = useState('正在加载年份…')
  const [selectedYear, setSelectedYear] = useState<number | null>(null)
  const [report, setReport] = useState<AnnualReportData | null>(null)
  const [generating, setGenerating] = useState(false)
  const [progress, setProgress] = useState<{ status: string; progress: number } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [exporting, setExporting] = useState(false)
  const [dualOpen, setDualOpen] = useState(false)
  const reportRef = useRef<HTMLDivElement>(null)
  const sectionRefs = useRef<Array<HTMLDivElement | null>>([])

  useEffect(() => {
    let off: (() => void) | undefined
    void window.electronAPI.annualReport.startAvailableYearsLoad().then((r) => {
      if (r.success) {
        setYearsStatus(r.snapshot?.statusText || '正在加载年份…')
        if (r.snapshot?.years?.length) setYears(r.snapshot.years)
        if (r.reused || r.snapshot?.done === true) setYearsLoading(false)
      } else {
        setError(r.error || '年份加载失败')
        setYearsLoading(false)
      }
    })
    off = window.electronAPI.annualReport.onAvailableYearsProgress((p) => {
      if (p.snapshot) {
        setYearsStatus(p.snapshot.statusText || '正在加载年份…')
        if (p.snapshot.done) {
          setYearsLoading(false)
          if (p.snapshot.years?.length) setYears(p.snapshot.years)
          if (p.snapshot.error) setError(p.snapshot.error)
        }
      }
    })
    return () => off?.()
  }, [])

  const generate = useCallback(
    async (year: number) => {
      setSelectedYear(year)
      setGenerating(true)
      setError(null)
      setReport(null)
      setProgress({ status: '准备生成…', progress: 0 })
      let off: (() => void) | undefined
      off = window.electronAPI.annualReport.onProgress((p) => {
        setProgress({ status: p.status || '生成中…', progress: p.progress || 0 })
      })
      try {
        const r = await window.electronAPI.annualReport.generateReport(year)
        if (r.success && r.data) {
          setReport(r.data)
        } else {
          setError(r.error || '报告生成失败')
        }
      } catch (e) {
        setError(String(e))
      } finally {
        off?.()
        setGenerating(false)
        setProgress(null)
      }
    },
    [],
  )

  const heatmapOption = useMemo(() => {
    if (!report) return null
    const values = heatmapToEcharts(report.activityHeatmap.data || [])
    const max = Math.max(1, ...values.map((v) => v[2]))
    return {
      ...baseChartTheme(colorMode),
      tooltip: {
        ...tooltipCommon,
        formatter: (params: any) => {
          const p = params as { value: [string, number, number] }
          return `${WEEKDAY_LABELS[p.value[1]]} ${p.value[0]}：<b>${p.value[2]}</b> 条`
        },
      },
      grid: { left: 40, right: 12, top: 12, bottom: 60 },
      xAxis: { type: 'category' as const, data: Array.from({ length: 24 }, (_, i) => `${i}时`), ...axisCommon, splitArea: { show: false } },
      yAxis: { type: 'category' as const, data: WEEKDAY_LABELS, ...axisCommon },
      visualMap: {
        min: 0,
        max,
        calculable: false,
        orient: 'horizontal',
        left: 'center',
        bottom: 0,
        textStyle: { color: '#6b6b74', fontSize: 10 },
        inRange: { color: ['#101828', '#1e3f8a', '#3f76d6', '#7fb4ff', '#a6cfff'] },
      },
      series: [
        {
          type: 'heatmap' as const,
          data: values,
          itemStyle: { borderColor: '#000', borderWidth: 1, borderRadius: 2 },
        },
      ],
    }
  }, [report, colorMode])

  const coreFriendsOption = useMemo(() => {
    if (!report) return null
    const top = report.coreFriends.slice(0, 8)
    return {
      ...baseChartTheme(colorMode),
      tooltip: { ...tooltipCommon, trigger: 'axis' as const },
      grid: { left: 80, right: 24, top: 16, bottom: 24 },
      xAxis: { type: 'value' as const, ...axisCommon },
      yAxis: { type: 'category' as const, data: [...top].reverse().map((f) => f.displayName), ...axisCommon, axisLabel: { color: '#b0b0b8', fontSize: 11 } },
      series: [
        {
          type: 'bar' as const,
          data: [...top].reverse().map((f) => f.messageCount),
          itemStyle: {
            color: (params: any) => blueRamp(1 - (params.value || 0) / Math.max(1, ...top.map((f) => f.messageCount)), colorMode),
            borderRadius: [0, 3, 3, 0],
          },
          barMaxWidth: 14,
        },
      ],
    }
  }, [report, colorMode])

  const exportImages = async () => {
    if (exporting || !report) return
    setExporting(true)
    try {
      const dir = await window.electronAPI.dialog.openDirectory({ title: '选择图片保存目录' })
      if (!dir) return
      const images: Array<{ name: string; dataUrl: string }> = []
      for (let i = 0; i < sectionRefs.current.length; i++) {
        const node = sectionRefs.current[i]
        if (!node) continue
        try {
          const canvas = await html2canvas(node, { backgroundColor: '#000000', scale: 2, useCORS: true })
          images.push({ name: `annual_report_${report.year}_${i + 1}.png`, dataUrl: canvas.toDataURL('image/png') })
        } catch {
          /* 跳过捕获失败的分区 */
        }
      }
      if (images.length > 0) {
        const r = await window.electronAPI.annualReport.exportImages({ baseDir: dir, folderName: `年度报告_${report.year}`, images })
        if (r.success && r.dir) {
          await window.electronAPI.shell.openPath(r.dir)
        }
      }
    } finally {
      setExporting(false)
    }
  }

  const registerSection = (el: HTMLDivElement | null, index: number) => {
    sectionRefs.current[index] = el
  }

  useEscape(onClose)

  return (
    <div className="annual-report-view">
      <div className="annual-head">
        <div>
          <h2>
            <Sparkles size={18} />
            年度报告
          </h2>
          <p className="v09-sub">基于本地聊天记录生成的年度回顾 · 数据不出本机</p>
        </div>
        <div className="annual-actions">
          {!dualOpen && report && (
            <button type="button" className="ghost-btn" disabled={exporting} onClick={() => void exportImages()}>
              <Camera size={14} />
              {exporting ? '导出中…' : '导出报告图片'}
            </button>
          )}
          <button
            type="button"
            className={`chip ${dualOpen ? 'chip-active' : ''}`}
            onClick={() => {
              setDualOpen((prev) => !prev)
              setError(null)
            }}
          >
            <Users size={13} />
            {dualOpen ? '返回年度报告' : '双人报告'}
          </button>
          <button type="button" className="icon-btn-ghost" onClick={onClose}>
            <X size={16} />
          </button>
        </div>
      </div>

      {dualOpen ? (
        <DualReportView onBack={() => setDualOpen(false)} defaultYear={selectedYear || 0} />
      ) : (
        <>
      {error && <div className="wp-error">{error}</div>}

      {yearsLoading ? (
        <div className="wp-loading page-loading">
          <Loader2 className="spin" size={20} />
          {yearsStatus}
        </div>
      ) : (
        <div className="annual-year-row">
          <span className="v09-sub">选择年份：</span>
          {years.map((y) => (
            <button
              key={y}
              type="button"
              className={`chip ${selectedYear === y ? 'chip-active' : ''}`}
              disabled={generating}
              onClick={() => void generate(y)}
            >
              <Calendar size={13} />
              {y} 年
            </button>
          ))}
          {years.length === 0 && !yearsLoading && <span className="wp-empty">未找到聊天记录年份</span>}
        </div>
      )}

      {generating && (
        <div className="annual-progress">
          <div className="progress-track">
            <div className="progress-fill" style={{ width: `${Math.min(100, progress?.progress || 0)}%` }} />
          </div>
          <span>{progress?.status || '生成中…'}</span>
        </div>
      )}

      {report && (
        <div className="annual-report-body" ref={reportRef}>
          {/* 总览 */}
          <div className="annual-hero" ref={(el) => registerSection(el, 0)}>
            <div className="annual-hero-year">{report.year}</div>
            <h3>这一年，我们聊了 {formatNum(report.totalMessages)} 条消息</h3>
            <p>与 {report.totalFriends} 位好友保持联系</p>
            <div className="stat-cards">
              <div className="stat-card">
                <span className="stat-label">
                  <MessageSquare size={11} /> 总消息
                </span>
                <b>
                  <CountUp value={report.totalMessages} format={formatNum} />
                </b>
              </div>
              <div className="stat-card">
                <span className="stat-label">
                  <Users size={11} /> 联系好友
                </span>
                <b>
                  <CountUp value={report.totalFriends} />
                </b>
              </div>
              <div className="stat-card">
                <span className="stat-label">
                  <CalendarDays size={11} /> 峰值日
                </span>
                <b>
                  <CountUp value={report.peakDay?.messageCount ?? 0} />
                </b>
                <span className="stat-sub">{report.peakDay?.date || ''}</span>
              </div>
              {report.longestStreak && (
                <div className="stat-card">
                  <span className="stat-label">
                    <Flame size={11} /> 最长连续
                  </span>
                  <b>
                    <CountUp value={report.longestStreak.days} />
                    <span style={{ fontSize: 13 }}> 天</span>
                  </b>
                  <span className="stat-sub">{report.longestStreak.friendName}</span>
                </div>
              )}
            </div>
          </div>

          {/* 核心好友 */}
          <div className="v09-panel annual-section" ref={(el) => registerSection(el, 1)}>
            <div className="v09-panel-head">
              <h3>
                <Trophy size={14} />
                年度核心好友
              </h3>
            </div>
            <div className="annual-core-friends">
              {report.coreFriends.slice(0, 3).map((f, i) => (
                <div key={f.username} className="annual-friend-card">
                  <span className="annual-friend-rank">{i + 1}</span>
                  <Avatar src={f.avatarUrl} name={f.displayName} size={44} shape="rounded" />
                  <span className="annual-friend-name">{f.displayName}</span>
                  <b>{formatNum(f.messageCount)}</b>
                  <span className="v09-sub">
                    发送 {formatNum(f.sentCount)} · 接收 {formatNum(f.receivedCount)}
                  </span>
                </div>
              ))}
            </div>
            {report.coreFriends.length > 3 && <ReactECharts option={coreFriendsOption} style={{ height: 240 }} notMerge />}
          </div>

          {/* 月度好友 + 活动热力图 */}
          <div className="chart-grid-2">
            <div className="v09-panel annual-section" ref={(el) => registerSection(el, 2)}>
              <div className="v09-panel-head">
                <h3>每月聊得最多的人</h3>
              </div>
              <div className="annual-monthly-list">
                {report.monthlyTopFriends.map((m) => (
                  <div key={m.month} className="annual-monthly-row">
                    <span className="annual-month">{m.month} 月</span>
                    <Avatar src={m.avatarUrl} name={m.displayName} size={20} shape="circle" />
                    <span className="annual-monthly-name">{m.displayName}</span>
                    <b>{formatNum(m.messageCount)}</b>
                  </div>
                ))}
              </div>
            </div>
            <div className="v09-panel annual-section" ref={(el) => registerSection(el, 3)}>
              <div className="v09-panel-head">
                <h3>全年活跃热力图</h3>
                <span className="v09-sub">每周 7 天 × 24 小时</span>
              </div>
              {heatmapOption && <ReactECharts option={heatmapOption} style={{ height: 260 }} notMerge />}
            </div>
          </div>

          {/* 趣味统计 */}
          <div className="annual-fun-grid">
            {report.midnightKing && (
              <div className="v09-panel annual-section" ref={(el) => registerSection(el, 4)}>
                <div className="v09-panel-head">
                  <h3>
                    <Moon size={14} />
                    深夜王者
                  </h3>
                </div>
                <div className="annual-fun-body">
                  <b>{report.midnightKing.displayName}</b>
                  <p>
                    深夜（0-5 点）陪你聊天 {report.midnightKing.count} 次，占全部深夜消息的 {report.midnightKing.percentage}%
                  </p>
                </div>
              </div>
            )}
            {report.mutualFriend && (
              <div className="v09-panel annual-section" ref={(el) => registerSection(el, 5)}>
                <div className="v09-panel-head">
                  <h3>互相奔赴</h3>
                </div>
                <div className="annual-fun-body">
                  <div className="annual-mutual">
                    <Avatar src={report.mutualFriend.avatarUrl} name={report.mutualFriend.displayName} size={34} shape="rounded" />
                    <div>
                      <b>{report.mutualFriend.displayName}</b>
                      <p>
                        你发送 {report.mutualFriend.sentCount} · TA 发送 {report.mutualFriend.receivedCount} · 双向占比 {report.mutualFriend.ratio}%
                      </p>
                    </div>
                  </div>
                </div>
              </div>
            )}
            {report.socialInitiative && (
              <div className="v09-panel annual-section" ref={(el) => registerSection(el, 6)}>
                <div className="v09-panel-head">
                  <h3>社交主动性</h3>
                </div>
                <div className="annual-fun-body">
                  <b>主动发起 {report.socialInitiative.initiatedChats} 次</b>
                  <p>
                    占比 {report.socialInitiative.initiativeRate}% · 最常主动联系 {report.socialInitiative.topInitiatedFriend || '–'}（
                    {report.socialInitiative.topInitiatedCount || 0} 次）
                  </p>
                </div>
              </div>
            )}
            {report.responseSpeed && (
              <div className="v09-panel annual-section" ref={(el) => registerSection(el, 7)}>
                <div className="v09-panel-head">
                  <h3>响应速度</h3>
                </div>
                <div className="annual-fun-body">
                  <b>平均 {formatDuration(report.responseSpeed.avgResponseTime)} 回复</b>
                  <p>
                    回复最快的是 {report.responseSpeed.fastestFriend}（{formatDuration(report.responseSpeed.fastestTime)}）
                  </p>
                </div>
              </div>
            )}
          </div>

          {/* 高频短语 + 朋友圈 */}
          <div className="chart-grid-2">
            <div className="v09-panel annual-section" ref={(el) => registerSection(el, 8)}>
              <div className="v09-panel-head">
                <h3>年度高频短语</h3>
              </div>
              <div className="phrase-list">
                {report.topPhrases.slice(0, 16).map((p, i) => (
                  <div key={i} className="phrase-row">
                    <span className="phrase-text">{p.phrase}</span>
                    <span className="phrase-count">{p.count}</span>
                  </div>
                ))}
              </div>
            </div>
            <div className="v09-panel annual-section" ref={(el) => registerSection(el, 9)}>
              <div className="v09-panel-head">
                <h3>
                  <ImageIcon size={14} />
                  朋友圈这一年
                </h3>
              </div>
              {report.snsStats ? (
                <div className="annual-sns-stats">
                  <div className="annual-sns-total">
                    <b>{formatNum(report.snsStats.totalPosts)}</b>
                    <span className="v09-sub">条朋友圈动态</span>
                  </div>
                  {report.snsStats.typeCounts && (
                    <div className="sns-type-chips">
                      {Object.entries(report.snsStats.typeCounts).map(([type, count]) => (
                        <span key={type} className="chip chip-active">
                          类型 {type} ×{count}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              ) : (
                <div className="wp-empty">该年度暂无朋友圈数据</div>
              )}
            </div>
          </div>

          {report.lostFriend && (
            <div className="v09-panel annual-section" ref={(el) => registerSection(el, 10)}>
              <div className="v09-panel-head">
                <h3>渐行渐远的好友</h3>
              </div>
              <div className="annual-fun-body">
                <div className="annual-mutual">
                  <Avatar src={report.lostFriend.avatarUrl} name={report.lostFriend.displayName} size={34} shape="rounded" />
                  <div>
                    <b>{report.lostFriend.displayName}</b>
                    <p>
                      {report.lostFriend.periodDesc} · 上半年 {report.lostFriend.earlyCount} 条，下半年 {report.lostFriend.lateCount} 条
                    </p>
                  </div>
                </div>
              </div>
            </div>
          )}

          <div className="annual-footer">
            <Download size={14} />
            报告由 Weport 本地生成 · 数据仅存储在你的设备
          </div>
        </div>
      )}
        </>
      )}
    </div>
  )
}


