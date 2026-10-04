import {
  buildPrerequisiteReport,
  supportsReadOnlyScan,
  type PrereqItem,
  type PrereqObservations,
  type PrereqReport,
} from './keyPrerequisite'
import type { PageKeyMode } from './wcdbPageKey'
import type { KeySource } from './keyHealthService'

/**
 * 密钥获取**编排层**（V12 §1.3 / §1.4 / D1 / D2）。
 *
 * ## 一个按钮，两条路
 *
 * 用户只看到「获取密钥」。内部按固定顺序试，并且**如实报告走了哪条**：
 *
 * ```
 * 0. 已有密钥 → page 1 HMAC 自校验 → 通过就"已连接"（不打扰用户，K6）
 * 1. Windows 且版本 ≥ 4.1.10 → 免登录只读扫描（每库 page key，K1/K5）
 * 2. Hook（平台通用；macOS/Linux 的唯一自动路径，D2/K8）
 * 3. 失败 → 逐项自检结果 + 手动粘贴（§1.5 末条：任何一项未通过都不许静默回落）
 * ```
 *
 * ## 为什么编排层单独一个模块
 *
 * 三条路（扫描 / Hook / 手动）在三个平台上有不同的**前置条件**与**失败文案**，
 * 而 UI 必须长得一样。把"决策"（{@link planKeyAcquisition}）与"文案"
 * （`keyPrerequisite.ts`）都做成纯函数，就能在没有微信、没有 Electron 的环境里
 * 用单测把矩阵钉死 —— 这类分支最容易在真实机器上才炸。
 */

/** 用户请求的模式。 */
export type KeyAcquisitionMode = 'scan' | 'hook' | 'auto'

/** 实际生效的那条路。 */
export type KeyAcquisitionPath = 'existing' | 'scan' | 'hook' | 'manual'

export interface AcquiredKey {
  id: string
  kind: string
  path: string
  /** 完整密钥（只在内存/加密配置里流转，绝不进日志）。 */
  keyHex: string
  saltHex: string | null
  mode: PageKeyMode
  fingerprint: string
  source: KeySource
}

export interface KeyAcquisitionResult {
  success: boolean
  /** 账号级密钥（能喂给 `wcdb_open_account` 的那种；扫描拿不到时为 undefined）。 */
  key?: string
  /** 每库 page key（扫描路径的产物，§1.7 的 per-DB 模型）。 */
  keys?: AcquiredKey[]
  /** 实际生效路径。 */
  mode?: KeyAcquisitionPath
  error?: string
  logs?: string[]
  /** 逐项自检（D4）。 */
  prerequisites?: PrereqItem[]
  /** 自检总述（卡片折叠态用一行）。 */
  prerequisiteSummary?: string
  /** 每条路为什么没成 —— 说清"另一条为什么失败"，而不是只报最后一句。 */
  reasons?: { existing?: string; scan?: string; hook?: string }
  diagnostics?: {
    platform: string
    scanSupported: boolean
    elapsedMs: number
    scan?: unknown
  }
}

/** 平台观测结果（自检矩阵的输入，K2/K3/K4/K5/K10）。 */
export interface PlatformObservation {
  wechatInstalled: boolean
  wechatExePath?: string | null
  wechatPids: number[]
  /** `null` = 读不到版本资源。 */
  wechatVersion?: string | null
  /** `null` = 未探测。 */
  wechatLoggedIn?: boolean | null
  sameUser?: boolean | null
  memoryReadable?: boolean | null
  /** Hook 组件（`wx_key.dll` / helper）是否可用。 */
  hookHelperAvailable?: boolean | null
}

