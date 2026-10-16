/**
 * 诊断页用的小工具（渲染层纯函数，无 Electron 依赖，可单测）。
 *
 * 单独成文件的原因：页面组件 import 了 scss 与 lucide-react，在 node 环境里跑不起来；
 * 把可测的部分摘出来，页面里只留状态与 JSX。
 */

/** 人类可读的字节数（与 electron/services/diagnosticsService.ts 的 formatBytes 同规则）。 */
export function formatBytes(bytes: number | undefined): string {
  const value = Number(bytes)
  if (!Number.isFinite(value) || value <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let scaled = value
  let index = 0
  while (scaled >= 1024 && index < units.length - 1) {
    scaled /= 1024
    index += 1
  }
  return `${scaled >= 100 || index === 0 ? Math.round(scaled) : scaled.toFixed(1)} ${units[index]}`
}

/**
 * 取路径的父目录。
 *
 * 渲染层没有 `path` 模块（也不能引：那是 Node 内建），而诊断包路径可能是 Windows
 * 分隔符也可能是 POSIX 的。取两种分隔符里靠后的那个即可，尾部分隔符会被忽略
 * （`C:\a\b\` → `C:\a`；`/` → `/`）。
 */
export function parentDirOf(target: string): string {
  const text = String(target || '')
  let end = text.length
  while (end > 1 && (text[end - 1] === '\\' || text[end - 1] === '/')) end -= 1
  const trimmed = text.slice(0, end)
  const index = Math.max(trimmed.lastIndexOf('\\'), trimmed.lastIndexOf('/'))
  if (index < 0) return ''
  if (index === 0) return trimmed.slice(0, 1)
  // 保留 `C:\` 这种根：`C:\file.zip` 的父目录应是 `C:\`
  if (index === 2 && /^[A-Za-z]:$/.test(trimmed.slice(0, 2))) return trimmed.slice(0, 3)
  return trimmed.slice(0, index)
}
