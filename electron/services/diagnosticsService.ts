import { execFile } from 'child_process'
import { promisify } from 'util'
import { arch as osArch, freemem, release as osRelease, totalmem, type as osType } from 'os'
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync, unlinkSync, mkdirSync, openSync, readSync, closeSync } from 'fs'
import { basename, dirname, join, parse as parsePath } from 'path'
import * as fsModule from 'fs'
import type { MacDiagnosticCheck, MacDiagnosticsReport } from './macDiagnosticsService'
import { keyBufferFromHex, keyFingerprint, listDbFiles, readPage1, saltHexOf, verifyHexKeyForPage } from './wcdbPageKey'
import {
  redactConfigForBundle,
  redactSecretsDeep,
  redactSecretsInText,
  type RedactedConfigResult,
} from './diagnosticsRedaction'
import { createZipBuffer, type ZipEntryInput } from './zipWriter'
import { expandHomePath } from '../utils/pathUtils'

const execFileAsync = promisify(execFile)

/**
 * 跨平台诊断（v1.2 §5 / D17）。
 *
 * ## 为什么复用 macOS 那套词汇而不是新造一套
 *
 * `macDiagnosticsService.ts` 已经把「一条检查」的形状、状态枚举与文案纪律定了下来
 * （见其中 `MacDiagnosticCheck` 的注释）。这一页是它的**跨平台扩展**：同一批
 * 记录形状、同一套 `ok/warn/fail/unknown`，界面组件与"复制给维护者"的路径都
 * 可以共用。新增一套 `DiagnosticItem` 只会让两个页面说两种话。
 *
 * ## 这一页要回答的问题
 *
 * "为什么读不到我的聊天记录" 有十几个互不相同的原因（微信没装/没开/版本是 3.x/
 * 数据目录选错/库被占用/密钥过期/宿主起不来/磁盘满了/没权限/Electron 没起来），
 * 而它们过去的共同表现只有一句失败提示。这里逐条测出来，每条给一行能照做的动作。
 *
 * ## 边界（硬约束）
 *
 * - **只读**：唯一的写入是"往 userData / 导出目录写一个 1 字节探针文件再删掉"
 *   来判定可写性；微信数据目录一律不写。
 * - **不解密**：`safe:` 密文只报计数与指纹，`ConfigService.get()` 的解密结果
 *   只在「算指纹 / 验 HMAC」的局部变量里存在，绝不进入任何返回值。
 * - **不联网**：整页不发起任何网络请求，诊断包只落本地（D17）。
 */

/** 与 macOS 诊断完全同构的一条检查记录。 */
export type DiagnosticCheck = MacDiagnosticCheck
/** 与 macOS 诊断完全同构的一份报告。 */
export type DiagnosticsReport = MacDiagnosticsReport

/** 检查 id 的前缀即分组（`wechat.running` → `wechat`）。 */
export type DiagnosticGroupId = 'app' | 'wechat' | 'db' | 'engine' | 'config' | 'logs' | 'env' | 'perm' | 'other'

/** 界面用的分组顺序与中文标题（顺序 = 排查顺序）。 */
export const DIAGNOSTIC_GROUPS: Array<{ id: DiagnosticGroupId; title: string; hint: string }> = [
  { id: 'app', title: '应用与构建', hint: '版本、平台、运行形态' },
  { id: 'wechat', title: '微信连接', hint: '安装、运行、版本、数据目录与账号' },
  { id: 'db', title: '数据库与密钥', hint: '逐库打开状态、密钥指纹、首页 HMAC 校验' },
  { id: 'engine', title: 'WCDB 宿主', hint: '子进程存活、动态库路径、初始化错误' },
  { id: 'config', title: '配置', hint: '路径、可读性、密文计数' },
  { id: 'logs', title: '日志', hint: '文件与最新错误行' },
  { id: 'env', title: '运行环境', hint: '磁盘、内存、WebView2、提权、系统版本' },
  { id: 'perm', title: '权限', hint: '微信目录可读、userData 与导出目录可写' },
]

/** 由检查 id 求分组；未知前缀归入 `other`（不丢项）。 */
export function groupOfCheckId(id: string): DiagnosticGroupId {
  const prefix = String(id || '').split('.')[0]
  return (DIAGNOSTIC_GROUPS.some((g) => g.id === prefix) ? prefix : 'other') as DiagnosticGroupId
}

export interface DiagnosticsStateCounts {
  ok: number
  warn: number
  fail: number
  unknown: number
  total: number
}

export function countCheckStates(checks: DiagnosticCheck[]): DiagnosticsStateCounts {
  const counts: DiagnosticsStateCounts = { ok: 0, warn: 0, fail: 0, unknown: 0, total: checks.length }
  for (const check of checks) counts[check.state] += 1
  return counts
}

// ---------------------------------------------------------------------------
// 纯函数（单独导出，单测直接钉住；真实机器上很难复现这些输出）
// ---------------------------------------------------------------------------

/** 取文本末尾 N 行（用于日志尾巴）。空行结尾不计入，行数不足时返回全部。 */
export function tailText(text: string, lines: number): string {
  const limit = Math.max(1, Math.floor(Number(lines) || 1))
  const all = String(text ?? '').split(/\r?\n/)
  while (all.length > 0 && all[all.length - 1] === '') all.pop()
  return all.slice(Math.max(0, all.length - limit)).join('\n')
}

/** 单条日志行的最大长度（诊断包不该被一行 2 MB 的堆栈撑爆）。 */
export const MAX_LOG_LINE_CHARS = 400

export function truncateLine(line: string, max = MAX_LOG_LINE_CHARS): string {
  const text = String(line ?? '')
  return text.length <= max ? text : `${text.slice(0, max)}…（已截断 ${text.length - max} 字符）`
}

/**
 * 把多行错误压成一行。
 *
 * 诊断结论是**给人读的一句话**：把 Node 的报错原文（含换行与 require stack）整段
 * 塞进去，用户看到的是一屏乱码，而真正有用的只有第一句。所以这里折叠空白再截断。
 */
export function oneLine(text: string, max = 220): string {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim()
  if (!flat) return ''
  return flat.length <= max ? flat : `${flat.slice(0, max)}…`
}

/** 日志里"看起来是错误"的行。中英文都认，错误码也认。 */
const ERROR_LINE_PATTERN = /(\berror\b|\bfail(ed|ure)?\b|\bexception\b|\bcrash\b|错误|失败|异常|崩溃|-1006|-2301|-3002|-3003|-3004|-3001|EACCES|EPERM|ENOENT)/i

export interface LogErrorLine {
  file: string
  line: string
}

/**
 * 从若干份日志尾块里挑出"最新错误行"。
 *
 * 入参已经是**每份日志的尾部文本**（调用方负责只读尾巴，别把整份日志读进内存）。
 * 结果按文件顺序拼接、整体截断到 `maxLines` —— 顺序稳定，两次采集结果可比。
 */
export function pickErrorLines(
  files: Array<{ name: string; tail: string }>,
  maxLines = 12,
): LogErrorLine[] {
  const out: LogErrorLine[] = []
  for (const file of files) {
    const lines = String(file.tail || '').split(/\r?\n/)
    for (const line of lines) {
      if (!line.trim()) continue
      if (!ERROR_LINE_PATTERN.test(line)) continue
      out.push({ file: file.name, line: truncateLine(line) })
      if (out.length >= maxLines) return out
    }
  }
  return out
}

/** 解析 `tasklist /FO CSV /NH` 的一行，取出 PID；不是目标进程返回 null。 */
export function parseTasklistPid(stdout: string, imageName: string): number[] {
  const pids: number[] = []
  for (const rawLine of String(stdout || '').split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('INFO:')) continue
    const parts = line.split('","').map((part) => part.replace(/^"|"$/g, ''))
    if (String(parts[0] || '').toLowerCase() !== imageName.toLowerCase()) continue
    const pid = Number(parts[1])
    if (Number.isFinite(pid) && pid > 0) pids.push(pid)
  }
  return pids
}

/** 解析 `ps -eo pid=,comm=`（darwin / linux），匹配进程名。 */
export function parsePsOutput(stdout: string, imageNames: string[]): Array<{ pid: number; command: string }> {
  const wanted = new Set(imageNames.map((name) => name.toLowerCase()))
  const out: Array<{ pid: number; command: string }> = []
  for (const rawLine of String(stdout || '').split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line) continue
    const match = /^(\d+)\s+(.+)$/.exec(line)
    if (!match) continue
    const command = match[2].trim()
    const stem = basename(command).toLowerCase()
    if (!wanted.has(stem)) continue
    out.push({ pid: Number(match[1]), command })
  }
  return out
}

