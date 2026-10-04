import {
  isNoLoginDbKeyScanEnabled,
} from './v12StablePolicy'

/**
 * 密钥获取的**前置条件自检矩阵**（V12 §1.5 / D4）。
 *
 * ## 这个模块存在的唯一理由
 *
 * 旧流程最糟的一点不是"取不到密钥"，而是**取不到时什么也不说**：用户点了按钮，
 * 界面转一圈回到原样；他不知道是微信没开、没登录、版本太旧，还是杀软挡住了
 * `OpenProcess`。§1.5 的规则很硬 —— 未通过的项要**红**，并且每一项都带一行
 * **可执行的动作**。
 *
 * 所以这里把"缺什么"与"下一步做什么"做成**常量**：文案只有一处定义，
 * 单测能断言它们两两不同（同一个坑不要用同一句话糊过去），UI 只负责点亮与着色。
 *
 * 文案纪律（本项目硬要求）：
 * 1. 每一句都必须是**具体的下一步动作**，不许出现"请重试"这种把责任推回用户的空话；
 * 2. 只描述用户能自己完成的操作（装微信 / 打开微信 / 同一 Windows 用户 / 加白名单 /
 *    选目录 / 重新获取），做不到的事（如 macOS 的免登录扫描）要**明说做不到**。
 */

/** 自检项 id。新增项必须同时补 {@link PREREQ_MESSAGES} 与 {@link PREREQ_ACTIONS}。 */
export type PrereqId =
  | 'platform-scan-support'
  | 'wechat-installed'
  | 'wechat-running'
  | 'wechat-logged-in'
  | 'wechat-version'
  | 'same-user'
  | 'memory-readable'
  | 'data-dir-selected'
  | 'db-files-present'
  | 'stored-key-valid'
  | 'scan-key-found'
  | 'hook-helper-available'
  | 'manual-key-available'

/** 单项结论。`warn` = 该项不满足但**有后备路径**（例如版本旧 → 回落 Hook）。 */
export type PrereqStatus = 'pass' | 'fail' | 'warn' | 'skip'

export interface PrereqItem {
  id: PrereqId
  status: PrereqStatus
  /** 结论一句话（含具体版本号/路径等事实）。 */
  message: string
  /** 未通过时的**一行动作**；通过时为 undefined。 */
  action?: string
  /** 内部诊断细节（进程号、计数器），只在"诊断信息"里展开。 */
  detail?: string
}

export interface PrereqReport {
  items: PrereqItem[]
  /** 全部 pass/warn/skip（即没有 fail）。 */
  allSatisfied: boolean
  /** fail 的项，UI 直接照着渲染红点。 */
  blocking: PrereqItem[]
  /** 一行总述，用于卡片折叠态。 */
  summary: string
}

/** 每个自检项的结论文案（必须两两不同 —— 单测会断言）。 */
export const PREREQ_MESSAGES: Record<PrereqId, string> = {
  'platform-scan-support':
    '当前系统没有免登录路径：macOS 的微信是加固签名 + 沙盒进程，Linux 上需要 ptrace 断点并提权，两者都只能在**微信启动的瞬间**捕获密钥。',
  'wechat-installed':
    '未检测到微信客户端。',
  'wechat-running':
    '微信没有在运行。免登录扫描需要读取正在运行的微信进程内存，密钥只在微信启动后才存在。',
  'wechat-logged-in':
    '微信在运行，但还没有登录目标账号（账号目录里没有可读的 session.db 写入）。',
  'wechat-version':
    '微信版本不在免登录扫描的支持范围内（免登录扫描需要微信 4.1.10 及以上）。',
  'same-user':
    '微信与 Weport 运行在不同的 Windows 用户下，跨用户的进程内存无法读取。',
  'memory-readable':
    '无法读取微信进程内存（`OpenProcess` 被拒绝），通常是安全软件/杀毒软件的进程防护拦截。',
  'data-dir-selected':
    '还没有选择微信数据目录。',
  'db-files-present':
    '选定的目录里没有找到微信 4.x 的数据库文件（db_storage/*.db）。',
  'stored-key-valid':
    '已保存的密钥与这个账号的数据库对不上（密钥不匹配）。',
  'scan-key-found':
    '扫描已经跑完，但没有在微信进程里找到与这些数据库匹配的密钥 —— 该微信版本的内部结构可能已变化。',
  'hook-helper-available':
    '登录捕获组件（wx_key.dll）缺失，安装包可能不完整或被安全软件删除。',
  'manual-key-available':
    '自动获取的两条路都没有成功，需要你手动粘贴一次密钥。',
}

