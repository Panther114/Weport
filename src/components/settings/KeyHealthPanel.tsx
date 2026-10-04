import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import {
  AlertTriangle,
  CheckCircle2,
  ClipboardCheck,
  Copy,
  Database,
  HelpCircle,
  Loader2,
  MinusCircle,
  RefreshCw,
  ShieldCheck,
  Trash2,
} from 'lucide-react'

/**
 * §10.4 密钥健康面板。
 *
 * ## 它替代的那个结论
 *
 * 旧界面只有一个"密钥对不对"的答案。多库/多账号时这句话没有信息量：用户看到
 * "密钥无效"却不知道是 22 个库里的哪一个坏了、坏的是"密钥错"还是"库换了"。
 * 这个面板把结论拆到**每库一行**，并且每行都给出**下一步做什么**。
 *
 * ## 硬约束（决定了这里的交互长什么样）
 *
 * 1. **完整密钥永远不会回到渲染层。** 引擎只回指纹（`b62d…6768`），所以面板里
 *    没有"查看/复制密钥"这种入口 —— 不是没做，是设计上不存在。
 * 2. **粘贴是"先验证后落盘"。** 引擎会用 page 1 HMAC 对着目标库验一遍，验不过
 *    就原样保持（不覆盖任何已验证的好密钥），错误直接显示在这一行下面。
 * 3. **四种粘贴语法都收**：裸 64 hex / `0x` 前缀 / `x'…'`（WCDB 形式）/
 *    `<key><salt>` 96 hex。归一化在引擎侧（`wcdbPageKey.parsePastedKeyInput`），
 *    面板只负责把用户的原文送过去。
 *
 * 样式自带（`wkh-` 前缀 + 组件内 `<style>`），不往共享 scss 里加规则；
 * 按钮沿用全局 `.primary-btn` / `.secondary-btn` / `.link-btn` / `.hint` 视觉原语。
 */

interface KeyHealthPanelProps {
  /** 可选：指定账号目录；不传则用当前配置的账号。 */
  accountDir?: string
  /** 可选：面板里点了"重新扫描"之后的回调（页面据此刷新自己的密钥状态）。 */
  onChanged?: (report: KeyHealthReport) => void
  /** 可选：外部已知的阻塞项（§1 前置矩阵），会显示在面板顶部。 */
  blockers?: Array<{ id: string; message: string; actionable: string }>
}

const STATUS_META: Record<
  KeyHealthEntry['status'],
  { label: string; tone: string; icon: ReactNode }
> = {
  ok: { label: '校验通过', tone: 'ok', icon: <CheckCircle2 size={13} /> },
  stale: { label: '库已更换', tone: 'warn', icon: <AlertTriangle size={13} /> },
  invalid: { label: '不匹配', tone: 'error', icon: <AlertTriangle size={13} /> },
  missing: { label: '库不存在', tone: 'muted', icon: <MinusCircle size={13} /> },
  unknown: { label: '未校验', tone: 'muted', icon: <HelpCircle size={13} /> },
}

const SOURCE_LABEL: Record<NonNullable<KeyHealthEntry['source']>, string> = {
  scan: '免登录扫描',
  hook: '登录捕获',
  manual: '手动粘贴',
  config: '历史配置',
}

/** 上一次取密钥用的模式（契约里的 `KeyHealthReport.mode`）。 */
const MODE_LABEL: Record<'scan' | 'hook' | 'manual' | 'none', string> = {
  scan: '免登录扫描',
  hook: '登录捕获',
  manual: '手动粘贴',
  none: '尚无',
}

/** 粘贴语法的占位提示：四种写法都给出示例，用户不用猜。 */
const PASTE_PLACEHOLDER = "粘贴 64 位密钥：xxxx…（也支持 0x… / x'…' / 带 salt 的 96 位）"

