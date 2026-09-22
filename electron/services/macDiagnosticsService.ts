import { execFile } from 'child_process'
import { promisify } from 'util'
import { existsSync, readdirSync, statSync } from 'fs'
import { join, dirname } from 'path'
import { homedir, arch } from 'os'

const execFileAsync = promisify(execFile)

/**
 * macOS 能力诊断。
 *
 * 为什么需要它：macOS 上「拿不到密钥」有三个**完全不同**的原因，而它们的
 * 表现几乎一样（都是等到超时后一句失败提示）：
 *
 *   1. 微信是加固签名 + 沙盒进程，`task_for_pid` 被系统直接拒绝（最常见）；
 *   2. 应用没有「完全磁盘访问权限」，读不到微信容器目录；
 *   3. 数据目录解析到了错误的位置（例如 3.x 遗留目录）。
 *
 * 用户无法自查、也无法反馈 —— 他手上只有一句「失败」。这个模块在**用户等待
 * 之前**把这三个条件逐条测出来，给出可执行的结论；一键复制的内容也包含足够
 * 复现问题的信息（不含任何聊天内容）。
 *
 * 只在 `process.platform === 'darwin'` 时执行真实探测；其他平台返回
 * `supported: false`，调用方据此隐藏入口。
 */

export interface MacDiagnosticCheck {
  id: string
  label: string
  /** ok = 满足条件；warn = 需要注意；fail = 会直接导致失败；unknown = 无法判定 */
  state: 'ok' | 'warn' | 'fail' | 'unknown'
  /** 面向用户的一句话结论。 */
  detail: string
  /** 原始输出（仅用于复制诊断信息，界面上收起来）。 */
  raw?: string
}

export interface MacDiagnosticsReport {
  supported: boolean
  collectedAt: number
  platform: string
  appVersion: string
  arch: string
  checks: MacDiagnosticCheck[]
  /** 可直接粘贴给维护者的一段文本（不含聊天内容与密钥）。 */
  summary: string
}

// ---------------------------------------------------------------------------
// 纯解析函数（单独导出以便单测；真实机器上很难复现这些输出）
// ---------------------------------------------------------------------------

/** `csrutil status` → 是否开启 SIP。 */
export function parseSipStatus(output: string): 'enabled' | 'disabled' | 'unknown' {
  const text = String(output || '')
  if (/System Integrity Protection status:\s*enabled/i.test(text)) return 'enabled'
  if (/System Integrity Protection status:\s*disabled/i.test(text)) return 'disabled'
  return 'unknown'
}

export interface SignatureInfo {
  signed: boolean
  authority: string | null
  /** 目标进程是否带 get-task-allow（决定能否被附加）。 */
  getTaskAllow: boolean
  hardenedRuntime: boolean
  flags: string | null
}

/**
 * 解析 `codesign -d --entitlements -` / `codesign -dv` 的输出。
 *
 * 判定的关键：**get-task-allow 是「被附加方」的属性**。微信没有它，就意味着
 * 任何进程（包括 root）都无法对它 task_for_pid —— 这不是权限问题，也不是
 * SIP 开关能解决的。很多用户被误导去关 SIP，在这里可以一次性说清。
 */
export function parseSignatureInfo(codesignVerbose: string, entitlements: string): SignatureInfo {
  const verbose = String(codesignVerbose || '')
  const ents = String(entitlements || '')
  const authorityMatch = verbose.match(/Authority=([^\n]+)/)
  return {
    signed: !/code object is not signed at all/i.test(verbose),
    authority: authorityMatch ? authorityMatch[1].trim() : null,
    getTaskAllow: /get-task-allow/.test(ents) && /<true\s*\/>|=\s*1|true/.test(ents),
    // 加固运行时是附加失败的另一条独立原因：它会让 task_for_pid 直接返回
    // KERN_FAILURE，且与 SIP 无关。
    hardenedRuntime: /flags=0x[0-9a-f]*\bruntime\b/i.test(verbose) || /runtime/i.test(verbose),
    flags: (verbose.match(/flags=([^\n]+)/) || [])[1]?.trim() ?? null,
  }
}