/** 解析 `reg query … /v pv` 的输出里某个值的字符串内容。 */
export function parseRegQueryValue(stdout: string, valueName: string): string | null {
  for (const rawLine of String(stdout || '').split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line) continue
    const match = new RegExp(`^${valueName}\\s+REG_[A-Z_]+\\s+(.+)$`, 'i').exec(line)
    if (match) return match[1].trim()
  }
  return null
}

/** PowerShell 输出的 True/False（提权判定用）。 */
export function parsePowerShellBool(stdout: string): boolean | null {
  const text = String(stdout || '').trim().toLowerCase()
  if (text === 'true') return true
  if (text === 'false') return false
  return null
}

/** 规范化的微信 4.x 版本号（`4.1.13.65`），拿不到返回 null。 */
export function normalizeWeChatVersion(text: string | null | undefined): string | null {
  const match = /(\d+(?:\.\d+){1,3})/.exec(String(text || ''))
  return match ? match[1] : null
}

/** 3.x 客户端读不了（没有 db_storage / kvcomm 结构）。 */
export function isWeChat3x(version: string | null | undefined): boolean {
  if (!version) return false
  const major = parseInt(String(version).split('.')[0], 10)
  return Number.isFinite(major) && major < 4
}

/** 各单位换算，给磁盘/内存文案用。 */
export function formatBytes(bytes: number): string {
  const value = Number(bytes)
  if (!Number.isFinite(value) || value <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let index = 0
  let scaled = value
  while (scaled >= 1024 && index < units.length - 1) {
    scaled /= 1024
    index += 1
  }
  return `${scaled >= 100 || index === 0 ? Math.round(scaled) : scaled.toFixed(1)} ${units[index]}`
}

/** 微信可执行文件的候选位置（安装路径随版本/渠道不同）。 */
export function weChatExeCandidates(
  platform: string,
  env: Record<string, string | undefined> = process.env,
): string[] {
  if (platform === 'win32') {
    const roots = [env['ProgramFiles'], env['ProgramFiles(x86)'], env['ProgramW6432'], 'C:\\Program Files']
      .filter((value): value is string => Boolean(value))
    const out: string[] = []
    for (const root of roots) {
      out.push(join(root, 'Tencent', 'Weixin', 'Weixin.exe'))
      out.push(join(root, 'Tencent', 'WeChat', 'WeChat.exe'))
    }
    return Array.from(new Set(out))
  }
  if (platform === 'darwin') {
    return ['/Applications/WeChat.app', '/Applications/Weixin.app']
  }
  return ['/opt/apps/com.tencent.wechat/files/bin/wechat', '/usr/bin/wechat', '/usr/bin/weixin']
}

/** 进程名（按平台）。 */
export function weChatImageNames(platform: string): string[] {
  if (platform === 'win32') return ['Weixin.exe', 'WeChat.exe']
  if (platform === 'darwin') return ['WeChat', 'Weixin']
  return ['wechat', 'weixin', 'WeChat']
}

/** WCDB 动态库文件名（按**目标平台**，不是宿主平台 —— 单测要能跨平台断言）。 */
export function wcdbLibNameFor(platform: string): string {
  if (platform === 'darwin') return 'libwcdb_api.dylib'
  if (platform === 'linux') return 'libwcdb_api.so'
  return 'wcdb_api.dll'
}

const WCDB_LIB_NAME = wcdbLibNameFor(process.platform)

/**
 * WCDB 动态库的候选路径（**只读镜像** `wcdbCore.buildDllCandidates` 的目录布局）。
 *
 * 为什么不直接问引擎：那份候选列表是 `private`，而诊断的目的是"引擎起不来时"
 * 报告它应该在哪 —— 此时引擎本身就是不可信的一方。这里只做存在性检查，不加载
 * 任何动态库（加载失败才是要诊断的事，不能让它也把诊断带崩）。
 */
export function wcdbDllCandidates(root: string, platform: string, archName: string): string[] {
  const platformDir = platform === 'darwin' ? 'macos' : platform === 'linux' ? 'linux' : 'win32'
  const archDir = platform === 'darwin' ? 'universal' : archName === 'arm64' ? 'arm64' : 'x64'
  const libName = wcdbLibNameFor(platform)
  const out: string[] = []
  for (const base of [join(root, 'resources'), root]) {
    out.push(join(base, 'wcdb', platformDir, archDir, libName))
    out.push(join(base, 'wcdb', platformDir, 'x64', libName))
    out.push(join(base, 'wcdb', platformDir, 'universal', libName))
    out.push(join(base, 'wcdb', platformDir, libName))
  }
  out.push(join(root, platformDir, libName))
  out.push(join(root, libName))
  return Array.from(new Set(out))
}

/** 配置文件名（`electron-store` 的默认命名，带项目名）。 */
export function resolveConfigFilePath(
  userDataPath: string,
  fileExists: (path: string) => boolean = existsSync,
  listDir: (path: string) => string[] = (path) => {
    try {
      return readdirSync(path)
    } catch {
      return []
    }
  },
): string {
  const primary = join(userDataPath, 'Weport-config.json')
  if (fileExists(primary)) return primary
  const candidates = listDir(userDataPath).filter((name) => /config.*\.json$/i.test(name))
  if (candidates.length > 0) return join(userDataPath, candidates[0])
  return primary
}

/** 由检查表生成人读摘要（checks.md 的正文）。 */
export function renderChecksMarkdown(
  checks: DiagnosticCheck[],
  meta: {
    appVersion: string
    platform: string
    arch: string
    shellVersion?: string
    collectedAt: number
    full: boolean
  },
): string {
  const counts = countCheckStates(checks)
  const lines: string[] = [
    `# Weport 诊断摘要 v${meta.appVersion}`,
    '',
    `- 采集时间：${new Date(meta.collectedAt).toLocaleString('zh-CN')}`,
    `- 平台：${meta.platform} · ${meta.arch}${meta.shellVersion ? ` · Electron ${meta.shellVersion}` : ''}`,
    `- 采集模式：${meta.full ? '完整（含逐库 HMAC 校验）' : '快速'}`,
    `- 结论：ok ${counts.ok} · warn ${counts.warn} · fail ${counts.fail} · unknown ${counts.unknown}`,
    '- 本文件不含任何密钥、令牌或聊天内容。',
    '',
  ]

  const blocking = checks.filter((check) => check.state === 'fail')
  if (blocking.length > 0) {
    lines.push('## 需要处理', '')
    for (const check of blocking) {
      lines.push(`- **${check.label}**：${check.detail}`)
    }
    lines.push('')
  }

  for (const group of DIAGNOSTIC_GROUPS) {
    const groupChecks = checks.filter((check) => groupOfCheckId(check.id) === group.id)
    if (groupChecks.length === 0) continue
    lines.push(`## ${group.title}`, '')
    for (const check of groupChecks) {
      lines.push(`### [${check.state.toUpperCase()}] ${check.label}`, '', check.detail, '')
      if (check.raw) {
        lines.push('```', check.raw, '```', '')
      }
    }
  }
  return lines.join('\n')
}

/** 一行总述（复制到剪贴板的那段文本，格式与 macOS 诊断一致）。 */
export function renderSummaryText(
  checks: DiagnosticCheck[],
  meta: { appVersion: string; platform: string; arch: string; collectedAt: number },
): string {
  return [
    `Weport ${meta.appVersion} · ${meta.platform} · ${meta.arch}`,
    `采集时间：${new Date(meta.collectedAt).toLocaleString('zh-CN')}`,
    '',
    ...checks.map((check) => `[${check.state.toUpperCase()}] ${check.label}：${check.detail}`),
    '',
    '--- 原始输出 ---',
    ...checks.filter((check) => check.raw).map((check) => `### ${check.label}\n${check.raw}`),
  ].join('\n')
}

// ---------------------------------------------------------------------------
// 采集上下文
// ---------------------------------------------------------------------------

export interface DiagnosticsContext {
  appVersion: string
  /** 打包后的 `process.resourcesPath`；开发态传项目根。 */
  resourcesPath: string
  userDataPath: string
  /** 日志目录（通常 `userData/logs`，另加 `app.getPath('logs')` 去重后的结果）。 */
  logDirs: string[]
  isPackaged: boolean
  shellVersion: string
  chromeVersion: string
  nodeVersion: string
  /** 配置里的导出目录（可为空）。 */
  exportPath: string | null
  /** 配置里的微信数据目录（可为空；空则用 dbPathService 的默认值）。 */
  dbPath: string | null
}

export const DEFAULT_LOG_TAIL_LINES = 200
export const MAX_LOG_TAIL_BYTES = 512 * 1024
export const MAX_LOG_FILES = 40

export interface LogFileInfo {
  name: string
  bytes: number
  mtime: number
}

function check(
  id: string,
  label: string,
  state: DiagnosticCheck['state'],
  detail: string,
  raw?: string,
): DiagnosticCheck {
  return raw ? { id, label, state, detail, raw } : { id, label, state, detail }
}

async function tryExec(file: string, args: string[], timeout = 8000): Promise<string | null> {
  try {
    const { stdout, stderr } = await execFileAsync(file, args, { timeout, windowsHide: true })
    const combined = `${stdout || ''}${stderr || ''}`.trim()
    return combined || null
  } catch (error) {
    const out = (error as { stdout?: string; stderr?: string })?.stdout
    const err = (error as { stdout?: string; stderr?: string })?.stderr
    const combined = `${out || ''}${err || ''}`.trim()
    return combined || null
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise<T>((resolve) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      resolve(fallback)
    }, ms)
    promise
      .then((value) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(value)
      })
      .catch(() => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(fallback)
      })
  })
}