/** 平台驱动：真正的扫描 / Hook 实现在平台各自的 service 里。 */
export interface PlatformKeyDriver {
  platform: 'win32' | 'darwin' | 'linux' | string
  observe(): Promise<PlatformObservation>
  /** 免登录只读扫描；只有 Windows 提供。 */
  scanKeys?(options: {
    accountDir: string
    onProgress?: (message: string, ratio?: number | null) => void
    cancel?: { cancelled: boolean }
  }): Promise<{ success: boolean; keys: AcquiredKey[]; error?: string; diagnostics?: unknown; logs?: string[] }>
  /** Hook / 登录捕获（平台原有路径）。 */
  hookAcquire(options: {
    timeoutMs: number
    onStatus?: (message: string, level: number) => void
  }): Promise<{ success: boolean; key?: string; error?: string; logs?: string[] }>
}

// === 纯决策逻辑（单测重点） ===

export interface AcquisitionPlanInput {
  platform: string
  mode: KeyAcquisitionMode
  hasStoredKey: boolean
  /** `null` = 没有已存密钥（不是"无效"）。 */
  storedKeyValid?: boolean | null
  wechatVersion?: string | null
  wechatRunning: boolean
  dbFilesPresent?: boolean
}

export interface AcquisitionPlan {
  /** 依次尝试的步骤。 */
  steps: Array<'existing' | 'scan' | 'hook'>
  /** 本平台是否支持免登录扫描。 */
  scanSupported: boolean
  /** 需要如实告诉用户的能力边界（macOS/Linux 常驻一条）。 */
  notes: string[]
}

/**
 * 决定"这次该按什么顺序试"。
 *
 * 规则（与 V12 §1.4 的状态机一一对应）：
 * - 有已存密钥 → 先自校验；通过就结束（K6）。
 * - 只有 Windows + 免登录扫描受支持的版本（≥4.1.10）才排进步骤 1（K4）。
 * - 微信没在运行时**不跳过**扫描项，而是让自检第 2 项报红（K2）—— 静默跳过等于
 *   "点了没反应"，正是这次要消灭的东西。
 * - `mode: 'hook'` 时不允许扫描；`mode: 'scan'` 时扫描失败也不回落（便于测试与诊断）。
 */
export function planKeyAcquisition(input: AcquisitionPlanInput): AcquisitionPlan {
  const scanSupported = input.platform === 'win32'
  const notes: string[] = []
  const steps: Array<'existing' | 'scan' | 'hook'> = []

  if (input.hasStoredKey) steps.push('existing')

  const versionOk = input.wechatVersion ? supportsReadOnlyScan(input.wechatVersion) : true
  if (scanSupported && input.mode !== 'hook' && versionOk) steps.push('scan')
  if (!scanSupported) {
    notes.push(
      input.platform === 'darwin'
        ? 'macOS 没有免登录路径：微信是加固签名 + 沙盒进程，`task_for_pid` 会被系统拒绝，只能在微信启动瞬间捕获密钥。'
        : 'Linux 没有免登录路径：读取密钥需要 ptrace 断点并提权（会弹一次 sudo 提示），只能在微信启动瞬间捕获密钥。'
    )
  }
  if (scanSupported && !versionOk) {
    notes.push(`微信 ${input.wechatVersion} 低于免登录扫描要求的 4.1.10，本次直接走登录捕获。`)
  }
  if (input.mode !== 'scan') steps.push('hook')
  return { steps, scanSupported, notes }
}

/** 自检矩阵的输入装配（纯函数，喂给 `buildPrerequisiteReport`）。 */
export function toPrerequisiteObservations(args: {
  plan: AcquisitionPlan
  platform: string
  observation: PlatformObservation
  dataDir?: string | null
  dbFilesPresent: boolean
  storedKeyValid?: boolean | null
  scanAttempted?: boolean
  scanKeyFound?: boolean
  keyObtained?: boolean
}): PrereqObservations {
  const scanWanted = args.plan.steps.includes('scan')
  return {
    platform: args.platform,
    mode: scanWanted ? 'scan' : 'hook',
    wechatInstalled: args.observation.wechatInstalled,
    wechatExePath: args.observation.wechatExePath ?? null,
    wechatPids: args.observation.wechatPids,
    wechatLoggedIn: args.observation.wechatLoggedIn ?? null,
    wechatVersion: args.observation.wechatVersion ?? null,
    sameUser: args.observation.sameUser ?? null,
    memoryReadable: args.observation.memoryReadable ?? null,
    dataDirConfigured: !!args.dataDir,
    dataDir: args.dataDir ?? null,
    dbFilesPresent: args.dbFilesPresent,
    storedKeyValid: args.storedKeyValid ?? null,
    scanAttempted: args.scanAttempted,
    scanKeyFound: args.scanKeyFound,
    keyObtained: args.keyObtained,
    hookHelperAvailable: args.observation.hookHelperAvailable ?? null,
  }
}

