import { useCallback, useEffect, useRef, useState } from 'react'
import { AlertTriangle, Database, Loader2, RefreshCw, X } from 'lucide-react'
import { EmptyState } from '../EmptyState'
import { useLiveTask } from '../../hooks/useLiveTask'
import { LIVE_TASK, liveTask } from '../../utils/liveTask'
import { formatRelative } from './searchQuery'

/**
 * 索引状态与"还没有索引"的空状态（v1.2 §6）。
 *
 * 铁律 3：建索引是长任务，**进度不许存在页面的 useState 里** —— 切页会卸载组件、
 * 托盘隐藏会销毁窗口，而主进程还在建。所以：
 *
 *   1. 点「建立索引」只发一次 `search:buildIndex`，拿到 taskId；
 *   2. 进度从 `LIVE_TASK.searchIndex` 这个模块级 store 订阅（接线在
 *      `utils/liveTaskWiring.ts`，由 main.tsx 在启动时装好）；
 *   3. 页面的 `indexStatus` 只在任务收尾时刷新一次（`ready/accounts` 那种"结果性"
 *      信息走状态接口，不是进度）。
 *
 * 「取消」按 AGENTS.md 的口径只发一个事件给外壳（`WEPORT_CANCEL_INDEX_EVENT`），
 * 由持有 taskId 的那一层去调真正的取消通道 —— 页面拿不到 taskId 之外的句柄，
 * 自己发明一个取消通道只会得到"按钮点了没反应"。
 */
export const WEPORT_CANCEL_INDEX_EVENT = 'weport:search-cancel-index'

export interface IndexStateProps {
  index: SearchIndexStatus | null
  indexLoading: boolean
  indexError: string | null
  /** 重新向引擎要一次状态（建完、取消完、手动刷新） */
  onRefresh: () => void
}

function useBuildTask() {
  const task = useLiveTask(LIVE_TASK.searchIndex)
  const start = useCallback((message: string) => liveTask(LIVE_TASK.searchIndex).start(message), [])
  const running = task.status === 'running'
  return { ...task, start, running }
}

/** 「陈旧」只写在账号级（`accounts[].stale`），这里统一派生顶部那一档。 */
function anyStale(accounts: SearchIndexAccountStatus[] | undefined): boolean {
  return Array.isArray(accounts) && accounts.some((account) => account?.stale === true)
}

/** 顶部状态条：只在"需要说点什么"时出现（就绪且新鲜时显示一行统计）。 */
export function IndexStatusBar({ index, indexLoading, indexError, onRefresh }: IndexStateProps) {
  const task = useBuildTask()
  const stale = anyStale(index?.accounts)
  const building = task.running || Boolean(index?.building)
  const progress = building ? Math.max(task.progress, Math.round((index?.progress || 0) * 100)) : task.progress

  return (
    <div className="sp-status" role="status" aria-live="polite">
      <span className="sp-status-icon" aria-hidden>
        {building ? <Loader2 size={13} className="spin" /> : <Database size={13} />}
      </span>

      {indexError ? (
        <span className="sp-status-text is-warn">
          <AlertTriangle size={12} aria-hidden />
          索引状态读取失败：{indexError}
        </span>
      ) : building ? (
        <span className="sp-status-text">
          正在建立索引{task.stage ? `（${task.stage}）` : ''}
          {task.message ? ` · ${task.message}` : ''}
          {progress > 0 ? ` · ${Math.round(progress)}%` : ''}
        </span>
      ) : index?.ready ? (
        <span className="sp-status-text">
          索引就绪 · {index.docs.toLocaleString('zh-CN')} 条
          {index.lastBuiltAt ? ` · 更新于 ${formatRelative(index.lastBuiltAt)}` : ''}
          {index.accounts?.length
            ? ` · ${index.accounts.map((account) => `${account.wxid}${account.stale ? '（待更新）' : ''}`).join('、')}`
            : ''}
        </span>
      ) : indexLoading ? (
        <span className="sp-status-text">正在检查索引…</span>
      ) : (
        <span className="sp-status-text is-warn">
          <AlertTriangle size={12} aria-hidden />
          尚未建立索引，搜索无结果
        </span>
      )}

      <span className="sp-status-actions">
        {building && (
          <button
            type="button"
            className="ghost-btn sp-status-btn"
            onClick={() => window.dispatchEvent(new CustomEvent(WEPORT_CANCEL_INDEX_EVENT))}
          >
            <X size={12} aria-hidden />
            取消
          </button>
        )}
        {!building && (stale || !index?.ready) && (
          <BuildButton onStarted={onRefresh} label={index?.ready ? '重建索引' : '建立索引'} />
        )}
        {!building && index?.ready && !stale && (
          <BuildButton onStarted={onRefresh} label="重建" subtle icon={<RefreshCw size={12} aria-hidden />} />
        )}
      </span>

      {building && (
        <span className="sp-status-track" aria-hidden>
          <span className="sp-status-fill" style={{ width: `${Math.max(2, Math.min(100, progress))}%` }} />
        </span>
      )}
    </div>
  )
}

