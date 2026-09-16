import { useEffect, useState } from 'react'
import { Cpu, ShieldCheck } from 'lucide-react'

/**
 * 人格克隆**实际在用哪个 AI 服务**（只读）。
 *
 * v1.0 之前这里是一个「OpenCode Go API Key · muse-spark-1.2-contributor」的密钥
 * 输入框：人格克隆被硬编码锁在那个网关上，用户既改不了也看不懂，而这个网关在本机
 * 是按地区拒绝的 —— 于是人格克隆永远报 "Internal server error"，用户的第一反应
 * 只能是"为什么这里会有 muse spark 这个模型"。
 *
 * 现在人格克隆**没有自己的服务**：它和 WeportAI / WeBot 共用「设置 → AI 服务」里
 * 用户配好的那一份（默认跟随默认服务）。所以这一块不再需要任何输入控件，只需要
 * 把"当前用的是谁"如实显示出来，并提供改它的入口指向。
 */
interface ConsumerAssignment {
  consumer: string
  profileName: string
  providerId: string
  model: string
  followsDefault: boolean
}

export default function WeCloneModelCard() {
  const [assignment, setAssignment] = useState<ConsumerAssignment | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const res = await window.electronAPI.ai.getConsumerAssignments()
        if (cancelled) return
        const list = (res?.consumers || []) as ConsumerAssignment[]
        setAssignment(list.find((item) => item.consumer === 'weclone') || null)
      } catch {
        if (!cancelled) setFailed(true)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  const model = assignment?.model || ''
  const label = model ? `${assignment?.profileName || assignment?.providerId} · ${model}` : ''

  return (
    <div className="weclone-model-card">
      <div className="weclone-model-head">
        <span className="weclone-model-title">
          <Cpu size={13} />
          生成与对话用的服务
        </span>
        <span className={`weclone-model-pill${model ? ' set' : ''}`}>
          {model ? (assignment?.followsDefault ? '跟随默认服务' : '已单独指定') : '未配置'}
        </span>
      </div>
      <p className="weclone-model-value">
        {failed ? (
          '读取 AI 服务配置失败，请到「设置 → AI 服务」确认。'
        ) : label ? (
          <code>{label}</code>
        ) : (
          <>
            还没有可用的 AI 服务。到
            <strong>「设置 → AI 服务」</strong>
            添加一个提供商与密钥，WeClone 会直接用它。
          </>
        )}
      </p>
      <p className="hint weclone-model-hint">
        <ShieldCheck size={12} />
        <span>
          WeClone 与 WeportAI、WeBot 共用这一份配置；聊天记录、人格档案与语料始终
          <strong>只在本机</strong>，只有发给这个模型的那一次请求会出网。
        </span>
      </p>
    </div>
  )
}
