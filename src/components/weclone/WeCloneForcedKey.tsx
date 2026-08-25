import { useEffect, useState } from 'react'
import { ChevronDown, Cpu, Eye, EyeOff, KeyRound, Loader2 } from 'lucide-react'

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

/** 强制 Provider API KEY 区（OpenCode Go）+ 克隆模型选择 */
export default function WeCloneForcedKey({ notify }: WeCloneForcedKeyProps) {
  const [forcedKey, setForcedKey] = useState('')
  const [showForcedKey, setShowForcedKey] = useState(false)
  const [savingKey, setSavingKey] = useState(false)
  const [forcedStatus, setForcedStatus] = useState<ForcedProviderStatus | null>(null)
  const [catalog, setCatalog] = useState<string[]>([])
  const [catalogError, setCatalogError] = useState('')
  const [modelValue, setModelValue] = useState('')
  const [savingModel, setSavingModel] = useState(false)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const fp = await window.electronAPI.weclone.getForcedProviderStatus()
        if (!cancelled && fp) setForcedStatus(fp)
      } catch {
        /* 保持默认空值 */
      }
      try {
        const override = await window.electronAPI.weclone.getModelOverride()
        if (!cancelled) setModelValue(String(override || ''))
      } catch {
        /* 保持默认空值 */
      }
      try {
        const cat = await window.electronAPI.weclone.getModelCatalog()
        if (!cancelled && cat.success && cat.models) setCatalog(cat.models)
        else if (!cancelled) setCatalogError(cat.error || '模型目录拉取失败')
      } catch (e) {
        if (!cancelled) setCatalogError(String(e))
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  /** 保存强制 API Key → 锁定 opencode-go */
  async function handleSaveForcedKey() {
    if (savingKey) return
    const apiKey = forcedKey.trim()
    setSavingKey(true)
    try {
      const r = await window.electronAPI.weclone.setForcedApiKey({ apiKey })
      if (r.success && r.status) {
        setForcedStatus(r.status)
        setForcedKey('')
        notify('ok', 'OpenCode Go API Key 已保存', `WeClone 将通过该 Key 调用 OpenCode Go${r.status.activeProfileSummary ? ` · ${r.status.activeProfileSummary.apiKeyHint}` : ''}`)
      } else {
        notify('err', 'API Key 保存失败', r.error || '未知错误')
      }
    } catch (e) {
      notify('err', 'API Key 保存失败', String(e))
    } finally {
      setSavingKey(false)
    }
  }

  /** 保存克隆模型覆盖（空 = 默认 muse-spark-1.2-contributor） */
  async function handleSaveModel() {
    if (savingModel) return
    setSavingModel(true)
    try {
      const r = await window.electronAPI.weclone.setModelOverride(modelValue.trim())
      if (r.success) {
        notify('ok', '克隆模型已更新', r.model ? `WeClone 本地对话/生成立即改用 ${r.model}` : '已恢复默认模型 muse-spark-1.2-contributor')
      } else {
        notify('err', '模型设置失败', '写入配置失败')
      }
    } catch (e) {
      notify('err', '模型设置失败', String(e))
    } finally {
      setSavingModel(false)
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
            OpenCode Go API Key
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
            aria-label="OpenCode Go API Key"
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
          设置后 WeClone 生成阶段将强制使用该密钥调用 OpenCode Go；不影响 WeportAI 页面自身的服务配置。
        </p>

        <div className="weclone-model-row" style={{ marginTop: 10 }}>
          <div className="weclone-exp-head">
            <span className="weclone-exp-title">
              <Cpu size={13} />
              克隆模型
            </span>
            <span className={`weclone-apikey-status${modelValue ? '' : ' set'}`}>
              {modelValue || '默认 muse-spark-1.2'}
            </span>
          </div>
          <div className="weclone-input-row">
            {catalog.length > 0 ? (
              <div className="weclone-select-wrap" style={{ position: 'relative', flex: 1, minWidth: 0 }}>
                <select
                  className="path-input"
                  value={catalog.includes(modelValue) ? modelValue : ''}
                  onChange={(e) => setModelValue(e.target.value)}
                  aria-label="选择克隆模型"
                  style={{ appearance: 'none', paddingRight: 26 }}
                >
                  <option value="">（默认）muse-spark-1.2-contributor</option>
                  {catalog.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
                <ChevronDown size={13} style={{ position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)', pointerEvents: 'none', opacity: 0.6 }} />
              </div>
            ) : (
              <input
                className="path-input"
                type="text"
                value={modelValue}
                placeholder={catalogError ? `目录不可用（${catalogError.slice(0, 40)}…），手动输入模型 id` : '加载模型列表…或手动输入模型 id'}
                onChange={(e) => setModelValue(e.target.value)}
                spellCheck={false}
                autoComplete="off"
                aria-label="克隆模型 id"
              />
            )}
            <button
              className="primary-btn weclone-save-key"
              type="button"
              disabled={savingModel}
              onClick={() => void handleSaveModel()}
            >
              {savingModel ? <Loader2 size={12} className="spin" /> : <Cpu size={12} />}
              {savingModel ? '应用中…' : '应用模型'}
            </button>
          </div>
          <p className="hint" style={{ margin: 0 }}>
            留空 = 默认 muse-spark-1.2-contributor。本地对话、克隆生成与服务器分享全部使用同一模型；
            更换后建议重新生成克隆以保持语气一致。
          </p>
        </div>
      </div>
    </div>
  )
}
