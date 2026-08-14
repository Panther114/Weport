import { useState } from 'react'
import { ArrowLeft, ArrowRight, BarChart3, LineChart, Users } from 'lucide-react'
import { GlobalAnalytics } from './GlobalAnalytics'
import { GroupAnalytics } from './GroupAnalytics'
import { AnnualReportView } from './AnnualReportView'

export type AnalyticsSection = 'hub' | 'global' | 'group'

interface AnalyticsModuleProps {
  section: AnalyticsSection
  onSectionChange: (section: AnalyticsSection) => void
}

export default function AnalyticsModule({ section, onSectionChange }: AnalyticsModuleProps) {
  const [annualOpen, setAnnualOpen] = useState(false)

  if (section === 'hub') {
    return (
      <div className="v09-page analytics-hub">
        <div className="analytics-hub-hero">
          <div className="analytics-hub-icon">
            <LineChart size={26} strokeWidth={1.8} />
          </div>
          <h2>微信数据分析</h2>
          <p>基于本地聊天记录的全量统计 · 不上传任何数据</p>
        </div>
        <div className="analytics-hub-cards">
          <button type="button" className="analytics-big-card" onClick={() => onSectionChange('global')}>
            <div className="analytics-big-icon">
              <BarChart3 size={44} strokeWidth={1.4} />
            </div>
            <div className="analytics-big-title">全局分析</div>
            <div className="analytics-big-desc">全部聊天 · 总体统计、时段分布、联系排行榜、年度报告</div>
            <div className="analytics-big-arrow">
              进入分析
              <ArrowRight size={15} />
            </div>
          </button>
          <button type="button" className="analytics-big-card" onClick={() => onSectionChange('group')}>
            <div className="analytics-big-icon">
              <Users size={44} strokeWidth={1.4} />
            </div>
            <div className="analytics-big-title">群聊分析</div>
            <div className="analytics-big-desc">单个群聊 · 成员排行榜、活跃热力图、媒体构成、成员画像</div>
            <div className="analytics-big-arrow">
              进入分析
              <ArrowRight size={15} />
            </div>
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="v09-page analytics-page">
      <div className="v09-toolbar">
        <div className="v09-toolbar-title">
          <LineChart size={17} />
          <span>{section === 'global' ? '全局分析' : '群聊分析'}</span>
          <span className="v09-sub">{section === 'global' ? '全部私聊会话的确定性统计' : '单群成员与活跃度统计'}</span>
        </div>
        <div className="v09-actions">
          {section === 'global' && (
            <button type="button" className="chip chip-active" onClick={() => setAnnualOpen((v) => !v)}>
              <LineChart size={14} />
              年度报告
            </button>
          )}
          <button type="button" className="chip" onClick={() => onSectionChange('hub')}>
            <ArrowLeft size={14} />
            返回选择
          </button>
        </div>
      </div>

      {section === 'global' ? (
        <GlobalAnalytics annualOpen={annualOpen} onAnnualClose={() => setAnnualOpen(false)} />
      ) : (
        <GroupAnalytics />
      )}
      {annualOpen && <AnnualReportView onClose={() => setAnnualOpen(false)} />}
    </div>
  )
}
