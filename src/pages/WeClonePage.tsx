import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  Fingerprint,
  Info,
  KeyRound,
  Loader2,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  Trash2,
  Users,
  XCircle,
} from 'lucide-react'
import { EmptyState } from '../components/EmptyState'
import WeCloneProgress from '../components/weclone/WeCloneProgress'
import WeCloneCard from '../components/weclone/WeCloneCard'
import WeCloneModelCard from '../components/weclone/WeCloneModelCard'
import WeCloneChatDrawer from '../components/weclone/WeCloneChatDrawer'
import WeCloneSettingsPanel from '../components/weclone/WeCloneSettingsPanel'
import { useLiveTask } from '../hooks/useLiveTask'
import { LIVE_TASK, liveTask } from '../utils/liveTask'
import type { WeCloneListItem, WeCloneProgressInfo } from '../types/weclone'

type WeCloneSection = 'hub' | 'manage' | 'create'

type ToastKind = 'ok' | 'err' | 'info'
interface PageToast {
  id: number
  kind: ToastKind
  title: string
  body?: string
}

let toastSeq = 1

/**
 * 上次停留的分区 —— **模块级**，活得比这个页面久。
 *
 * 页面是条件渲染的：切到「导出数据」再切回来，整个组件重新挂载，
 * `useState('hub')` 会把用户扔回入口页。用户看到的是"我刚才在生成，回来
 * 怎么变回首页了"。修法有两层：
 *
 *   1. 记住上次的分区，回来还在原来那一屏；
 *   2. **有任务在跑时优先回到 create** —— 生成进度长在那个分区上，
 *      把用户送回 manage/hub 等于让他自己再点一次才能看见进度。
 *      "切走再回来还得重新找一遍进度"正是用户报的那件事。
 */
let lastSection: WeCloneSection = 'hub'

