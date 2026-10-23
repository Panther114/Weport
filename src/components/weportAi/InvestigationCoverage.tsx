import '../v13Controls.css'
import { useMemo } from 'react'
import { latestInvestigationCoverage } from './coverageState'

interface Step { toolCalls?: Array<{ name: string; result?: string }> }
export default function InvestigationCoverage({ messages }: { messages: Step[] }) {
  const coverage = useMemo(() => latestInvestigationCoverage(messages), [messages])
  if (!coverage) return <section className="ai-inspector-empty"><h3>调查覆盖</h3><p>读取或搜索聊天后，这里会显示最近一次工具返回的范围与覆盖说明。</p></section>
  const time = (value: unknown, seconds = false) => typeof value === 'number' && value > 0 ? new Date(value * (seconds ? 1000 : 1)).toLocaleString() : '未限定'
  const data = coverage.data
  return <section className="ai-investigation-coverage v13-controls" aria-label="调查范围与覆盖状态">
    <h3>调查覆盖</h3><p className="ai-inspector-intro">最近一次读取的范围，不代表整个调查已完成。</p>
    {coverage.kind === 'page' ? <>
      <p>最近读取页：{data.returned} 条，偏移 {data.offset}。{data.error ? '本次读取失败，覆盖未知。' : data.hasMore ? '仍有未读取页面。' : '已到所请求窗口的末尾。'}</p>
      <p>请求：{time(data.requestedStart, true)} – {time(data.requestedEnd, true)}</p>
      <p>实际读取：{time(data.inspectedStart, true)} – {time(data.inspectedEnd, true)}；快照 {time(data.snapshotTime)}。</p>
      <p>这是一页消息的范围，不代表其他会话、时间段或之前失败的读取已完成。</p>
    </> : coverage.kind === 'sample' ? <>
      <p>分层样本：返回 {data.returned} 条，快照 {time(data.snapshotTime)}；不代表全量覆盖。</p>
      <p>请求：{time(data.requestedStart, true)} – {time(data.requestedEnd, true)}。{data.truncated ? '仍有未返回消息。' : ''}</p>
      {data.failedWindows?.length ? <p>读取失败的窗口：{data.failedWindows.length} 个。失败不等于没有消息。</p> : null}
    </> : coverage.kind === 'images' ? <>
      <p>图片扫描：{data.scanned ?? 0} 条消息，选中 {data.returned ?? 0} 张，附上 {data.attached ?? 0} 张。{data.hasMore || !data.complete ? '仍有未检查或不可用的来源。' : '已扫描所请求窗口。'}</p>
      <p>图片消息引用可定位来源，附件不可用时不能判断图片内容。快照 {time(data.snapshotTime)}。</p>
    </> : coverage.kind === 'aggregate' ? <>
      <p>派生统计快照：{time(data.snapshotTime)}。{data.mayUseStaleCache ? '结果可能使用缓存。' : ''}统计不能替代消息原文证据。</p>
      {data.missingSessions?.length ? <p>未取得统计的会话：{data.missingSessions.length} 个。</p> : null}
      {data.error ? <p>本次统计读取失败，覆盖未知。</p> : null}
    </> : coverage.kind === 'search' ? <>
      <p>搜索索引：{data.indexedDocuments} 条消息；建立于 {time(data.indexedAt)}。{data.stale ? '索引已落后于来源。' : ''}</p>
      <p>{data.complete && !data.truncated ? '已扫描本次查询的全部索引候选。' : '本次结果或索引覆盖不完整。'} 命中不代表读取了全部原文。</p>
      {Array.isArray(data.failedTables) && data.failedTables.length ? <p>未完成来源：{data.failedTables.join('、')}</p> : null}
    </> : <p>此工具没有返回可解析的结构化范围，或结果被截断。完整覆盖未知，不能据此声称检查了全部历史。</p>}
  </section>
}