/**
 * 一次性收集全部检查。
 *
 * 任何单个探测抛错都不允许影响其余结论（每一项自己 try/catch，失败即一种结论），
 * 因此 `detail` 永远是一句**具体的话**，绝不出现"未知错误"。
 */
export async function collectDiagnostics(
  context: DiagnosticsContext,
  options: { full?: boolean; now?: number; platform?: NodeJS.Platform; arch?: string } = {},
): Promise<DiagnosticsReport> {
  const platform = options.platform ?? process.platform
  const archName = options.arch ?? osArch()
  const collectedAt = options.now ?? Date.now()
  const full = options.full === true
  const checks: DiagnosticCheck[] = []

  // ===== 1. 应用与构建 =====
  checks.push(
    check(
      'app.build',
      '应用与构建',
      'ok',
      `Weport ${context.appVersion} · ${platform} · ${archName} · ` +
        `${context.isPackaged ? '安装版' : '开发态（vite dev / 未打包）'} · Electron ${context.shellVersion}`,
      [
        `packaged=${context.isPackaged}`,
        `electron=${context.shellVersion}`,
        `chrome=${context.chromeVersion}`,
        `node=${context.nodeVersion}`,
        `execPath=${process.execPath}`,
        `resourcesPath=${context.resourcesPath}`,
        `userData=${context.userDataPath}`,
      ].join('\n'),
    ),
  )
  if (!context.isPackaged) {
    checks.push(
      check(
        'app.dev-warning',
        '运行形态',
        'warn',
        '当前是开发态运行：文件路径、动态库位置与安装版不同，若你把这份包发给维护者，请注明是 dev 运行。',
      ),
    )
  }

  // ===== 2. 微信 =====
  const imageNames = weChatImageNames(platform)
  const pids: Array<{ pid: number; command: string }> = []
  let psError: string | null = null
  try {
    if (platform === 'win32') {
      for (const imageName of imageNames) {
        const stdout = await tryExec('tasklist', ['/FI', `IMAGENAME eq ${imageName}`, '/FO', 'CSV', '/NH'])
        for (const pid of parseTasklistPid(stdout || '', imageName)) pids.push({ pid, command: imageName })
      }
    } else {
      const stdout = await tryExec('ps', ['-eo', 'pid=,comm='])
      pids.push(...parsePsOutput(stdout || '', imageNames))
    }
  } catch (error) {
    psError = (error as Error)?.message || String(error)
  }

  let installedExe: string | null = null
  for (const candidate of weChatExeCandidates(platform)) {
    if (existsSync(candidate)) {
      installedExe = candidate
      break
    }
  }
  let runningExePath: string | null = null
  if (platform === 'win32' && pids.length > 0) {
    // 运行中进程的可执行文件路径最可信（用户可能装在自定义位置）；
    // 版本号是另一件事，下面按这个路径单独读版本资源。
    const pathRaw = await tryExec('powershell', [
      '-NoProfile',
      '-Command',
      `(Get-CimInstance Win32_Process -Filter "ProcessId=${pids[0].pid}").ExecutablePath`,
    ], 6000)
    const firstLine = pathRaw ? pathRaw.split(/\r?\n/).map((line) => line.trim()).find((line) => /\.exe$/i.test(line)) : null
    runningExePath = firstLine || null
  }
  if (platform === 'darwin' && installedExe === null && pids.length > 0) {
    installedExe = '/Applications/WeChat.app'
  }

  checks.push(
    installedExe
      ? check('wechat.installed', '微信安装', 'ok', `已检测到微信客户端（${installedExe}）。`, installedExe)
      : check(
        'wechat.installed',
        '微信安装',
        pids.length > 0 ? 'warn' : 'fail',
        pids.length > 0
          ? `检测到微信进程，但在常见安装位置里没找到客户端文件（检查过的路径：${weChatExeCandidates(platform).slice(0, 4).join('、')}…）。若你装在自定义位置，这属于正常情况。`
          : '未检测到微信客户端。请先从腾讯官网安装微信 4.x，登录一次后回到这里重新检测。',
        weChatExeCandidates(platform).join('\n'),
      ),
  )

  checks.push(
    pids.length > 0
      ? check(
        'wechat.running',
        '微信进程',
        'ok',
        `微信正在运行（${pids.length} 个进程）。`,
        pids.map((item) => `pid=${item.pid} ${item.command}`).join('\n'),
      )
      : check(
        'wechat.running',
        '微信进程',
        'warn',
        psError
          ? `没有检测到微信进程（进程枚举本身也失败了：${oneLine(psError)}）。请先打开微信并保持登录。`
          : '没有检测到微信进程。需要重新获取密钥时请启动微信；已有密钥仍可用于读取历史记录。',
      ),
  )

  // 版本：Windows 读 exe 版本资源，macOS 读 Info.plist
  const versionProbePath = runningExePath || installedExe
  let wechatVersion: string | null = null
  let versionRaw: string | null = null
  try {
    if (versionProbePath && platform === 'win32' && versionProbePath.toLowerCase().endsWith('.exe')) {
      versionRaw = await tryExec('powershell', [
        '-NoProfile',
        '-Command',
        `(Get-Item -LiteralPath '${versionProbePath.replace(/'/g, "''")}').VersionInfo.FileVersion`,
      ], 8000)
      wechatVersion = normalizeWeChatVersion(versionRaw)
    } else if (versionProbePath && platform === 'darwin') {
      versionRaw = await tryExec('defaults', ['read', `${versionProbePath}/Contents/Info`, 'CFBundleShortVersionString'])
      wechatVersion = normalizeWeChatVersion(versionRaw)
    }
  } catch (error) {
    versionRaw = (error as Error)?.message || String(error)
  }
  const wechatIs3x = isWeChat3x(wechatVersion)
  checks.push(
    wechatVersion
      ? check(
        'wechat.version',
        '微信版本',
        wechatIs3x ? 'fail' : 'ok',
        wechatIs3x
          ? `检测到微信 ${wechatVersion}（3.x）。Weport 只能读取微信 4.x 数据（db_storage / kvcomm / *_t.dat）：请从腾讯官网重装微信并升级到 4.x、等待迁移完成后，再做一次检测。`
          : `微信 ${wechatVersion}，代际符合要求。`,
        versionRaw || undefined,
      )
      : check(
        'wechat.version',
        '微信版本',
        'unknown',
        versionProbePath
          ? `读不到微信版本号（探测路径 ${versionProbePath}）。不影响已有密钥的库读取，但无法判断 3.x/4.x 代际。`
          : '微信不在运行且没找到客户端文件，因此无法读取版本号。',
        versionRaw || undefined,
      ),
  )

  // 数据目录 + 账号
  let dataRoot = context.dbPath ? expandHomePath(context.dbPath) : ''
  let dataRootSource = context.dbPath ? '配置' : '默认探测'
  if (!dataRoot) {
    try {
      const { dbPathService } = await import('./dbPathService')
      dataRoot = dbPathService.getDefaultPath()
    } catch {
      dataRoot = ''
    }
  }
  const dataRootExists = dataRoot ? existsSync(dataRoot) : false
  checks.push(
    dataRootExists
      ? check('wechat.data-dir', '数据目录', 'ok', `数据目录已解析：${dataRoot}（来源：${dataRootSource}）。`, dataRoot)
      : check(
        'wechat.data-dir',
        '数据目录',
        dataRoot ? 'fail' : 'warn',
        dataRoot
          ? `数据目录不存在：${dataRoot}（来源：${dataRootSource}）。请在欢迎页/设置里重新选择 xwechat_files 根目录（里面应有以 wxid_ 开头的账号目录）。`
          : '没有配置数据目录，也没能自动探测到。请在设置里手动选择 xwechat_files 根目录。',
      ),
  )

  interface AccountProbe {
    wxid: string
    dir: string
    dbStorage: string | null
    sessionDb: string | null
    dbCount: number
  }
  const accounts: AccountProbe[] = []
  let accountScanError: string | null = null
  try {
    if (dataRootExists) {
      const { dbPathService } = await import('./dbPathService')
      const found = dbPathService.scanWxids(dataRoot)
      for (const entry of found) {
        const dir = isAccountDirName(dataRoot) ? dataRoot : join(dataRoot, entry.wxid)
        const dbStorage = resolveDbStorage(dir)
        const sessionDb = dbStorage ? findSessionDb(dbStorage) : null
        let dbCount = 0
        if (dbStorage) {
          try {
            dbCount = listDbFiles(dbStorage).length
          } catch {
            dbCount = 0
            accountScanError = '至少一个账号的数据库数量超过安全枚举上限，计数不完整。'
          }
        }
        accounts.push({ wxid: entry.canonicalWxid || entry.wxid, dir, dbStorage, sessionDb, dbCount })
      }
    }
  } catch (error) {
    accountScanError = (error as Error)?.message || String(error)
  }

  const accountsWithSession = accounts.filter((account) => account.sessionDb)
  checks.push(
    accounts.length === 0
      ? check(
        'wechat.accounts',
        '账号目录',
        dataRootExists ? 'fail' : 'unknown',
        dataRootExists
          ? `在 ${dataRoot} 下没有找到微信 4.x 账号目录（应含 <wxid>/db_storage）。若微信还没登录过，先登录一次再重新检测。${accountScanError ? `（扫描报错：${oneLine(accountScanError, 160)}）` : ''}`
          : '数据目录不可用，无法扫描账号。',
      )
      : check(
        'wechat.accounts',
        '账号目录',
        accountScanError ? 'warn' : 'ok',
        `找到 ${accounts.length} 个账号目录，其中 ${accountsWithSession.length} 个含可用的 session.db。${accountScanError ? ` ${accountScanError}` : ''}`,
        accounts
          .map((account) => `${account.wxid}\n  dir=${account.dir}\n  db_storage=${account.dbStorage || '(未找到)'}\n  db=${account.dbCount}`)
          .join('\n'),
      ),
  )
  checks.push(
    accounts.length === 0
      ? check('wechat.session-db', 'session.db', 'unknown', '没有账号目录可检查。')
      : accountsWithSession.length > 0
        ? check(
          'wechat.session-db',
          'session.db',
          'ok',
          `${accountsWithSession.length}/${accounts.length} 个账号存在 session.db（会话列表库）。`,
          accounts.map((account) => `${account.wxid} → ${account.sessionDb || '缺失'}`).join('\n'),
        )
        : check(
          'wechat.session-db',
          'session.db',
          'fail',
          '账号目录存在但没有 session.db：微信可能还没完成登录、或被停在了初始化阶段。请在微信里登录并看到聊天列表后重新检测。',
          accounts.map((account) => `${account.wxid} → ${account.sessionDb || '缺失'}`).join('\n'),
        ),
  )

  // ===== 3. 数据库与密钥 =====
  const primaryAccount = accountsWithSession[0] ?? accounts[0] ?? null
  let configKeyHex: string | null = null
  let configKeyError: string | null = null
  try {
    const { ConfigService } = await import('./config')
    const raw = ConfigService.getInstance().get('decryptKey')
    configKeyHex = typeof raw === 'string' && raw ? raw : null
  } catch (error) {
    configKeyError = (error as Error)?.message || String(error)
  }

  let dbEntries: ReturnType<typeof listDbFiles> = []
  let dbEnumerationError: string | null = null
  try {
    dbEntries = primaryAccount?.dbStorage ? listDbFiles(primaryAccount.dbStorage) : []
  } catch {
    dbEnumerationError = '数据库数量超过安全枚举上限，无法确认完整状态。'
  }
  // 快速模式只验核心库；两种模式使用同一密钥编码判据，避免快速检查误报口令密钥。
  const hmacLimit = full ? 24 : 2
  const hmacTargets = dbEntries.slice(0, hmacLimit)
  const fingerprint = configKeyHex ? keyFingerprint(configKeyHex) : ''
  const keyBuffer = configKeyHex ? keyBufferFromHex(configKeyHex) : null

  interface DbVerdict {
    id: string
    verdict: 'ok' | 'fail' | 'unknown'
    note: string
  }
  const verdicts: DbVerdict[] = []
  if (dbEnumerationError) {
    checks.push(check('db.open-status', '数据库枚举', 'unknown', dbEnumerationError))
  } else if (dbEntries.length === 0) {
    checks.push(
      check(
        'db.open-status',
        '数据库枚举',
        'unknown',
        primaryAccount
          ? '账号目录里没有枚举到 .db 文件，无法判断打开状态。'
          : '没有可用账号目录，无法枚举数据库。',
      ),
    )
  } else if (!keyBuffer) {
    checks.push(
      check(
        'db.open-status',
        '数据库枚举',
        'warn',
        `枚举到 ${dbEntries.length} 个库，但本机没有已保存的密钥（或密钥读不出来${configKeyError ? `：${oneLine(configKeyError, 160)}` : ''}），无法校验。请在设置里获取或粘贴一次密钥。`,
        dbEntries.slice(0, 40).map((entry) => entry.id).join('\n'),
      ),
    )
  } else {
    for (const entry of hmacTargets) {
      const page = readPage1(entry.path)
      if (!page.ok || !page.page1) {
        verdicts.push({ id: entry.id, verdict: 'unknown', note: page.message || '读不到首页' })
        continue
      }
      const mode = verifyHexKeyForPage(page.page1, configKeyHex!)?.mode
      verdicts.push({
        id: entry.id,
        verdict: mode ? 'ok' : 'fail',
        note: mode
          ? `命中 ${mode} 形态 · salt=${saltHexOf(page.page1).slice(0, 8)}…`
          : '首页 HMAC 不匹配（这把密钥不属于该库）',
      })
    }
    const okCount = verdicts.filter((item) => item.verdict === 'ok').length
    checks.push(
      check(
        'db.open-status',
        '数据库枚举',
        okCount === verdicts.length ? 'ok' : okCount > 0 ? 'warn' : 'fail',
        `枚举到 ${dbEntries.length} 个库，本次校验 ${verdicts.length} 个（${full ? '完整' : '快速'}模式）：${okCount} 个通过。`,
        dbEntries.slice(0, 60).map((entry) => `${entry.id} [${entry.group}]`).join('\n'),
      ),
    )
    checks.push(
      check(
        'db.key-status',
        '密钥状态',
        okCount === verdicts.length ? 'ok' : okCount > 0 ? 'warn' : 'fail',
        okCount === verdicts.length
          ? `当前密钥（指纹 ${fingerprint}）能解开本次校验的全部 ${verdicts.length} 个库。`
          : `当前密钥（指纹 ${fingerprint}）只解开了 ${okCount}/${verdicts.length} 个库。微信 4.x 的密钥逐库不同，若某几个库长期对不上，请重新获取一次密钥。`,
        verdicts.map((item) => `${item.id} [${item.verdict}] ${item.note}`).join('\n'),
      ),
    )
    checks.push(
      check(
        'db.page1-hmac',
        '首页 HMAC 校验',
        verdicts.every((item) => item.verdict === 'ok')
          ? 'ok'
          : verdicts.some((item) => item.verdict === 'ok')
            ? 'warn'
            : 'fail',
        '判据是 SQLCipher 第 1 页的 HMAC-SHA512（与引擎开库同源），因此"面板说 OK、导出说错钥"这类分歧不会再出现。密钥只以指纹形式出现在本页与诊断包里。',
        verdicts.map((item) => `${item.id} → ${item.verdict}（${item.note}）`).join('\n'),
      ),
    )
  }

  // ===== 4. WCDB 宿主 / 引擎 =====
  let engineReady = false
  let engineConnected = false
  let hostGeneration: number | null = null
  let lastInitError: string | null = null
  let engineError: string | null = null
  try {
    const { wcdbService } = await import('./wcdbService')
    engineReady = wcdbService.isReady()
    hostGeneration = wcdbService.getHostGeneration()
    engineConnected = await withTimeout(wcdbService.isConnected(), 2500, false)
    lastInitError = await withTimeout(wcdbService.getLastInitError(), 2500, null)
  } catch (error) {
    engineError = (error as Error)?.message || String(error)
  }
  let dllInitError: string | null = null
  try {
    const { getLastDllInitError } = await import('./wcdbCore')
    dllInitError = getLastDllInitError()
  } catch {
    dllInitError = null
  }

  const dllCandidateList = wcdbDllCandidates(context.resourcesPath, platform, archName)
  const dllPath = dllCandidateList.find((candidate) => existsSync(candidate)) || null
  const initErrorText = lastInitError || dllInitError
  const mentions1006 = /-1006/.test(`${initErrorText || ''}`)
  checks.push(
    check(
      'engine.host',
      'WCDB 宿主进程',
      engineReady ? (engineConnected ? 'ok' : 'warn') : 'fail',
      engineReady
        ? engineConnected
          ? `宿主进程存活，已连接数据库（第 ${hostGeneration ?? 1} 代）。`
          : `宿主进程已就绪但当前未连接数据库（第 ${hostGeneration ?? 1} 代）：这在没打开过账号时是正常的，打开一次账号即可。`
        : `宿主进程没有起来${engineError ? `（${oneLine(engineError)}）` : ''}。请在设置里切换一次数据目录或重启 Weport；宿主会在首次查询时自动拉起。`,
      [
        `ready=${engineReady}`,
        `connected=${engineConnected}`,
        `hostGeneration=${hostGeneration ?? '(未知)'}`,
        engineError ? `error=${engineError}` : '',
      ].filter(Boolean).join('\n'),
    ),
  )
  checks.push(
    check(
      'engine.dll',
      'WCDB 动态库',
      dllPath ? 'ok' : 'fail',
      dllPath
        ? `动态库已就位：${dllPath}`
        : `没有找到 ${WCDB_LIB_NAME}。检查过的路径（前 3 个）：${dllCandidateList.slice(0, 3).join('、')}。安装包可能不完整，请重新安装 Weport。`,
      dllCandidateList.map((candidate) => `${existsSync(candidate) ? '[有]' : '[无]'} ${candidate}`).join('\n'),
    ),
  )
  checks.push(
    check(
      'engine.init',
      '引擎初始化',
      mentions1006 ? 'fail' : initErrorText ? 'warn' : 'ok',
      mentions1006
        ? '引擎报告 -1006（宿主可执行文件名检查失败）。Weport 会把宿主部署成 WeFlow.exe 再启动；出现这一条说明宿主被改名或被安全软件拦截，请重新安装 Weport。'
        : initErrorText
          ? `最近一次初始化报错：${truncateLine(initErrorText, 300)}`
          : '没有记录到初始化错误。',
      initErrorText ? truncateLine(initErrorText, 600) : undefined,
    ),
  )

  // ===== 5. 配置 =====
  const configPath = resolveConfigFilePath(context.userDataPath)
  let rawStore: Record<string, unknown> = {}
  let configReadError: string | null = null
  try {
    rawStore = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>
  } catch (error) {
    configReadError = (error as Error)?.message || String(error)
  }
  const configKeys = Object.keys(rawStore)
  const safeKeys = configKeys.filter((key) => typeof rawStore[key] === 'string' && /^safe:/.test(rawStore[key] as string))
  const lockKeys = configKeys.filter((key) => typeof rawStore[key] === 'string' && /^lock:/.test(rawStore[key] as string))
  let unreadable: string[] = []
  let unreadableError: string | null = null
  if (safeKeys.length > 0) {
    try {
      const { ConfigService } = await import('./config')
      const service = ConfigService.getInstance()
      unreadable = safeKeys.filter((key) => {
        try {
          return service.isValueUnreadable(key)
        } catch {
          return false
        }
      })
    } catch (error) {
      unreadableError = (error as Error)?.message || String(error)
    }
  }
  const schemaVersion = String((rawStore as Record<string, unknown>)['__schemaVersion'] ?? rawStore['schemaVersion'] ?? '未标注')
  checks.push(
    check(
      'config.summary',
      '配置文件',
      configReadError ? (existsSync(configPath) ? 'fail' : 'warn') : 'ok',
      configReadError
        ? existsSync(configPath)
          ? `配置文件存在但读不出来/不是合法 JSON：${oneLine(configReadError)}。Weport 会回落到默认值启动，你的设置看起来"丢了"。`
          : `没有找到配置文件（预期位置：${configPath}）。首次运行或从未改过设置时属于正常。`
        : `配置已读取：${configKeys.length} 个键，其中加密值 ${safeKeys.length} 个（锁定模式 ${lockKeys.length} 个）。`,
      [
        `path=${configPath}`,
        `keys=${configKeys.length}`,
        `schema=${schemaVersion}`,
      ].join('\n'),
    ),
  )
  checks.push(
    check(
      'config.secrets',
      '密文可读性',
      unreadableError ? 'unknown' : unreadable.length === 0 ? 'ok' : 'warn',
      unreadableError
        ? `无法判定：当前进程拿不到配置服务（${oneLine(unreadableError, 160)}），因此 ${safeKeys.length} 个加密值只报了计数，没有尝试解密。`
        : unreadable.length === 0
          ? `${safeKeys.length} 个加密值在本进程里都可解密。`
          : `有 ${unreadable.length} 个加密值在本进程里**读不出来**（系统密钥存储不可用或换了系统账号）：${unreadable.join('、')}。这些值不会自动明文写回；若某项功能提示"未配置"，请重新填一次。`,
      [
        `safe=${safeKeys.length}`,
        `lock=${lockKeys.length}`,
        `unreadable=${unreadableError ? '(未判定)' : unreadable.length}`,
        unreadable.length > 0 ? `unreadableKeys=${unreadable.join(',')}` : '',
        unreadableError ? `error=${oneLine(unreadableError)}` : '',
      ].filter(Boolean).join('\n'),
    ),
  )

  // ===== 6. 日志 =====
  const logFiles = listLogFilesSync(context.logDirs)
  const totalLogBytes = logFiles.reduce((sum, file) => sum + file.bytes, 0)
  checks.push(
    check(
      'logs.files',
      '日志文件',
      logFiles.length === 0 ? 'warn' : 'ok',
      logFiles.length === 0
        ? `日志目录里没有 .log 文件（检查过：${context.logDirs.join('、')}）。若刚启动应用，这是正常的。`
        : `${logFiles.length} 个日志文件，合计 ${formatBytes(totalLogBytes)}，最新的是 ${logFiles[0].name}（${formatBytes(logFiles[0].bytes)}）。`,
      logFiles.map((file) => `${file.name}\t${file.bytes}\t${new Date(file.mtime).toLocaleString('zh-CN')}`).join('\n'),
    ),
  )
  const tails = readLogTailsSync(context.logDirs, logFiles.slice(0, 3), 400)
  const errorLines = pickErrorLines(tails.map((item) => ({ name: item.name, tail: item.content })))
  checks.push(
    check(
      'logs.errors',
      '最近错误行',
      errorLines.length === 0 ? 'ok' : 'warn',
      errorLines.length === 0
        ? '日志尾部没有出现错误行。'
        : `日志尾部有 ${errorLines.length} 行像错误（已截断到 ${MAX_LOG_LINE_CHARS} 字符）：${errorLines[0].line.slice(0, 120)}`,
      errorLines.map((item) => `[${item.file}] ${item.line}`).join('\n') || undefined,
    ),
  )

  // ===== 7. 环境 =====
  const diskTarget = pickExistingPath([dataRoot, context.userDataPath, context.resourcesPath])
  const disk = diskSpaceOf(diskTarget)
  checks.push(
    check(
      'env.disk',
      '磁盘空间',
      disk.freeBytes === null ? 'unknown' : disk.freeBytes < 512 * 1024 * 1024 ? 'fail' : disk.freeBytes < 2 * 1024 * 1024 * 1024 ? 'warn' : 'ok',
      disk.freeBytes === null
        ? `取不到 ${diskTarget} 所在卷的剩余空间（${disk.error || '系统调用不可用'}）。`
        : `${diskTarget} 所在卷剩余 ${formatBytes(disk.freeBytes)} / 共 ${formatBytes(disk.totalBytes || 0)}。导出大账号至少需要几 GB。`,
      disk.error || undefined,
    ),
  )
  const freeMem = freemem()
  const totalMem = totalmem()
  checks.push(
    check(
      'env.memory',
      '内存',
      freeMem < 512 * 1024 * 1024 ? 'fail' : freeMem < 1024 * 1024 * 1024 ? 'warn' : 'ok',
      `可用物理内存 ${formatBytes(freeMem)} / 共 ${formatBytes(totalMem)}。WCDB 宿主常驻约 200 MB，导出大账号时会再涨。`,
    ),
  )
  const webview = await detectWebView2Version(platform)
  checks.push(
    check(
      'env.webview2',
      'WebView2 / Edge 运行时',
      webview.version ? 'ok' : 'unknown',
      webview.version
        ? `WebView2 运行时 ${webview.version}（来源：${webview.source}）。`
        : '未检测到 WebView2 运行时版本。Electron 自带 Chromium，不依赖 WebView2；这条只在排查系统级渲染问题时有用。',
      webview.raw || undefined,
    ),
  )
  const elevation = await detectElevation(platform)
  checks.push(
    check(
      'env.elevation',
      '权限级别',
      'ok',
      elevation.elevated === null
        ? `无法判定是否以管理员身份运行（${elevation.raw || '查询失败'}）。这一条不影响读取：只读访问微信数据不需要提权。`
        : elevation.elevated
          ? '当前以管理员权限运行。若需要"点通知跳回微信"之类的跨进程操作，这是有利的；日常读取并不需要提权。'
          : '当前以普通用户权限运行（读取微信数据不需要提权）。',
      elevation.raw || undefined,
    ),
  )
  checks.push(
    check(
      'env.os',
      '系统版本',
      'ok',
      `${osType()} ${osRelease()} · ${platform} ${archName}`,
      [`release=${osRelease()}`, `type=${osType()}`, `platform=${platform}`, `arch=${archName}`].join('\n'),
    ),
  )

  // ===== 8. 权限 =====
  checks.push(
    check(
      'perm.wechat-read',
      '微信目录可读',
      dataRootExists ? (accounts.length > 0 ? 'ok' : 'warn') : 'fail',
      dataRootExists
        ? accounts.length > 0
          ? '可以进入微信数据目录并列出账号子目录。'
          : '能进入数据目录但列不出账号子目录（权限不足或目录为空）。'
        : `读不到微信数据目录（${dataRoot || '未解析'}）。请确认目录存在且当前用户有权访问。`,
      dataRoot || undefined,
    ),
  )
  const userDataWrite = probeWritable(context.userDataPath)
  checks.push(
    check(
      'perm.userdata-write',
      'userData 可写',
      userDataWrite.ok ? 'ok' : 'fail',
      userDataWrite.ok
        ? `可以写入 ${context.userDataPath}（日志、配置、缓存都落在这里）。`
        : `无法写入 ${context.userDataPath}：${userDataWrite.error}。请检查目录权限或换一个可写位置。`,
    ),
  )
  const exportDir = context.exportPath ? expandHomePath(context.exportPath) : ''
  if (!exportDir) {
    checks.push(
      check('perm.export-write', '导出目录可写', 'unknown', '还没有配置导出目录，跳过写入测试。'),
    )
  } else if (!existsSync(exportDir)) {
    checks.push(
      check(
        'perm.export-write',
        '导出目录可写',
        'warn',
        `配置的导出目录还不存在：${exportDir}。Weport 在真正导出时会尝试创建它；若创建失败，导出会报错。`,
      ),
    )
  } else {
    const exportWrite = probeWritable(exportDir)
    checks.push(
      check(
        'perm.export-write',
        '导出目录可写',
        exportWrite.ok ? 'ok' : 'fail',
        exportWrite.ok
          ? `可以写入配置的导出目录 ${exportDir}。`
          : `无法写入 ${exportDir}：${exportWrite.error}。请换一个当前用户可写的目录（桌面/文档通常可以）。`,
      ),
    )
  }

  const summary = renderSummaryText(checks, { appVersion: context.appVersion, platform, arch: archName, collectedAt })
  return {
    supported: true,
    collectedAt,
    platform,
    appVersion: context.appVersion,
    arch: archName,
    checks,
    summary,
  }
}

