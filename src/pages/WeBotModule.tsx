import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Check, ChevronDown, ChevronRight, Clock, History, PenLine, Pin, Play, Plus, Trash2, X } from 'lucide-react'
import ReferencePicker, { type ReferenceCandidate, type ReferencePickerHandle } from '../components/reference/ReferencePicker'
import { findActiveMention, referenceKindLabel, rewriteMentionQuery, stripMention, type ChatReference } from '../utils/mentionTrigger'
import { loadReferenceCandidates } from '../utils/sessionCandidates'
import {
  CATCH_UP_OPTIONS,
  WEEKDAY_OPTIONS,
  describeNextRun,
  describeRelativeTime,
  describeSchedule,
  formatDuration,
  formatStamp,
  runStatusLabel,
  toTwelveHour,
  toTwentyFourHour,
  type Meridiem,
} from '../utils/weBotFormat'
import '../styles/weBot.scss'

export type WeBotSection = 'tasks' | 'notes'

/** 12 小时制的下拉项（12 在前，与「12 点」的读法一致）。 */
const HOUR12_OPTIONS = [12, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]

interface Props {
  section: WeBotSection
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
export default function WeBotModule({ section }: Props) {
  const api = window.electronAPI
  const [tasks, setTasks] = useState<WeBotTask[]>([])
  const [notes, setNotes] = useState<WeBotNote[]>([])
  const [runs, setRuns] = useState<WeBotRun[]>([])
  const [candidates, setCandidates] = useState<ReferenceCandidate[]>([])
  const [candidatesState, setCandidatesState] = useState<{ loading: boolean; ok: boolean; error?: string }>({
    loading: true,
    ok: true,
  })
  const [loading, setLoading] = useState(true)
  const [busyTaskId, setBusyTaskId] = useState<string | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draft, setDraft] = useState<Draft>(emptyDraft)
  const [unreadOnly, setUnreadOnly] = useState(false)
  const [unread, setUnread] = useState(0)
  const [message, setMessage] = useState('')
  // 编辑器默认收起：任务列表才是这一页的内容，表单只在要建/改任务时出现。
  const [editorOpen, setEditorOpen] = useState(false)

  // `@` 引用状态：pick 的锚点（start/query）与光标位置。
  const [mention, setMention] = useState<{ start: number; query: string; caret: number } | null>(null)
  const pickerRef = useRef<ReferencePickerHandle>(null)
  const descriptionRef = useRef<HTMLTextAreaElement | null>(null)
  const titleRef = useRef<HTMLInputElement | null>(null)

  /** 编辑器里的时间按 12 小时制显示（内部 hour 仍是 0–23）。 */
  const twelveHour = useMemo(() => toTwelveHour(draft.hour), [draft.hour])

