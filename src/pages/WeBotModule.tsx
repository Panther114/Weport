import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { CalendarClock, Check, Clock, Pin, Play, Plus, Trash2, X } from 'lucide-react'
import ReferencePicker, { type ReferenceCandidate, type ReferencePickerHandle } from '../components/reference/ReferencePicker'
import { applyMention, findActiveMention, referenceKindLabel, type ChatReference } from '../utils/mentionTrigger'
import { CATCH_UP_OPTIONS, WEEKDAY_OPTIONS, describeNextRun, describeRelativeTime, describeSchedule } from '../utils/weBotFormat'
import '../styles/weBot.scss'

export type WeBotSection = 'tasks' | 'notes'

interface Props {
  section: WeBotSection
  onSectionChange: (section: WeBotSection) => void
}

interface SessionLike {
  username?: string
  displayName?: string
  nickName?: string
  remark?: string
  avatarUrl?: string
  type?: string
}

/**
 * 把会话映射成引用候选。
 *
 * 类型判定只看 username：`@chatroom` 是群、`gh_` 是公众号，其余为私聊 ——
 * 这与 Weport 其余部分（导出、通知过滤）用的是同一套判据。
 */
function toCandidates(sessions: SessionLike[]): ReferenceCandidate[] {
  const mapped: ReferenceCandidate[] = []
  for (const session of sessions) {
    const id = String(session.username || '').trim()
    if (!id) continue
    const kind: ReferenceCandidate['kind'] = id.endsWith('@chatroom')
      ? 'group'
      : id.startsWith('gh_')
        ? 'official'
        : 'private'
    const label = String(session.displayName || session.remark || session.nickName || id)
    // 备注与显示名相同时不再重复一遍（否则每条都会写「备注：<同名>」）。
    const subtitle = session.remark && session.remark !== label ? `备注：${session.remark}` : undefined
    mapped.push({ id, label, kind, subtitle, avatarUrl: session.avatarUrl })
  }
  return mapped.sort((a, b) => {
    // 群聊排在前面：WeBot 的典型用法是「扫描某个群」，私聊引用相对少见。
    if (a.kind !== b.kind) return a.kind === 'group' ? -1 : b.kind === 'group' ? 1 : 0
    return a.label.localeCompare(b.label)
  })
}

const emptyDraft = () => ({
  title: '',
  description: '',
  scheduleKind: 'daily' as WeBotSchedule['kind'],
  hour: 8,
  minute: 30,
  weekday: 1,
  day: 1,
  everyMinutes: 60,
  catchUp: 'once' as WeBotCatchUp,
  allowParallel: false,
  references: [] as WeBotReference[],
})

type Draft = ReturnType<typeof emptyDraft>

/**
 * WeBot：定时任务与笔记板。
 *
 * 一个页面承载两块内容（任务 / 笔记）而不是两个顶级入口：它们是同一个功能
 * 的两面 —— 任务产出笔记，笔记链接回任务。分成两个平级入口只会让用户在
 * 两个页面之间来回跳。
 */