// --- 采集用的小工具（同步、只读） ---

function isAccountDirName(root: string): boolean {
  const name = basename(String(root || ''))
  return /^wxid_[^\\/]+$/i.test(name) || resolveDbStorage(root) !== null
}

function resolveDbStorage(accountDir: string): string | null {
  if (!accountDir) return null
  try {
    const direct = join(accountDir, 'db_storage')
    if (existsSync(direct)) return direct
    return basename(accountDir).toLowerCase() === 'db_storage' && existsSync(accountDir) ? accountDir : null
  } catch {
    return null
  }
}

function findSessionDb(dbStorage: string): string | null {
  for (const candidate of [join(dbStorage, 'session', 'session.db'), join(dbStorage, 'session.db')]) {
    try {
      if (existsSync(candidate)) return candidate
    } catch {
      /* 下一个候选 */
    }
  }
  return null
}

function pickExistingPath(candidates: string[]): string {
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) return candidate
  }
  return candidates.find(Boolean) || process.cwd()
}

function diskSpaceOf(target: string): { freeBytes: number | null; totalBytes: number | null; error: string | null } {
  // `fs.statfsSync` 在 Node 18.15+ 才有，@types/node 的版本随仓库浮动，
  // 因此这里用结构性类型取值，而不是直接引用（拿不到就如实报 unknown）。
  const statfs = (fsModule as {
    statfsSync?: (path: string) => { bsize: number; blocks: number; bfree: number }
  }).statfsSync
  if (typeof statfs !== 'function') {
    return { freeBytes: null, totalBytes: null, error: '当前 Node 没有 fs.statfsSync' }
  }
  try {
    const root = parsePath(target).root || dirname(target)
    const stats = statfs(root)
    const blockSize = Number(stats.bsize) || 0
    return {
      freeBytes: blockSize * Number(stats.bfree || 0),
      totalBytes: blockSize * Number(stats.blocks || 0),
      error: null,
    }
  } catch (error) {
    return { freeBytes: null, totalBytes: null, error: oneLine((error as Error)?.message || String(error)) }
  }
}