export default function WeClonePage() {
  const api = window.electronAPI

  // ---------------------------------------------------------------- 分区导航
  //
  // 初值不能直接写 'hub'：这个组件在切页时会被卸载重建，固定初值等于每次
  // 回来都把用户扔回入口页。有生成任务在跑时更要直接落到 create ——
  // 那是唯一能看到进度的地方。
  const [section, setSection] = useState<WeCloneSection>(() => {
    const task = liveTask(LIVE_TASK.wecloneGenerate).getState()
    if (task.status === 'running') return 'create'
    return lastSection
  })

  /** 切分区时同时记到模块变量里，供下次挂载恢复 */
  const gotoSection = useCallback((next: WeCloneSection) => {
    lastSection = next
    setSection(next)
  }, [])

  // ---------------------------------------------------------------- 列表 / 状态
  const [clones, setClones] = useState<WeCloneListItem[]>([])
  const [listLoading, setListLoading] = useState(true)
  const [remoteError, setRemoteError] = useState('')

  // ---------------------------------------------------------------- 生成流程
  //
  // 进度**不放在这个页面的 state 里**。
  //
  // 用户报的问题：生成克隆时切到别的面板，再切回来就什么都看不到了 —— 页面被
  // 卸载，`generating` / `progress` / `logs` 一起消失，而主进程还在跑。更狠的是
  // 托盘隐藏会销毁整个窗口。
  //
  // 现在进度活在模块级 store（`utils/liveTask.ts`，由 `main.tsx` 在启动时接线）
  // 里，这个组件只是它的一个视图：切回来时读到的就是最新值，窗口重建后
  // `task:status` 快照还会把日志和开始时间一起补回来。
  const generateTask = useLiveTask(LIVE_TASK.wecloneGenerate)
  const generating = generateTask.status === 'running'
  /**
   * 终态文案认 **store 的 status**，不认主进程的 stage。
   *
   * 主进程两个方向都用 `stage: 'done'` 收尾（成功是"克隆已生成"，失败是
   * "生成失败：…"），所以只按 stage 判会把**一次失败显示成「生成完成」**——
   * 实测撞上过：卡在 relationships.md 之后报"生成完成"，而磁盘上的 metadata
   * 还是上一版的。status 是渲染层与主进程各自显式写入的终态，它没有歧义。
   */
  const taskStatus = generateTask.status
  /**
   * 用户点了「收起」的那一轮（用它的 startedAt 标识）。
   *
   * 收起的判断必须写在**任务轮次**上而不是一个布尔值：布尔值在页面卸载时丢掉，
   * 切回来就会把用户已经收起的面板又弹出来；而"这一轮被收起过"是可以从
   * startedAt 复原的。
   */
  const dismissedTaskId = useRef<number | undefined>(undefined)
  /** 收起/展开是纯 UI 动作，用一个计数器强制重算（可见性由上面的 ref 决定） */
  const [, setPanelTick] = useState(0)
  const panelOpen = generating || dismissedTaskId.current !== generateTask.startedAt
  const progress: WeCloneProgressInfo | null =
    generateTask.status === 'idle'
      ? null
      : {
          stage: (generateTask.stage as WeCloneProgressInfo['stage']) || 'scan',
          progress: generateTask.progress,
          message: generateTask.message,
        }
  const logs = generateTask.logs
  /** 对话抽屉的目标分身：非空即打开 */
  const [chatTarget, setChatTarget] = useState<WeCloneListItem | null>(null)
  /** 设置的编辑目标：非空即打开 */
  const [settingsTarget, setSettingsTarget] = useState<WeCloneListItem | null>(null)
  /** 渲染侧取消句柄：中止本地 UI 状态跟踪（真正的取消走 weclone.cancel IPC） */
  const abortRef = useRef<AbortController | null>(null)

  // ---------------------------------------------------------------- 删除确认
  const [confirmDelete, setConfirmDelete] = useState<WeCloneListItem | null>(null)
  const [deleteBusy, setDeleteBusy] = useState(false)

  // ---------------------------------------------------------------- 生成选项
  /**
   * 导出时是否做敏感信息脱敏。**默认开**，并且存在配置里 —— 勾了之后再切页面
   * 回来，勾选状态不该自己变回默认。
   */
  const [redact, setRedact] = useState(true)
  useEffect(() => {
    void (async () => {
      try {
        const result = await api.weclone.getRedact()
        if (result.success) setRedact(result.redact !== false)
      } catch { /* 读不到就用默认（开） */ }
    })()
  }, [api])

  const toggleRedact = useCallback(
    (next: boolean) => {
      setRedact(next)
      void api.weclone.setRedact(next).catch(() => undefined)
    },
    [api]
  )

  // ---------------------------------------------------------------- 本地 toast
  const [toasts, setToasts] = useState<PageToast[]>([])
  const toastTimers = useRef<Map<number, number>>(new Map())

  const dismissToast = useCallback((id: number) => {
    const t = toastTimers.current.get(id)
    if (t) {
      window.clearTimeout(t)
      toastTimers.current.delete(id)
    }
    setToasts((prev) => prev.filter((x) => x.id !== id))
  }, [])

  const pushToast = useCallback(
    (kind: ToastKind, title: string, body?: string, ms = 5200) => {
      const id = toastSeq++
      setToasts((prev) => [...prev.slice(-4), { id, kind, title, body }])
      toastTimers.current.set(
        id,
        window.setTimeout(() => dismissToast(id), ms)
      )
    },
    [dismissToast]
  )

  useEffect(() => {
    const timers = toastTimers.current
    return () => {
      timers.forEach((t) => window.clearTimeout(t))
      timers.clear()
    }
  }, [])

  // ---------------------------------------------------------------- 数据加载
  const refreshList = useCallback(async () => {
    try {
      const result = await api.weclone.list()
      if (result.success) {
        setClones(result.clones || [])
        setRemoteError(String(result.error || ''))
      } else {
        pushToast('err', '克隆列表加载失败', result.error)
      }
    } catch (e) {
      pushToast('err', '克隆列表加载失败', String(e))
    } finally {
      setListLoading(false)
    }
  }, [api, pushToast])

  // 列表首次加载（仅挂载一次）。
  //
  // 进度**不订阅**：订阅在 `utils/liveTaskWiring.ts` 里、由 main.tsx 启动时装好，
  // 所以这里不再需要 useEffect 去接 IPC —— 也正因为如此，卸载这个页面不会
  // 打断任何东西。
  useEffect(() => {
    void refreshList()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /**
   * 生成一结束就重读列表。
   *
   * 为什么不能只靠 `handleGenerate` 成功分支里那句 `refreshList()`：那句话只有在
   * **发起生成的那个组件实例还活着**时才跑得掉。用户切走过、或者这一轮是被全局
   * 任务条感知到的，列表就会停在生成之前的那条记录上 —— 卡片上显示的是上一版的
   * 段数/token/时间，而点「行为」保存又会因为 clone id 已经换了而报「找不到该克隆」。
   * 实测就是这么翻车的：卡片上是「17 分 54 秒 / 1,044,454 tok」，磁盘上是
   * 「19 分 32 秒 / 1,159,698 tok」，设置改了保存不住。
   *
   * 挂在 store 的状态上就没有这个前提 —— 谁先发现任务结束都无所谓。
   */
  useEffect(() => {
    if (generateTask.status === 'done') void refreshList()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [generateTask.status])

  // ---------------------------------------------------------------- 派生统计
  const totalClones = clones.length
  const latestCutoff = useMemo(() => {
    let max = ''
    for (const c of clones) {
      if (c.knowledgeCutoff && c.knowledgeCutoff > max) max = c.knowledgeCutoff
    }
    return max
  }, [clones])

  /**
   * 最近那个克隆的生成深度（段数 / 耗时）。
   *
   * 入口页原来只说"N 个 WeClone · 知识截止 X"—— 那是**数据范围**，不是
   * **生成质量**。用户最想知道的是"这次它到底读了多少段、跑了多久"，因为
   * 「它不了解我」的抱怨只有这两个数字能回答。详情在卡片上，一眼可见的
   * 摘要放在入口页。
   */
  const latestDepth = useMemo(() => {
    const newest = [...clones].sort((a, b) => String(b.generatedAt).localeCompare(String(a.generatedAt)))[0]
    if (!newest || !newest.shardCount) return ''
    const minutes = Math.round((newest.elapsedMs || 0) / 60000)
    return `${newest.shardCount} 段${minutes > 0 ? ` · ${minutes} 分钟` : ''}`
  }, [clones])

  const handleRefreshAll = useCallback(() => {
    setListLoading(true)
    void refreshList()
  }, [refreshList])

  // ---------------------------------------------------------------- 一键生成
  const handleGenerate = useCallback(async () => {
    if (generating) return

    // 前置检查 1：数据目录 / 账号 / 密钥（与连接页 allReady 同口径）
    try {
      const [dbPath, decryptKey, myWxid] = await Promise.all([
        api.config.get('dbPath'),
        api.config.get('decryptKey'),
        api.config.get('myWxid'),
      ])
      if (!String(dbPath || '').trim() || String(decryptKey || '').trim().length !== 64 || !String(myWxid || '').trim()) {
        pushToast('err', '请先完成「连接微信」配置', '需要数据目录、账号与 64 位解密密钥就绪后才能扫描聊天记录')
        return
      }
    } catch { /* 主进程不可用时让服务端报错 */ }

    // 前置检查 2：AI 服务配置
    try {
      const setup = await api.ai.getSetup()
      if (!setup.profiles || setup.profiles.length === 0 || !setup.hasApiKey) {
        pushToast('err', '请先配置 WePort AI', '生成人格档案需要可用的 AI 服务，请前往「设置 → AI 服务」添加')
        return
      }
    } catch { /* 忽略预检失败，由主进程兜底报错 */ }

    const ctrl = new AbortController()
    abortRef.current = ctrl
    dismissedTaskId.current = undefined
    // 唯一的进度起点：写进模块级 store，这个页面卸载也不会丢
    liveTask(LIVE_TASK.wecloneGenerate).start('正在检查配置…')

    try {
      const result = await api.weclone.generate({ redact })
      const task = liveTask(LIVE_TASK.wecloneGenerate)
      if (result.success) {
        pushToast('ok', '克隆生成完成', '人格档案与语料已保存在本机，可以开始对话了', 7000)
        task.update({ status: 'done', progress: 100, message: '生成完成' })
        void refreshList()
      } else if (result.aborted) {
        pushToast('info', '已取消生成', '已扫描的部分不会保留')
        task.update({ status: 'aborted', message: '已取消' })
      } else {
        const msg = String(result.error || '未知错误')
        task.update({ status: 'failed', message: msg, error: msg })
        if (msg.includes('未配置 AI')) {
          pushToast('err', '请先配置 WePort AI', msg, 9000)
        } else {
          pushToast('err', '克隆生成失败', msg, 10000)
        }
      }
    } catch (e) {
      const msg = String(e)
      liveTask(LIVE_TASK.wecloneGenerate).update({ status: 'failed', message: msg, error: msg })
      pushToast('err', '克隆生成失败', msg, 10000)
    } finally {
      abortRef.current = null
    }
  }, [api, generating, pushToast, refreshList, redact])

  const handleCancelGenerate = useCallback(async () => {
    abortRef.current?.abort()
    try {
      await api.weclone.cancel()
      pushToast('info', '正在取消生成…', '等待当前步骤安全退出')
    } catch { /* noop */ }
  }, [api, pushToast])

  // ---------------------------------------------------------------- 删除
  const handleDelete = useCallback(async () => {
    const target = confirmDelete
    if (!target || deleteBusy) return
    setDeleteBusy(true)
    try {
      const result = await api.weclone.delete(target.id)
      if (result.success) {
        pushToast('ok', '克隆已删除', '本机档案与语料已移除')
        setConfirmDelete(null)
        void refreshList()
      } else {
        pushToast('err', '删除失败', result.error)
      }
    } catch (e) {
      pushToast('err', '删除失败', String(e))
    } finally {
      setDeleteBusy(false)
    }
  }, [api, confirmDelete, deleteBusy, pushToast, refreshList])

  // ---------------------------------------------------------------- Hub（入口选择）
  if (section === 'hub') {
    return (
      <div className="v09-page analytics-hub weclone-hub">
        {/* hero 与页面头重复，去掉后两张卡片能在不滚动的情况下全部可见
            （与「分析」入口同样的处理）。 */}
        <div className="analytics-hub-cards">
          <button type="button" className="analytics-big-card" onClick={() => gotoSection('manage')}>
            <div className="analytics-big-icon">
              <Users size={44} strokeWidth={1.4} />
            </div>
            <div className="analytics-big-title">管理 WeClone</div>
            <div className="analytics-big-desc">
              {totalClones > 0
                ? `${totalClones} 个 WeClone · 知识截止 ${latestCutoff || '—'}${latestDepth ? ` · ${latestDepth}` : ''} · 全部仅存本机`
                : '查看已生成的 WeClone · 档案预览、行为设置与本机对话'}
            </div>
            <div className="analytics-big-arrow">
              进入管理
              <ArrowRight size={15} />
            </div>
          </button>
          <button type="button" className="analytics-big-card" onClick={() => gotoSection('create')}>
            <div className="analytics-big-icon">
              <Sparkles size={44} strokeWidth={1.4} />
            </div>
            <div className="analytics-big-title">新建 WeClone</div>
            <div className="analytics-big-desc">逐段提炼全部聊天记录 · 可选脱敏 · 可随时取消</div>
            <div className="analytics-big-arrow">
              开始生成
              <ArrowRight size={15} />
            </div>
          </button>
        </div>
      </div>
    )
  }

  // ---------------------------------------------------------------- 工具栏（manage / create 共用）
  const toolbar = (
    <div className="v09-toolbar">
      <div className="v09-toolbar-title">
        <Fingerprint size={17} />
        <span>{section === 'manage' ? '管理 WeClone' : '新建 WeClone'}</span>
        <span className="v09-sub">
          {section === 'manage' ? '人格档案与每个克隆的行为设置' : '逐段提炼聊天记录，生成本地人格档案'}
        </span>
      </div>
      <div className="v09-actions">
        {section === 'manage' && (
          /* 原来这里是一个"服务器在线/离线"指示灯 —— 没有服务器了，改成说明
             这个功能的边界。用户最该知道的一件事就是"数据不出本机"。 */
          <span className="weclone-server-chip online" title="人格档案与语料只保存在本机；对话也在本机完成">
            <span className="weclone-server-dot" />
            数据仅存本机
          </span>
        )}
        <button type="button" className="chip" onClick={() => gotoSection('hub')}>
          <ArrowLeft size={14} />
          返回
        </button>
      </div>
    </div>
  )

  // 对话抽屉必须挂在**每个**分支上，不能只挂在文件末尾那个 return。
  // 「管理分身」是独立的 early return，之前只把抽屉加到末尾，于是从列表点
  // 「开始对话」永远不会打开任何东西 —— 状态改了，但没有地方渲染它。
  const chatDrawer = chatTarget ? (
    <WeCloneChatDrawer clone={chatTarget} onClose={() => setChatTarget(null)} />
  ) : null

  // ---------------------------------------------------------------- Manage（列表）
  if (section === 'manage') {
    return (
      <div className="v09-page">
        {toolbar}

        {listLoading ? (
          <div className="page-loading">
            <Loader2 size={22} className="spin" />
            <span className="hint">正在加载克隆列表…</span>
          </div>
        ) : clones.length === 0 ? (
          <div className="v09-panel">
            <EmptyState
              icon={Fingerprint}
              title="还没有 WeClone"
              hint="前往「新建 WeClone」，把聊天记录逐段提炼成人格档案。全程在本机完成，不会上传到任何服务器。"
            />
            <div className="weclone-empty-cta">
              <button className="primary-btn" type="button" disabled={generating} onClick={() => gotoSection('create')}>
                <Sparkles size={14} />
                去新建 WeClone
              </button>
            </div>
          </div>
        ) : (
          <>
            <div className="v09-toolbar-sub">
              <h3 style={{ margin: 0, fontSize: 13.5 }}>我的克隆</h3>
              {totalClones > 0 && <span className="badge">{totalClones}</span>}
              {remoteError && (
                <span className="hint">远端列表获取失败：{remoteError}（仅显示本地档案）</span>
              )}
              <button
                className="ghost-btn compact"
                type="button"
                style={{ marginLeft: 'auto' }}
                disabled={listLoading}
                onClick={handleRefreshAll}
              >
                <RefreshCw size={13} />
                刷新
              </button>
            </div>
            <div className="weclone-grid">
              {clones.map((clone) => (
                <WeCloneCard
                  key={clone.id}
                  clone={clone}
                  onDeleteRequest={(c) => setConfirmDelete(c)}
                  onChat={(c) => setChatTarget(c)}
                  onSettings={(c) => setSettingsTarget(c)}
                />
              ))}
            </div>
            {chatDrawer}
            {settingsTarget && (
              <WeCloneSettingsPanel
                clone={settingsTarget}
                onClose={() => setSettingsTarget(null)}
                onStale={() => {
                  // 这个 clone id 已经不存在（重新生成过克隆）——
                  // 关掉设置、重读列表，让卡片显示的是当前这一版，而不是继续
                  // 让用户在上一版上改设置（改十次十次都会被回滚）。
                  setSettingsTarget(null)
                  pushToast('info', '这个克隆已被新的一次生成替换', '列表已刷新，请在新的卡片上修改设置', 8000)
                  void refreshList()
                }}
              />
            )}
          </>
        )}

        {/* ---- 删除确认 ---- */}
        {confirmDelete && (
          <div className="wp-overlay" onClick={() => !deleteBusy && setConfirmDelete(null)}>
            <div className="wp-dialog weclone-delete-dialog" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
              <div className="wp-dialog-icon danger">
                <Trash2 size={20} />
              </div>
              <h3 className="wp-dialog-title">删除克隆「{confirmDelete.displayName || confirmDelete.id}」？</h3>
              <p className="wp-dialog-desc">
                将删除本机的人格档案与语料。本机是唯一副本，删除后无法恢复。
              </p>
              <div className="wp-dialog-actions">
                <button className="secondary-btn" type="button" disabled={deleteBusy} onClick={() => setConfirmDelete(null)}>
                  取消
                </button>
                <button className="danger-btn" type="button" disabled={deleteBusy} onClick={() => void handleDelete()}>
                  {deleteBusy ? '删除中…' : '确认删除'}
                </button>
              </div>
            </div>
          </div>
        )}

        <ToastStack toasts={toasts} onDismiss={dismissToast} />
      </div>
    )
  }

  // ---------------------------------------------------------------- Create（生成 + 配置）
  return (
    <div className="v09-page">
      {toolbar}

      <div className="v09-panel weclone-generate">
        <div className="weclone-generate-main">
          <strong>一键生成 WeClone</strong>
          <span>
            扫描全部聊天记录（<strong>不抽样、不截断</strong>），按时间切成若干段逐段交给 AI 提炼，
            再归并成人格画像、关系图谱、知识库、时间线与语料样例，全部<strong>在本机</strong>保存，
            随后就能像「你本人」一样与它对话。整个过程通常要几分钟到十几分钟。
          </span>
        </div>
        <button
          className="primary-btn weclone-generate-btn"
          type="button"
          disabled={generating}
          onClick={() => void handleGenerate()}
        >
          {generating ? <Loader2 size={14} className="spin" /> : <Sparkles size={14} />}
          {generating ? '生成中…' : '开始生成'}
        </button>
      </div>

      {/*
        生成选项。
        脱敏开关放在"开始生成"正下方，因为它改变的是**这一次**生成的产物，
        而不是某个全局偏好 —— 用户点之前就该看见它，而不是事后在设置里翻到。
      */}
      <div className="v09-panel weclone-options">
        <div className="weclone-option-row">
          <label className="weclone-option" data-active={redact}>
            <input
              type="checkbox"
              checked={redact}
              disabled={generating}
              onChange={(e) => toggleRedact(e.target.checked)}
            />
            <span className="weclone-option-main">
              <strong>移除敏感信息（推荐）</strong>
              <span>
                扫描时把身份证号、手机号、银行卡号、密码、精确住址这类能直接拿去用的内容
                替换成占位符，生成时再让模型复核一遍。
              </span>
            </span>
          </label>
        </div>
        {!redact && (
          <p className="weclone-option-warn">
            <ShieldAlert size={12} />
            <span>
              已关闭脱敏：语料会保留原文，人格档案里也可能出现原始的手机号、住址等内容。
              数据仍然只存在本机，但你自己跟它聊天时会看到这些。
            </span>
          </p>
        )}
        <p className="weclone-exp-sub" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <ShieldCheck size={12} />
          <span>
            生成进度会一直显示，切换页面或最小化都不会中断；它跑在本机，随时可以取消。
          </span>
        </p>
      </div>

      {(generating || panelOpen) && (
        <WeCloneProgress
          running={generating}
          progress={progress}
          logs={logs}
          startedAt={generateTask.startedAt}
          status={taskStatus}
          onCancel={() => void handleCancelGenerate()}
          onDismiss={() => {
            // 收起只是隐藏面板，**不取消任务** —— 用户可能只是想去看别的页面。
            // 记住"这一轮被收起过"（用 startedAt 标识轮次）而不是一个布尔值：
            // 布尔值在页面卸载时会丢，切回来就会把已经收起的面板又弹出来。
            dismissedTaskId.current = generateTask.startedAt
            setPanelTick((n) => n + 1)
          }}
        />
      )}

      {/*
        生成完成后的下一步。
        面板只说"完成了"，而用户此刻最想做的事是**去看那个克隆 / 直接开始对话**。
        以前这一步要自己点「返回」再点「管理 WeClone」—— 而生成页的返回按钮在
        页头右上角，跟刚跑完的进度面板隔了整整一屏。
      */}
      {generateTask.status === 'done' && (
        <div className="v09-panel weclone-done-cta">
          <div className="weclone-done-main">
            <CheckCircle2 size={16} />
            <span>
              <strong>克隆已生成。</strong>
              人格档案、语气语料与风格指纹都在本机，可以开始对话了。
            </span>
          </div>
          <button className="primary-btn" type="button" onClick={() => gotoSection('manage')}>
            查看与对话
            <ArrowRight size={14} />
          </button>
        </div>
      )}

      <div className="v09-panel">
        <div className="v09-panel-head">
          <h3>
            <KeyRound size={15} />
            生成用的模型
          </h3>
          <span className="v09-sub">用哪个 AI 把聊天记录提炼成人格档案</span>
        </div>

        <WeCloneModelCard />

        <p className="weclone-exp-sub" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <ShieldCheck size={12} />
          <span>
            你的聊天记录、生成出的档案与语料<strong>只保存在本机</strong>
            ：不上传、不经过任何 Weport 服务器。对话时只会把它们交给你配置的那个模型。
          </span>
        </p>
      </div>

      <ToastStack toasts={toasts} onDismiss={dismissToast} />
      {chatDrawer}
    </div>
  )
}

/* ---------------------------------------------------------------- 页内 toast 栈（复用全局样式） */
function ToastStack({ toasts, onDismiss }: { toasts: PageToast[]; onDismiss: (id: number) => void }) {
  return (
    <div className="toast-stack" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className="toast" data-kind={t.kind}>
          <span className="toast-icon">
            {t.kind === 'ok' ? <CheckCircle2 size={16} /> : t.kind === 'err' ? <XCircle size={16} /> : <Info size={16} />}
          </span>
          <div>
            <h4>{t.title}</h4>
            {t.body ? <p>{t.body}</p> : null}
          </div>
          <button className="toast-close" type="button" aria-label="关闭" onClick={() => onDismiss(t.id)}>
            ×
          </button>
        </div>
      ))}
    </div>
  )
}