/** 把 fs 读目录失败归类成人能看懂的原因。 */
export function classifyContainerAccessError(error: unknown): { state: MacDiagnosticCheck['state']; detail: string } {
  const code = String((error as { code?: string })?.code || '')
  const message = String((error as Error)?.message || error || '')
  if (code === 'EPERM' || code === 'EACCES' || /operation not permitted/i.test(message)) {
    return {
      state: 'fail',
      detail: '没有权限读取微信的数据目录。请在「系统设置 → 隐私与安全性 → 完全磁盘访问权限」中勾选 Weport，然后重启 Weport。',
    }
  }
  if (code === 'ENOENT') {
    return { state: 'fail', detail: '这个位置不存在。微信可能没有安装过，或者数据目录被移动了。' }
  }
  return { state: 'unknown', detail: `读取目录失败：${message || '未知错误'}` }
}

/** 判定是否运行在 Rosetta 下（会导致内存扫描超时）。 */
export function isRosettaTranslation(procTranslated: string): boolean {
  return String(procTranslated || '').trim() === '1'
}

/**
 * 从 `defaults read … CFBundleShortVersionString` 输出或 Info.plist 文本里
 * 提取微信版本号（如 `3.8.10` / `4.1.8`）。
 *
 * v1.0.0 的诊断没有这一项：3.x 机器在「数据目录权限」上显示 OK，用户随后
 * 只看到 `-3001` / 「kvcomm 为空」—— 完全看不出是代际问题。版本号是区分
 * 「3.x 整机」与「4.x 但路径不对」的唯一依据，所以单独解析、单独成项。
 */
export function parseWeChatVersion(input: string): string | null {
  const text = String(input || '')
  if (!text) return null
  // plist XML：<key>CFBundleShortVersionString</key><string>4.1.8</string>
  const plistMatch = text.match(/CFBundleShortVersionString<\/key>\s*<string>\s*([0-9]+(?:\.[0-9]+){1,2})\s*<\/string>/)
  if (plistMatch) return plistMatch[1]
  const first = text.match(/([0-9]+(?:\.[0-9]+){1,2})/)
  return first ? first[1] : null
}

/** 主版本号 < 4 即 3.x —— Weport 引擎（db_storage / kvcomm / *_t.dat）读不了。 */
export function isUnsupportedWeChatVersion(version: string | null | undefined): boolean {
  if (!version) return false
  const major = parseInt(String(version).split('.')[0], 10)
  return Number.isFinite(major) && major < 4
}

export interface DataCandidateProbe {
  path: string
  exists: boolean
  readable: boolean
  /** 子目录里含 `db_storage` 的个数（4.x 账号标记）。 */
  accountCount: number
  /** 任一账号含 `db_storage/session/session.db` 或 `db_storage/session.db`。 */
  hasSessionDb: boolean
  errorCode?: string
}

/**
 * 数据候选汇总（纯函数，单测覆盖）。
 *
 * 关键修正：v1.0.0 只要 `readdir` 成功就报 OK，于是 3.x 整机（唯一可读候选
 * 是 `2.0b4.0.9`，里面没有 `db_storage`）也显示 `[OK] 可以读取 1 个候选`。
 * 现在「可读」≠「可用」：没有 `db_storage` 的可读候选必须报 fail 并指明代际。
 */