function probeWritable(dir: string): { ok: boolean; error: string | null } {
  if (!dir) return { ok: false, error: '目录为空' }
  const probe = join(dir, `.weport-diag-${process.pid}-${Date.now()}.tmp`)
  try {
    writeFileSync(probe, 'weport', 'utf8')
    unlinkSync(probe)
    return { ok: true, error: null }
  } catch (error) {
    try {
      if (existsSync(probe)) unlinkSync(probe)
    } catch {
      /* 清不掉就算了，探针文件只有一个字节级内容 */
    }
    const code = String((error as { code?: string })?.code || '')
    return { ok: false, error: `${oneLine((error as Error)?.message || String(error))}${code ? ` [${code}]` : ''}` }
  }
}

let elevationCache: { elevated: boolean | null; raw: string } | null = null

/** 提权判定（PowerShell 约 300 ms，结果在进程生命周期内缓存）。 */
async function detectElevation(platform: string): Promise<{ elevated: boolean | null; raw: string }> {
  if (elevationCache) return elevationCache
  if (platform === 'win32') {
    const stdout = await tryExec('powershell', [
      '-NoProfile',
      '-Command',
      '([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)',
    ], 8000)
    const raw = (stdout || '').trim()
    elevationCache = { elevated: parsePowerShellBool(raw), raw }
    return elevationCache
  }
  const uid = process.getuid?.()
  elevationCache = {
    elevated: typeof uid === 'number' ? uid === 0 : null,
    raw: `uid=${uid ?? '(无)'}`,
  }
  return elevationCache
}

