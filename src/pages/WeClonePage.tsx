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

export default function WeClonePage() {
  const api = window.electronAPI

  // ---------------------------------------------------------------- 分区导航
  const [section, setSection] = useState<WeCloneSection>('hub')

  // ---------------------------------------------------------------- 列表 / 状态
  const [clones, setClones] = useState<WeCloneListItem[]>([])
  const [listLoading, setListLoading] = useState(true)
  const [remoteError, setRemoteError] = useState('')

  // ---------------------------------------------------------------- 生成流程
  const [generating, setGenerating] = useState(false)
  const [progress, setProgress] = useState<WeCloneProgressInfo | null>(null)
  const [logs, setLogs] = useState<string[]>([])
  const [panelOpen, setPanelOpen] = useState(false)
  /** 对话抽屉的目标分身：非空即打开 */
  const [chatTarget, setChatTarget] = useState<WeCloneListItem | null>(null)
  /** 渲染侧取消句柄：中止本地 UI 状态跟踪（真正的取消走 weclone.cancel IPC） */
  const abortRef = useRef<AbortController | null>(null)

  // ---------------------------------------------------------------- 删除确认
  const [confirmDelete, setConfirmDelete] = useState<WeCloneListItem | null>(null)
  const [deleteBusy, setDeleteBusy] = useState(false)

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

  // 进度订阅 + 首次加载（仅挂载一次）
  useEffect(() => {
    void refreshList()
    const unsub = api.weclone.onProgress((payload) => {
      // 主进程只会发 scan / generate / filter / done；这里收紧一次类型，
      // 免得 "upload" 这种已经不存在的阶段漏进 UI（上传功能已整体移除）。
      const rawStage = String(payload?.stage || 'scan')
      const stage: WeCloneProgressInfo['stage'] =
        rawStage === 'generate' || rawStage === 'filter' || rawStage === 'done' ? rawStage : 'scan'
      const p: WeCloneProgressInfo = {
        stage,
        progress: Number(payload?.progress) || 0,
        message: String(payload?.message || ''),
      }
      setProgress(p)
      if (p.message) {
        const time = new Date().toLocaleTimeString('zh-Hans-CN', { hour12: false })
        setLogs((prev) => [...prev.slice(-199), `[${time}] ${p.message}`])
      }
    })
    return unsub
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ---------------------------------------------------------------- 派生统计
  const totalClones = clones.length
  const latestCutoff = useMemo(() => {
    let max = ''
    for (const c of clones) {
      if (c.knowledgeCutoff && c.knowledgeCutoff > max) max = c.knowledgeCutoff
    }
    return max
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
    setGenerating(true)
    setPanelOpen(true)
    setProgress({ stage: 'scan', progress: 0, message: '正在检查配置…' })
    setLogs([])

    try {
      const result = await api.weclone.generate()
      if (result.success) {
        pushToast('ok', '克隆生成完成', '人格档案与语料已保存在本机，可以开始对话了', 7000)
        setProgress((prev) => (prev ? { ...prev, stage: 'done', progress: 100, message: '生成完成' } : prev))
        void refreshList()
      } else if (result.aborted) {
        pushToast('info', '已取消生成', '已扫描的部分不会保留')
        // 终态必须显式落下：否则面板停在最后一个中途阶段，"已取消"看起来还在跑
        setProgress((prev) => (prev ? { ...prev, stage: 'aborted', message: '已取消' } : prev))
      } else {
        const msg = String(result.error || '未知错误')
        setProgress((prev) => (prev ? { ...prev, stage: 'failed', message: msg } : prev))
        if (msg.includes('未配置 AI')) {
          pushToast('err', '请先配置 WePort AI', msg, 9000)
        } else {
          pushToast('err', '克隆生成失败', msg, 10000)
        }
      }
    } catch (e) {
      pushToast('err', '克隆生成失败', String(e), 10000)
      setProgress((prev) => (prev ? { ...prev, stage: 'failed', message: String(e) } : prev))
    } finally {
      abortRef.current = null
      setGenerating(false)
    }
  }, [api, generating, pushToast, refreshList])

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
          <button type="button" className="analytics-big-card" onClick={() => setSection('manage')}>
            <div className="analytics-big-icon">
              <Users size={44} strokeWidth={1.4} />
            </div>
            <div className="analytics-big-title">管理 WeClone</div>
            <div className="analytics-big-desc">
              {totalClones > 0
                ? `${totalClones} 个 WeClone · 知识截止 ${latestCutoff || '—'} · 全部仅存本机`
                : '查看已生成的 WeClone · 档案预览与本机对话'}
            </div>
            <div className="analytics-big-arrow">
              进入管理
              <ArrowRight size={15} />
            </div>
          </button>
          <button type="button" className="analytics-big-card" onClick={() => setSection('create')}>
            <div className="analytics-big-icon">
              <Sparkles size={44} strokeWidth={1.4} />
            </div>
            <div className="analytics-big-title">新建 WeClone</div>
            <div className="analytics-big-desc">扫描聊天记录 · 隐私脱敏后生成 WeClone，可随时取消</div>
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
          {section === 'manage' ? '人格档案列表与分享控制' : '从聊天记录生成本地人格档案'}
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
        <button type="button" className="chip" onClick={() => setSection('hub')}>
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
              hint="前往「新建 WeClone」，从聊天记录中提炼你的人格知识库；生成后可设为公开或链接分享。"
            />
            <div className="weclone-empty-cta">
              <button className="primary-btn" type="button" disabled={generating} onClick={() => setSection('create')}>
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
                />
              ))}
            </div>
            {chatDrawer}
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
            扫描全部聊天记录，AI 提炼人格画像、关系图谱、知识库、时间线与语料样例，
            经双重隐私脱敏后<strong>在本机</strong>生成 WeClone，随后就能像「你本人」一样与它对话。
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

      {(generating || panelOpen) && (
        <WeCloneProgress
          running={generating}
          progress={progress}
          logs={logs}
          onCancel={() => void handleCancelGenerate()}
          onDismiss={() => setPanelOpen(false)}
        />
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
