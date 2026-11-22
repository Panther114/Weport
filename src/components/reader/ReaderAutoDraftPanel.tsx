import { useCallback, useEffect, useRef, useState } from 'react'
import { ChevronDown, Copy, Info, Loader2, Pause, Play, RefreshCw, Sparkles } from 'lucide-react'
import { copyTextToClipboard } from '../../utils/clipboard'
import { readerDraftClones, type ReaderDraftClone } from './readerDraftContext'
import {
  READER_DRAFT_RANGES,
  normalizeReaderDraftNote,
  normalizeReaderDraftRange,
  type ReaderDraftRange,
  type ReaderDraftSessionSettings,
} from '../../utils/readerDraftSettings'
import {
  READER_AUTO_DRAFT_STYLES,
  type ReaderAutoDraftDraft,
  type ReaderAutoDraftSnapshot,
  type ReaderAutoDraftVariant,
} from '../../utils/readerAutoDraft'
import { normalizeDraftText } from '../../utils/readerDraftFormat'
import { weCloneStyleOption, type WeCloneStylePreset } from '../../utils/weCloneStyle'
import './readerReplyDraft.css'
import './readerAutoDraft.css'

interface Props {
  accountId: string
  sessionId: string
  sessionName?: string
  disabled: boolean
}

/**
 * 阅读器底部的「自动回复草稿」停靠卡片（v1.3.3）。
 *
 * - 折叠时也显示监听状态、草稿单行预览和复制按钮 —— 用户不用展开就能拿走草稿；
 * - 展开后是克隆 / 范围 / 风格 / 本会话提示词 / 完整草稿卡片；
 * - 草稿正文在写入前已经过 `normalizeDraftText`：没有空行、没有换行、标点正确。
 */
