import { useCallback, useEffect, useState } from 'react'
import { Loader2, MessageSquareX, ShieldAlert, Sparkles } from 'lucide-react'
import type { WeCloneListItem } from '../../types/weclone'

/**
 * 单个克隆自己的设置（v1.0.1）。
 *
 * 用户的要求是把"要不要拒答"变成**每个克隆各自的开关**：给同事看的那份
 * 克隆该有分寸，自己跟自己聊的那份可以完全不设限。所以设置存在克隆目录里
 * （`settings.json`），跟着它的档案和语料一起生灭 —— 删掉克隆，设置也一起消失，
 * 不会留下找不到主人的配置。
 *
 * 界面上刻意把两种模式写成**会发生什么**而不是"开/关"：
 * 「以本人的方式带过去」vs「什么都不回避」。因为这里改的是模型的行为，
 * 用"开启/关闭"这种词没人能预料到点了会发生什么。
 */
interface Props {
  clone: WeCloneListItem
  onClose: () => void
  /**
   * 这个 clone id 在本机已经不存在了（重新生成过克隆 → id 变了）。
   *
   * 必须让上层知道：否则界面会停在一张过期的卡片上，而每次「保存」都只是
   * 静默回滚 —— 用户看到的是"设置改不动"，而不是"你看的是上一版克隆"。
   * 实测就是这么发生的。
   */
  onStale?: () => void
}

export default function WeCloneSettingsPanel({ clone, onClose, onStale }: Props) {
  const api = window.electronAPI
  const [refusal, setRefusal] = useState<WeCloneRefusalMode>('character')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  /** "找不到该克隆" 是**过期**信号，不是普通保存失败 —— 分开处理 */
  const isStaleError = (message: string): boolean => /找不到该克隆|克隆目录已丢失/.test(String(message || ''))

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    void (async () => {
      try {
        const result = await api.weclone.getSettings(clone.id)
        if (cancelled) return
        if (result.success && result.settings) {
          setRefusal(result.settings.refusal)
        } else if (result.error) {
          if (isStaleError(result.error)) onStale?.()
          else setError(result.error)
        }
      } catch (e) {
        if (!cancelled) setError(String(e))
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [api, clone.id, onStale])

  const change = useCallback(
    async (next: WeCloneRefusalMode) => {
      if (saving || next === refusal) return
      const previous = refusal
      // 乐观更新：这个开关是本地文件写入，慢了会让人觉得没反应；
      // 失败时回滚到上一个值，而不是留一个和磁盘不一致的界面。
      setRefusal(next)
      setSaving(true)
      setError('')
      try {
        const result = await api.weclone.setSettings(clone.id, { refusal: next })
        if (!result.success) {
          setRefusal(previous)
          // 过期不是"保存失败"，别让用户以为是磁盘或者权限的问题
          if (isStaleError(result.error || '')) onStale?.()
          else setError(result.error || '保存失败')
        } else if (result.settings) {
          setRefusal(result.settings.refusal)
        }
      } catch (e) {
        setRefusal(previous)
        setError(String(e))
      } finally {
        setSaving(false)
      }
    },
    [api, clone.id, refusal, saving, onStale]
  )

  return (
    <div className="wp-overlay" onClick={() => !saving && onClose()}>
      <div className="wp-dialog weclone-settings-dialog" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <div className="wp-dialog-icon">
          <Sparkles size={20} />
        </div>
        <h3 className="wp-dialog-title">「{clone.displayName || clone.id}」的行为设置</h3>
        <p className="wp-dialog-desc">
          这些设置只影响这一个克隆，存在它的档案目录里；重新生成会回到默认值。
        </p>

        {loading ? (
          <div className="weclone-settings-loading">
            <Loader2 size={16} className="spin" />
            <span>正在读取设置…</span>
          </div>
        ) : (
          <div className="weclone-settings-body">
            <div className="weclone-settings-label">
              <ShieldAlert size={14} />
              <span>敏感话题</span>
            </div>
            <div className="weclone-refusal-options" role="radiogroup" aria-label="敏感话题">
              <button
                type="button"
                role="radio"
                aria-checked={refusal === 'character'}
                className="weclone-refusal-option"
                data-active={refusal === 'character'}
                disabled={saving}
                onClick={() => void change('character')}
              >
                <strong>以本人的方式带过去</strong>
                <span>
                  被问到证件号、住址、或要你评价某个人的感情时，用自己的语气把话岔开。
                  这是默认值，也是最像真人的一种。
                </span>
              </button>
              <button
                type="button"
                role="radio"
                aria-checked={refusal === 'off'}
                className="weclone-refusal-option"
                data-active={refusal === 'off'}
                disabled={saving}
                onClick={() => void change('off')}
              >
                <strong>什么都不回避</strong>
                <span>
                  提示词里完全不出现"有些事你不说"，问什么答什么。
                  留意：如果生成时关掉了脱敏，语料里的原文就都在档案里。
                </span>
              </button>
            </div>

            {refusal === 'off' && (
              <p className="weclone-settings-warn">
                <MessageSquareX size={12} />
                <span>这个克隆不再主动回避任何话题。它仍然只在本机运行，但回答里可能出现你原本不会说的话。</span>
              </p>
            )}
            {error && <p className="weclone-settings-error">{error}</p>}
          </div>
        )}

        <div className="wp-dialog-actions">
          <button className="secondary-btn" type="button" disabled={saving} onClick={onClose}>
            {saving ? '保存中…' : '完成'}
          </button>
        </div>
      </div>
    </div>
  )
}
