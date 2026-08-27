import { useEffect, useState } from 'react'
import { Eye, EyeOff, KeyRound, Loader2 } from 'lucide-react'

/** 渲染侧安全状态（不含明文 key，与 vite-env.d.ts 的 weclone.getForcedProviderStatus 对齐） */
interface ForcedProviderStatus {
  providerId: string
  baseUrl: string
  model: string
  hasApiKey: boolean
  isForced: boolean
  activeProfileSummary?: {
    id: string
    name: string
    providerId: string
    baseUrl: string
    model: string
    hasApiKey: boolean
    apiKeyHint: string
  }
}

interface WeCloneForcedKeyProps {
  notify: (kind: 'ok' | 'err' | 'info', title: string, body?: string) => void
}

/** 强制 Provider API KEY 区（OpenCode Go · muse-spark-1.2-contributor） */
export default function WeCloneForcedKey({ notify }: WeCloneForcedKeyProps) {
  const [forcedKey, setForcedKey] = useState('')
  const [showForcedKey, setShowForcedKey] = useState(false)
  const [savingKey, setSavingKey] = useState(false)
  const [forcedStatus, setForcedStatus] = useState<ForcedProviderStatus | null>(null)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const fp = await window.electronAPI.weclone.getForcedProviderStatus()
        if (!cancelled && fp) setForcedStatus(fp)
      } catch {
        /* 保持默认空值 */
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  /** 保存强制 API Key → 锁定 opencode-go / muse-spark-1.2-contributor */
  async function handleSaveForcedKey() {
    if (savingKey) return
    const apiKey = forcedKey.trim()
    setSavingKey(true)
    try {
      const r = await window.electronAPI.weclone.setForcedApiKey({ apiKey })
      if (r.success && r.status) {
        setForcedStatus(r.status)
        setForcedKey('')
        notify(
          'ok',
          'OpenCode Go API Key 已保存',
          `WeClone 生成已锁定 ${r.status.model}${r.status.activeProfileSummary ? ` · ${r.status.activeProfileSummary.apiKeyHint}` : ''}`
        )
      } else {
        notify('err', 'API Key 保存失败', r.error || '未知错误')
      }
    } catch (e) {
      notify('err', 'API Key 保存失败', String(e))
    } finally {
      setSavingKey(false)
    }
  }

  const forcedPill = forcedStatus?.isForced
    ? `LOCKED · ${forcedStatus.activeProfileSummary?.apiKeyHint || 'KEY SET'}`
    : forcedStatus?.hasApiKey
      ? `KEY · ${forcedStatus.activeProfileSummary?.apiKeyHint || 'SET'}`
      : 'NO KEY'

  return (
    <div className="exp-section weclone-exp">
      <div className="weclone-apikey">
        <div className="weclone-exp-head">
          <span className="weclone-exp-title">
            <KeyRound size={13} />
            OpenCode Go API Key · muse-spark-1.2-contributor
          </span>
          <span className={`weclone-apikey-status${forcedStatus?.hasApiKey ? ' set' : ''}`} title={forcedPill}>
            {forcedPill}
          </span>
        </div>
        <div className="weclone-input-row">
          <input
            className="path-input"
            type={showForcedKey ? 'text' : 'password'}
            value={forcedKey}
            placeholder={forcedStatus?.hasApiKey ? '已保存密钥 · 输入新值可覆盖' : '粘贴 OpenCode Go API Key'}
            onChange={(e) => setForcedKey(e.target.value)}
            spellCheck={false}
            autoComplete="off"
            aria-label="OpenCode Go API Key · muse-spark-1.2-contributor"
          />
          <button
            className="ghost-btn icon-btn-sm"
            type="button"
            onClick={() => setShowForcedKey((v) => !v)}
            title={showForcedKey ? '隐藏密钥' : '显示密钥'}
            aria-label={showForcedKey ? '隐藏密钥' : '显示密钥'}
          >
            {showForcedKey ? <EyeOff size={14} /> : <Eye size={14} />}
          </button>
          <button
            className="primary-btn weclone-save-key"
            type="button"
            disabled={savingKey}
            onClick={() => void handleSaveForcedKey()}
          >
            {savingKey ? <Loader2 size={12} className="spin" /> : <KeyRound size={12} />}
            {savingKey ? '保存中…' : '保存 KEY'}
          </button>
        </div>
        <p className="hint" style={{ margin: 0 }}>
          设置后 WeClone 生成阶段将强制使用该密钥调用 OpenCode Go（muse-spark-1.2-contributor）；
          不影响 WeportAI 页面自身的服务配置。
        </p>
      </div>
    </div>
  )
}