export default function WeBotModule({ section, onSectionChange }: Props) {
  const api = window.electronAPI
  const [tasks, setTasks] = useState<WeBotTask[]>([])
  const [notes, setNotes] = useState<WeBotNote[]>([])
  const [runs, setRuns] = useState<WeBotRun[]>([])
  const [candidates, setCandidates] = useState<ReferenceCandidate[]>([])
  const [loading, setLoading] = useState(true)
  const [busyTaskId, setBusyTaskId] = useState<string | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draft, setDraft] = useState<Draft>(emptyDraft)
  const [unreadOnly, setUnreadOnly] = useState(false)
  const [message, setMessage] = useState('')

  // `@` 引用状态：pick 的锚点（start/query）与光标位置。
  const [mention, setMention] = useState<{ start: number; query: string; caret: number } | null>(null)
  const pickerRef = useRef<ReferencePickerHandle>(null)
  const descriptionRef = useRef<HTMLTextAreaElement | null>(null)

  const refresh = useCallback(async () => {
    try {
      const [nextTasks, nextNotes, nextRuns] = await Promise.all([
        api.weBot.listTasks(),
        api.weBot.listNotes({ unreadOnly }),
        api.weBot.listRuns(),
      ])
      setTasks(nextTasks)
      setNotes(nextNotes)
      setRuns(nextRuns)
    } catch (error) {
      setMessage(`读取 WeBot 数据失败：${String((error as Error)?.message || error)}`)
    } finally {
      setLoading(false)
    }
  }, [api, unreadOnly])

  useEffect(() => {
    void refresh()
  }, [refresh])

  useEffect(() => {
    // 会话列表只取一次：引用候选不需要实时刷新，而每次打开页面都去读 WCDB
    // 会明显拖慢页面切换。
    let cancelled = false
    void (async () => {
      try {
        const sessions = (await api.chat.getSessions()) as { data?: SessionLike[]; success?: boolean } | SessionLike[]
        const list = Array.isArray(sessions) ? sessions : Array.isArray(sessions?.data) ? sessions.data : []
        if (!cancelled) setCandidates(toCandidates(list))
      } catch {
        if (!cancelled) setCandidates([])
      }
    })()
    return () => {
      cancelled = true
    }
  }, [api])

  const unsubscribe = useCallback(
    () => api.weBot.onNote(() => void refresh()),
    [api, refresh]
  )
  useEffect(() => unsubscribe(), [unsubscribe])

  const runsByTask = useMemo(() => {
    const map = new Map<string, WeBotRun>()
    for (const run of runs) if (!map.has(run.taskId)) map.set(run.taskId, run)
    return map
  }, [runs])

  const startCreate = () => {
    setEditingId(null)
    setDraft(emptyDraft())
  }

  const startEdit = (task: WeBotTask) => {
    setEditingId(task.id)
    setDraft({
      ...emptyDraft(),
      title: task.title,
      description: task.description,
      catchUp: task.catchUp,
      allowParallel: task.allowParallel,
      references: task.references.map((reference) => ({ ...reference })),
      ...(task.schedule.kind === 'daily'
        ? { scheduleKind: 'daily', hour: task.schedule.hour, minute: task.schedule.minute }
        : task.schedule.kind === 'weekly'
          ? { scheduleKind: 'weekly', hour: task.schedule.hour, minute: task.schedule.minute, weekday: task.schedule.weekday }
          : task.schedule.kind === 'monthly'
            ? { scheduleKind: 'monthly', hour: task.schedule.hour, minute: task.schedule.minute, day: task.schedule.day }
            : { scheduleKind: 'interval', everyMinutes: task.schedule.everyMinutes }),
    })
  }

  const buildSchedule = (value: Draft): WeBotSchedule => {
    if (value.scheduleKind === 'daily') return { kind: 'daily', hour: value.hour, minute: value.minute }
    if (value.scheduleKind === 'weekly') return { kind: 'weekly', weekday: value.weekday, hour: value.hour, minute: value.minute }
    if (value.scheduleKind === 'monthly') return { kind: 'monthly', day: value.day, hour: value.hour, minute: value.minute }
    // 间隔任务的锚点取「创建/保存的当下」，之后按固定周期推进。
    return { kind: 'interval', everyMinutes: value.everyMinutes, anchorMs: 0 }
  }

  const save = async () => {
    if (!draft.title.trim()) {
      setMessage('请先填写任务标题')
      return
    }
    const schedule = buildSchedule(draft)
    try {
      if (editingId) {
        await api.weBot.updateTask(editingId, {
          title: draft.title.trim(),
          description: draft.description.trim(),
          schedule,
          catchUp: draft.catchUp,
          allowParallel: draft.allowParallel,
          references: draft.references,
        })
      } else {
        await api.weBot.createTask({
          title: draft.title.trim(),
          description: draft.description.trim(),
          schedule,
          catchUp: draft.catchUp,
          allowParallel: draft.allowParallel,
          references: draft.references,
        })
      }
      setMessage('')
      startCreate()
      await refresh()
    } catch (error) {
      setMessage(`保存失败：${String((error as Error)?.message || error)}`)
    }
  }

  const removeTask = async (task: WeBotTask) => {
    await api.weBot.deleteTask(task.id)
    if (editingId === task.id) startCreate()
    await refresh()
  }

  const runTask = async (task: WeBotTask) => {
    setBusyTaskId(task.id)
    setMessage('')
    try {
      const result = await api.weBot.runNow(task.id)
      if (!result.success) setMessage(`运行失败：${result.error || '未知错误'}`)
      await refresh()
    } finally {
      setBusyTaskId(null)
    }
  }

  const toggleEnabled = async (task: WeBotTask) => {
    await api.weBot.updateTask(task.id, { enabled: !task.enabled })
    await refresh()
  }

  // -------------------------------------------------------------------------
  // `@` 引用：与 WeportAI 输入框共用同一套纯逻辑（utils/mentionTrigger.ts）
  // -------------------------------------------------------------------------

  const syncMention = (value: string, caret: number) => {
    const active = findActiveMention(value, caret)
    setMention(active ? { ...active, caret } : null)
  }

  const pickReference = (reference: ChatReference) => {
    if (!mention) return
    const textarea = descriptionRef.current
    const current = draft.description
    const caret = textarea?.selectionStart ?? mention.caret
    const { value, caret: nextCaret } = applyMention(current, { start: mention.start, query: mention.query }, caret, reference.label)
    setDraft((prev) => ({
      ...prev,
      description: value,
      // 同一个会话只引用一次；重复 `@` 同一群没有意义，还会让提示里出现两份。
      references: prev.references.some((item) => item.id === reference.id)
        ? prev.references
        : [...prev.references, { id: reference.id, label: reference.label, kind: reference.kind }],
    }))
    setMention(null)
    requestAnimationFrame(() => {
      textarea?.focus()
      textarea?.setSelectionRange(nextCaret, nextCaret)
    })
  }

  const removeReference = (id: string) => {
    setDraft((prev) => ({ ...prev, references: prev.references.filter((item) => item.id !== id) }))
  }

  if (loading) return <div className="webot-loading">正在加载 WeBot…</div>

  return (
    <div className="webot">
      <div className="webot-tabs" role="tablist" aria-label="WeBot 视图">
        <button type="button" role="tab" aria-selected={section === 'tasks'} data-active={section === 'tasks'} onClick={() => onSectionChange('tasks')}>
          <CalendarClock size={14} />
          定时任务
          <span className="webot-count">{tasks.length}</span>
        </button>
        <button type="button" role="tab" aria-selected={section === 'notes'} data-active={section === 'notes'} onClick={() => onSectionChange('notes')}>
          <Pin size={14} />
          笔记
          <span className="webot-count">{notes.length}</span>
        </button>
      </div>

      {message ? (
        <div className="webot-message" role="status">
          {message}
          <button type="button" onClick={() => setMessage('')} aria-label="关闭提示">
            <X size={13} />
          </button>
        </div>
      ) : null}

      {section === 'tasks' ? (
        <div className="webot-body">
          <div className="webot-list">
            {tasks.length === 0 ? (
              <div className="webot-empty">
                还没有定时任务。右侧可以创建一个：比如「每天 08:30 扫描化学群，把作业整理成笔记」。
              </div>
            ) : null}

            {tasks.map((task) => {
              const lastRun = runsByTask.get(task.id)
              return (
                <div className="webot-card" key={task.id} data-active={editingId === task.id}>
                  <div className="webot-card-main">
                    <div className="webot-card-title">{task.title}</div>
                    <div className="webot-card-meta">
                      <span>
                        <Clock size={12} /> {describeSchedule(task.schedule)}
                      </span>
                      <span>下次 {describeNextRun(task.nextRunAt)}</span>
                    </div>
                    {task.references.length > 0 ? (
                      <div className="ref-chips">
                        {task.references.map((reference) => (
                          <span className="ref-chip" key={reference.id}>
                            @{reference.label}
                            <span className="webot-chip-kind">{referenceKindLabel(reference.kind)}</span>
                          </span>
                        ))}
                      </div>
                    ) : null}
                    {lastRun?.status === 'error' ? <div className="webot-card-error">上次失败：{lastRun.error}</div> : null}
                  </div>

                  <div className="webot-card-actions">
                    <label className="webot-switch" title={task.enabled ? '已启用' : '已停用'}>
                      <input type="checkbox" checked={task.enabled} onChange={() => void toggleEnabled(task)} />
                      <span />
                    </label>
                    <button type="button" className="ghost-btn" disabled={busyTaskId === task.id} onClick={() => void runTask(task)} title="立即运行一次">
                      <Play size={13} />
                      {busyTaskId === task.id ? '运行中…' : '运行'}
                    </button>
                    <button type="button" className="ghost-btn" onClick={() => startEdit(task)}>
                      编辑
                    </button>
                    <button type="button" className="ghost-btn webot-danger" onClick={() => void removeTask(task)} title="删除任务（已有笔记会保留）">
                      <Trash2 size={13} />
                    </button>
                  </div>
                </div>
              )
            })}
          </div>

          <div className="webot-editor">
            <div className="webot-editor-head">
              <h3>{editingId ? '编辑任务' : '新建任务'}</h3>
              {editingId ? (
                <button type="button" className="ghost-btn" onClick={startCreate}>
                  <Plus size={13} /> 改为新建
                </button>
              ) : null}
            </div>

            <label className="webot-field">
              <span>标题</span>
              <input value={draft.title} maxLength={80} placeholder="例如：化学群作业整理" onChange={(e) => setDraft((prev) => ({ ...prev, title: e.target.value }))} />
            </label>

            <div className="webot-field">
              <span>任务内容</span>
              <textarea
                ref={descriptionRef}
                rows={5}
                value={draft.description}
                placeholder="描述要做什么。输入 @ 可以引用一个群或联系人，例如：@化学 3 班 每天找出布置的作业并整理成笔记。"
                onChange={(e) => {
                  setDraft((prev) => ({ ...prev, description: e.target.value }))
                  syncMention(e.target.value, e.target.selectionStart ?? e.target.value.length)
                }}
                onKeyDown={(e) => {
                  if (!mention) return
                  // 选择器把按键交给它处理；只有它消费了按键我们才阻止默认行为，
                  // 否则用户没法在描述里正常打字。
                  const consumed = pickerRef.current?.handleKeyDown(e as unknown as { key: string; preventDefault: () => void })
                  if (consumed) e.preventDefault()
                  if (!consumed && (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'Home' || e.key === 'End')) {
                    setMention(null)
                  }
                }}
                onBlur={() => {
                  // 延迟关闭：点击选择器条目时会先触发 blur。
                  setTimeout(() => setMention(null), 120)
                }}
              />
              {mention ? (
                <div className="webot-picker-anchor">
                  <ReferencePicker
                    ref={pickerRef}
                    query={mention.query}
                    candidates={candidates}
                    onQueryChange={(query) => setMention((prev) => (prev ? { ...prev, query } : prev))}
                    onPick={pickReference}
                    onClose={() => setMention(null)}
                  />
                </div>
              ) : null}
            </div>

            {draft.references.length > 0 ? (
              <div className="ref-chips">
                {draft.references.map((reference) => (
                  <span className="ref-chip" key={reference.id}>
                    @{reference.label}
                    <button type="button" onClick={() => removeReference(reference.id)} aria-label={`移除引用 ${reference.label}`}>
                      <X size={11} />
                    </button>
                  </span>
                ))}
              </div>
            ) : null}

            <div className="webot-field">
              <span>执行频率</span>
              <div className="segmented" role="radiogroup" aria-label="执行频率">
                {(
                  [
                    { id: 'daily', label: '每天' },
                    { id: 'weekly', label: '每周' },
                    { id: 'monthly', label: '每月' },
                    { id: 'interval', label: '间隔' },
                  ] as const
                ).map((option) => (
                  <button
                    key={option.id}
                    type="button"
                    role="radio"
                    aria-checked={draft.scheduleKind === option.id}
                    className="segmented-item"
                    data-active={draft.scheduleKind === option.id}
                    onClick={() => setDraft((prev) => ({ ...prev, scheduleKind: option.id }))}
                  >
                    {option.label}
                  </button>
                ))}
              </div>

              <div className="webot-schedule-row">
                {draft.scheduleKind === 'interval' ? (
                  <label>
                    <span>每</span>
                    <input
                      type="number"
                      min={5}
                      max={1440}
                      value={draft.everyMinutes}
                      onChange={(e) => setDraft((prev) => ({ ...prev, everyMinutes: Number(e.target.value) || 60 }))}
                    />
                    <span>分钟</span>
                  </label>
                ) : (
                  <>
                    {draft.scheduleKind === 'weekly' ? (
                      <select value={draft.weekday} onChange={(e) => setDraft((prev) => ({ ...prev, weekday: Number(e.target.value) }))}>
                        {WEEKDAY_OPTIONS.map((label, index) => (
                          <option key={label} value={index}>
                            {label}
                          </option>
                        ))}
                      </select>
                    ) : null}
                    {draft.scheduleKind === 'monthly' ? (
                      <label>
                        <span>每月</span>
                        <input
                          type="number"
                          min={1}
                          max={31}
                          value={draft.day}
                          onChange={(e) => setDraft((prev) => ({ ...prev, day: Number(e.target.value) || 1 }))}
                        />
                        <span>日</span>
                      </label>
                    ) : null}
                    <label>
                      <input
                        type="number"
                        min={0}
                        max={23}
                        value={draft.hour}
                        onChange={(e) => setDraft((prev) => ({ ...prev, hour: Number(e.target.value) || 0 }))}
                      />
                      <span>:</span>
                      <input
                        type="number"
                        min={0}
                        max={59}
                        value={draft.minute}
                        onChange={(e) => setDraft((prev) => ({ ...prev, minute: Number(e.target.value) || 0 }))}
                      />
                    </label>
                  </>
                )}
              </div>
              <p className="webot-hint">
                {describeSchedule(buildSchedule(draft))} · 下次 {describeNextRun(Date.now() + 60_000)}
              </p>
            </div>

            <div className="webot-field">
              <span>错过时怎么办</span>
              <div className="webot-radio-list">
                {CATCH_UP_OPTIONS.map((option) => (
                  <label key={option.id} className="webot-radio">
                    <input
                      type="radio"
                      name="webot-catchup"
                      checked={draft.catchUp === option.id}
                      onChange={() => setDraft((prev) => ({ ...prev, catchUp: option.id }))}
                    />
                    <span>
                      <strong>{option.label}</strong>
                      <em>{option.hint}</em>
                    </span>
                  </label>
                ))}
              </div>
            </div>

            <label className="webot-checkbox">
              <input
                type="checkbox"
                checked={draft.allowParallel}
                onChange={(e) => setDraft((prev) => ({ ...prev, allowParallel: e.target.checked }))}
              />
              <span>允许与其他任务同时运行（默认串行，避免同时抢占数据库）</span>
            </label>

            <div className="webot-editor-actions">
              <button type="button" className="primary-btn" onClick={() => void save()}>
                <Check size={14} />
                {editingId ? '保存修改' : '创建任务'}
              </button>
            </div>
          </div>
        </div>
      ) : (
        <div className="webot-notes">
          <div className="webot-notes-head">
            <label className="webot-checkbox">
              <input type="checkbox" checked={unreadOnly} onChange={(e) => setUnreadOnly(e.target.checked)} />
              <span>只看未读</span>
            </label>
            {notes.length > 0 ? (
              <button
                type="button"
                className="ghost-btn webot-danger"
                onClick={async () => {
                  await api.weBot.clearNotes()
                  await refresh()
                }}
              >
                <Trash2 size={13} /> 清空笔记
              </button>
            ) : null}
          </div>

          {notes.length === 0 ? (
            <div className="webot-empty">还没有笔记。任务跑完后，结果会以简短卡片的形式出现在这里。</div>
          ) : null}

          <div className="webot-note-list">
            {notes.map((note) => (
              <article className="webot-note" key={note.id} data-unread={!note.read} data-status={note.status}>
                <header>
                  <h4>{note.title}</h4>
                  <span className="webot-note-time">{describeRelativeTime(note.createdAt)}</span>
                </header>
                <p>{note.summary}</p>
                <footer>
                  <span className="webot-note-task">{note.taskTitle}</span>
                  {note.references.map((reference) => (
                    <span className="ref-chip" key={reference.id}>
                      @{reference.label}
                    </span>
                  ))}
                  <div className="webot-note-actions">
                    <button
                      type="button"
                      className="ghost-btn"
                      aria-pressed={note.pinned}
                      title={note.pinned ? '取消置顶' : '置顶'}
                      onClick={async () => {
                        await api.weBot.updateNote(note.id, { pinned: !note.pinned })
                        await refresh()
                      }}
                    >
                      <Pin size={13} />
                    </button>
                    <button
                      type="button"
                      className="ghost-btn"
                      title={note.read ? '标为未读' : '标为已读'}
                      onClick={async () => {
                        await api.weBot.updateNote(note.id, { read: !note.read })
                        await refresh()
                      }}
                    >
                      <Check size={13} />
                    </button>
                  </div>
                </footer>
              </article>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