/** 每一项未通过时的**一行动作**。禁止出现"请重试"。 */
export const PREREQ_ACTIONS: Record<PrereqId, string> = {
  'platform-scan-support':
    '请用「③ 重启微信并捕获」这条流程：先完全退出微信，再重新打开（自动登录即可），Weport 会在进程启动瞬间捕获密钥；密钥只需捕获一次，之后长期有效。',
  'wechat-installed':
    '请先从腾讯官网安装微信 4.x，装好并登录一次后回到这里。',
  'wechat-running':
    '请打开微信并停留在已登录状态，然后回到 Weport 点「获取密钥」。',
  'wechat-logged-in':
    '请在微信里完成登录（扫码或自动登录），确认能看到聊天列表后，回到 Weport 点「获取密钥」。',
  'wechat-version':
    '按下面第 ③ 步走：点「退出微信」→ 重新打开微信（可用自动登录）→ 保持 Weport 开着，启动瞬间会自动捕获密钥。',
  'same-user':
    '请用同一个 Windows 账号登录后再运行 Weport（微信与 Weport 必须同用户）。',
  'memory-readable':
    '请把 Weport 加入安全软件的信任/白名单（或在杀软的「进程防护」里放行 Weport），然后重新点「获取密钥」。',
  'data-dir-selected':
    '请在上方「微信数据目录」里选择 xwechat_files（里面应有以 wxid_ 开头的账号目录），然后点「获取密钥」。',
  'db-files-present':
    '请确认选择的是微信 4.x 的数据根目录（路径下应有 <wxid>/db_storage），旧版 3.x 的 WeChat Files 无法使用。',
  'stored-key-valid':
    '请使用登录捕获或手动输入有效的账号级密钥，替换这把失效的密钥。',
  'scan-key-found':
    '按下面第 ③ 步走：点「退出微信」→ 重新打开微信（可用自动登录）→ 保持 Weport 开着，启动瞬间会自动捕获密钥。',
  'hook-helper-available':
    '请重新下载并覆盖安装 Weport（安装包内应含 resources/key/win32/x64/wx_key.dll），或直接手动粘贴密钥。',
  'manual-key-available':
    '请把 64 位密钥粘贴到「手动输入密钥」框并保存。',
}

/** 观察结果：由编排层（keyAcquisition）逐项探测后填入，`null` 表示"未探测"。 */
export interface PrereqObservations {
  platform: 'win32' | 'darwin' | 'linux' | string
  /** 当前想走的模式：`scan` 时版本项才参与判定。 */
  mode: 'scan' | 'hook' | 'auto'
  wechatInstalled: boolean
  wechatExePath?: string | null
  wechatPids?: number[]
  /** `null` = 未探测。 */
  wechatLoggedIn?: boolean | null
  /** 形如 `4.1.13.65`；`null` = 未读到版本资源。 */
  wechatVersion?: string | null
  sameUser?: boolean | null
  memoryReadable?: boolean | null
  dataDirConfigured: boolean
  dataDir?: string | null
  dbFilesPresent: boolean
  /** `null` = 没有已存密钥（不是"无效"）。 */
  storedKeyValid?: boolean | null
  /** 扫描是否跑过 / 是否命中。 */
  scanAttempted?: boolean
  scanKeyFound?: boolean
  hookHelperAvailable?: boolean | null
  /** 这次到底有没有拿到密钥（`false` 时补一条"手动粘贴"的兜底指引）。 */
  keyObtained?: boolean
}

/** 扫描路径要求的最低微信版本（4.1.10.31 起是 password mode）。证据：报告 §2 版本表。 */
export const MIN_SCAN_WECHAT_VERSION = '4.1.10'

/** 比较 `a.b.c(.d)` 形式的版本号；a>b 返回正数。 */
export function compareVersions(a: string, b: string): number {
  const pa = String(a || '').split('.').map((n) => Number(n) || 0)
  const pb = String(b || '').split('.').map((n) => Number(n) || 0)
  const len = Math.max(pa.length, pb.length)
  for (let i = 0; i < len; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d !== 0) return d
  }
  return 0
}

