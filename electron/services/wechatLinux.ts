import { basename, join } from 'path'
import { existsSync, readdirSync, readFileSync, statSync } from 'fs'
import { execFile, spawn } from 'child_process'
import { promisify } from 'util'

/**
 * Linux 微信进程检测、启动与窗口聚焦。
 *
 * 进程检测/启动原本长在 `keyServiceLinux.ts` 里（取密钥时要找微信并自动拉起），
 * 这里抽出来给两处共用：
 *   1. 密钥服务（原有行为不变）；
 *   2. Linux 系统通知被点击时"打开微信"（linuxNotify 的 default action）。
 *
 * 窗口聚焦是**尽力而为**：Wayland 没有通用的跨进程聚焦协议，能用的手段是各自
 * 合成器的 IPC（这里实现 niri）和 X11 的 xdotool。都不行时宁可不动作，也不重复
 * 启动第二个微信实例。
 */

const execFileAsync = promisify(execFile)

/** 已知微信客户端的进程名（官方 / UOS / Flatpak / 各发行版打包）。 */
export const WECHAT_PROCESS_NAMES = ['xwechat', 'wechat-uos', 'weixin', 'wechat', 'wechat-bin']

/** 已知微信窗口的 app_id（小写）。XWayland 下 niri 取自 WM_CLASS。 */
export const WECHAT_WINDOW_APP_IDS = [
  'wechat',
  'xwechat',
  'wechat-uos',
  'wechat-bin',
  'weixin',
  'com.tencent.wechat',
  'com.tencent.wechat.universal',
  'com.tencent.wechat.desktop',
]

/** 有序的启动候选；一次最多启动一个。 */
const WECHAT_LAUNCH_CANDIDATES = [
  { command: 'xwechat', args: [] as string[], label: 'xwechat' },
  { command: 'wechat-uos', args: [] as string[], label: 'wechat-uos' },
  { command: 'weixin', args: [] as string[], label: 'weixin' },
  { command: 'wechat', args: [] as string[], label: 'wechat' },
  { command: 'wechat-bin', args: [] as string[], label: 'wechat-bin' },
  { command: '/opt/wechat/wechat', args: [] as string[], label: '/opt/wechat/wechat' },
  { command: '/opt/apps/com.tencent.wechat/files/wechat', args: [] as string[], label: 'UOS WeChat' },
  { command: '/usr/bin/wechat', args: [] as string[], label: '/usr/bin/wechat' },
  { command: '/usr/local/bin/wechat', args: [] as string[], label: '/usr/local/bin/wechat' },
  { command: '/usr/bin/wechat-bin', args: [] as string[], label: '/usr/bin/wechat-bin' },
  { command: '/usr/local/bin/wechat-bin', args: [] as string[], label: '/usr/local/bin/wechat-bin' },
  { command: 'flatpak', args: ['run', 'com.tencent.WeChat'], label: 'Flatpak com.tencent.WeChat' },
]

/** 补全 PATH 后的命令环境（AppImage/托盘启动时 PATH 可能不含常规目录）。 */
export function defaultCommandEnvironment(): NodeJS.ProcessEnv {
  const pathEntries = [
    ...(process.env.PATH || '').split(':').filter(Boolean),
    '/bin',
    '/usr/bin',
    '/sbin',
    '/usr/sbin',
    '/usr/local/bin',
  ]
  return {
    ...process.env,
    PATH: [...new Set(pathEntries)].join(':'),
  }
}

export function parsePositiveIntegers(stdout: string): number[] {
  return String(stdout || '')
    .split(/\s+/)
    .map((value) => Number.parseInt(value, 10))
    .filter((value) => Number.isInteger(value) && value > 0)
}

/**
 * 按精确进程名找微信（`pgrep -x` 优先，`ps` 兜底），避免 shell 插值与误匹配。
 */