export function summarizeDataCandidates(
  probes: DataCandidateProbe[],
  options?: { wechatVersion?: string | null; kvcommFiles?: number; templateFiles?: number }
): { state: MacDiagnosticCheck['state']; detail: string } {
  const wechatVersion = options?.wechatVersion ?? null
  const is3x = isUnsupportedWeChatVersion(wechatVersion)
  const existing = probes.filter((p) => p.exists)
  const readable = probes.filter((p) => p.exists && p.readable)
  const withAccounts = probes.filter((p) => p.accountCount > 0)
  const withSession = probes.filter((p) => p.hasSessionDb)

  if (withSession.length > 0) {
    return {
      state: 'ok',
      detail: `找到 ${withSession.length} 个含可用 4.x 账号的目录（有 db_storage + session.db）。`,
    }
  }
  if (withAccounts.length > 0) {
    return {
      state: 'warn',
      detail:
        '找到账号目录骨架（有 db_storage）但没有 session.db：微信可能还没登录过、' +
        '或数据尚未完整写入。请先登录微信并保持前台，再重新检查。',
    }
  }
  if (readable.length > 0) {
    const names = readable.map((p) => p.path).slice(0, 3).join('、')
    if (is3x) {
      return {
        state: 'fail',
        detail:
          `检测到微信 ${wechatVersion}（3.x），而可读的数据目录里没有 4.x 账号 ` +
          `（如 ${names}，3.x 没有 db_storage）。Weport 只能读取微信 4.x 数据：` +
          '请从腾讯官网重装微信并升级到 4.x、等待迁移完成后，再选择 …/Documents/xwechat_files。',
      }
    }
    return {
      state: 'fail',
      detail:
        `可以读取 ${readable.length} 个目录（如 ${names}），但里面都没有 ` +
        'db_storage（4.x 账号标记）。`2.0b4.0.9` 是 3.x 数据/回滚副本，' +
        'Weport 读不了；4.x 的正确位置是 …/Data/Documents/xwechat_files。' +
        '若微信仍是 3.x，请先升级到 4.x 并等待迁移完成。',
    }
  }
  if (existing.length === 0) {
    return { state: 'fail', detail: '没有找到任何微信数据目录。请确认微信已登录过，或手动指定数据目录。' }
  }
  return { state: 'fail', detail: '找到数据目录但都读不进去。请确认完全磁盘访问权限后重试。' }
}

// ---------------------------------------------------------------------------
// 真实探测（仅 macOS）
// ---------------------------------------------------------------------------

async function tryExec(file: string, args: string[]): Promise<string | null> {
  try {
    const { stdout, stderr } = await execFileAsync(file, args, { timeout: 8000 })
    return `${stdout || ''}${stderr || ''}`.trim() || null
  } catch (error) {
    // 命令「失败」也可能带着有用输出（codesign 校验失败时就是如此），
    // 因此这里把 stdout/stderr 一并取出而不是直接丢弃。
    const out = (error as { stdout?: string; stderr?: string })?.stdout
    const err = (error as { stderr?: string })?.stderr
    const combined = `${out || ''}${err || ''}`.trim()
    return combined || null
  }
}

function darwinCandidatePaths(): string[] {
  const home = homedir()
  const containerData = join(home, 'Library', 'Containers', 'com.tencent.xinWeChat', 'Data')
  const paths = [join(containerData, 'Documents', 'xwechat_files')]
  const appSupportBase = join(containerData, 'Library', 'Application Support', 'com.tencent.xinWeChat')
  if (existsSync(appSupportBase)) {
    try {
      for (const entry of readdirSync(appSupportBase)) {
        if (/^\d+\.\d+b\d+\.\d+/.test(entry) || /^\d+\.\d+\.\d+/.test(entry)) paths.push(join(appSupportBase, entry))
      }
    } catch { /* 读不到就算了，下面会单独报权限问题 */ }
  }
  paths.push(join(home, 'Documents', 'xwechat_files'))
  return Array.from(new Set(paths))
}

/**
 * 逐候选探测「存在 / 可读 / 是否含 db_storage / 是否含 session.db」。
 *
 * 只读两层（候选 → 子目录），不递归：够判定代际，又不会在大目录上扫出
 * 几分钟。全部吞异常 —— 探测失败本身就是一种结论（exists=false），
 * 绝不能让诊断自己崩掉。
 */