async function detectWebView2Version(
  platform: string,
): Promise<{ version: string | null; source: string; raw: string | null }> {
  if (platform !== 'win32') {
    return { version: null, source: '仅 Windows', raw: null }
  }
  const registryKey = 'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\EdgeUpdate\\Clients\\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}'
  const stdout = await tryExec('reg', ['query', registryKey, '/v', 'pv'])
  const version = parseRegQueryValue(stdout || '', 'pv')
  if (version) return { version, source: '注册表', raw: stdout || null }
  const base = join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Microsoft', 'EdgeWebView', 'Application')
  try {
    const versions = readdirSync(base).filter((name) => /^\d+\./.test(name))
    if (versions.length > 0) {
      return { version: versions[versions.length - 1], source: `目录 ${base}`, raw: versions.join('\n') }
    }
  } catch {
    /* 目录不存在即视为没装 */
  }
  return { version: null, source: '注册表与目录都没有', raw: null }
}

// ---------------------------------------------------------------------------
// 日志枚举与读取（日志在 userData/logs，属于应用自己的文件，可直接读）
// ---------------------------------------------------------------------------

function listLogFilesSync(logDirs: string[]): LogFileInfo[] {
  const byName = new Map<string, LogFileInfo>()
  for (const dir of logDirs) {
    let names: string[] = []
    try {
      names = readdirSync(dir)
    } catch {
      continue
    }
    for (const name of names) {
      if (!/\.log$/i.test(name)) continue
      try {
        const stats = statSync(join(dir, name))
        if (!stats.isFile()) continue
        const existing = byName.get(name)
        const info: LogFileInfo = { name, bytes: stats.size, mtime: stats.mtimeMs }
        if (!existing || info.mtime > existing.mtime) byName.set(name, info)
      } catch {
        continue
      }
    }
  }
  return Array.from(byName.values())
    .sort((a, b) => b.mtime - a.mtime || a.name.localeCompare(b.name))
    .slice(0, MAX_LOG_FILES)
}

