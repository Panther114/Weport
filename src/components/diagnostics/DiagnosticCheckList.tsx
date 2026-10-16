import { useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, ChevronDown, ChevronRight, Copy, HelpCircle, XCircle } from 'lucide-react'

/**
 * 分组检查列表（v1.2 §5）。
 *
 * 记录形状直接沿用 `electron/services/macDiagnosticsService.ts` 定下来的
 * `{ id, label, state, detail, raw? }` —— 这一页只是把它跨平台化，不再发明第二套词汇。
 *
 * 两条界面纪律：
 *   1. **颜色不是唯一通道**：每条检查都有状态文字（正常/注意/异常/未知），
 *      色盲用户与灰度截图都能读懂；
 *   2. **raw 默认折叠**：它是最长、最像"日志"的一段，展开是用户主动要的动作。
 */

type CheckState = 'ok' | 'warn' | 'fail' | 'unknown'

/**
 * 分组表（**与 electron/services/diagnosticsService.ts 的 DIAGNOSTIC_GROUPS 保持一致**）。
 *
 * 渲染层不能 import 引擎模块（那会把 fs / child_process 拖进浏览器包），所以这张表
 * 在两边各存一份：引擎那份决定 checks.md 的小节顺序，这份决定页面上的分组标题。
 * 新增检查前缀时两处都要加；`groupOf` 对未知前缀回落到「其它」，不会把检查项弄丢。
 */
const GROUPS: Array<{ id: string; title: string; hint: string }> = [
  { id: 'app', title: '应用与构建', hint: '版本、平台、运行形态' },
  { id: 'wechat', title: '微信连接', hint: '安装、运行、版本、数据目录与账号' },
  { id: 'db', title: '数据库与密钥', hint: '逐库打开状态、密钥指纹、首页 HMAC 校验' },
  { id: 'engine', title: 'WCDB 宿主', hint: '子进程存活、动态库路径、初始化错误' },
  { id: 'config', title: '配置', hint: '路径、可读性、密文计数' },
  { id: 'logs', title: '日志', hint: '文件与最新错误行' },
  { id: 'env', title: '运行环境', hint: '磁盘、内存、WebView2、提权、系统版本' },
  { id: 'perm', title: '权限', hint: '微信目录可读、userData 与导出目录可写' },
  { id: 'other', title: '其它', hint: '未归类的检查项' },
]

const STATE_TEXT: Record<CheckState, string> = {
  ok: '正常',
  warn: '注意',
  fail: '异常',
  unknown: '未知',
}

function groupOf(id: string): string {
  const prefix = String(id || '').split('.')[0]
  return GROUPS.some((group) => group.id === prefix) ? prefix : 'other'
}

function StateIcon({ state }: { state: CheckState }) {
  const size = 15
  const strokeWidth = 2
  if (state === 'ok') {
    // 「正常」用文字+点表示即可，勾太多会显得吵；异常/注意/未知才需要图形强调。
    return <span className="dx-state-dot" aria-hidden="true" />
  }
  if (state === 'fail') return <XCircle size={size} strokeWidth={strokeWidth} aria-hidden="true" />
  if (state === 'warn') return <AlertTriangle size={size} strokeWidth={strokeWidth} aria-hidden="true" />
  return <HelpCircle size={size} strokeWidth={strokeWidth} aria-hidden="true" />
}

function StateBadge({ state }: { state: CheckState }) {
  return (
    <span className="dx-state" data-state={state}>
      <StateIcon state={state} />
      {STATE_TEXT[state]}
    </span>
  )
}

/** 一条检查的可复制文本：状态 + 结论 + 原始输出（raw 为可选）。 */
function checkToText(check: DiagnosticsCheck): string {
  const lines = [`[${check.state.toUpperCase()}] ${check.label}（${check.id}）`, check.detail]
  if (check.raw) lines.push('--- 原始输出 ---', check.raw)
  return lines.join('\n')
}

