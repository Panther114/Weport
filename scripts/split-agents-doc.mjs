/**
 * 把 AGENTS.md 里"按模块/历史"的章节移到 docs/agents/ 下，并留下指向性的一行。
 *
 * 为什么必须做：工作区指令有 65536 字节预算，超出的部分会被**截断**，也就是静默地
 * 对 agent 不可见。79 KB 的 AGENTS.md 意味着最后约 14 KB（Export Layout / CI /
 * Releases / Reference Repos 等）等于没写 —— 而"约束文件被截断"比"文件太长"危险得多。
 *
 * 留在 AGENTS.md 的是**动手前必须知道的不变量**（WCDB 宿主、弹窗、探针第一规则、
 * 内存引用规则、构建与发布流程）；移出去的是模块说明与历史叙述。
 *
 * 幂等：重复运行不会重复搬（找不到章节就跳过）。
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'

const SRC = 'AGENTS.md'
const OUT_DIR = 'docs/agents'

/** heading 前缀 → 目标文件 */
const PLAN = [
  ['## v0.9 Modules — 朋友圈 (SNS) / 分析 (Analytics)', 'modules.md'],
  ['## v0.9.5 Modules — MCP 服务 / 分析新图表', 'modules.md'],
  ['## Export Layout', 'modules.md'],
  ['## Contact Name Warmup', 'modules.md'],
  ['## WeClone (`electron/services/weCloneService.ts`) — v1.0 (local-only)', 'weclone.md'],
  ['### WeClone Chat History & Language — v1.0.1', 'weclone.md'],
  ['## WeClone Provider — v1.0.1 (local-only, no forced service)', 'weclone.md'],
  ['## Linux Packaging (v0.9.10)', 'platform.md'],
  ['## Weport TUI (`packages/weport-tui`) — v1.0', 'platform.md'],
  ['## Connectors (`electron/services/connectors/`) — v1.0', 'platform.md'],
  ['## Reference Repos (on-disk only, never shipped)', 'platform.md'],
  ['## v0.9.6 Reference-Study Policy', 'platform.md'],
]

const DOC_TITLES = {
  'modules.md': '# 模块说明（SNS / 分析 / MCP / 导出 / 联系人预热）',
  'weclone.md': '# WeClone（人格克隆）与它的服务解析',
  'platform.md': '# 平台打包、TUI、连接器与参考仓库',
}

const raw = readFileSync(SRC, 'utf8')
const lines = raw.split(/\r?\n/)
const before = Buffer.byteLength(raw, 'utf8')

/** 找到 heading 行的下标；`###` 与 `##` 都按"以该前缀开头"匹配 */
function findHeading(prefix) {
  return lines.findIndex((l) => l.trim() === prefix.trim() || l.startsWith(prefix))
}

/** 取一个章节：[start, endExclusive)，end 是下一个同级或更高级的 heading */
function sectionRange(start) {
  const level = (lines[start].match(/^#+/) || ['#'])[0].length
  let end = lines.length
  for (let i = start + 1; i < lines.length; i++) {
    const m = lines[i].match(/^(#+) /)
    if (m && m[1].length <= level) {
      end = i
      break
    }
  }
  return [start, end]
}

mkdirSync(OUT_DIR, { recursive: true })
const buckets = new Map()
const moved = []
// 从后往前删，避免下标失效
const removals = []

for (const [prefix, doc] of PLAN) {
  const start = findHeading(prefix)
  if (start === -1) {
    console.warn(`[skip] 找不到章节：${prefix}`)
    continue
  }
  const [s, e] = sectionRange(start)
  const body = lines.slice(s, e).join('\n').trimEnd()
  if (!buckets.has(doc)) buckets.set(doc, [])
  buckets.get(doc).push(body)
  removals.push([s, e, prefix])
  moved.push({ prefix, doc, bytes: Buffer.byteLength(body, 'utf8') })
}

if (moved.length === 0) {
  console.log('没有可搬的章节（可能已经搬过了）。')
  process.exit(0)
}

// 写目标文档
for (const [doc, sections] of buckets) {
  const p = `${OUT_DIR}/${doc}`
  const existing = existsSync(p) ? readFileSync(p, 'utf8').trimEnd() + '\n\n' : ''
  const head = existing ? '' : `${DOC_TITLES[doc]}\n\n> 从 ` + '`AGENTS.md`' + ` 拆出：这里是模块与历史说明，不是动手前必读的不变量。\n\n`
  writeFileSync(p, `${existing}${head}${sections.join('\n\n')}\n`, 'utf8')
}

// 在 AGENTS.md 中把搬走的章节换成指向性一行
for (const [s, e, prefix] of removals.sort((a, b) => b[0] - a[0])) {
  const doc = PLAN.find(([p]) => p === prefix)[1]
  const heading = lines[s]
  const stub = `${heading}\n\n已移至 [\`${OUT_DIR}/${doc}\`](${OUT_DIR}/${doc})。\n`
  lines.splice(s, e - s, ...stub.split('\n'))
}

writeFileSync(SRC, lines.join('\n'), 'utf8')
const after = Buffer.byteLength(lines.join('\n'), 'utf8')

console.log(`AGENTS.md: ${before} B → ${after} B  (预算 65536)`)
console.log(`搬迁章节 ${moved.length} 个：`)
for (const m of moved.sort((a, b) => b.bytes - a.bytes)) {
  console.log(`  ${String(m.bytes).padStart(6)} B  → docs/agents/${m.doc}   ${m.prefix.slice(0, 60)}`)
}
console.log(`余量：${65536 - after} B`)