export async function findWeChatPids(env: NodeJS.ProcessEnv = defaultCommandEnvironment()): Promise<number[]> {
  const found = new Set<number>()
  const pgrepPaths = ['/usr/bin/pgrep', '/bin/pgrep']

  for (const pgrepPath of pgrepPaths) {
    if (!existsSync(pgrepPath)) continue
    for (const name of WECHAT_PROCESS_NAMES) {
      try {
        const { stdout } = await execFileAsync(pgrepPath, ['-x', name], { env })
        for (const pid of parsePositiveIntegers(stdout)) found.add(pid)
      } catch {
        // Exit code 1 means the exact name is not running.
      }
    }
    if (found.size > 0) break
  }

  if (found.size === 0) {
    try {
      const psPath = existsSync('/bin/ps') ? '/bin/ps' : '/usr/bin/ps'
      const { stdout } = await execFileAsync(psPath, ['-A', '-o', 'pid=,comm='], { env })
      for (const line of String(stdout || '').split(/\r?\n/)) {
        const match = line.trim().match(/^(\d+)\s+(\S+)$/)
        if (!match) continue
        const pid = Number.parseInt(match[1], 10)
        const comm = basename(match[2])
        if (WECHAT_PROCESS_NAMES.includes(comm) && pid > 0) found.add(pid)
      }
    } catch {
      // Report no process; the caller provides the actionable message.
    }
  }

  return [...found].sort((a, b) => a - b)
}

/**
 * 单个微信主进程 PID。同一个可执行名可能有多个 helper/renderer 进程，
 * 优先返回"父进程不在集合里"的那个（最高 PID 通常是子进程）。
 */
export async function findWeChatRootPid(env: NodeJS.ProcessEnv = defaultCommandEnvironment()): Promise<number | null> {
  const pids = await findWeChatPids(env)
  if (pids.length === 0) return null

  const pidSet = new Set(pids)
  for (const pid of pids) {
    try {
      const status = readFileSync(`/proc/${pid}/status`, 'utf8')
      const parentPid = Number.parseInt(status.match(/^PPid:\s*(\d+)/m)?.[1] || '0', 10)
      if (!pidSet.has(parentPid)) return pid
    } catch {
      // Fall through to the oldest discovered PID when /proc is restricted.
    }
  }
  return pids[0]
}

export function resolveExecutable(command: string, env: NodeJS.ProcessEnv): string | null {
  if (command.includes('/')) {
    try {
      if (existsSync(command) && (statSync(command).mode & 0o111) !== 0) return command
    } catch { }
    return null
  }

  for (const directory of String(env.PATH || '').split(':').filter(Boolean)) {
    const candidate = join(directory, command)
    try {
      if (existsSync(candidate) && (statSync(candidate).mode & 0o111) !== 0) return candidate
    } catch { }
  }
  return null
}

/** 只在没有可用的微信进程时调用；一次最多启动一个已知客户端。 */
export function launchWeChat(
  env: NodeJS.ProcessEnv = defaultCommandEnvironment(),
  onStatus?: (message: string, level: number) => void,
): boolean {
  const candidate = WECHAT_LAUNCH_CANDIDATES.find((item) => resolveExecutable(item.command, env))
  if (!candidate) return false

  const executable = resolveExecutable(candidate.command, env)
  if (!executable) return false

  const cleanEnv = { ...env }
  delete cleanEnv.ELECTRON_RUN_AS_NODE
  delete cleanEnv.ELECTRON_NO_ATTACH_CONSOLE
  delete cleanEnv.APPDIR
  delete cleanEnv.APPIMAGE

  try {
    const child = spawn(executable, candidate.args, {
      detached: true,
      stdio: 'ignore',
      env: cleanEnv,
    })
    child.once('error', (error) => {
      console.warn(`[wechatLinux] 启动 ${candidate.label} 失败:`, error.message)
    })
    child.unref()
    console.log(`[wechatLinux] 已尝试启动微信客户端: ${candidate.label}`)
    onStatus?.(`正在启动微信客户端（${candidate.label}）...`, 0)
    return true
  } catch (error: any) {
    console.warn(`[wechatLinux] 启动 ${candidate.label} 发生异常:`, error?.message || error)
    return false
  }
}

export interface NiriWindow {
  id: number
  pid?: number
  app_id?: string
  title?: string
}

/**
 * 从 `niri msg -j windows` 的 JSON 里选微信窗口（纯函数）。
 *
 * 优先 app_id：Flatpak/bwrap 沙箱里的微信有独立 PID namespace，niri 报的
 * `pid` 是沙箱内的 PID（XWayland 下甚至解析成 xwayland-satellite），只有
 * WM_CLASS 派的 `app_id` 跨沙箱仍然正确。`pid` 与标题只作补充。
 */
