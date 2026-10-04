import { useMemo, useState } from 'react'
import { Copy, Search } from 'lucide-react'

const ERROR_CODES = [
  { code: '-3001', meaning: '未找到数据库目录（db_storage）', action: '确认数据目录指向账号目录的父目录；macOS 微信 4.x 通常在 xwechat_files。' },
  { code: '-3002', meaning: '未找到 session.db', action: '检查账号目录是否选错，或微信是否尚未在该账号下产生会话。' },
  { code: '-3003 / -3004', meaning: '数据库句柄无效 / 恢复连接失败', action: '确认微信正在运行；重启微信后重新连接。' },
  { code: '-2301', meaning: 'WCDB 动态库加载失败', action: '重新安装 Weport，并把诊断包里的动态库候选路径交给维护者。' },
  { code: '-2302 / -2303', meaning: 'WCDB 初始化异常 / 初始化失败', action: '查看 wcdb.log 中的 bootstrap 行，确认动态库版本与平台匹配。' },
  { code: '-1006', meaning: 'WCDB 宿主文件名自检失败', action: '宿主必须以 WeFlow.exe（Windows）或 WeFlow（macOS/Linux）启动；重新安装以修复宿主。' },
  { code: '-3999', meaning: '初始化失败且未解析出具体错误码', action: '查看同一条错误附带的原始原因与 wcdb.log。' },
  { code: '-3998', meaning: '连接期间出现未预期异常', action: '查看完整异常与诊断包；确认数据库目录仍可读。' },
]

export default function ErrorCodeHandbook() {
  const [query, setQuery] = useState('')
  const [copied, setCopied] = useState('')
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return needle
      ? ERROR_CODES.filter((item) => `${item.code} ${item.meaning} ${item.action}`.toLowerCase().includes(needle))
      : ERROR_CODES
  }, [query])

  async function copy(item: (typeof ERROR_CODES)[number]) {
    const text = `${item.code}｜${item.meaning}｜${item.action}`
    try {
      await navigator.clipboard.writeText(text)
      setCopied(item.code)
      window.setTimeout(() => setCopied((current) => current === item.code ? '' : current), 1500)
    } catch {
      setCopied('')
    }
  }

  return (
    <section className="dx-handbook" aria-label="错误码手册">
      <div className="dx-monitor-head">
        <div>
          <h3>错误码手册</h3>
          <p>可按错误码或关键词搜索；处理建议也可复制。</p>
        </div>
        <label className="dx-handbook-search">
          <Search size={14} aria-hidden="true" />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索错误码或含义" aria-label="搜索错误码" />
        </label>
      </div>
      {filtered.length ? (
        <div className="dx-error-code-list">
          {filtered.map((item) => (
            <article className="dx-error-code" key={item.code}>
              <code>{item.code}</code>
              <div><b>{item.meaning}</b><p>{item.action}</p></div>
              <button type="button" className="ghost-btn compact" onClick={() => void copy(item)} aria-label={`复制 ${item.code} 的说明`} title="复制说明">
                <Copy size={13} />{copied === item.code ? '已复制' : '复制'}
              </button>
            </article>
          ))}
        </div>
      ) : <p className="dx-note">没有匹配的错误码。</p>}
    </section>
  )
}