interface DiagnosticCheckListProps {
  checks: DiagnosticsCheck[]
  /** 重新检测进行中：禁用逐条复制之外的动作（避免复制到半旧的数据）。 */
  busy?: boolean
}

export default function DiagnosticCheckList({ checks, busy = false }: DiagnosticCheckListProps) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const [copied, setCopied] = useState<string>('')
  /** "已复制"的复位定时器（见 copyCheck）。 */
  const copyTimer = useRef<number | null>(null)
  useEffect(() => () => {
    if (copyTimer.current !== null) window.clearTimeout(copyTimer.current)
  }, [])

  const grouped = useMemo(() => {
    const buckets = new Map<string, DiagnosticsCheck[]>()
    for (const check of checks) {
      const key = groupOf(check.id)
      const list = buckets.get(key)
      if (list) list.push(check)
      else buckets.set(key, [check])
    }
    return GROUPS
      .map((group) => ({ ...group, checks: buckets.get(group.id) ?? [] }))
      .filter((group) => group.checks.length > 0)
  }, [checks])

  async function copyCheck(check: DiagnosticsCheck): Promise<void> {
    try {
      await navigator.clipboard.writeText(checkToText(check))
      setCopied(check.id)
      // 复位定时器跟着组件走：切页/卸载后到点回调一个已卸载的组件没有意义
      if (copyTimer.current !== null) window.clearTimeout(copyTimer.current)
      copyTimer.current = window.setTimeout(() => setCopied((current) => (current === check.id ? '' : current)), 1600)
    } catch {
      setCopied('')
    }
  }

  return (
    <div className="dx-groups">
      {grouped.map((group) => {
        const failures = group.checks.filter((check) => check.state === 'fail').length
        const warns = group.checks.filter((check) => check.state === 'warn').length
        return (
          <section className="dx-group" key={group.id} aria-label={group.title}>
            <div className="dx-group-head">
              <h3>{group.title}</h3>
              <span className="dx-group-hint">{group.hint}</span>
              <span className="dx-group-roll">
                {group.checks.length} 项
                {failures > 0 ? ` · 异常 ${failures}` : ''}
                {warns > 0 ? ` · 注意 ${warns}` : ''}
              </span>
            </div>
            {group.checks.map((check) => {
              const isOpen = expanded[check.id] === true
              const rawId = `dx-raw-${check.id.replace(/[^a-zA-Z0-9_-]/g, '-')}`
              return (
                <article className="dx-check" data-state={check.state} key={check.id}>
                  <div className="dx-check-main">
                    <div className="dx-check-top">
                      <StateBadge state={check.state} />
                      <span className="dx-check-label" title={check.label}>
                        {check.label}
                      </span>
                      <span className="dx-check-actions">
                        {check.raw ? (
                          <button
                            type="button"
                            className="dx-icon-btn"
                            aria-expanded={isOpen}
                            aria-controls={rawId}
                            title={isOpen ? '收起原始输出' : '展开原始输出'}
                            onClick={() =>
                              setExpanded((current) => ({ ...current, [check.id]: !isOpen }))
                            }
                          >
                            {isOpen ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
                            <span className="sr-only">{isOpen ? '收起原始输出' : '展开原始输出'}</span>
                          </button>
                        ) : null}
                        <button
                          type="button"
                          className="dx-icon-btn"
                          disabled={busy}
                          title="复制这条检查（含原始输出）"
                          aria-label={`复制检查：${check.label}`}
                          onClick={() => void copyCheck(check)}
                        >
                          <Copy size={14} />
                        </button>
                      </span>
                      {copied === check.id ? (
                        <span className="dx-note" role="status">
                          已复制
                        </span>
                      ) : null}
                    </div>
                    <p className="dx-check-detail">{check.detail}</p>
                    {check.raw && isOpen ? (
                      <pre className="dx-raw" id={rawId}>
                        {check.raw}
                      </pre>
                    ) : null}
                  </div>
                </article>
              )
            })}
          </section>
        )
      })}
    </div>
  )
}
