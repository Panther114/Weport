import { execFile, spawn } from 'child_process'
import { promisify } from 'util'

const execFileAsync = promisify(execFile)

/**
 * Linux 桌面通知守护进程投递（mako / dunst / swaync / notify-osd …）。
 *
 * 为什么 Linux 不直接用应用内弹窗：
 *   1. 弹窗的实时玻璃要 `desktopCapturer.getSources()` 抓整个桌面，Wayland 下这会
 *      触发 `xdg-desktop-portal` 的「共享屏幕」授权框 —— 来一条微信消息弹一次。
 *   2. 弹窗的位置 / 超时 / 边框 / 字体是 Weport 自己的一套，无法复用用户对通知
 *      守护进程的配置，在 Linux 上属于重复造轮子。
 *
 * 检测不到守护进程时由调用方回退到应用内弹窗；回退路径同样不抓桌面（见
 * notificationWindow.ts 的 Linux 分支），所以任何情况下都不会再触发 portal。
 *
 * 用 `notify-send`（libnotify 的稳定 CLI）而不是自己拼 D-Bus 调用：几乎所有
 * Linux 桌面都装了它，守护进程收到的是与其它应用完全一致的通知。
 */

/** D-Bus 上桌面通知守护进程的 well-known name。 */
export const NOTIFICATIONS_SERVICE = 'org.freedesktop.Notifications'

/**
 * 通知投递方式：
 *   auto       有通知守护进程走系统通知，检测不到则回退应用内弹窗（默认）
 *   force-dbus 跳过检测，总是尝试系统通知（发送失败仍会回退，消息不能丢）
 *   off        总是使用应用内弹窗
 */
export type LinuxNotificationMode = 'auto' | 'force-dbus' | 'off'

const DETECT_TIMEOUT_MS = 3000
const SEND_TIMEOUT_MS = 5000
/**
 * 守护进程检测结果的缓存时长。检测要 fork `busctl`，不能每条通知都做一遍；
 * 但也不能永久缓存 —— 用户可能中途关掉 mako 或把它拉起来。
 */
const DAEMON_CACHE_MS = 60_000

let daemonCache: { available: boolean; at: number } | null = null

/** 解析 `busctl --user list --no-legend`：NAME 是第一列。 */
export function parseBusctlList(stdout: string): boolean {
  return /^\s*org\.freedesktop\.Notifications(\s|$)/m.test(stdout)
}

/** 解析 `gdbus call …NameHasOwner` 的输出：`(true,)` / `(false,)`。 */
export function parseGdbusBoolean(stdout: string): boolean {
  return /\btrue\b/.test(stdout)
}

/** 解析 `gdbus call …ListActivatableNames` 的 `(['a', 'b'],)` 输出。 */
export function parseActivatableNames(stdout: string): string[] {
  return [...stdout.matchAll(/'([^']+)'/g)].map((match) => match[1])
}

/** 环境变量优先于配置，非法值一律退回 auto。 */
export function resolveLinuxNotificationMode(
  envValue: unknown,
  configValue: unknown,
): LinuxNotificationMode {
  return normalizeMode(envValue) ?? normalizeMode(configValue) ?? 'auto'
}

function normalizeMode(value: unknown): LinuxNotificationMode | null {
  switch (String(value ?? '').trim().toLowerCase()) {
    case 'auto':
      return 'auto'
    case 'force-dbus':
      return 'force-dbus'
    case 'off':
      return 'off'
    default:
      return null
  }
}

async function gdbusCall(args: string[]): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('gdbus', args, { timeout: DETECT_TIMEOUT_MS })
    return stdout
  } catch {
    return null
  }
}

async function detectNotificationDaemon(): Promise<boolean> {
  // systemd 的 busctl：一次调用就能看到总线上所有 name（Arch 等主流发行版必有）。
  // 非 systemd 发行版上它不存在，落到 gdbus。
  try {
    const { stdout } = await execFileAsync('busctl', ['--user', 'list', '--no-legend'], {
      timeout: DETECT_TIMEOUT_MS,
    })
    if (parseBusctlList(stdout)) return true
  } catch {
    /* busctl 不可用，继续用 gdbus */
  }

  // name 已被持有是最直接的证据。
  const owner = await gdbusCall([
    'call',
    '--session',
    '--dest', 'org.freedesktop.DBus',
    '--object-path', '/org/freedesktop/DBus',
    '--method', 'org.freedesktop.DBus.NameHasOwner',
    NOTIFICATIONS_SERVICE,
  ])
  if (owner && parseGdbusBoolean(owner)) return true

  // 守护进程可能只是还没被拉起：D-Bus 激活也算可用 —— notify-send 会把它唤醒。
  const activatable = await gdbusCall([
    'call',
    '--session',
    '--dest', 'org.freedesktop.DBus',
    '--object-path', '/org/freedesktop/DBus',
    '--method', 'org.freedesktop.DBus.ListActivatableNames',
  ])
  return Boolean(activatable && parseActivatableNames(activatable).includes(NOTIFICATIONS_SERVICE))
}

/**
 * 总线上是否有可用的通知守护进程（结果缓存 60s）。
 * `refresh: true` 跳过缓存，用于发送失败后的立刻复查。
 */