export function supportsReadOnlyScan(version: string | null | undefined): boolean {
  if (!version) return false
  return compareVersions(version, MIN_SCAN_WECHAT_VERSION) >= 0
}

export function isScanPlatform(platform: string): boolean {
  return isNoLoginDbKeyScanEnabled(platform)
}

function item(id: PrereqId, status: PrereqStatus, overrides: Partial<PrereqItem> = {}): PrereqItem {
  const base: PrereqItem = { id, status, message: PREREQ_MESSAGES[id] }
  if (status === 'fail' || status === 'warn') base.action = PREREQ_ACTIONS[id]
  return { ...base, ...overrides }
}

/**
 * 由观察结果生成整张自检表。
 *
 * 顺序即 UI 顺序，也即"用户排查顺序"：先看装没装、开没开、登没登，再看平台能力，
 * 最后才看密钥本身。**任何一项 fail 都不允许静默回落**（§1.5 末条）。
 */
export function buildPrerequisiteReport(obs: PrereqObservations): PrereqReport {
  const items: PrereqItem[] = []
  const scanPlatform = isScanPlatform(obs.platform)
  const wantsScan = scanPlatform && (obs.mode === 'scan' || obs.mode === 'auto')

  // 1) 平台能力（macOS / Linux 常驻一条，如实说明边界 —— D2 / K8）
  if (obs.platform === 'win32' && !scanPlatform) {
    items.push(item('platform-scan-support', 'skip', {
      message: '当前稳定版按已有账号级密钥和登录捕获流程获取密钥。',
    }))
  } else if (scanPlatform) {
    items.push(item('platform-scan-support', 'pass', {
      message: '当前系统支持免登录扫描（Windows）。',
    }))
  } else {
    items.push(item('platform-scan-support', 'warn', {
      message: obs.platform === 'darwin'
        ? PREREQ_MESSAGES['platform-scan-support']
        : PREREQ_MESSAGES['platform-scan-support'],
      detail: `platform=${obs.platform}`,
    }))
  }

  // 2) 已安装
  items.push(obs.wechatInstalled
    ? item('wechat-installed', 'pass', {
      message: '已检测到微信客户端。',
      detail: obs.wechatExePath ? `exe=${obs.wechatExePath}` : undefined,
    })
    : item('wechat-installed', 'fail'))

  // 3) 正在运行
  const pids = obs.wechatPids ?? []
  items.push(pids.length > 0
    ? item('wechat-running', 'pass', { message: `微信正在运行（${pids.length} 个进程）。`, detail: `pids=${pids.join(',')}` })
    : item('wechat-running', 'fail'))

  // 4) 已登录
  const loggedIn = obs.wechatLoggedIn ?? null
  if (loggedIn === null) {
    items.push(item('wechat-logged-in', 'skip', { message: '尚未确认微信登录状态。' }))
  } else if (loggedIn) {
    items.push(item('wechat-logged-in', 'pass', { message: '微信已登录目标账号。' }))
  } else {
    items.push(item('wechat-logged-in', 'fail'))
  }

  // 5) 版本（只有扫描路径在意；Hook 路径不设限）
  const version = obs.wechatVersion ?? null
  if (!version) {
    items.push(item('wechat-version', wantsScan ? 'warn' : 'skip', {
      message: '读不到微信版本号。',
      action: wantsScan ? PREREQ_ACTIONS['wechat-version'] : undefined,
    }))
  } else if (supportsReadOnlyScan(version)) {
    items.push(item('wechat-version', 'pass', { message: `微信 ${version} 支持免登录扫描。` }))
  } else if (wantsScan) {
    items.push(item('wechat-version', 'warn', {
      message: `你当前的微信版本是 ${version}，低于免登录扫描要求的 ${MIN_SCAN_WECHAT_VERSION}。`,
      action: PREREQ_ACTIONS['wechat-version'],
    }))
  } else {
    items.push(item('wechat-version', 'skip', { message: `微信 ${version}（当前流程不需要版本判断）。` }))
  }

  // 6) 同一用户
  const sameUser = obs.sameUser ?? null
  if (!scanPlatform) {
    items.push(item('same-user', 'skip', { message: '当前流程不读取微信进程内存。' }))
  } else if (sameUser === null) {
    items.push(item('same-user', 'skip', { message: '尚未确认微信与 Weport 是否同一 Windows 用户。' }))
  } else if (sameUser) {
    items.push(item('same-user', 'pass', { message: '微信与 Weport 运行在同一个 Windows 用户下。' }))
  } else {
    items.push(item('same-user', 'fail'))
  }

  // 7) 可读进程内存
  const memoryReadable = obs.memoryReadable ?? null
  if (!scanPlatform) {
    items.push(item('memory-readable', 'skip', { message: '当前流程不读取微信进程内存。' }))
  } else if (memoryReadable === null) {
    items.push(item('memory-readable', 'skip', { message: '尚未尝试读取微信进程内存（微信未运行时无法判断）。' }))
  } else if (memoryReadable) {
    items.push(item('memory-readable', 'pass', { message: '可以只读访问微信进程内存（非提权即可）。' }))
  } else {
    items.push(item('memory-readable', 'fail'))
  }

  // 8) 数据目录
  items.push(obs.dataDirConfigured
    ? item('data-dir-selected', 'pass', {
      message: '已选择微信数据目录。',
      detail: obs.dataDir ? `dir=${obs.dataDir}` : undefined,
    })
    : item('data-dir-selected', 'fail'))

  // 9) 库文件存在
  if (!obs.dataDirConfigured) {
    items.push(item('db-files-present', 'skip', { message: '尚未选择数据目录，无法检查数据库文件。' }))
  } else {
    items.push(obs.dbFilesPresent
      ? item('db-files-present', 'pass', { message: '数据库文件已就绪。' })
      : item('db-files-present', 'fail'))
  }

  // 10) 已存密钥是否仍然有效（`null` = 没有已存密钥）
  const storedKeyValid = obs.storedKeyValid ?? null
  if (storedKeyValid === null) {
    items.push(item('stored-key-valid', 'skip', { message: '本机还没有保存过这个账号的密钥。' }))
  } else if (storedKeyValid) {
    items.push(item('stored-key-valid', 'pass', { message: '已保存的密钥与该账号数据库校验通过。' }))
  } else {
    items.push(item('stored-key-valid', 'fail'))
  }

  // 11) 扫描是否命中（只有真的跑过扫描才评价）
  if (!scanPlatform) {
    items.push(item('scan-key-found', 'skip', {
      message: obs.platform === 'win32'
        ? 'V1.2 稳定版暂不执行 Windows 免登录扫描。'
        : '当前系统不做免登录扫描。',
    }))
  } else if (!obs.scanAttempted) {
    items.push(item('scan-key-found', 'skip', { message: '尚未执行免登录扫描。' }))
  } else if (obs.scanKeyFound) {
    items.push(item('scan-key-found', 'pass', { message: '免登录扫描已取到并校验通过该账号的密钥。' }))
  } else {
    items.push(item('scan-key-found', 'warn'))
  }

  // 12) Hook 组件可用性（扫描失败时的兜底是否真的存在）
  const hookAvailable = obs.hookHelperAvailable ?? null
  if (hookAvailable === null) {
    items.push(item('hook-helper-available', 'skip', { message: '尚未检查登录捕获组件。' }))
  } else if (hookAvailable) {
    items.push(item('hook-helper-available', 'pass', { message: '登录捕获组件已就绪。' }))
  } else {
    items.push(item('hook-helper-available', 'fail'))
  }

  // 13) 两条自动路都没成 → 明确给出"手动粘贴"这条兜底（不许只剩一句"失败"）
  if (obs.keyObtained === false) {
    items.push(item('manual-key-available', 'warn'))
  }

  const blocking = items.filter((i) => i.status === 'fail')
  const allSatisfied = blocking.length === 0
  const summary = allSatisfied
    ? '全部条件已满足。'
    : `${blocking.length} 项条件未满足：${blocking.map((i) => i.message.replace(/。$/, '')).join('；')}。`

  return { items, allSatisfied, blocking, summary }
}

/** 便于单测与 UI：列出所有 id。 */
export const PREREQ_IDS: PrereqId[] = Object.keys(PREREQ_MESSAGES) as PrereqId[]
