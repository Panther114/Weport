// 通过 CLI host 跑一条 weport 命令并打印结果。
//
// 用途：验证 CLI/TUI 的命令面（v1.0 的「终端里能用全部功能」）时，不必真的开
// 一个终端 —— 这个脚本走的是和 TUI 完全相同的通道与协议：spawn
// `Weport.exe --cli`，先发一次 `{kind:'hello', token}` 握手，再用
// `{kind:'call', command, args}` 调命令。任何在 TUI 里能用的命令都能在这里跑，
// 任何在这里跑不通的命令在 TUI 里也跑不通。
//
// 协议细节与 TUI（packages/weport-tui/src/engine.ts）保持一致：
//  - 通道是 Node IPC，不是 stdin/stdout（Windows 上主进程 stdin 立刻 EOF）
//  - 握手是一次性令牌；令牌不匹配引擎会 exit(3)
//  - 收尾必须发 `{kind:'bye'}`，否则引擎会一直等到 disconnect 才退出
//
// 用法：
//   node scripts/run-cli-command.mjs ai.costs
//   node scripts/run-cli-command.mjs ai.costs --models deepseek-v4.1-flash
//   node scripts/run-cli-command.mjs connectors.addTask --content "测试" --dueText tomorrow

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const argv = process.argv.slice(2)
const commandName = argv[0]
if (!commandName) {
  console.error('usage: node scripts/run-cli-command.mjs <command> [--arg value ...]')
  process.exit(2)
}

const args = {}
for (let i = 1; i < argv.length; i += 1) {
  if (!argv[i].startsWith('--')) continue
  const key = argv[i].slice(2)
  const next = argv[i + 1]
  if (next === undefined || next.startsWith('--')) args[key] = true
  else {
    args[key] = next
    i += 1
  }
}

const devExe = join(root, 'release', 'win-unpacked', 'Weport.exe')
const installedExe = join(process.env.LOCALAPPDATA || '', 'Programs', 'Weport', 'Weport.exe')
const exe = existsSync(devExe) ? devExe : installedExe
if (!existsSync(exe)) {
  console.error(`Weport.exe not found (${devExe} / ${installedExe})`)
  process.exit(1)
}

const token = randomBytes(24).toString('hex')

// 参数顺序与 TUI（packages/weport-tui/src/engine.ts）逐字对齐：`--cli` 之后跟
// `--disable-gpu`，令牌走 `--weport-token <value>` 两个 argv。**不要**在这里
// 加 `--user-data-dir` —— 引擎按自己的 userData 读配置，额外传一个会改变
// userData 解析并让引擎起不来（实测本次就卡在握手）。
const child = spawn(exe, ['--cli', '--disable-gpu', '--weport-token', token], {
  cwd: root,
  env: { ...process.env, WEPORT_CLI_TOKEN: token, WEPORT_DISCARD_DELAY_MS: '600000' },
  stdio: ['ignore', 'pipe', 'pipe', 'ipc']
})

const waiters = new Map()
let nextId = 0

const waitFor = (predicate, timeoutMs, label) =>
  new Promise((resolvePromise, reject) => {
    const id = ++nextId
    waiters.set(id, { predicate, resolvePromise, reject })
    setTimeout(() => {
      if (waiters.has(id)) {
        waiters.delete(id)
        reject(new Error(`timeout: ${label}`))
      }
    }, timeoutMs)
  })

child.on('message', (msg) => {
  for (const [id, entry] of waiters) {
    if (!entry.predicate(msg)) continue
    waiters.delete(id)
    entry.resolvePromise(msg)
    return
  }
})

let stderr = ''
child.stderr?.on('data', (b) => {
  stderr += b.toString()
})

let settled = false
const finish = (code, payload) => {
  if (settled) return
  settled = true
  if (payload !== undefined) console.log(typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2))
  if (code !== 0 && stderr.trim()) console.error(stderr.trim().slice(-1200))
  try {
    child.send({ kind: 'bye', id: 'bye' })
  } catch {
    /* channel already closed */
  }
  // 引擎收到 bye 会自行退出；给它一点时间，然后强杀兜底
  setTimeout(() => {
    try {
      child.kill()
    } catch {
      /* gone */
    }
    process.exit(code)
  }, 600)
}

child.on('exit', (code) => {
  if (!settled) {
    if (stderr.trim()) console.error(stderr.trim().slice(-1200))
    console.error(`cli host exited before answering (code=${code})`)
    process.exit(1)
  }
})

try {
  // 握手是**客户端发起**的：引擎不会自己宣告就绪，必须由客户端发 hello。
  // （踩过一次：干等 ready 直到超时，看起来像引擎起不来。）
  child.send({ kind: 'hello', token })
  const ready = await waitFor((m) => m?.kind === 'ready', 60_000, 'handshake')
  child.send({ kind: 'call', id: 'c1', command: commandName, args })
  const result = await waitFor((m) => m?.id === 'c1', 200_000, commandName)
  finish(result?.success === false ? 1 : 0, { version: ready.version, ...result })
} catch (error) {
  console.error(String(error?.message || error))
  finish(1)
}