/** 失败时的用户文案：先给"下一步做什么"，再给"哪条路为什么没成"。 */
export function describeAcquisitionFailure(args: {
  report: PrereqReport
  reasons: { existing?: string; scan?: string; hook?: string }
  plan: AcquisitionPlan
}): string {
  const lines: string[] = []
  const blocking = args.report.blocking
  if (blocking.length > 0) {
    lines.push(...blocking.map((item) => `${item.message}${item.action ? ` ${item.action}` : ''}`))
  } else {
    lines.push('密钥没有取到，但前置条件都满足 —— 说明是 Weport 这一侧没成功。')
  }
  lines.push('---')
  if (args.reasons.existing) lines.push(`已有密钥：${args.reasons.existing}`)
  if (args.plan.steps.includes('scan') && args.reasons.scan) lines.push(`免登录扫描：${args.reasons.scan}`)
  else if (!args.plan.scanSupported) lines.push('免登录扫描：本平台不支持（已在上面说明原因）')
  if (args.plan.steps.includes('hook') && args.reasons.hook) lines.push(`登录捕获：${args.reasons.hook}`)
  lines.push('最后手段：把 64 位密钥粘贴到「手动输入密钥」，或在下方密钥健康面板里逐库处理。')
  return lines.join('\n')
}

// === 编排服务 ===

export interface StoredKeyProbe {
  /** 配置里已存的账号级密钥（hex）；没有则 null。 */
  hexKey: string | null
  source: KeySource
}

export interface KeyAcquisitionDeps {
  driver: PlatformKeyDriver
  /** 账号目录（`…/wxid_xxx`）。 */
  accountDir?: string | null
  /** 已存密钥。 */
  storedKey?: StoredKeyProbe
  /** 校验已存密钥（生产：对账号下每个库做 page 1 HMAC）。 */
  validateStoredKey?: (hexKey: string, accountDir: string) => Promise<{ valid: boolean; checked: number; matched: number; error?: string }>
  /** 账号目录下是否真的有库文件。 */
  hasDbFiles?: (accountDir: string) => Promise<boolean>
  /** 扫描成功后把结果并入密钥库（合并写入，绝不覆盖其它库）。 */
  persistKeys?: (accountDir: string, keys: AcquiredKey[]) => Promise<void>
  onStatus?: (message: string, level: number) => void
  onScanProgress?: (message: string, ratio?: number | null) => void
  cancel?: { cancelled: boolean }
  timeoutMs?: number
  now?: () => number
}

/**
 * 编排实现。**所有失败路径都必须带自检结果**：调用方永远能拿到
 * `prerequisites`，UI 因此不存在"点了没反应"的状态（§1.5 末条）。
 */
export class KeyAcquisitionService {
  constructor(private deps: KeyAcquisitionDeps) {}