function timeAgo(ts?: number): string {
  if (!ts) return '—'
  const diff = Date.now() - ts
  if (diff < 60_000) return '刚刚'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`
  return `${Math.floor(diff / 86_400_000)} 天前`
}

export default function KeyHealthPanel({ accountDir, onChanged, blockers }: KeyHealthPanelProps) {
  const [report, setReport] = useState<KeyHealthReport | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<'rescan' | string>('')
  const [error, setError] = useState<string>('')
  const [notice, setNotice] = useState<string>('')
  const [pasteFor, setPasteFor] = useState<string>('')
  const [pasteText, setPasteText] = useState<string>('')
  const [pasteError, setPasteError] = useState<string>('')
  const [confirmCopy, setConfirmCopy] = useState<string>('')

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const next = await window.electronAPI.keyHealth.get()
      setReport(next)
      setError(next?.error || '')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh, accountDir])

  const databases = useMemo(() => report?.databases ?? [], [report])
  const counts = useMemo(() => {
    const base = { ok: 0, stale: 0, invalid: 0, missing: 0, unknown: 0 }
    for (const entry of databases) base[entry.status]++
    return base
  }, [databases])
  const needsAttention = counts.stale + counts.invalid

  const rescan = async (kinds?: string[]) => {
    setBusy('rescan')
    setNotice('')
    setError('')
    try {
      const next = await window.electronAPI.keyHealth.rescan(kinds ? { kinds } : undefined)
      setReport(next)
      onChanged?.(next)
      const scanned = next.databases.filter((d) => d.status === 'ok').length
      const modeLabel = next.mode ? ` 本次密钥来源：${MODE_LABEL[next.mode]}。` : ''
      setNotice(`重新扫描完成：${scanned}/${next.databases.length} 个库校验通过。${modeLabel}`)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy('')
    }
  }

  const submitPaste = async (kind: string) => {
    const text = pasteText.trim()
    if (!text) {
      setPasteError('请先粘贴密钥。')
      return
    }
    setBusy(kind)
    setPasteError('')
    setNotice('')
    try {
      const result = await window.electronAPI.keyHealth.paste({ kind, text })
      if (!result.success) {
        // 关键：验不过就**不写入** —— 面板上已有 ✓ 的库不会被这一下弄坏
        setPasteError(result.error || '这把密钥没有通过该库的校验，未写入。')
        return
      }
      setPasteFor('')
      setPasteText('')
      setNotice(`已保存 ${kind}：${result.fingerprint || '（指纹不可用）'}。原文件未被改动，其它库的密钥保持原样。`)
      await refresh()
    } finally {
      setBusy('')
    }
  }

  const clearOne = async (kind: string) => {
    setBusy(kind)
    setNotice('')
    try {
      const result = await window.electronAPI.keyHealth.clear({ kind })
      if (!result.success) setError(result.error || '清除失败')
      else setNotice(`已清除 ${kind} 的密钥（其它库不受影响）。`)
      await refresh()
    } finally {
      setBusy('')
    }
  }

  const copyFingerprint = async (entry: KeyHealthEntry) => {
    if (confirmCopy !== entry.kind) {
      // 二次确认：指纹虽然不足以还原密钥，但仍是"这把密钥的身份"，不静默外带
      setConfirmCopy(entry.kind)
      setNotice('再点一次「复制指纹」确认复制（复制的是掩码指纹，不是完整密钥）。')
      return
    }
    try {
      await navigator.clipboard.writeText(`${entry.kind} ${entry.fingerprint || ''}`)
      setNotice(`已复制 ${entry.kind} 的指纹。完整密钥永远不会离开主进程，所以无法复制完整值。`)
    } catch {
      setNotice('浏览器拒绝了剪贴板访问。')
    } finally {
      setConfirmCopy('')
    }
  }

  return (
    <section className="wkh">
      <style>{WKH_STYLES}</style>

      <header className="wkh-head">
        <div className="wkh-title">
          <ShieldCheck size={16} />
          <strong>密钥健康</strong>
          <span className="wkh-sub">
            {report?.mode ? `上次取密钥：${MODE_LABEL[report.mode]}` : '逐库校验'}
          </span>
        </div>
        <div className="wkh-actions">
          <button className="secondary-btn" type="button" disabled={busy === 'rescan' || loading} onClick={() => void rescan()}>
            {busy === 'rescan' ? <Loader2 size={13} className="wkh-spin" /> : <RefreshCw size={13} />} 重新扫描全部
          </button>
          {needsAttention > 0 ? (
            <button
              className="secondary-btn"
              type="button"
              disabled={busy === 'rescan'}
              onClick={() => void rescan(databases.filter((d) => d.status !== 'ok').map((d) => d.kind))}
            >
              <RefreshCw size={13} /> 只重扫有问题的 {needsAttention} 个
            </button>
          ) : null}
        </div>
      </header>

      {(blockers || []).length > 0 ? (
        <ul className="wkh-blockers">
          {(blockers || []).map((blocker) => (
            <li key={blocker.id}>
              <AlertTriangle size={13} />
              <span>
                <strong>{blocker.message}</strong>
                {blocker.actionable ? <em>{blocker.actionable}</em> : null}
              </span>
            </li>
          ))}
        </ul>
      ) : null}

      <p className="wkh-summary">
        <Database size={13} /> 共 {databases.length} 个库：
        <span data-tone="ok">✓ {counts.ok}</span>
        {counts.stale > 0 ? <span data-tone="warn">⚠ {counts.stale} 已更换</span> : null}
        {counts.invalid > 0 ? <span data-tone="error">✗ {counts.invalid} 不匹配</span> : null}
        {counts.unknown > 0 ? <span data-tone="muted">○ {counts.unknown} 未校验</span> : null}
        {counts.missing > 0 ? <span data-tone="muted">－ {counts.missing} 不存在</span> : null}
      </p>

      {loading ? (
        <p className="wkh-empty">
          <Loader2 size={13} className="wkh-spin" /> 正在校验每个库的首页 HMAC…
        </p>
      ) : databases.length === 0 ? (
        <p className="wkh-empty">还没有可检查的数据库。请先在「连接微信」里选择微信数据目录。</p>
      ) : (
        <ul className="wkh-list">
          {databases.map((entry) => {
            const meta = STATUS_META[entry.status]
            return (
              <li key={entry.kind} className="wkh-row" data-status={entry.status}>
                <div className="wkh-row-main">
                  <span className="wkh-status" data-tone={meta.tone}>
                    {meta.icon} {meta.label}
                  </span>
                  <span className="wkh-kind" title={entry.path}>
                    {entry.kind}
                  </span>
                  <code className="wkh-fp">{entry.fingerprint || '未保存'}</code>
                  <span className="wkh-meta">
                    {entry.source ? SOURCE_LABEL[entry.source] : '—'}
                    {entry.verifiedAt ? ` · ${timeAgo(entry.verifiedAt)}` : ''}
                  </span>
                </div>

                {entry.status !== 'ok' && entry.error ? <p className="wkh-reason">{entry.error}</p> : null}

                <div className="wkh-row-actions">
                  <button className="link-btn" type="button" onClick={() => { setPasteFor(entry.kind === pasteFor ? '' : entry.kind); setPasteText(''); setPasteError('') }}>
                    {pasteFor === entry.kind ? '收起' : '粘贴该库密钥'}
                  </button>
                  <button className="link-btn" type="button" disabled={!entry.fingerprint} onClick={() => void copyFingerprint(entry)}>
                    <Copy size={12} /> 复制指纹
                  </button>
                  {entry.status !== 'missing' ? (
                    <button className="link-btn danger" type="button" disabled={busy === entry.kind} onClick={() => void clearOne(entry.kind)}>
                      <Trash2 size={12} /> 清除
                    </button>
                  ) : null}
                </div>

                {pasteFor === entry.kind ? (
                  <div className="wkh-paste">
                    <input
                      type="password"
                      autoComplete="off"
                      spellCheck={false}
                      placeholder={PASTE_PLACEHOLDER}
                      value={pasteText}
                      onChange={(event) => setPasteText(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') void submitPaste(entry.kind)
                      }}
                    />
                    <button className="primary-btn" type="button" disabled={busy === entry.kind} onClick={() => void submitPaste(entry.kind)}>
                      {busy === entry.kind ? '校验中…' : '保存到该库'}
                    </button>
                  </div>
                ) : null}

                {pasteFor === entry.kind && pasteError ? <p className="wkh-paste-error">{pasteError}</p> : null}
              </li>
            )
          })}
        </ul>
      )}

      {notice ? (
        <p className="wkh-message" data-kind="ok">
          <ClipboardCheck size={13} /> {notice}
        </p>
      ) : null}
      {error ? (
        <p className="wkh-message" data-kind="error">
          <AlertTriangle size={13} /> {error}
        </p>
      ) : null}

      <p className="hint">
        密钥只在本机使用：写入走合并流程（一个库失败不会影响其它库），完整密钥永不出主进程，界面与日志里只有
        <code>b62d…6768</code> 这样的指纹。
      </p>
    </section>
  )
}

/** 组件自带样式：不往共享 scss 里加规则，删掉这个组件不会留下孤儿样式。 */
const WKH_STYLES = `
.wkh { display: flex; flex-direction: column; gap: 10px; }
.wkh-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
.wkh-title { display: flex; align-items: center; gap: 8px; }
.wkh-sub { opacity: .6; font-size: 12px; }
.wkh-actions { display: flex; gap: 8px; flex-wrap: wrap; }
.wkh-summary { display: flex; align-items: center; gap: 10px; font-size: 12px; opacity: .85; margin: 0; }
.wkh-summary span[data-tone="ok"] { color: #3fb950; }
.wkh-summary span[data-tone="warn"] { color: #d29922; }
.wkh-summary span[data-tone="error"] { color: #f85149; }
.wkh-summary span[data-tone="muted"] { opacity: .6; }
.wkh-blockers { list-style: none; margin: 0; padding: 8px 10px; border-radius: 8px; background: rgba(210,153,34,.10); border: 1px solid rgba(210,153,34,.35); display: flex; flex-direction: column; gap: 6px; }
.wkh-blockers li { display: flex; gap: 8px; font-size: 12px; line-height: 1.5; }
.wkh-blockers em { display: block; font-style: normal; opacity: .8; }
.wkh-empty { display: flex; align-items: center; gap: 8px; font-size: 12px; opacity: .75; margin: 0; }
.wkh-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.wkh-row { border: 1px solid rgba(127,127,127,.22); border-radius: 8px; padding: 8px 10px; display: flex; flex-direction: column; gap: 6px; }
.wkh-row[data-status="invalid"] { border-color: rgba(248,81,73,.45); }
.wkh-row[data-status="stale"] { border-color: rgba(210,153,34,.45); }
.wkh-row-main { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.wkh-status { display: inline-flex; align-items: center; gap: 4px; font-size: 12px; min-width: 84px; }
.wkh-status[data-tone="ok"] { color: #3fb950; }
.wkh-status[data-tone="warn"] { color: #d29922; }
.wkh-status[data-tone="error"] { color: #f85149; }
.wkh-status[data-tone="muted"] { opacity: .6; }
.wkh-kind { font-size: 12px; font-weight: 600; }
.wkh-fp { font-size: 11px; opacity: .8; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.wkh-meta { font-size: 11px; opacity: .6; margin-left: auto; }
.wkh-reason { margin: 0; font-size: 12px; opacity: .85; line-height: 1.5; }
.wkh-row-actions { display: flex; gap: 12px; flex-wrap: wrap; }
.wkh-paste { display: flex; gap: 8px; align-items: center; }
.wkh-paste input { flex: 1; min-width: 200px; }
.wkh-paste-error { margin: 0; font-size: 12px; color: #f85149; }
.wkh-message { display: flex; align-items: center; gap: 6px; font-size: 12px; margin: 0; }
.wkh-message[data-kind="ok"] { color: #3fb950; }
.wkh-message[data-kind="error"] { color: #f85149; }
.wkh-spin { animation: wkh-spin 1s linear infinite; }
@keyframes wkh-spin { to { transform: rotate(360deg); } }
`
