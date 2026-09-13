#!/usr/bin/env node
/**
 * `weport` — the terminal entry point.
 *
 * Bare `weport` opens the TUI. `weport <command> [key=value …]` runs one command and
 * prints the result, which is what scripts and agents use; both paths go through the
 * same engine, so a command that works interactively works non-interactively too.
 *
 * Exit codes: 0 success, 1 command failed, 2 no engine found, 3 bad usage.
 */
import { runTui, resolveEngineExe } from './app.js'
import { WeportEngine } from './engine.js'

function parseArgs(argv: string[]): { command: string | null; args: Record<string, unknown>; flags: Record<string, string | boolean> } {
  const flags: Record<string, string | boolean> = {}
  const positional: string[] = []
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (token.startsWith('--')) {
      const [rawName, inlineValue] = token.slice(2).split('=')
      const next = argv[index + 1]
      if (inlineValue !== undefined) flags[rawName] = inlineValue
      else if (next && !next.startsWith('-')) { flags[rawName] = next; index += 1 }
      else flags[rawName] = true
      continue
    }
    positional.push(token)
  }
  const command = positional.shift() || null
  const args: Record<string, unknown> = {}
  positional.forEach((token, index) => {
    const [key, ...rest] = token.split('=')
    if (rest.length === 0) {
      // Bare positional values land under `_0`, `_1`, … so they can be passed on
      // without inventing names the caller never used.
      args[`_${index}`] = token
      return
    }
    args[key] = rest.join('=')
  })
  return { command, args, flags }
}

function printHelp(): void {
  process.stdout.write(`Weport 终端界面

用法
  weport                        打开完整 TUI（所有功能，除浏览朋友圈图片）
  weport <命令> [参数=值 …]      执行单条命令并输出结果（脚本 / 代理用）
  weport commands               列出所有命令
  weport --exe <路径>           指定 Weport 可执行文件（默认自动查找）

示例
  weport sessions.list limit=20
  weport messages.list session=12345678@chatroom limit=50 type=group
  weport analytics.rankings limit=10
  weport connectors.addTask content="明天交周报" dueText="tomorrow 9am" priority=urgent
  weport ai.ask text="总结一下这周的群聊"

参数
  --json            以 JSON 输出（供脚本解析）
  --exe <路径>      指定引擎可执行文件
  --dump <目录>     把每个界面渲染成文本文件后退出（QA 用）
  --width/--height  --dump 时的画布尺寸（默认 120×34）
  --help            显示本帮助
  --version         显示版本

退出码
  0 成功 · 1 命令失败 · 2 找不到引擎 · 3 用法错误
`)
}

/** Map the friendly aliases from the docs onto the canonical command names. */
const ALIASES: Record<string, string> = {
  sessions: 'sessions.list',
  messages: 'messages.list',
  moments: 'sns.timeline',
  sns: 'sns.timeline',
  analytics: 'analytics.overview',
  rankings: 'analytics.rankings',
  groups: 'groups.members',
  contacts: 'contacts.info',
  connectors: 'connectors.list',
  todoist: 'connectors.addTask',
  ai: 'ai.status',
  ask: 'ai.ask',
  status: 'cli.ping',
  commands: 'cli.commands',
  config: 'config.get',
}

async function main(): Promise<number> {
  const { command, args, flags } = parseArgs(process.argv.slice(2))

  if (flags.help || command === 'help') { printHelp(); return 0 }
  if (flags.version) {
    // The package version is enough here: the engine version is reported by `status`.
    process.stdout.write('weport 1.0.0\n')
    return 0
  }

  if (!command) {
    // `--dump` renders every section to files and exits: the QA harness uses it to
    // inspect the layout on a machine where nothing can attach to a terminal.
    const dumpDir = typeof flags.dump === 'string' ? flags.dump : ''
    return await runTui({
      exe: typeof flags.exe === 'string' ? flags.exe : undefined,
      dumpDir,
      dumpWidth: Number(flags.width) || undefined,
      dumpHeight: Number(flags.height) || undefined,
      dumpSession: typeof flags.session === 'string' ? flags.session : undefined,
    })
  }

  const exe = typeof flags.exe === 'string' ? flags.exe : resolveEngineExe({}) || undefined
  const engine = new WeportEngine(exe || '', process.cwd())
  if (!exe) {
    process.stderr.write('找不到 Weport 引擎：请安装 Weport 桌面版，或用 --exe 指定可执行文件。\n')
    return 2
  }

  const json = flags.json === true
  try {
    await engine.start()
  } catch (error) {
    const message = String((error as Error)?.message || error)
    if (json) process.stdout.write(`${JSON.stringify({ success: false, error: message })}\n`)
    else process.stderr.write(`无法连接 Weport 引擎：${message}\n`)
    return 2
  }

  const name = ALIASES[command] || command
  const result = await engine.call(name, args)
  engine.stop()

  if (json) {
    process.stdout.write(`${JSON.stringify({ command: name, ...result })}\n`)
  } else if (result.success) {
    if (result.text) process.stdout.write(`${result.text}\n`)
    else if (result.data !== undefined) process.stdout.write(`${JSON.stringify(result.data, null, 2)}\n`)
  } else {
    process.stderr.write(`${result.error || '命令失败'}\n`)
  }
  return result.success ? 0 : 1
}

main()
  .then((code) => {
    // A single-shot command has finished; the interactive TUI never resolves (it
    // calls process.exit from its own quit path), so this only ends commands.
    process.exit(code)
  })
  .catch((error) => {
    process.stderr.write(`${String(error?.stack || error)}\n`)
    process.exit(1)
  })