  async acquire(mode: KeyAcquisitionMode = 'auto'): Promise<KeyAcquisitionResult> {
    const started = (this.deps.now ?? Date.now)()
    const logs: string[] = []
    const status = (message: string, level = 0): void => {
      logs.push(message)
      try { this.deps.onStatus?.(message, level) } catch { /* noop */ }
    }
    const accountDir = String(this.deps.accountDir || '').trim()
    const reasons: KeyAcquisitionResult['reasons'] = {}
    const storedHex = this.deps.storedKey?.hexKey ?? null

    let observation: PlatformObservation
    /** 观察本身失败（枚举进程/读 DLL 抛错）——与"微信没装/没运行"是两件事，不能混成一条。 */
    let observationFailed: string | null = null
    try {
      observation = await this.deps.driver.observe()
    } catch (e) {
      // 注意这里**不能**假装"没装微信"：那会让自检把责任推到用户身上（"未检测到微信客户端 /
      // 微信没有在运行"），而真实原因是我们的观察步骤坏了，用户去修也修不好。
      observationFailed = e instanceof Error ? e.message : String(e)
      // 字段保持"未知"而不是 false：wechatInstalled:false 会被自检读成"没装"。
      observation = { wechatInstalled: true, wechatPids: [], hookHelperAvailable: false }
      status(`观测平台状态失败：${observationFailed}`, 2)
    }

    // 下面两个 await 同样在 try/catch 之外：任一个抛错都会把整个 acquire() 变成 reject，
    // 调用方只能拿到一句"密钥获取失败"，而这个文件的契约是**每条失败路径都带自检结果**。
    let dbFilesPresent = !!accountDir
    if (accountDir && this.deps.hasDbFiles) {
      try {
        dbFilesPresent = await this.deps.hasDbFiles(accountDir)
      } catch (e) {
        status(`检查数据库文件失败：${e instanceof Error ? e.message : String(e)}`, 2)
      }
    }
    const plan = planKeyAcquisition({
      platform: this.deps.driver.platform,
      mode,
      hasStoredKey: !!storedHex,
      wechatVersion: observation.wechatVersion ?? null,
      wechatRunning: observation.wechatPids.length > 0,
      dbFilesPresent,
    })
    for (const note of plan.notes) status(note, 1)

    let storedKeyValid: boolean | null = null
    let scanAttempted = false
    let scanKeyFound = false
    let scanKeys: AcquiredKey[] = []
    let scanDiagnostics: unknown

    // ── 0) 已有密钥自校验（K6/K7）
    if (plan.steps.includes('existing') && storedHex && accountDir && this.deps.validateStoredKey) {
      status('正在校验已保存的密钥…')
      let check: Awaited<ReturnType<NonNullable<typeof this.deps.validateStoredKey>>> | null = null
      try {
        check = await this.deps.validateStoredKey(storedHex, accountDir)
      } catch (e) {
        // 校验本身抛错 = "判不出来"，不是"判为无效"。当成无效会把一条可能好的密钥说成坏的。
        status(`校验已保存的密钥时失败：${e instanceof Error ? e.message : String(e)}`, 2)
      }
      if (check?.valid) {
        storedKeyValid = true
        const report = buildPrerequisiteReport(toPrerequisiteObservations({
          plan, platform: this.deps.driver.platform, observation, dataDir: accountDir, dbFilesPresent, storedKeyValid: true, keyObtained: true,
        }))
        status('已保存的密钥校验通过，无需重新获取。', 1)
        return {
          success: true,
          key: storedHex,
          keys: [],
          mode: 'existing',
          logs,
          prerequisites: report.items,
          prerequisiteSummary: report.summary,
          diagnostics: { platform: this.deps.driver.platform, scanSupported: plan.scanSupported, elapsedMs: (this.deps.now ?? Date.now)() - started },
        }
      }
      if (check) {
        storedKeyValid = check.valid
      }
      if (check) {
        const reason = check.error || `保存的密钥与本机数据库对不上（检查了 ${check.checked} 个库，匹配 ${check.matched} 个）。`
        reasons.existing = reason
        status(reason, check.error ? 2 : 1)
      }
    } else if (plan.steps.includes('existing') && storedHex && !accountDir) {
      reasons.existing = '配置里有密钥，但没有选定账号目录，无法校验。'
    }

    // ── 1) 免登录只读扫描（K1/K5）
    if (plan.steps.includes('scan') && this.deps.driver.scanKeys) {
      if (!accountDir) {
        reasons.scan = '没有选定数据目录，扫描无法定位要校验的数据库。'
        status(reasons.scan, 1)
      } else if (observation.wechatPids.length === 0) {
        // 观察失败时**不能**说"微信没在运行" —— 那是我们的观测步骤坏了，用户照着这条去修
        // 永远修不好。分开说一句"我们没测出来"。
        reasons.scan = observationFailed
          ? `没能确认微信是否在运行（平台状态观测失败：${observationFailed}），因此先不扫描。`
          : '微信没在运行 —— 免登录扫描要读它的进程内存，密钥只在微信启动后才存在。'
        status(reasons.scan, 1)
      } else {
        scanAttempted = true
        try {
          const scan = await this.deps.driver.scanKeys({
            accountDir,
            onProgress: (message, ratio) => { try { this.deps.onScanProgress?.(message, ratio) } catch { /* noop */ } },
            cancel: this.deps.cancel,
          })
          logs.push(...(scan.logs ?? []))
          scanDiagnostics = scan.diagnostics
          scanKeys = scan.keys
          scanKeyFound = scan.keys.length > 0
          if (scan.success && scan.keys.length > 0) {
            if (this.deps.persistKeys) {
              try {
                await this.deps.persistKeys(accountDir, scan.keys)
              } catch (e) {
                status(`扫描结果已取到，但写入密钥库失败：${e instanceof Error ? e.message : String(e)}`, 2)
              }
            }
            const report = buildPrerequisiteReport(toPrerequisiteObservations({
              plan, platform: this.deps.driver.platform, observation, dataDir: accountDir, dbFilesPresent,
              storedKeyValid, scanAttempted: true, scanKeyFound: true, keyObtained: true,
            }))
            status(`免登录扫描取到 ${scan.keys.length} 个库的密钥并全部校验通过。`, 1)
            // 账号级密钥（能喂 wcdb_open_account 的那种）与每库 page key 是两回事：
            // 扫描拿到的是 page key（raw），账号口令只有 Hook/历史配置才有。
            return {
              success: true,
              keys: scan.keys,
              key: undefined,
              mode: 'scan',
              logs,
              prerequisites: report.items,
              prerequisiteSummary: report.summary,
              diagnostics: { platform: this.deps.driver.platform, scanSupported: true, elapsedMs: (this.deps.now ?? Date.now)() - started, scan: scan.diagnostics },
            }
          }
          reasons.scan = scan.error || '扫描完成但没有找到能解开这些数据库的密钥。'
          status(reasons.scan, 1)
        } catch (e) {
          reasons.scan = e instanceof Error ? e.message : String(e)
          status(`免登录扫描异常：${reasons.scan}`, 2)
        }
      }
    }

    // ── 2) Hook（平台通用；macOS/Linux 的唯一自动路径）
    if (plan.steps.includes('hook')) {
      if (observation.wechatPids.length === 0) {
        reasons.hook = '微信没在运行。登录捕获必须在微信进程启动的瞬间完成。'
        status(reasons.hook, 1)
      } else if (observation.hookHelperAvailable === false) {
        reasons.hook = '登录捕获组件不可用（wx_key.dll / helper 缺失或被安全软件删除）。'
        status(reasons.hook, 2)
      } else {
        status('正在用登录捕获模式获取账号密钥…')
        try {
          const hook = await this.deps.driver.hookAcquire({
            timeoutMs: this.deps.timeoutMs ?? 120_000,
            onStatus: (message, level) => status(message, level),
          })
          logs.push(...(hook.logs ?? []))
          if (hook.success && hook.key) {
            const report = buildPrerequisiteReport(toPrerequisiteObservations({
              plan, platform: this.deps.driver.platform, observation, dataDir: accountDir, dbFilesPresent,
              storedKeyValid, scanAttempted, scanKeyFound, keyObtained: true,
            }))
            return {
              success: true,
              key: hook.key,
              keys: scanKeys,
              mode: 'hook',
              logs,
              prerequisites: report.items,
              prerequisiteSummary: report.summary,
              reasons: Object.keys(reasons).length ? reasons : undefined,
              diagnostics: { platform: this.deps.driver.platform, scanSupported: plan.scanSupported, elapsedMs: (this.deps.now ?? Date.now)() - started, scan: scanDiagnostics },
            }
          }
          reasons.hook = hook.error || '登录捕获没有拿到密钥（微信可能在捕获就位之前就已经启动完成）。'
          status(reasons.hook, 2)
        } catch (e) {
          reasons.hook = e instanceof Error ? e.message : String(e)
          status(`登录捕获异常：${reasons.hook}`, 2)
        }
      }
    }

    // ── 3) 失败：自检 + 手动粘贴
    const report = buildPrerequisiteReport(toPrerequisiteObservations({
      plan, platform: this.deps.driver.platform, observation, dataDir: accountDir, dbFilesPresent,
      storedKeyValid, scanAttempted, scanKeyFound, keyObtained: false,
    }))
    const error = describeAcquisitionFailure({ report, reasons, plan })
    return {
      success: false,
      keys: scanKeys,
      error,
      mode: undefined,
      logs,
      prerequisites: report.items,
      prerequisiteSummary: report.summary,
      reasons: Object.keys(reasons).length ? reasons : undefined,
      diagnostics: { platform: this.deps.driver.platform, scanSupported: plan.scanSupported, elapsedMs: (this.deps.now ?? Date.now)() - started, scan: scanDiagnostics },
    }
  }
}