/** 解析日志文件名到绝对路径；拒绝任何目录穿越。 */
export function resolveLogPath(logDirs: string[], name: string): string | null {
  const safeName = String(name || '')
  if (!/^[A-Za-z0-9._-]+\.log$/i.test(safeName)) return null
  for (const dir of logDirs) {
    const full = join(dir, safeName)
    try {
      if (existsSync(full) && statSync(full).isFile()) return full
    } catch {
      continue
    }
  }
  return null
}

/** 只读日志尾部（最多 512 KB），不解码整份文件。 */
export function readLogTailsSync(
  logDirs: string[],
  files: LogFileInfo[],
  tailLines = DEFAULT_LOG_TAIL_LINES,
): Array<{ name: string; content: string }> {
  const out: Array<{ name: string; content: string }> = []
  for (const file of files) {
    const full = resolveLogPath(logDirs, file.name)
    if (!full) continue
    try {
      const stats = statSync(full)
      const start = Math.max(0, stats.size - MAX_LOG_TAIL_BYTES)
      const fd = openSync(full, 'r')
      let text = ''
      try {
        const length = stats.size - start
        const buffer = Buffer.alloc(length)
        const read = readSync(fd, buffer, 0, length, start)
        text = buffer.subarray(0, read).toString('utf8')
      } finally {
        closeSync(fd)
      }
      out.push({ name: file.name, content: tailText(text, tailLines) })
    } catch {
      continue
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// 服务门面（appMain 注入上下文，然后四个 IPC 直接转调）
// ---------------------------------------------------------------------------

export interface DiagnosticsBundleResult {
  success: boolean
  path?: string
  sizeBytes?: number
  error?: string
}

export interface DiagnosticsBundlePayload {
  path?: string
  includeLogs?: boolean
  includeConfig?: boolean
}

export interface DiagnosticMonitorFile {
  name: string
  kind: 'db' | 'wal' | 'shm'
  sizeBytes: number
  modifiedAt: number
  sizeGrowthBytesPerSecond: number | null
}

export interface DiagnosticMonitorSnapshot {
  collectedAt: number
  databaseRoot: string | null
  files: DiagnosticMonitorFile[]
  totals: { files: number; bytes: number; sizeGrowthBytesPerSecond: number | null }
  runtime: { rssBytes: number; heapUsedBytes: number; cpuPercent: number | null }
  tasks: Array<{ key: string; status: string; stage?: string; progress: number; message: string; startedAt?: number }>
  subsystems: { wcdbReady: boolean | null; databaseConnected: boolean | null; imageKeyConfigured: boolean | null }
}

/** Non-negative size delta per second; null means there is no prior sample. */
export function bytesPerSecond(current: number, previous: number | undefined, elapsedMs: number): number | null {
  if (previous === undefined || elapsedMs <= 0 || !Number.isFinite(current) || !Number.isFinite(previous)) return null
  return Math.max(0, current - previous) / (elapsedMs / 1000)
}

export class DiagnosticsService {
  private context: DiagnosticsContext | null = null
  private lastReport: DiagnosticsReport | null = null
  private monitorSample: { at: number; cpu: NodeJS.CpuUsage; sizes: Map<string, number> } | null = null

  setContext(context: DiagnosticsContext): void {
    this.context = context
  }

  /** 最近一次采集结果（导出诊断包时复用，避免重复跑一次 HMAC）。 */
  getLastReport(): DiagnosticsReport | null {
    return this.lastReport
  }

  private requireContext(): DiagnosticsContext {
    if (!this.context) throw new Error('诊断服务尚未初始化（DiagnosticsService.setContext 未调用）')
    return this.context
  }

  async collect(payload: { full?: boolean } = {}): Promise<DiagnosticsReport> {
    const report = await collectDiagnostics(this.requireContext(), { full: payload?.full === true })
    this.lastReport = report
    return report
  }

  /** Read-only live database/runtime monitor. The caller polls while this page is open. */
  async monitorSnapshot(): Promise<DiagnosticMonitorSnapshot> {
    const context = this.requireContext()
    const collectedAt = Date.now()
    let databaseRoot: string | null = null
    let filePaths: Array<{ path: string; name: string; kind: DiagnosticMonitorFile['kind'] }> = []
    let imageKeyConfigured: boolean | null = null
    try {
      const { ConfigService } = await import('./config')
      const config = ConfigService.getInstance()
      const imageKeys = config.getImageKeysForCurrentWxid()
      imageKeyConfigured = Boolean(imageKeys.aesKey || imageKeys.xorKey)
      const configuredRoot = context.dbPath || config.get('dbPath') || ''
      const wxid = config.getMyWxidCleaned()
      const accountDir = configuredRoot && wxid ? config.getAccountDir(configuredRoot, wxid) : null
      const storageDir = accountDir ? resolveDbStorage(accountDir) : null
      if (storageDir) {
        databaseRoot = storageDir
        for (const entry of listDbFiles(storageDir, { maxFiles: 160, allowTruncated: true })) {
          filePaths.push({ path: entry.path, name: entry.id, kind: 'db' })
          filePaths.push({ path: `${entry.path}-wal`, name: `${entry.id}-wal`, kind: 'wal' })
          filePaths.push({ path: `${entry.path}-shm`, name: `${entry.id}-shm`, kind: 'shm' })
        }
      }
    } catch {
      databaseRoot = null
    }

    const fileFacts: Array<{ path: string; name: string; kind: DiagnosticMonitorFile['kind']; sizeBytes: number; modifiedAt: number }> = []
    for (const entry of filePaths) {
      try {
        const stats = statSync(entry.path)
        if (!stats.isFile()) continue
        fileFacts.push({ path: entry.path, name: entry.name, kind: entry.kind, sizeBytes: stats.size, modifiedAt: stats.mtimeMs })
      } catch {
        // Missing WAL/SHM files are normal; an unreadable DB simply is not in this snapshot.
      }
    }

    const currentCpu = process.cpuUsage()
    const previous = this.monitorSample
    const elapsedMs = previous ? Math.max(0, collectedAt - previous.at) : 0
    const cpuMicros = previous ? (currentCpu.user - previous.cpu.user) + (currentCpu.system - previous.cpu.system) : 0
    const cpuPercent = previous && elapsedMs > 0 ? Math.max(0, (cpuMicros / 1000 / elapsedMs) * 100) : null
    const sizes = new Map(fileFacts.map((entry) => [entry.path, entry.sizeBytes]))
    const files: DiagnosticMonitorFile[] = fileFacts.map((entry) => ({
      name: entry.name,
      kind: entry.kind,
      sizeBytes: entry.sizeBytes,
      modifiedAt: entry.modifiedAt,
      sizeGrowthBytesPerSecond: bytesPerSecond(entry.sizeBytes, previous?.sizes.get(entry.path), elapsedMs),
    }))
    const totals = {
      files: files.length,
      bytes: files.reduce((sum, file) => sum + file.sizeBytes, 0),
      sizeGrowthBytesPerSecond: previous && elapsedMs > 0
        ? files.reduce((sum, file) => sum + (file.sizeGrowthBytesPerSecond ?? 0), 0)
        : null,
    }
    this.monitorSample = { at: collectedAt, cpu: currentCpu, sizes }

    let wcdbReady: boolean | null = null
    let databaseConnected: boolean | null = null
    try {
      const { wcdbService } = await import('./wcdbService')
      wcdbReady = wcdbService.isReady()
      databaseConnected = wcdbReady ? await withTimeout(wcdbService.isConnected(), 1500, false) : false
    } catch {
      wcdbReady = null
      databaseConnected = null
    }
    let tasks: DiagnosticMonitorSnapshot['tasks'] = []
    try {
      const { taskStatusService } = await import('./taskStatusService')
      tasks = Object.entries(taskStatusService.all()).map(([key, task]) => ({
        key,
        status: task.status,
        stage: task.stage,
        progress: task.progress,
        message: task.message,
        startedAt: task.startedAt,
      }))
    } catch {
      tasks = []
    }
    const memory = process.memoryUsage()
    return {
      collectedAt,
      databaseRoot,
      files,
      totals,
      runtime: { rssBytes: memory.rss, heapUsedBytes: memory.heapUsed, cpuPercent },
      tasks,
      subsystems: { wcdbReady, databaseConnected, imageKeyConfigured },
    }
  }

  listLogs(): { files: LogFileInfo[] } {
    const context = this.requireContext()
    return { files: listLogFilesSync(context.logDirs) }
  }

  readLog(payload: { name?: string; tailLines?: number } = {}): { content: string } {
    const context = this.requireContext()
    const name = String(payload?.name || '')
    const full = resolveLogPath(context.logDirs, name)
    if (!full) {
      return { content: `（读不到日志 ${name || '(未指定文件名)'}：它不在日志目录里，或已被轮转删除。）` }
    }
    const requested = Math.min(Math.max(1, Math.floor(Number(payload?.tailLines) || DEFAULT_LOG_TAIL_LINES)), 5000)
    const tails = readLogTailsSync(context.logDirs, [{ name, bytes: 0, mtime: 0 }], requested)
    return { content: tails[0]?.content ?? '（日志为空。）' }
  }

  /**
   * 生成诊断包。
   *
   * 内容：`diagnostics.json`（完整报告）+ `checks.md`（人读摘要）+
   * 请求到的日志尾巴 + `config.redacted.json`（**白名单**脱敏后的配置）。
   * 每个字符串落地前都过 `redactSecretsInText`，见 diagnosticsRedaction 的说明。
   */
  async exportBundle(payload: DiagnosticsBundlePayload = {}): Promise<DiagnosticsBundleResult> {
    const context = this.requireContext()
    try {
      const report = this.lastReport ?? (await this.collect({ full: true }))
      const stamp = new Date(report.collectedAt)
      const defaultName = `weport-diagnostics-${stamp.toISOString().replace(/[:.]/g, '-').slice(0, 19)}.zip`
      let targetPath = payload.path
        ? expandHomePath(payload.path)
        : join(context.userDataPath, 'diagnostics', defaultName)
      if (!/\.zip$/i.test(targetPath)) targetPath = `${targetPath}.zip`

      mkdirSync(dirname(targetPath), { recursive: true })
      const entries = buildBundleEntries(context, report, payload)
      const buffer = createZipBuffer(entries, { date: stamp })
      writeFileSync(targetPath, buffer)
      return { success: true, path: targetPath, sizeBytes: buffer.length }
    } catch (error) {
      return { success: false, error: (error as Error)?.message || String(error) }
    }
  }
}

/**
 * 组装诊断包的条目（纯函数：给定上下文与报告即产出全部字节，不落盘）。
 *
 * 单独导出是为了让"包里不含密钥"这条**能在单测里用夹具配置钉住**，
 * 而不必在测试里跑一遍真实探测（那会让断言依赖本机状态）。
 */
export function buildBundleEntries(
  context: DiagnosticsContext,
  report: DiagnosticsReport,
  payload: DiagnosticsBundlePayload = {},
): ZipEntryInput[] {
  const entries: ZipEntryInput[] = []

  // 1) checks.md
  const checksMarkdown = renderChecksMarkdown(report.checks, {
    appVersion: report.appVersion,
    platform: report.platform,
    arch: report.arch,
    shellVersion: context.shellVersion,
    collectedAt: report.collectedAt,
    full: true,
  })
  entries.push({ name: 'checks.md', data: redactSecretsInText(checksMarkdown) })

  // 2) 日志尾巴
  const logFacts: Array<{ name: string; bytes: number; mtime: number; tailLines: number }> = []
  if (payload.includeLogs !== false) {
    const files = listLogFilesSync(context.logDirs)
    for (const tail of readLogTailsSync(context.logDirs, files.slice(0, 3), DEFAULT_LOG_TAIL_LINES)) {
      const info = files.find((file) => file.name === tail.name)
      entries.push({ name: `logs/${tail.name}`, data: redactSecretsInText(tail.content) })
      logFacts.push({
        name: tail.name,
        bytes: info?.bytes ?? 0,
        mtime: info?.mtime ?? 0,
        tailLines: tail.content ? tail.content.split(/\r?\n/).length : 0,
      })
    }
  }

  // 3) config.redacted.json —— 白名单 + 值级扫描
  const configPath = resolveConfigFilePath(context.userDataPath)
  let redaction: RedactedConfigResult = { config: {}, redactedKeys: [], storedSecretKeys: [] }
  if (payload.includeConfig !== false) {
    try {
      const rawStore = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>
      redaction = redactConfigForBundle(rawStore)
    } catch {
      redaction = { config: {}, redactedKeys: [], storedSecretKeys: [] }
    }
    entries.push({
      name: 'config.redacted.json',
      data: redactSecretsInText(JSON.stringify({
        generatedAt: new Date(report.collectedAt).toISOString(),
        note: '本文件由白名单生成：只有明确安全的白名单键才会出现，其余键只留名字。任何密钥/令牌形状的字符串都已替换为 «redacted:sha256:first8»。',
        redactedKeys: redaction.redactedKeys,
        storedSecretKeys: redaction.storedSecretKeys,
        config: redaction.config,
      }, null, 2)),
    })
  }

  // 4) diagnostics.json —— 放最后，这样它能把前三步的事实一起记下来
  entries.push({
    name: 'diagnostics.json',
    data: redactSecretsInText(JSON.stringify({
      schemaVersion: 1,
      collectedAt: new Date(report.collectedAt).toISOString(),
      appVersion: report.appVersion,
      platform: report.platform,
      arch: report.arch,
      full: true,
      counts: countCheckStates(report.checks),
      configPath,
      redactedKeys: redaction.redactedKeys,
      storedSecretKeys: redaction.storedSecretKeys,
      logFiles: logFacts,
      checks: report.checks.map((item) => ({
        ...item,
        detail: redactSecretsInText(item.detail),
        raw: item.raw ? redactSecretsInText(item.raw) : undefined,
      })),
    }, null, 2)),
  })
  entries.push({
    name: 'README.txt',
    data: [
      'Weport 诊断包',
      '',
      '本包由 Weport 本地生成，不含密钥、令牌或聊天内容。',
      '  · diagnostics.json     — 完整检查结果（机器可读）',
      '  · checks.md            — 人读摘要',
      '  · config.redacted.json — 白名单过滤后的配置（密钥/令牌已替换为指纹）',
      '  · logs/                — 请求到的日志尾部',
      '',
      '把它发给维护者即可；也可以用文本编辑器直接打开 checks.md 自己看。',
    ].join('\n'),
  })
  return entries
}

export const diagnosticsService = new DiagnosticsService()
