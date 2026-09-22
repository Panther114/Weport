#!/usr/bin/env node
/**
 * verify-cache-prefix.mjs — 用**真实运行日志**核对前缀稳定性。
 *
 * 背景：单元测试能证明「给定这套请求构造方式，相邻请求逐字节只增不改」，
 * 但它证明不了真实运行时前缀没有被别的东西改写（设置变更、工具集变化、
 * 压缩、平台分支……）。这个脚本直接读主进程写的
 * `weport-ai/debug.log`，逐条核对每条请求的前缀变化原因。
 *
 * 期望的健康形态（见 docs/reference/dsh-cache-architecture.md §D.3）：
 *   - 一整轮里全是 `append`；
 *   - `first` 只出现在每一轮的第一步（帧从 prefix-probe.json 恢复后，重启后的
 *     第一条应是带 `restored` 的 `append`，`first` 只属于全新会话）；
 *   - `head-rewrite` 只在压缩之后出现，且每一轮次数很少；
 *   - `system` / `tools` / `route` 在同一个会话里**永远不该出现** —— 出现即
 *     前缀整段失效（route = provider/model/protocol 换了缓存域）。
 *
 * 用法：
 *   node scripts/verify-cache-prefix.mjs [debug.log 路径]
 * 默认路径：%APPDATA%/Weport/weport-ai/debug.log（macOS/Linux 为 ~/... 下同）。
 *
 * 退出码：0 = 没有异常；1 = 发现 system/tools 变化或无法解释的 head-rewrite。
 * 注意：本脚本只能核对**前缀稳定性**，不能测出真实命中率 —— 命中率需要
 * provider 返回的 usage，那由应用内右下角读数给出。
 */
import { existsSync, readFileSync } from 'node:fs'
import { homedir, platform } from 'node:os'
import { join } from 'node:path'

const EXPLAINED = new Set(['first', 'append'])

function defaultLogPath() {
  const home = homedir()
  if (platform() === 'win32') return join(process.env.APPDATA || join(home, 'AppData', 'Roaming'), 'Weport', 'weport-ai', 'debug.log')
  if (platform() === 'darwin') return join(home, 'Library', 'Application Support', 'Weport', 'weport-ai', 'debug.log')
  return join(process.env.XDG_CONFIG_HOME || join(home, '.config'), 'Weport', 'weport-ai', 'debug.log')
}

const logPath = process.argv[2] || defaultLogPath()

if (!existsSync(logPath)) {
  console.log(`未找到调试日志：${logPath}`)
  console.log('先运行一次 WeportAI 长任务（应用内「调试日志」也会写这里），再执行本脚本。')
  process.exit(0)
}

const entries = []
for (const line of readFileSync(logPath, 'utf8').split(/\r?\n/)) {
  if (!line.trim()) continue
  try {
    const parsed = JSON.parse(line)
    if (parsed?.kind === 'prefix') entries.push(parsed)
  } catch {
    // 日志可能被截断（进程被杀），跳过坏行而不是整体失败。
  }
}

if (entries.length === 0) {
  console.log(`日志里没有前缀探针记录：${logPath}`)
  console.log('说明这份日志来自 v1.0 之前的版本，或者还没有跑过 AI 任务。')
  process.exit(0)
}

// 按 chatId 分组，并保持原始顺序 —— 前缀稳定性是**顺序**性质，排序会毁掉它。
const byChat = new Map()
for (const entry of entries) {
  const key = String(entry.chatId || 'unknown')
  if (!byChat.has(key)) byChat.set(key, [])
  byChat.get(key).push(entry)
}

let failures = 0
console.log(`前缀探针记录 ${entries.length} 条，覆盖 ${byChat.size} 个会话\n`)

for (const [chatId, list] of byChat) {
  const counts = new Map()
  for (const entry of list) counts.set(entry.change, (counts.get(entry.change) || 0) + 1)

  const append = counts.get('append') || 0
  const first = counts.get('first') || 0
  const rewrite = counts.get('head-rewrite') || 0
  const system = counts.get('system') || 0
  const tools = counts.get('tools') || 0
  const route = counts.get('route') || 0
  const explained = append + first + rewrite

  const rate = list.length > 0 ? ((append + first) / list.length) * 100 : 0

  console.log(`会话 ${chatId.slice(0, 8)}…  请求 ${list.length} 条`)
  console.log(`  append=${append}  first=${first}  head-rewrite=${rewrite}  system=${system}  tools=${tools}  route=${route}`)
  console.log(`  可复用前缀比例：${rate.toFixed(1)}%（head-rewrite 之后的那一条必然失效）`)

  if (system > 0) {
    console.log('  ✗ 会话中途系统提示发生变化 —— 整段前缀失效')
    failures += 1
  }
  if (tools > 0) {
    console.log('  ✗ 会话中途工具定义发生变化 —— 整段前缀失效')
    failures += 1
  }
  if (route > 0) {
    console.log('  ✗ 会话中途模型路由（provider/model/protocol）变化 —— 换了缓存域，全量重算')
    failures += 1
  }
  // 压缩以外的 head-rewrite 说明历史被改写；正常一轮不会有几次。
  if (rewrite > Math.max(1, Math.floor(list.length / 50))) {
    console.log(`  ✗ head-rewrite 次数偏多（${rewrite}）—— 压缩触发可能又变频繁了`)
    failures += 1
  }
  console.log('')
}

if (failures > 0) {
  console.error(`发现 ${failures} 处前缀稳定性问题。`)
  process.exit(1)
}

console.log('前缀稳定性检查通过：没有会话中途的 system/tools 变化，head-rewrite 次数在预期内。')
console.log('（真实命中率请看应用内右下角读数；本脚本只核对前缀是否逐字节可复用。）')