function probeDataCandidates(candidates: string[]): DataCandidateProbe[] {
  return candidates.map((candidate): DataCandidateProbe => {
    if (!existsSync(candidate)) {
      return { path: candidate, exists: false, readable: false, accountCount: 0, hasSessionDb: false }
    }
    let entries: string[] = []
    try {
      entries = readdirSync(candidate)
    } catch (error) {
      const code = String((error as { code?: string })?.code || '')
      return { path: candidate, exists: true, readable: false, accountCount: 0, hasSessionDb: false, errorCode: code || undefined }
    }
    let accountCount = 0
    let hasSessionDb = false
    for (const entry of entries) {
      const entryPath = join(candidate, entry)
      let isDir = false
      try {
        isDir = statSync(entryPath).isDirectory()
      } catch {
        continue
      }
      if (!isDir) continue
      const dbStorage = join(entryPath, 'db_storage')
      if (!existsSync(dbStorage)) continue
      accountCount += 1
      if (
        existsSync(join(dbStorage, 'session', 'session.db')) ||
        existsSync(join(dbStorage, 'session.db'))
      ) {
        hasSessionDb = true
      }
    }
    return { path: candidate, exists: true, readable: true, accountCount, hasSessionDb }
  })
}

/**
 * 采集 macOS 能力诊断。
 *
 * `appVersion` / `resourcesPath` 由调用方注入，避免本模块直接依赖 electron，
 * 从而可以在非 Electron 环境下被单测导入。
 */