export function selectWeChatWindow(windows: unknown, pids: number[]): NiriWindow | null {
  if (!Array.isArray(windows)) return null
  const pidSet = new Set(pids)
  const candidates = windows.filter(
    (window): window is NiriWindow =>
      Boolean(window) && typeof window === 'object' && Number.isInteger((window as NiriWindow).id),
  )
  return (
    candidates.find((window) => WECHAT_WINDOW_APP_IDS.includes(String(window.app_id || '').toLowerCase())) ??
    candidates.find((window) => Number.isInteger(window.pid) && pidSet.has(Number(window.pid))) ??
    candidates.find((window) => ['微信', 'wechat'].includes(String(window.title || '').trim().toLowerCase())) ??
    null
  )
}

/** niri IPC socket：优先 NIRI_SOCKET，其次是运行目录里的 niri.wayland-*.sock。 */
export function resolveNiriSocket(env: NodeJS.ProcessEnv): string | null {
  const explicit = String(env.NIRI_SOCKET || '').trim()
  if (explicit) return explicit

  const runtimeDir =
    String(env.XDG_RUNTIME_DIR || '').trim() ||
    (typeof process.getuid === 'function' ? `/run/user/${process.getuid()}` : '')
  if (!runtimeDir || !existsSync(runtimeDir)) return null

  try {
    const match = readdirSync(runtimeDir)
      .filter((name) => /^niri\.wayland-.*\.sock$/.test(name))
      .sort()[0]
    return match ? join(runtimeDir, match) : null
  } catch {
    return null
  }
}

async function focusWithNiri(pids: number[], env: NodeJS.ProcessEnv): Promise<boolean> {
  const socket = resolveNiriSocket(env)
  if (!socket) return false
  const childEnv = { ...env, NIRI_SOCKET: socket }
  try {
    const { stdout } = await execFileAsync('niri', ['msg', '-j', 'windows'], { env: childEnv, timeout: 3000 })
    const target = selectWeChatWindow(JSON.parse(stdout), pids)
    if (!target) return false
    await execFileAsync('niri', ['msg', 'action', 'focus-window', '--id', String(target.id)], {
      env: childEnv,
      timeout: 3000,
    })
    console.log(`[wechatLinux] 已聚焦微信窗口 #${target.id}`)
    return true
  } catch (error: any) {
    console.warn('[wechatLinux] niri 聚焦失败:', error?.message || error)
    return false
  }
}

async function focusWithXdotool(env: NodeJS.ProcessEnv): Promise<boolean> {
  if (!env.DISPLAY) return false
  const xdotool = resolveExecutable('xdotool', env)
  if (!xdotool) return false
  try {
    const { stdout } = await execFileAsync(xdotool, ['search', '--class', '^[Ww]echat$'], { env, timeout: 3000 })
    for (const windowId of parsePositiveIntegers(stdout)) {
      try {
        await execFileAsync(xdotool, ['windowactivate', '--sync', String(windowId)], { env, timeout: 3000 })
        console.log(`[wechatLinux] 已聚焦微信窗口 ${windowId}`)
        return true
      } catch {
        // 试下一个候选窗口
      }
    }
  } catch {
    // 没有匹配窗口
  }
  return false
}

/** 聚焦已运行的微信窗口；找不到窗口返回 false（调用方不重复启动）。 */
export async function focusWeChatWindow(
  pids: number[],
  env: NodeJS.ProcessEnv = defaultCommandEnvironment(),
): Promise<boolean> {
  if (await focusWithNiri(pids, env)) return true
  return focusWithXdotool(env)
}

export type OpenWeChatResult = 'focused' | 'launched' | 'no-window' | 'failed'

/**
 * 通知点击后的"打开微信"：没运行就启动，运行中就聚焦窗口。
 * 不写微信数据、不注入消息，只做进程与窗口层面的动作。
 */
export async function openWeChat(
  env: NodeJS.ProcessEnv = defaultCommandEnvironment(),
): Promise<OpenWeChatResult> {
  try {
    const pids = await findWeChatPids(env)
    if (pids.length > 0) {
      if (await focusWeChatWindow(pids, env)) return 'focused'
      console.warn('[wechatLinux] 微信在运行但未找到可聚焦的窗口')
      return 'no-window'
    }
    return launchWeChat(env) ? 'launched' : 'failed'
  } catch (error: any) {
    console.warn('[wechatLinux] 打开微信失败:', error?.message || error)
    return 'failed'
  }
}