export async function hasNotificationDaemon(opts?: { refresh?: boolean }): Promise<boolean> {
  const now = Date.now()
  if (!opts?.refresh && daemonCache && now - daemonCache.at < DAEMON_CACHE_MS) {
    return daemonCache.available
  }
  const available = await detectNotificationDaemon()
  daemonCache = { available, at: now }
  return available
}

/** 发送失败 / 守护进程状态可能变化时清掉缓存，让下一条通知重新探测。 */
export function invalidateNotificationDaemonCache(): void {
  daemonCache = null
}

export interface LinuxNotifyOptions {
  title: string
  body?: string
  /** 主题图标名（如 weport）或**外部进程可读**的绝对路径。 */
  icon?: string
  urgency?: 'low' | 'normal' | 'critical'
  /** 毫秒；不传则由守护进程决定默认时长。 */
  timeoutMs?: number
  /** 桌面通知分类（如 im.received），mako/dunst 可按它路由。 */
  category?: string
  /**
   * 默认动作的标签（如"打开微信"）。设置后 notify-send 会携带 default action
   * 并等待用户点击，点击时回调 `onAction`。两个字段必须成对出现。
   */
  actionLabel?: string
  /** 用户点击默认动作（左键/激活）时回调。 */
  onAction?: () => void
}

/**
 * 构造 notify-send 参数（纯函数，便于单测）。
 *
 * 标题/正文一律放在 `--` 之后：微信消息的标题可能以 `-` 开头，不隔离就被
 * GOption 当成选项解析了。
 */
export function buildNotifySendArgs(opts: LinuxNotifyOptions): string[] {
  const args = [`--app-name=Weport`, `--urgency=${opts.urgency ?? 'normal'}`]
  if (opts.icon) args.push(`--icon=${opts.icon}`)
  if (opts.timeoutMs !== undefined && Number.isFinite(opts.timeoutMs)) {
    args.push(`--expire-time=${Math.max(0, Math.round(opts.timeoutMs))}`)
  }
  if (opts.category) args.push(`--category=${opts.category}`)
  if (opts.actionLabel && opts.onAction) {
    // --print-id：id 一打印出来就说明守护进程收下了通知（据此判断投递成功）；
    // --action=default=…：隐式 --wait，用户点击后把动作名打到 stdout。
    args.push('--print-id', `--action=default=${opts.actionLabel}`)
  }
  args.push('--', String(opts.title ?? ''), String(opts.body ?? ''))
  return args
}

/**
 * 带默认动作的投递：spawn 而不是 execFile —— notify-send 会一直等到
 * 通知关闭（点击/超时），不能 await 它。
 *
 * stdout 约定（notify-send 0.8+）：
 *   第一行数字 = 通知 id（投递成功，立刻 resolve true）
 *   之后的行   = 用户调用的动作名（触发 onAction）
 * 进程在 id 打印前就退出（例如没有守护进程/没有 notify-send）→ resolve false。
 */
function sendLinuxNotificationWithAction(opts: LinuxNotifyOptions): Promise<boolean> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>
    try {
      child = spawn('notify-send', buildNotifySendArgs(opts), { stdio: ['ignore', 'pipe', 'ignore'] })
    } catch (error) {
      console.warn('[linuxNotify] notify-send spawn failed:', error)
      resolve(false)
      return
    }

    let settled = false
    let delivered = false
    let actionSeen = false
    let buffer = ''
    let timer: NodeJS.Timeout | null = null

    const finish = (ok: boolean) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      resolve(ok)
    }
    const handleLine = (raw: string) => {
      const line = raw.trim()
      if (!line) return
      if (!delivered && /^\d+$/.test(line)) {
        delivered = true
        finish(true)
        return
      }
      if (!delivered || actionSeen) return
      actionSeen = true
      try {
        opts.onAction?.()
      } catch (error) {
        console.warn('[linuxNotify] onAction failed:', error)
      }
    }

    child.stdout?.on('data', (chunk) => {
      buffer += String(chunk)
      let index = buffer.indexOf('\n')
      while (index >= 0) {
        const line = buffer.slice(0, index)
        buffer = buffer.slice(index + 1)
        handleLine(line)
        index = buffer.indexOf('\n')
      }
    })
    child.once('error', (error) => {
      console.warn('[linuxNotify] notify-send failed:', error)
      finish(false)
    })
    child.once('close', () => {
      handleLine(buffer)
      buffer = ''
      if (!delivered) finish(false)
    })
    // 只兜底"通知还没投出去"的情况；投递成功后子进程会自己等到超时/点击再退出
    timer = setTimeout(() => {
      finish(false)
      try {
        child.kill()
      } catch { /* 已退出 */ }
    }, SEND_TIMEOUT_MS)
    timer.unref?.()
  })
}

/** 投递一条系统通知；返回是否成功（失败由调用方决定是否回退应用内弹窗）。 */
export async function sendLinuxNotification(opts: LinuxNotifyOptions): Promise<boolean> {
  if (opts.actionLabel && opts.onAction) {
    return sendLinuxNotificationWithAction(opts)
  }
  try {
    await execFileAsync('notify-send', buildNotifySendArgs(opts), { timeout: SEND_TIMEOUT_MS })
    return true
  } catch (error) {
    console.warn('[linuxNotify] notify-send failed:', error)
    return false
  }
}