export async function collectMacDiagnostics(options: {
  appVersion: string
  resourcesPath: string
}): Promise<MacDiagnosticsReport> {
  const checks: MacDiagnosticCheck[] = []

  if (process.platform !== 'darwin') {
    return {
      supported: false,
      collectedAt: Date.now(),
      platform: process.platform,
      appVersion: options.appVersion,
      arch: arch(),
      checks: [],
      summary: '当前平台不是 macOS，没有 macOS 诊断信息。',
    }
  }

  // 1. WeChat 进程
  const pgrep = await tryExec('/usr/bin/pgrep', ['-fl', 'WeChat.app/Contents/MacOS/WeChat'])
  checks.push({
    id: 'wechat-process',
    label: '微信进程',
    state: pgrep ? 'ok' : 'warn',
    detail: pgrep ? '微信正在运行。' : '没有检测到微信进程。获取密钥时需要微信处于运行状态。',
    raw: pgrep || undefined,
  })

  // 2. 微信签名能力（决定 task_for_pid 是否可能成功）
  const codesignVerbose = await tryExec('/usr/bin/codesign', ['-dv', '--verbose=4', '/Applications/WeChat.app'])
  const entitlements = await tryExec('/usr/bin/codesign', ['-d', '--entitlements', '-', '/Applications/WeChat.app'])
  // 微信版本（代际判定：3.x 整机是「读不了」而不是「路径不对」，必须单独成项）
  const wechatVersionRaw =
    (await tryExec('/usr/bin/defaults', ['read', '/Applications/WeChat.app/Contents/Info', 'CFBundleShortVersionString'])) ||
    codesignVerbose
  const wechatVersion = parseWeChatVersion(wechatVersionRaw || '')
  const wechatIs3x = isUnsupportedWeChatVersion(wechatVersion)
  checks.push({
    id: 'wechat-version',
    label: '微信版本',
    state: wechatVersion ? (wechatIs3x ? 'fail' : 'ok') : 'unknown',
    detail: wechatVersion
      ? wechatIs3x
        ? `检测到微信 ${wechatVersion}（3.x）。Weport 只能读取微信 4.x 数据（db_storage / kvcomm / *_t.dat）：请从腾讯官网重装微信并升级到 4.x、等待迁移完成后，再选择 …/Documents/xwechat_files。`
        : `微信 ${wechatVersion}（4.x），代际符合要求。`
      : '无法读取微信版本号（/Applications/WeChat.app 不存在或 Info.plist 不可读）。',
    raw: wechatVersionRaw ? `CFBundleShortVersionString → ${wechatVersion ?? '(解析失败)'}\n${wechatVersionRaw}`.trim() : undefined,
  })
  if (codesignVerbose === null) {
    checks.push({
      id: 'wechat-signature',
      label: '微信签名',
      state: 'warn',
      detail: '找不到 /Applications/WeChat.app，或无法读取它的签名。如果你把微信装在其他位置，请手动确认。',
    })
  } else {
    const signature = parseSignatureInfo(codesignVerbose, entitlements || '')
    if (!signature.getTaskAllow) {
      checks.push({
        id: 'wechat-signature',
        label: '微信签名',
        state: 'fail',
        detail:
          '微信没有 get-task-allow 权限，因此系统会拒绝任何进程附加到它（即使以管理员身份运行也一样）。' +
          '这不是 SIP 或权限设置能解决的 —— 关闭 SIP 也不会让它成功。' +
          '图片导出不受影响（它直接从磁盘推导密钥，不需要附加进程）。',
        raw: `${codesignVerbose}\n${entitlements || ''}`.trim(),
      })
    } else {
      checks.push({
        id: 'wechat-signature',
        label: '微信签名',
        state: 'ok',
        detail: '微信带有 get-task-allow，自动获取密钥有机会成功。',
        raw: codesignVerbose,
      })
    }
  }

  // 3. SIP（只是提示，不是门槛）
  const csrutil = await tryExec('/usr/bin/csrutil', ['status'])
  const sip = parseSipStatus(csrutil || '')
  checks.push({
    id: 'sip',
    label: 'SIP',
    state: sip === 'enabled' ? 'warn' : 'unknown',
    detail:
      sip === 'enabled'
        ? 'SIP 已开启。SIP 本身不是决定因素（微信的签名才是），但开启时附加更容易被拒。Weport 不建议为此关闭 SIP。'
        : '无法判断 SIP 状态，或不影响本次操作。',
    raw: csrutil || undefined,
  })

  // 4. Rosetta
  const translated = await tryExec('/usr/sbin/sysctl', ['-in', 'sysctl.proc_translated'])
  const rosetta = isRosettaTranslation(translated || '')
  checks.push({
    id: 'rosetta',
    label: '运行架构',
    state: rosetta ? 'fail' : 'ok',
    detail: rosetta
      ? 'Weport 正在通过 Rosetta 转译运行，内存扫描会超时。请安装 arm64 版本（本项目只发布 arm64）。'
      : `原生 ${arch()} 运行。`,
    raw: translated || undefined,
  })

  // 5. 数据目录：先探「存在/可读」，再判「可用（db_storage/session.db）」。
  // v1.0.0 只探到可读就报 OK —— 3.x 整机的唯一可读候选是 2.0b4.0.9
  //（没有 db_storage），于是用户拿到 `[OK] 可以读取 1 个候选`，
  // 下一步却是 -3001。summary 里只认「可用」。
  const candidates = darwinCandidatePaths()
  const probes = probeDataCandidates(candidates)
  const dataSummary = summarizeDataCandidates(probes, { wechatVersion })
  const unreadable = probes.filter((p) => p.exists && !p.readable)
  const accessRaw = unreadable.length > 0
    ? `读不进去（疑似缺完全磁盘访问权限）：\n${unreadable.map((p) => `${p.path}${p.errorCode ? ` [${p.errorCode}]` : ''}`).join('\n')}`
    : undefined
  const probeRaw = [
    ...probes.map((p) => {
      const bits = [
        `exists=${p.exists ? 'y' : 'n'}`,
        `readable=${p.readable ? 'y' : 'n'}`,
        `accounts(db_storage)=${p.accountCount}`,
        `session.db=${p.hasSessionDb ? 'y' : 'n'}`,
      ]
      return `${p.path}\n  ${bits.join(' ')}`
    }),
    accessRaw,
  ].filter(Boolean).join('\n')
  const accessDetail = unreadable.length > 0 && dataSummary.state !== 'ok'
    ? `${dataSummary.detail}另有 ${unreadable.length} 个目录存在但读不进去（${unreadable[0].errorCode || '权限不足'}）：` +
      '请在「系统设置 → 隐私与安全性 → 完全磁盘访问权限」中勾选 Weport，然后重启 Weport。'
    : dataSummary.detail
  checks.push({
    id: 'container-access',
    label: '数据目录权限',
    state: dataSummary.state,
    detail: accessDetail,
    raw: probeRaw || undefined,
  })

  // 5b. WCDB 宿主位置（v1.0.0 自破密封的回归守卫）。
  // 旧版在 Contents/MacOS/WeFlow 写硬链接 → codesign 报 file added。
  // v1.0.1 起宿主永远住 userData；这一项断言「bundle 内没有 WeFlow」，
  // 否则用户看到的下一个症状就是「已损坏」回潮。
  try {
    const execPath = process.execPath || ''
    const execDir = execPath ? dirname(execPath) : ''
    const legacyHost = execDir ? join(execDir, 'WeFlow') : ''
    if (legacyHost && existsSync(legacyHost)) {
      checks.push({
        id: 'wcdb-host-seal',
        label: '宿主密封',
        state: 'fail',
        detail:
          'bundle 内残留旧版 WCDB 宿主链接（Contents/MacOS/WeFlow），它会破坏代码签名密封。' +
          '重启 Weport 一次即可自动清理（v1.0.1 起宿主改放用户数据目录，不再进 bundle）。',
        raw: legacyHost,
      })
    }
  } catch { /* 探测失败不影响其余结论 */ }

  // 6. 随包分发的原生产物（未签名/带 quarantine 是常见的「明明装好了却跑不起来」）
  const helperDir = join(options.resourcesPath, 'resources', 'key', 'macos', 'universal')
  const helperPath = join(helperDir, 'xkey_helper')
  if (existsSync(helperPath)) {
    const helperSignature = await tryExec('/usr/bin/codesign', ['-dv', '--verbose=2', helperPath])
    const xattr = await tryExec('/usr/bin/xattr', ['-l', helperPath])
    const quarantined = /com\.apple\.quarantine/.test(xattr || '')
    checks.push({
      id: 'key-helper',
      label: '密钥助手',
      state: quarantined ? 'fail' : 'ok',
      detail: quarantined
        ? '密钥助手带有 com.apple.quarantine 属性，系统会直接拒绝执行它，而报错信息会误导成「权限不足」。执行 xattr -cr 清理后重试。'
        : helperSignature
          ? '密钥助手存在。'
          : '密钥助手存在但无法读取签名信息。',
      raw: [helperSignature, xattr].filter(Boolean).join('\n') || undefined,
    })
  } else {
    checks.push({
      id: 'key-helper',
      label: '密钥助手',
      state: 'warn',
      detail: `没有找到密钥助手（${helperPath}）。如果你使用的是非安装版，这是正常的。`,
    })
  }

  const summary = [
    `Weport ${options.appVersion} · macOS · ${arch()}`,
    `采集时间：${new Date().toLocaleString('zh-CN')}`,
    '',
    ...checks.map((check) => `[${check.state.toUpperCase()}] ${check.label}：${check.detail}`),
    '',
    '--- 原始输出 ---',
    ...checks.filter((check) => check.raw).map((check) => `### ${check.label}\n${check.raw}`),
  ].join('\n')

  return {
    supported: true,
    collectedAt: Date.now(),
    platform: process.platform,
    appVersion: options.appVersion,
    arch: arch(),
    checks,
    summary,
  }
}

/** 数据目录候选（供界面展示；与 dbPathService 的规则保持一致）。 */
export function macCandidatePaths(): string[] {
  return darwinCandidatePaths()
}