function BuildButton({
  onStarted,
  label,
  force,
  subtle,
  icon,
}: {
  onStarted: () => void
  label: string
  force?: boolean
  subtle?: boolean
  icon?: React.ReactNode
}) {
  const task = useBuildTask()
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  return (
    <>
      <button
        type="button"
        className={subtle ? 'ghost-btn sp-status-btn' : 'ghost-btn sp-status-btn is-primary'}
        disabled={busy || task.running}
        onClick={() => {
          const api = typeof window !== 'undefined' ? window.electronAPI : undefined
          if (!api?.search?.buildIndex) {
            setError('建索引通道不可用')
            return
          }
          setBusy(true)
          setError(null)
          api.search
            .buildIndex({ force: force ?? true })
            .then((res) => {
              /**
               * 任务的 running 状态由 `liveTaskWiring` 从主进程快照灌进来；这里只做
               * 一件事：**任务真的起来了**（拿到了 taskId）才把本地 store 置成 running。
               * 反过来（先 start 再调用）会让调用失败时界面上留下一条永远在跑的假进度。
               */
              if (res && typeof res.taskId === 'string' && res.taskId) task.start('正在准备索引…')
              else setError('建索引没有返回任务号')
              onStarted()
            })
            .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
            .finally(() => setBusy(false))
        }}
      >
        {icon}
        {label}
      </button>
      {error && <span className="sp-status-err">{error}</span>}
    </>
  )
}

/**
 * "索引还没建好"的整页空状态：这是搜索页最重要的一个状态 ——
 * 一个空结果列表必须能区分"没建索引"和"没搜到"，否则用户会以为自己的记录丢了。
 */
export function EmptyIndexState({ index, indexLoading, indexError, onRefresh }: IndexStateProps) {
  const task = useBuildTask()
  const building = task.running || Boolean(index?.building)
  const doneAt = useRef<number | undefined>(undefined)

  /**
   * 任务收尾（成功 / 失败 / 取消）后刷新一次状态接口。
   * `doneAt` 去重：状态条每次重渲染都会跑这个 effect，但终态只该触发一次刷新。
   */
  useEffect(() => {
    const terminal = task.status === 'done' || task.status === 'failed' || task.status === 'aborted'
    if (!terminal) return
    if (doneAt.current === task.finishedAt) return
    doneAt.current = task.finishedAt
    onRefresh()
  }, [task.status, task.finishedAt, onRefresh])

  const progress = Math.max(task.progress, Math.round((index?.progress || 0) * 100))

  if (indexLoading && !index) return <EmptyState icon={Database} title="正在检查索引…" />
  if (building) {
    return (
      <div className="sp-build" role="status" aria-live="polite">
        <div className="sp-build-title">
          <Loader2 size={16} className="spin" aria-hidden />
          正在建立搜索索引
        </div>
        <div className="sp-build-track" aria-hidden>
          <div className="sp-build-fill" style={{ width: `${Math.max(2, Math.min(100, progress))}%` }} />
        </div>
        <p className="sp-build-note">{task.message || '首次建立需要扫描本机会话，完成后输入即搜'}</p>
        <button
          type="button"
          className="ghost-btn"
          onClick={() => window.dispatchEvent(new CustomEvent(WEPORT_CANCEL_INDEX_EVENT))}
        >
          <X size={12} aria-hidden />
          取消建立
        </button>
      </div>
    )
  }

  return (
    <div className="sp-build">
      <EmptyState
        icon={Database}
        title={indexError ? '索引状态读取失败' : '尚未建立搜索索引'}
        hint={indexError || index?.error || '建立索引后，可以跨会话搜索消息内容。索引只存在本机，不上传任何数据。'}
      />
      {/* 建索引按钮放在顶部的状态条里（那里是"全局状态"的唯一位置）：
          这里再放一颗会变成同一屏两个"建立索引"，用户要点哪个？ */}
    </div>
  )
}
