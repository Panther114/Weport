import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  AlertTriangle,
  Check,
  Info,
  Loader2,
  MessageSquareX,
  ShieldAlert,
  Sparkles,
  Wand2,
} from 'lucide-react'
import type { WeCloneListItem, WeCloneVoiceReview } from '../../types/weclone'
import {
  WECLONE_STYLES,
  WECLONE_STYLE_NOTE_MAX_CHARS,
  normalizeWeCloneStyle,
  normalizeWeCloneStyleNote,
  type WeCloneStylePreset,
} from '../../utils/weCloneStyle'

/**
 * 单个克隆自己的设置（v1.0.1，v1.3.3 扩展）。
 *
 * 用户的要求是把"要不要拒答"变成**每个克隆各自的开关**：给同事看的那份
 * 克隆该有分寸，自己跟自己聊的那份可以完全不设限。所以设置存在克隆目录里
 * （`settings.json`），跟着它的档案和语料一起生灭 —— 删掉克隆，设置也一起消失，
 * 不会留下找不到主人的配置。
 *
 * v1.3.3 增加两层：
 *   1. **说话复盘**：纯本地统计本人原话 + 分身历史回复，指出偏长、助手腔、
 *      结构化、语言不跟随、复读等问题（不调用模型）；
 *   2. **表达风格**：自然轻松 / 温柔 / 幽默 / 简洁 / 认真 + 一句补充要求。
 *      只改"怎么说"，不改身份与记忆，同时作用于 WeClone 对话和阅读器草稿。
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

type Busy = '' | 'refusal' | 'style' | 'note'

export default function WeCloneSettingsPanel({ clone, onClose, onStale }: Props) {
  const api = window.electronAPI
  const [refusal, setRefusal] = useState<WeCloneRefusalMode>('character')
  const [style, setStyle] = useState<WeCloneStylePreset>('original')
  const [styleNote, setStyleNote] = useState('')
  const [savedNote, setSavedNote] = useState('')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<Busy>('')
  const [error, setError] = useState('')
  const [noteNotice, setNoteNotice] = useState('')
  const [review, setReview] = useState<WeCloneVoiceReview | null>(null)
  const [reviewLoading, setReviewLoading] = useState(false)
  const [reviewError, setReviewError] = useState('')

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
          setStyle(normalizeWeCloneStyle(result.settings.style))
          const note = normalizeWeCloneStyleNote(result.settings.styleNote)
          setStyleNote(note)
          setSavedNote(note)
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

  const patch = useCallback(
    async (next: Parameters<typeof api.weclone.setSettings>[1], kind: Busy) => {
      setBusy(kind)
      setError('')
      try {
        const result = await api.weclone.setSettings(clone.id, next)
        if (!result.success) {
          if (isStaleError(result.error || '')) onStale?.()
          else setError(result.error || '保存失败')
          return null
        }
        return result.settings || null
      } catch (e) {
        setError(String(e))
        return null
      } finally {
        setBusy('')
      }
    },
    [api, clone.id, onStale]
  )

  const changeRefusal = useCallback(
    async (next: WeCloneRefusalMode) => {
      if (busy || next === refusal) return
      const previous = refusal
      // 乐观更新：本地文件写入，慢了会让人觉得没反应；失败时回滚。
      setRefusal(next)
      const saved = await patch({ refusal: next }, 'refusal')
      if (!saved) setRefusal(previous)
      else setRefusal(saved.refusal)
    },
    [busy, refusal, patch]
  )

  const changeStyle = useCallback(
    async (next: WeCloneStylePreset) => {
      if (busy || next === style) return
      const previous = style
      setStyle(next)
      const saved = await patch({ style: next }, 'style')
      if (!saved) setStyle(previous)
      else setStyle(normalizeWeCloneStyle(saved.style))
    },
    [busy, style, patch]
  )

  const saveNote = useCallback(async () => {
    const clean = normalizeWeCloneStyleNote(styleNote)
    if (busy || clean === savedNote) return
    setNoteNotice('')
    const saved = await patch({ styleNote: clean }, 'note')
    if (saved) {
      const value = normalizeWeCloneStyleNote(saved.styleNote)
      setStyleNote(value)
      setSavedNote(value)
      setNoteNotice('已保存')
    }
  }, [busy, patch, savedNote, styleNote])

  const analyze = useCallback(async () => {
    if (reviewLoading) return
    setReviewLoading(true)
    setReviewError('')
    try {
      const result = await api.weclone.analyzeVoice(clone.id)
      if (!result.success || !result.review) throw new Error(result.error || '复盘失败')
      setReview(result.review)
    } catch (e) {
      setReviewError(e instanceof Error ? e.message : String(e))
    } finally {
      setReviewLoading(false)
    }
  }, [api, clone.id, reviewLoading])

  const activeStyle = useMemo(
    () => WECLONE_STYLES.find((item) => item.id === style) || WECLONE_STYLES[0],
    [style]
  )
  const noteDirty = normalizeWeCloneStyleNote(styleNote) !== savedNote
  const anyBusy = busy !== ''

  return (
    <div className="wp-overlay" onClick={() => !anyBusy && onClose()}>
      <div className="wp-dialog weclone-settings-dialog" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <div className="wp-dialog-icon">
          <Sparkles size={20} />
        </div>
        <h3 className="wp-dialog-title">「{clone.displayName || clone.id}」的说话调整</h3>
        <p className="wp-dialog-desc">
          这些设置只影响这一个克隆，存在它的档案目录里；重新生成会回到默认值。
          风格同时作用于 WeClone 对话和阅读器的回复草稿。
        </p>

        {loading ? (
          <div className="weclone-settings-loading">
            <Loader2 size={16} className="spin" />
            <span>正在读取设置…</span>
          </div>
        ) : (
          <div className="weclone-settings-body">
            {/* ---------------------------------------------------------- 复盘 */}
            <div className="weclone-settings-label">
              <Wand2 size={14} />
              <span>说话复盘</span>
            </div>
            <p className="weclone-settings-hint">
              对比「本人原话」和「分身实际回复」，找出偏长、助手腔、结构化、语言不跟随、复读等问题。
              纯本机统计，不调用模型、不上传内容。
            </p>
            <button
              type="button"
              className="secondary-btn weclone-review-run"
              disabled={reviewLoading}
              onClick={() => void analyze()}
            >
              {reviewLoading ? <><Loader2 size={13} className="spin" />正在分析…</> : review ? '重新分析' : '分析之前的说话方式'}
            </button>
            {reviewError && <p className="weclone-settings-error" role="alert">{reviewError}</p>}
            {review && <div className="weclone-review">
              <p className="weclone-review-summary">{review.summary}</p>
              <div className="weclone-review-metrics">
                <span>本人中位 {review.metrics.voiceMedianLength} 字</span>
                <span>分身中位 {review.metrics.replyMedianLength} 字</span>
                {review.metrics.replyToVoiceRatio > 0 && <span>约 {review.metrics.replyToVoiceRatio.toFixed(1)}×</span>}
                <span>助手腔 {Math.round(review.metrics.assistantToneRate * 100)}%</span>
                <span>结构化 {Math.round(review.metrics.structureRate * 100)}%</span>
              </div>
              {review.issues.length > 0 && <div className="weclone-review-block">
                <strong>发现的问题</strong>
                {review.issues.map((issue) => (
                  <div className="weclone-review-issue" key={issue.id} data-severity={issue.severity}>
                    <span className="weclone-review-issue-title">
                      {issue.severity === 'warn' ? <AlertTriangle size={12} /> : <Info size={12} />}
                      {issue.title}
                    </span>
                    <span>{issue.detail}</span>
                    {issue.evidence && issue.evidence.length > 0 && (
                      <span className="weclone-review-evidence">{issue.evidence.join(' · ')}</span>
                    )}
                  </div>
                ))}
              </div>}
              {review.cautions.length > 0 && <div className="weclone-review-block">
                <strong>注意什么</strong>
                <ul>{review.cautions.map((item, index) => <li key={index}>{item}</li>)}</ul>
              </div>}
              {review.suggestions.length > 0 && <div className="weclone-review-block">
                <strong>之后怎么做</strong>
                <ul>{review.suggestions.map((item, index) => <li key={index}>{item}</li>)}</ul>
              </div>}
            </div>}

            {/* ---------------------------------------------------------- 风格 */}
            <div className="weclone-settings-label">
              <Sparkles size={14} />
              <span>表达风格</span>
            </div>
            <p className="weclone-settings-hint">
              只改"怎么说"，不改身份、记忆和愿不愿意说。长度约束仍然优先于风格。
            </p>
            <div className="weclone-style-options" role="radiogroup" aria-label="表达风格">
              {WECLONE_STYLES.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  role="radio"
                  aria-checked={style === option.id}
                  className="weclone-style-option"
                  data-active={style === option.id}
                  disabled={anyBusy}
                  onClick={() => void changeStyle(option.id)}
                >
                  <span className="weclone-style-option-head">
                    <strong>{option.label}</strong>
                    <span>{option.short}</span>
                    {style === option.id && <Check size={13} />}
                  </span>
                  {style === option.id && <span className="weclone-style-option-desc">{option.description}</span>}
                </button>
              ))}
            </div>

            <label className="weclone-style-note">
              <span>补充表达要求（可选）</span>
              <textarea
                value={styleNote}
                maxLength={WECLONE_STYLE_NOTE_MAX_CHARS}
                rows={3}
                placeholder="写做法，不要写例句。例如：少用感叹号，不要主动问对方在做什么。"
                onChange={(event) => { setStyleNote(event.target.value); setNoteNotice('') }}
                onBlur={() => void saveNote()}
                disabled={anyBusy}
              />
            </label>
            <div className="weclone-style-note-actions">
              <span className="weclone-settings-hint">
                {styleNote.length}/{WECLONE_STYLE_NOTE_MAX_CHARS}
                {noteDirty ? ' · 未保存' : noteNotice ? ` · ${noteNotice}` : ''}
              </span>
              <button
                type="button"
                className="secondary-btn"
                disabled={anyBusy || !noteDirty}
                onClick={() => void saveNote()}
              >
                {busy === 'note' ? '保存中…' : '保存补充要求'}
              </button>
            </div>
            <p className="weclone-settings-hint">
              当前生效：{activeStyle.label}
              {activeStyle.id === 'original' && !savedNote ? '（不额外调整）' : ''}。
              风格会写进 system prompt；补充要求与它冲突时，以身份、记忆与长度约束为准。
            </p>

            {/* ---------------------------------------------------------- 拒答 */}
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
                disabled={anyBusy}
                onClick={() => void changeRefusal('character')}
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
                disabled={anyBusy}
                onClick={() => void changeRefusal('off')}
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
          <button className="secondary-btn" type="button" disabled={anyBusy} onClick={onClose}>
            {anyBusy ? '保存中…' : '完成'}
          </button>
        </div>
      </div>
    </div>
  )
}
