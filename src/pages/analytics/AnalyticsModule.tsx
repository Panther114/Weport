import { ArrowLeft, ArrowRight, BarChart3, CalendarDays, LineChart, UserRound, Users } from 'lucide-react'
import { GlobalAnalytics } from './GlobalAnalytics'
import { GroupAnalytics } from './GroupAnalytics'
import { AnnualReportView } from './AnnualReportView'
import { DualReportView } from './DualReportView'

export type AnalyticsSection = 'hub' | 'global' | 'group' | 'annual' | 'dual'

interface AnalyticsModuleProps {
  section: AnalyticsSection
  onSectionChange: (section: AnalyticsSection) => void
}

export default function AnalyticsModule({ section, onSectionChange }: AnalyticsModuleProps) {
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
            <div className="analytics-big-desc">全部聊天 · 总体统计、时段分布与联系人排行榜</div>
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
            <div className="analytics-big-desc">单个群聊 · 成员排行榜、活跃热力图与媒体构成</div>
            <div className="analytics-big-arrow">
              进入分析
              <ArrowRight size={15} />
            </div>
          </button>
          <button type="button" className="analytics-big-card" onClick={() => onSectionChange('annual')}>
            <div className="analytics-big-icon">
              <CalendarDays size={40} strokeWidth={1.4} />
            </div>
            <div className="analytics-big-title">年度报告</div>
            <div className="analytics-big-desc">按年份回顾消息趋势、核心好友、活跃时段与年度片段</div>
            <div className="analytics-big-arrow">
              选择年份
              <ArrowRight size={15} />
            </div>
          </button>
          <button type="button" className="analytics-big-card" onClick={() => onSectionChange('dual')}>
            <div className="analytics-big-icon">
              <UserRound size={40} strokeWidth={1.4} />
            </div>
            <div className="analytics-big-title">双人报告</div>
            <div className="analytics-big-desc">选择一位好友，生成你们的专属聊天趋势与关系回顾</div>
            <div className="analytics-big-arrow">
              选择好友
              <ArrowRight size={15} />
            </div>
          </button>
        </div>
      </div>
    )
  }

  if (section === 'annual') {
    return <AnnualReportView onClose={() => onSectionChange('hub')} />
  }

  if (section === 'dual') {
    return <DualReportView onBack={() => onSectionChange('hub')} defaultYear={0} />
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
          <button type="button" className="chip" onClick={() => onSectionChange('hub')}>
            <ArrowLeft size={14} />
            返回选择
          </button>
        </div>
      </div>

      {section === 'global' ? (
        <GlobalAnalytics />
      ) : (
        <GroupAnalytics />
      )}
    </div>
  )
}