  /** 展开了运行记录的任务 id。 */
  const [openLogs, setOpenLogs] = useState<Set<string>>(() => new Set())

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
      // 未读数是**全量**的，不受「只看未读」筛选影响，因此单独取。
      setUnread(await api.weBot.unreadCount())
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
    // 会话列表只取一次（共享缓存 60s，两个 `@` 入口共用）：引用候选不需要实时刷新，
    // 而每次打开页面都去读 WCDB 会明显拖慢页面切换。
    // 解包与映射统一走 utils/sessionCandidates —— 以前这里按 `data` 解包
    // `chat:getSessions` 的 `{ sessions }` 返回，于是永远显示「先连接微信」。
    let cancelled = false
    void (async () => {
      const result = await loadReferenceCandidates(() => api.chat.getSessions())
      if (cancelled) return
      setCandidatesState({ loading: false, ok: result.ok, error: result.error })
      setCandidates(result.candidates)
    })()
    return () => {
      cancelled = true
    }
  }, [api])

  const unsubscribe = useCallback(
    () => {
      const offNote = api.weBot.onNote(() => void refresh())
      // 任务开始的那一刻就把「运行中」写进记录并展开这一段的日志：
      // 定时任务可能跑几分钟，用户在这一页上要能看见它正在跑，而不是等最后
      // 弹一个弹窗。失败时的错误文本也随之落在同一处。
      const offRun = api.weBot.onRunStarted((run) => {
        setRuns((prev) => [run, ...prev.filter((item) => item.id !== run.id)])
        setOpenLogs((prev) => new Set(prev).add(run.taskId))
      })
      return () => {
        offNote()
        offRun()
      }
    },
    [api, refresh]
  )
  useEffect(() => unsubscribe(), [unsubscribe])

  const toggleLog = (taskId: string) => {
    setOpenLogs((prev) => {
      const next = new Set(prev)
      if (next.has(taskId)) next.delete(taskId)
      else next.add(taskId)
      return next
    })
  }

  // 一个任务都没有时自动展开编辑器：新用户第一次进来不该只看到一个空列表，
  // 直接把「怎么建第一个任务」摆在他面前。只自动展开一次，之后尊重用户的手动收起。
  const autoOpened = useRef(false)
  useEffect(() => {
    if (loading || autoOpened.current) return
    autoOpened.current = true
    if (tasks.length === 0) setEditorOpen(true)
  }, [loading, tasks.length])

  const runsByTask = useMemo(() => {
    const map = new Map<string, WeBotRun[]>()
    // runs 是**全量、倒序**（最新在前）的历史。旧实现每个任务只留第一条，
    // 于是「上次失败：fetch failed」后面没有任何上下文 —— 用户看不到这次
    // 是什么时候跑的、跑了多久、之前有没有成功过。这里按任务分组保留全部。
    for (const run of runs) {
      const list = map.get(run.taskId)
      if (list) list.push(run)
      else map.set(run.taskId, [run])
    }
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

  const openCreate = () => {
    startCreate()
    setEditorOpen(true)
    // 打开后把光标送进标题：这一步几乎总是用户点「新建任务」后想做的事。
    requestAnimationFrame(() => titleRef.current?.focus())
  }

  const openEdit = (task: WeBotTask) => {
    startEdit(task)
    setEditorOpen(true)
  }

  const closeEditor = () => {
    setEditorOpen(false)
    startCreate()
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
      closeEditor()
      await refresh()
    } catch (error) {
      setMessage(`保存失败：${String((error as Error)?.message || error)}`)
    }
  }

  const removeTask = async (task: WeBotTask) => {
    await api.weBot.deleteTask(task.id)
    if (editingId === task.id) closeEditor()
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
    // 光标只有在**焦点确实还在输入框里**时才可信：用户在弹层搜索框里打过字的话，
    // textarea.selectionStart 是上一次的旧值，用它去切文本会切错位置。
    const caret = document.activeElement === textarea ? (textarea?.selectionStart ?? mention.caret) : mention.caret
    // **只加 chip，不往输入框里写 `@名称`**：文本与引用列表各只有一个来源，
    // 同一份引用不会再出现两次（用户报的"名字同时出现在输入框和下面"）。
    const { value, caret: nextCaret } = stripMention(current, { start: mention.start, query: mention.query }, caret)
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

  /**
   * 弹层搜索框里改了查询串 → 改写输入框里的那段 `@查询`。
   *
   * 查询串的唯一来源是输入框的文本，弹层只是它的另一个视图；两边各存一份
   * 状态最后一定会跑偏（输入框里是 `@化`、列表筛的是 `化学`）。
   */
  const setMentionQuery = (query: string) => {
    if (!mention) return
    const textarea = descriptionRef.current
    const caret = document.activeElement === textarea ? (textarea?.selectionStart ?? mention.caret) : mention.caret
    const { value, caret: nextCaret } = rewriteMentionQuery(
      draft.description,
      { start: mention.start, query: mention.query },
      caret,
      query
    )
    setDraft((prev) => ({ ...prev, description: value }))
    setMention({ start: mention.start, query: value.slice(mention.start + 1, nextCaret), caret: nextCaret })
    // 焦点在弹层搜索框里时**不要**把它抢回 textarea —— 用户正在那里打字。
    if (document.activeElement?.closest?.('.ref-picker')) return
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
      {/* 顶部不再放「定时任务 / 笔记」切换 —— 左侧栏的 WeBot / WeBot 笔记
          就是同一个动作，一页里两套等价导航只会让人犹豫该点哪个。
          这里只保留一条紧凑工具栏：左边说明当前视图，右边放该视图的动作。 */}
      <div className="webot-toolbar">
        <div>
          <h2>{section === 'tasks' ? '定时任务' : '笔记'}</h2>
          <span className="webot-toolbar-sub">
            {section === 'tasks'
              ? `共 ${tasks.length} 个任务；任务到点自动执行，结果写入笔记`
              : `共 ${notes.length} 条笔记${unread > 0 ? ` · ${unread} 条未读` : ''}`}
          </span>
        </div>
        <div className="webot-toolbar-actions">
          {section === 'tasks' ? (
            <button type="button" className="secondary-btn" onClick={openCreate}>
              <Plus size={14} /> 新建任务
            </button>
          ) : (
            <>
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
                  <Trash2 size={13} /> 清空
                </button>
              ) : null}
            </>
          )}
        </div>
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
          {editorOpen ? (
            <section className="webot-editor" aria-label={editingId ? '编辑任务' : '新建任务'}>
              <header className="webot-editor-head">
                <h3>{editingId ? '编辑任务' : '新建任务'}</h3>
                <button type="button" className="ghost-btn" onClick={closeEditor}>
                  <X size={14} /> 关闭
                </button>
              </header>

              <div className="webot-editor-grid">
                <div className="webot-editor-col">
                  <label className="webot-field">
                    <span>标题</span>
                    <input
                      ref={titleRef}
                      value={draft.title}
                      maxLength={80}
                      placeholder="例如：化学群作业整理"
                      onChange={(e) => setDraft((prev) => ({ ...prev, title: e.target.value }))}
                    />
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
                  onBlur={(e) => {
                    // 焦点落进选择器（它渲染在 body 下的浮层里，`relatedTarget`
                    // 仍然指向那个真实的 input）时**不要**关掉它 —— 用户点搜索框
                    // 是想在里面打字，旧版那 120ms 的延迟关闭正好把选择器收走，
                    // 于是"搜索框点了就没了"。
                    if ((e.relatedTarget as HTMLElement | null)?.closest?.('.ref-picker')) return
                    // 延迟关闭：点击选择器条目时会先触发 blur。
                    setTimeout(() => setMention(null), 120)
                  }}
                />
                {mention ? (
                  <ReferencePicker
                    ref={pickerRef}
                    anchor={descriptionRef}
                    query={mention.query}
                    candidates={candidates}
                    loading={candidatesState.loading}
                    ok={candidatesState.ok}
                    error={candidatesState.error}
                    onQueryChange={setMentionQuery}
                    onPick={pickReference}
                    onClose={() => setMention(null)}
                    pickedIds={draft.references.map((item) => item.id)}
                    onReturnFocus={() => descriptionRef.current?.focus()}
                  />
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

                </div>

                <div className="webot-editor-col">
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
                      <label className="webot-clock">
                        {/* 小时用 12 小时制下拉 + 上午/下午（用户报的："执行时间要 AM/PM，
                            小时是 12 不是 24"）。内部分钟点仍是 0–23：调度、已落盘的任务
                            与 `nextRunAfter` 都按 24 小时制工作，只有这一处录入/显示换算。 */}
                        <select
                          aria-label="小时"
                          value={twelveHour.hour}
                          onChange={(e) =>
                            setDraft((prev) => ({
                              ...prev,
                              hour: toTwentyFourHour(Number(e.target.value), twelveHour.meridiem),
                            }))
                          }
                        >
                          {HOUR12_OPTIONS.map((value) => (
                            <option key={value} value={value}>
                              {value}
                            </option>
                          ))}
                        </select>
                        <span>:</span>
                        <input
                          aria-label="分钟"
                          type="number"
                          min={0}
                          max={59}
                          value={draft.minute}
                          onChange={(e) => setDraft((prev) => ({ ...prev, minute: Number(e.target.value) || 0 }))}
                        />
                        <span className="segmented webot-meridiem" role="radiogroup" aria-label="上午或下午">
                          {(
                            [
                              { id: 'am', label: '上午' },
                              { id: 'pm', label: '下午' },
                            ] as const
                          ).map((option) => (
                            <button
                              key={option.id}
                              type="button"
                              role="radio"
                              aria-checked={twelveHour.meridiem === option.id}
                              className="segmented-item"
                              data-active={twelveHour.meridiem === option.id}
                              onClick={() =>
                                setDraft((prev) => ({ ...prev, hour: toTwentyFourHour(twelveHour.hour, option.id) }))
                              }
                            >
                              {option.label}
                            </button>
                          ))}
                        </span>
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
                </div>
              </div>

              <div className="webot-editor-actions">
                <button type="button" className="ghost-btn" onClick={closeEditor}>
                  取消
                </button>
                <button type="button" className="primary-btn" onClick={() => void save()}>
                  <Check size={14} />
                  {editingId ? '保存修改' : '创建任务'}
                </button>
              </div>
            </section>
          ) : null}

          <div className="webot-list">
            {tasks.length === 0 ? (
              <div className="webot-empty">
                还没有定时任务。点击右上角「新建任务」可以创建一个 —— 比如「每天 08:30 扫描化学群，把作业整理成笔记」。
              </div>
            ) : null}

            {tasks.map((task) => {
              const taskRuns = runsByTask.get(task.id) || []
              const lastRun = taskRuns[0]
              const logOpen = openLogs.has(task.id)
              const running = taskRuns.some((run) => run.status === 'running') || busyTaskId === task.id
              return (
                <div className="webot-card" key={task.id} data-active={editingId === task.id} data-enabled={task.enabled}>
                  <header>
                    <h4 className="webot-card-title">{task.title}</h4>
                    <label className="webot-switch" title={task.enabled ? '已启用，点击停用' : '已停用，点击启用'}>
                      <input type="checkbox" checked={task.enabled} onChange={() => void toggleEnabled(task)} />
                      <span />
                    </label>
                  </header>

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

                  {/* 上次失败只说一句话，**完整原因在运行记录里**：一句截断过的
                      `上次失败：fetch failed` 用户既无从判断是网络还是配置，
                      也看不到它是什么时候跑的、之前是否成功过。 */}
                  {lastRun?.status === 'error' ? (
                    <div className="webot-card-error">
                      <span>上次失败：{lastRun.error}</span>
                      <button type="button" className="ghost-btn" onClick={() => toggleLog(task.id)}>
                        {logOpen ? '收起记录' : '查看运行记录'}
                      </button>
                    </div>
                  ) : null}

                  {logOpen ? (
                    <div className="webot-runs" aria-label={`${task.title} 的运行记录`}>
                      {taskRuns.length === 0 ? (
                        <div className="webot-runs-empty">这个任务还没有运行过。</div>
                      ) : (
                        taskRuns.slice(0, 20).map((run) => (
                          <div className="webot-run" key={run.id} data-status={run.status}>
                            <div className="webot-run-head">
                              <span className="webot-run-time">{formatStamp(run.startedAt)}</span>
                              <span className="webot-run-status" data-status={run.status}>
                                {runStatusLabel(run.status)}
                              </span>
                              <span className="webot-run-duration">{formatDuration(run.durationMs)}</span>
                            </div>
                            {run.error ? <p className="webot-run-error">{run.error}</p> : null}
                            {run.noteId ? (
                              <p className="webot-run-note">
                                已写入笔记：
                                {notes.find((note) => note.id === run.noteId)?.title || '（已保留在笔记板）'}
                              </p>
                            ) : null}
                          </div>
                        ))
                      )}
                    </div>
                  ) : null}

                  {/* 动作单独占一行：卡片宽度只有 340px 上下，把开关和三个按钮塞进
                      标题那一行会把标题挤成每行一两个字。 */}
                  <div className="webot-card-actions">
                    <button type="button" className="ghost-btn" disabled={busyTaskId === task.id} onClick={() => void runTask(task)} title="立即运行一次">
                      <Play size={13} />
                      {busyTaskId === task.id ? '运行中…' : '运行'}
                    </button>
                    <button type="button" className="ghost-btn" onClick={() => openEdit(task)}>
                      <PenLine size={13} /> 编辑
                    </button>
                    {/* 运行记录入口一直存在（不只失败时）：想看「昨晚那次到底跑没跑」，
                        不该先制造一次失败。 */}
                    <button
                      type="button"
                      className="ghost-btn webot-card-log"
                      onClick={() => toggleLog(task.id)}
                      aria-expanded={logOpen}
                      data-busy={running || undefined}
                      title="运行记录"
                    >
                      <History size={13} />
                      {taskRuns.length > 0 ? taskRuns.length : ''}
                      {logOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                    </button>
                    <button
                      type="button"
                      className="ghost-btn webot-danger webot-card-delete"
                      onClick={() => void removeTask(task)}
                      title="删除任务（已有笔记会保留）"
                      aria-label={`删除任务 ${task.title}`}
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      ) : (
        <div className="webot-notes">
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