export function ReaderAutoDraftPanel({ accountId, sessionId, sessionName, disabled }: Props) {
  const api = window.electronAPI
  const [open, setOpen] = useState(false)
  const [clones, setClones] = useState<ReaderDraftClone[]>([])
  const [clonesLoading, setClonesLoading] = useState(false)
  const [clonesError, setClonesError] = useState('')

  const [settingsLoading, setSettingsLoading] = useState(true)
  const [cloneId, setCloneId] = useState('')
  const [range, setRange] = useState<ReaderDraftRange>('today')
  const [note, setNote] = useState('')
  const [savedNote, setSavedNote] = useState('')
  const [noteSaving, setNoteSaving] = useState(false)
  const [noteNotice, setNoteNotice] = useState('')
  const [consent, setConsent] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  const [snapshot, setSnapshot] = useState<ReaderAutoDraftSnapshot | null>(null)
  /** 生成后选择：默认选第一个成功版本；新一批草稿到达时重置。 */
  const [selectedStyle, setSelectedStyle] = useState<WeCloneStylePreset | ''>('')
  const [copiedStyle, setCopiedStyle] = useState('')

  const alive = useRef(true)
  const noteTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const noteSnapshot = useRef({ note: '', saved: '' })
  useEffect(() => {
    alive.current = true
    return () => { alive.current = false }
  }, [])

  const watchingThisSession = snapshot?.watching === true && snapshot.sessionId === sessionId
  const watchingOtherSession = snapshot?.watching === true && snapshot.sessionId !== sessionId
  const draftForThisSession = snapshot?.sessionId === sessionId ? snapshot?.lastDraft : undefined
  const cloneMissing = Boolean(cloneId) && clones.length > 0 && !clones.some((clone) => clone.id === cloneId)

  const loadClones = useCallback(async () => {
    if (clonesLoading) return
    setClonesLoading(true)
    setClonesError('')
    try {
      const result = await api.weclone.list()
      if (!alive.current) return
      if (!result.success) throw new Error(result.error || '无法读取本机分身。')
      setClones(readerDraftClones(result.clones, accountId))
    } catch (cause) {
      if (alive.current) {
        setClones([])
        setClonesError(cause instanceof Error ? cause.message : String(cause))
      }
    } finally {
      if (alive.current) setClonesLoading(false)
    }
  }, [accountId, api, clonesLoading])

  useEffect(() => {
    if (!open) return
    if (clones.length > 0 || clonesLoading) return
    void loadClones()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, accountId])

  useEffect(() => {
    let cancelled = false
    setSettingsLoading(true)
    setError('')
    void (async () => {
      try {
        const result = await api.readerDraft.getSettings(accountId, sessionId)
        if (cancelled || !alive.current) return
        if (!result.success) throw new Error(result.error || '无法读取本会话设置。')
        const settings: ReaderDraftSessionSettings | null = result.settings || null
        setCloneId(settings?.cloneId || '')
        setRange(normalizeReaderDraftRange(settings?.range))
        const value = normalizeReaderDraftNote(settings?.note)
        setNote(value)
        setSavedNote(value)
      } catch (cause) {
        if (!cancelled && alive.current) setError(cause instanceof Error ? cause.message : String(cause))
      } finally {
        if (!cancelled && alive.current) setSettingsLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [accountId, api, sessionId])

  useEffect(() => {
    let cancelled = false
    void api.readerDraft.status().then((value) => {
      if (!cancelled && alive.current) setSnapshot(value)
    }).catch(() => undefined)
    const unsubscribe = api.readerDraft.onEvent((value) => {
      if (alive.current) setSnapshot(value)
    })
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [api])

  const saveSettings = useCallback(
    async (patch: { cloneId?: string; range?: ReaderDraftRange; note?: string }, kind: 'note' | 'settings') => {
      if (kind === 'note') setNoteSaving(true)
      else setBusy(true)
      setError('')
      try {
        const result = await api.readerDraft.setSettings({ accountId, sessionId, ...patch })
        if (!result.success) throw new Error(result.error || '保存失败')
        if (patch.note !== undefined) {
          const requested = normalizeReaderDraftNote(patch.note)
          const value = normalizeReaderDraftNote(result.settings?.note)
          // 保存期间用户可能又输入了：只有当前文本仍是这次保存的内容时才回写。
          setNote((current) => normalizeReaderDraftNote(current) === requested ? value : current)
          setSavedNote(value)
          setNoteNotice('已保存，下次打开自动带出')
          // 手动草稿面板也使用同一段按会话提示词，通知它刷新。
          try {
            window.dispatchEvent(new CustomEvent('weport:reader-draft-note', {
              detail: { accountId, sessionId, note: value },
            }))
          } catch { /* noop */ }
        }
        return true
      } catch (cause) {
        if (alive.current) setError(cause instanceof Error ? cause.message : String(cause))
        return false
      } finally {
        if (kind === 'note') setNoteSaving(false)
        else setBusy(false)
      }
    },
    [accountId, api, sessionId]
  )

  const scheduleNoteSave = useCallback((value: string) => {
    if (noteTimer.current) clearTimeout(noteTimer.current)
    noteTimer.current = setTimeout(() => {
      noteTimer.current = null
      const clean = normalizeReaderDraftNote(value)
      if (clean !== savedNote) void saveSettings({ note: clean }, 'note')
    }, 700)
  }, [savedNote, saveSettings])

  const flushNote = useCallback(() => {
    if (noteTimer.current) {
      clearTimeout(noteTimer.current)
      noteTimer.current = null
    }
    const clean = normalizeReaderDraftNote(note)
    if (clean !== savedNote) void saveSettings({ note: clean }, 'note')
  }, [note, savedNote, saveSettings])

  useEffect(() => {
    noteSnapshot.current = { note, saved: savedNote }
  }, [note, savedNote])
  useEffect(() => () => {
    if (noteTimer.current) clearTimeout(noteTimer.current)
    const { note: latest, saved } = noteSnapshot.current
    const clean = normalizeReaderDraftNote(latest)
    if (clean !== saved) {
      void api.readerDraft.setSettings({ accountId, sessionId, note: clean }).catch(() => undefined)
    }
  }, [accountId, api, sessionId])

  useEffect(() => {
    const incoming = snapshot?.sessionId === sessionId ? snapshot?.lastDraft : undefined
    if (!incoming || incoming.variants.length === 0) return
    // 生成后选择：保留用户已经选中的风格；新草稿里没有它时退回第一个。
    setSelectedStyle((current) => {
      if (current && incoming.variants.some((variant) => variant.style === current)) return current
      return incoming.variants[0].style
    })
    setCopiedStyle('')
  }, [snapshot, sessionId])

  const changeClone = (value: string) => {
    setCloneId(value)
    setNotice('')
    void saveSettings({ cloneId: value }, 'settings')
  }
  const changeRange = (value: ReaderDraftRange) => {
    setRange(value)
    setNotice('')
    void saveSettings({ range: value }, 'settings')
  }

  const start = async () => {
    if (!cloneId) { setError('请先选择用于草稿的本机分身。'); return }
    if (!consent) { setError('请先勾选同意。'); return }
    setBusy(true)
    setError('')
    setNotice('')
    try {
      const result = await api.readerDraft.start({ accountId, sessionId, sessionName, cloneId, range })
      if (!result.success) throw new Error(result.error || '开启失败')
      if (result.snapshot) setSnapshot(result.snapshot)
      setConsent(false)
      setNotice('已开启：对方发来新消息时会自动生成草稿；切换会话不会停止。')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  const stop = async () => {
    setBusy(true)
    setError('')
    try {
      const result = await api.readerDraft.stop()
      if (result.snapshot) setSnapshot(result.snapshot)
      setNotice('已停止监听。')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  const regenerate = async () => {
    setBusy(true)
    setError('')
    try {
      const result = await api.readerDraft.regenerate()
      if (!result.success) throw new Error(result.error || '重新生成失败')
      if (result.snapshot) setSnapshot(result.snapshot)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  const selectedVariant: ReaderAutoDraftVariant | undefined = draftForThisSession
    ? (draftForThisSession.variants.find((variant) => variant.style === selectedStyle) || draftForThisSession.variants[0])
    : undefined

  const copyDraft = (variant?: ReaderAutoDraftVariant) => {
    const target = variant || selectedVariant
    const value = normalizeDraftText(target?.reply || '')
    if (!target || !value) return
    setSelectedStyle(target.style)
    void copyTextToClipboard(value).then((ok) => {
      if (!alive.current) return
      if (ok) {
        setCopiedStyle(target.style)
        window.setTimeout(() => { if (alive.current) setCopiedStyle('') }, 1600)
      } else {
        setNotice('复制失败，请手动选择草稿文字复制。')
      }
    })
  }

  const coverage = (draft: ReaderAutoDraftDraft | undefined) => {
    if (!draft) return ''
    const label = READER_DRAFT_RANGES.find((item) => item.id === draft.coverage.range)?.label || '今日'
    return `${label} · ${draft.coverage.includedCount}/${draft.coverage.eligibleCount} 条 · ${draft.coverage.charCount.toLocaleString()} 字符${draft.coverage.truncated ? ' · 已截断' : ''}`
  }

  const statusText = watchingThisSession
    ? (snapshot?.generating ? `正在生成 ${READER_AUTO_DRAFT_STYLES.length} 个风格…` : '正在监听')
    : watchingOtherSession ? '另一个会话监听中' : '未开启'
  const hasDraft = Boolean(draftForThisSession && draftForThisSession.variants.length > 0)

  return (
    <>
      {/* 草稿从设置面板里摘出来，直接作为聊天区底部的独立卡片；设置面板退到它下面。 */}
      {hasDraft && <section className="reader-auto-shelf" aria-label="自动回复草稿候选">
        <div className="reader-auto-shelf-head">
          <strong>自动回复草稿 · {draftForThisSession!.variants.length} 个风格</strong>
          <span>{coverage(draftForThisSession)}</span>
          {draftForThisSession!.stale ? <span>可能已过期</span> : null}
        </div>
        <div className="reader-auto-shelf-scroll">
          {draftForThisSession!.variants.map((variant) => (
            <div
              key={variant.style}
              className="reader-auto-variant"
              data-active={selectedVariant?.style === variant.style}
              role="button"
              tabIndex={0}
              onClick={() => setSelectedStyle(variant.style)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault()
                  setSelectedStyle(variant.style)
                }
              }}
            >
              <div className="reader-auto-variant-head">
                <strong>{variant.label}</strong>
                {variant.providerId || variant.model
                  ? <span>{[variant.providerId, variant.model].filter(Boolean).join(' · ')}</span>
                  : null}
                <button
                  type="button"
                  className="reader-auto-variant-copy"
                  onClick={(event) => { event.stopPropagation(); copyDraft(variant) }}
                >
                  <Copy size={12} />{copiedStyle === variant.style ? '已复制' : '复制'}
                </button>
              </div>
              <p>{variant.reply}</p>
            </div>
          ))}
        </div>
        {draftForThisSession!.errors && draftForThisSession!.errors.length > 0 && (
          <div className="reader-auto-variant-errors">
            {draftForThisSession!.errors.map((item) => (
              <span key={item.style}>{item.label}：{item.error}</span>
            ))}
          </div>
        )}
        <div className="reader-auto-shelf-actions">
          <button type="button" className="primary-btn" disabled={!selectedVariant} onClick={() => copyDraft(selectedVariant)}>
            <Copy size={13} />{copiedStyle && copiedStyle === selectedVariant?.style ? '已复制' : '复制选中草稿'}
          </button>
          <button type="button" className="ghost-btn" disabled={busy || !watchingThisSession} onClick={() => void regenerate()}>
            <RefreshCw size={13} />重新生成
          </button>
        </div>
      </section>}

      <section className="reader-auto-dock" aria-label="自动草稿设置">
        <div className="reader-auto-bar" data-state={watchingThisSession ? 'running' : watchingOtherSession ? 'other' : 'idle'}>
          <button
            type="button"
            className="reader-auto-bar-main"
            aria-expanded={open}
            onClick={() => setOpen((value) => !value)}
          >
            <span className="reader-auto-dot" data-on={watchingThisSession} aria-hidden />
            <Sparkles size={13} />
            <strong>自动草稿设置</strong>
            <span className="reader-auto-bar-status">{statusText}</span>
            <span className="reader-auto-bar-preview reader-auto-bar-empty">
              {hasDraft
                ? `${draftForThisSession!.variants.length} 个风格已生成，点上方卡片复制`
                : watchingThisSession ? '等待对方的新消息…' : '展开设置并开启监听'}
            </span>
            <ChevronDown size={14} className="reader-auto-bar-chevron" data-open={open} />
          </button>
        </div>

      {open && <div className="reader-auto-body">
        <div className="reader-auto-status" data-state={watchingThisSession ? (snapshot?.lastError ? 'error' : 'running') : 'idle'}>
          <div className="reader-auto-status-head">
            {watchingThisSession && snapshot?.generating
              ? <><Loader2 size={13} className="spin" /><strong>正在生成草稿…</strong></>
              : watchingThisSession
                ? <><span className="reader-auto-dot" data-on aria-hidden /><strong>正在监听</strong></>
                : <><Info size={13} /><strong>{watchingOtherSession ? '另一个会话正在监听' : '未开启'}</strong></>}
            <span className="reader-hint">
              {watchingThisSession ? '仅当前会话 · 新消息到达后约 6 秒生成' : watchingOtherSession ? '切换会话不会停止；在这里开启会替换它' : '开启后自动生成，供人工复制'}
            </span>
          </div>
          {watchingThisSession && snapshot?.statusMessage && <div className="reader-hint">{snapshot.statusMessage}</div>}
          {watchingThisSession && snapshot?.repliedManually && <div className="reader-hint">你已在微信里手动回复；这条草稿可能已经过期。</div>}
          {watchingThisSession && snapshot?.lastError && <p className="reader-gap-error" role="alert">{snapshot.lastError}</p>}
        </div>

        <div className="reader-auto-controls">
          <label>本机分身
            <select className="filter-input" aria-label="自动草稿使用的分身" value={cloneId} disabled={busy || clonesLoading || settingsLoading || watchingThisSession} onChange={(event) => changeClone(event.target.value)}>
              <option value="">请明确选择分身</option>
              {clones.map((clone) => <option key={clone.id} value={clone.id}>{clone.displayName || clone.wxid} · {clone.generatedAt}</option>)}
            </select>
          </label>
          <label>上下文范围
            <select className="filter-input" aria-label="自动草稿的上下文范围" value={range} disabled={busy || settingsLoading} onChange={(event) => changeRange(normalizeReaderDraftRange(event.target.value))}>
              {READER_DRAFT_RANGES.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
            </select>
          </label>
          <button type="button" className="ghost-btn" disabled={clonesLoading || busy} onClick={() => void loadClones()}>
            {clonesLoading ? '读取中…' : '刷新分身'}
          </button>
        </div>
        <p className="reader-hint">{READER_DRAFT_RANGES.find((item) => item.id === range)?.hint}。</p>
        {cloneMissing && <p className="reader-gap-error" role="status">之前保存的分身已不存在，请重新选择。补充提示词仍然保留。</p>}
        {!clonesLoading && !clones.length && <p className="reader-hint">当前账号没有可用的本机分身，请前往 WeClone 生成后刷新。</p>}
        {!clonesLoading && !clones.length && clonesError && <p className="reader-gap-error" role="alert">{clonesError}</p>}

        <p className="reader-hint">
          每条新消息会同时生成 {READER_AUTO_DRAFT_STYLES.length} 个风格版本（
          {READER_AUTO_DRAFT_STYLES.map((item) => weCloneStyleOption(item).label).join(' / ')}
          ），生成后选一个复制；不需要在生成前选择风格。
        </p>

        <label className="reader-auto-note-label">本会话补充提示词（可选，自动保存，不需要每次填写）
          <textarea
            value={note}
            rows={3}
            aria-label="本会话补充提示词"
            placeholder="只对这个会话生效。例如：对方是我老板，收着点说；我们在讨论下周的旅行。"
            disabled={settingsLoading}
            onChange={(event) => {
              setNote(event.target.value)
              setNoteNotice('')
              scheduleNoteSave(event.target.value)
            }}
            onBlur={flushNote}
          />
        </label>
        <div className="reader-auto-note-meta">
          <span>
            {note.length} 字
            {noteSaving
              ? ' · 保存中…'
              : normalizeReaderDraftNote(note) !== savedNote
                ? ' · 未保存'
                : noteNotice ? ` · ${noteNotice}` : savedNote ? ' · 已按会话保存' : ''}
          </span>
          <span>这段内容会随每次自动草稿发送给模型服务。</span>
        </div>

        <label className="reader-reply-consent">
          <input type="checkbox" checked={consent} disabled={busy || watchingThisSession || !cloneId} onChange={(event) => setConsent(event.target.checked)} />
          我了解：开启后，每收到一条对方新消息，都会把所选时间范围的聊天记录、分身资料和本会话补充提示词发送给当前配置的模型服务，并同时调用 {READER_AUTO_DRAFT_STYLES.length} 次生成多个风格版本，可能产生相应费用。
        </label>

        <div className="reader-auto-actions">
          {watchingThisSession
            ? <button type="button" className="secondary-btn" disabled={busy} onClick={() => void stop()}><Pause size={13} />停止监听</button>
            : <button type="button" className="secondary-btn" disabled={busy || disabled || !cloneId || !consent || cloneMissing} onClick={() => void start()}><Play size={13} />开始监听</button>}
          {watchingThisSession && <button type="button" className="ghost-btn" disabled={busy || snapshot?.generating} onClick={() => void regenerate()}><RefreshCw size={13} />用最近消息再生成</button>}
          {watchingOtherSession && <button type="button" className="ghost-btn" disabled={busy} onClick={() => void stop()}><Pause size={13} />停止另一个会话的监听</button>}
        </div>
        {error && <p className="reader-gap-error" role="alert">{error}</p>}
        {notice && <p className="reader-hint" role="status">{notice}</p>}
      </div>}
      </section>
    </>
  )
}