/** 便捷入口：编排一次并返回扩展后的结果形状。 */
export async function acquireDbKeyViaOrchestrator(deps: KeyAcquisitionDeps, mode: KeyAcquisitionMode = 'auto'): Promise<KeyAcquisitionResult> {
  return new KeyAcquisitionService(deps).acquire(mode)
}

/**
 * Windows 驱动：包住 `keyService.ts` 的三个方法（观测 / 扫描 / Hook）。
 *
 * 用接口而不是直接 import，是为了让编排层在单测里能塞一个假驱动 —— 密钥获取的
 * 分支几乎全部活在"平台 × 前置条件 × 两条路"的组合里，只有能注入才测得动。
 */
export function createWindowsKeyDriver(service: {
  observePlatform(): Promise<PlatformObservation>
  scanDbKeys(options: {
    accountDir: string
    onProgress?: (message: string, ratio?: number | null) => void
    cancel?: { cancelled: boolean }
  }): Promise<{ success: boolean; keys: AcquiredKey[]; error?: string; diagnostics?: unknown; logs?: string[] }>
  hookAcquireKey(options: {
    timeoutMs: number
    onStatus?: (message: string, level: number) => void
  }): Promise<{ success: boolean; key?: string; error?: string; logs?: string[] }>
}): PlatformKeyDriver {
  return {
    platform: 'win32',
    observe: () => service.observePlatform(),
    scanKeys: (options) => service.scanDbKeys(options),
    hookAcquire: (options) => service.hookAcquireKey(options),
  }
}

/**
 * macOS / Linux 驱动：**只有 Hook**（D2 / K8）。
 *
 * 这里刻意**不实现** `scanKeys`：这两个平台没有免登录路径（macOS 加固签名 + 沙盒，
 * `task_for_pid` 被系统拒绝；Linux 需要 ptrace 断点 + 提权）。声明了就等于骗用户 ——
 * 编排层看到 `scanKeys === undefined` 就只走 Hook，并在自检里常驻一条能力边界说明。
 */
export function createHookOnlyDriver(args: {
  platform: 'darwin' | 'linux' | string
  observe: () => Promise<PlatformObservation>
  hookAcquire: (options: {
    timeoutMs: number
    onStatus?: (message: string, level: number) => void
  }) => Promise<{ success: boolean; key?: string; error?: string; logs?: string[] }>
}): PlatformKeyDriver {
  return {
    platform: args.platform,
    observe: args.observe,
    hookAcquire: args.hookAcquire,
  }
}
