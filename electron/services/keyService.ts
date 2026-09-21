import { app } from 'electron'
import { join, dirname, basename } from 'path'
import { existsSync, copyFileSync, mkdirSync, readdirSync, statSync } from 'fs'
import { execFile, spawn } from 'child_process'
import { promisify } from 'util'
import os from 'os'
import crypto from 'crypto'
import { stripAccountSuffix } from './weChatLoginOracle'

const execFileAsync = promisify(execFile)

type DbKeyResult = { success: boolean; key?: string; error?: string; logs?: string[] }
type ImageKeyResult = { success: boolean; xorKey?: number; aesKey?: string; verified?: boolean; error?: string; accountDir?: string; tried?: string[] }
type DbKeyPollResult =
  | { status: 'success'; key: string; loginRequiredDetected: boolean }
  | { status: 'process-ended'; loginRequiredDetected: boolean }
  | { status: 'timeout'; loginRequiredDetected: boolean }

/** kvcomm 缓存里的一份账号密钥记录（wx_key.dll!GetImageKey 的 JSON 结构）。 */
export type ImageKeyCacheAccount = {
  wxid?: string
  keys?: Array<{ code?: number; aesKey?: string; xorKey?: number }>
}

/** 上游 `GetImageKey` 的 JSON 载荷。 */
export type ImageKeyCachePayload = { accounts?: ImageKeyCacheAccount[] }

/**
 * 一个 wxid 可能对应的几种写法。
 *
 * issue #20 的核心教训：图像 AES 密钥是 `md5(String(code) + canonicalWxid)` 的前
 * 16 个十六进制字符（本机 400/400 个真实 `*_t.dat` 模板实测）。而 UI 传下来的
 * "wxid" 其实是**磁盘目录名**，可能带微信改号后缀（`wxid_X_64b5`），自定义微信号
 * 还可能是 `别名_4f2a`。三种清洗规则各有盲区，因此这里把「原样 / 去掉改号后缀 /
 * 去下划线段」的写法全部列为候选，由模板校验决定谁是对的 —— 多试几个字符串的
 * 代价是一次 md5，猜错一个字符串的代价是整个功能不可用。
 */
export function canonicalWxidVariants(wxid: string): string[] {
  const variants: string[] = []
  const push = (value: string) => {
    const trimmed = String(value || '').trim()
    if (!trimmed || variants.includes(trimmed)) return
    variants.push(trimmed)
  }

  const raw = String(wxid || '').trim()
  push(raw)
  if (!raw) return variants

  // 微信改号后缀：`wxid_X_64b5` → `wxid_X`（weChatLoginOracle 的权威规则，
  // 已用 `all_users/login/<wxid>` 与 `key_info.db` 的 md5 交叉验证过）。
  push(stripAccountSuffix(raw))
  // `wxid_` 后只取第一段：`wxid_abc_64b5` → `wxid_abc`
  if (raw.toLowerCase().startsWith('wxid_')) {
    const match = raw.match(/^(wxid_[^_]+)/i)
    if (match) push(match[1])
  }
  // 自定义微信号 + 4 位后缀：`alias_4f2a` → `alias`
  const suffixMatch = raw.match(/^(.+)_([a-zA-Z0-9]{4})$/)
  if (suffixMatch) push(suffixMatch[1])

  return variants
}

/**
 * 图像 AES 密钥推导（与 `wx_key.dll` 内部一致，已在本机真实模板上验证）：
 * `md5(String(code) + wxid)` 的前 16 个十六进制字符；XOR 密钥是 `code & 0xFF`。
 */
export function deriveImageKeysForWxid(code: number, wxid: string): { xorKey: number; aesKey: string } {
  const xorKey = code & 0xFF
  const md5Full = crypto.createHash('md5').update(String(code) + String(wxid)).digest('hex')
  return { xorKey, aesKey: md5Full.substring(0, 16) }
}

/** 一个目录看起来像不像微信账号目录（图片模板就在它下面的 msg/attach 里）。 */
export function looksLikeWeChatAccountDir(dir: string): boolean {
  if (!dir) return false
  try {
    if (!statSync(dir).isDirectory()) return false
  } catch {
    return false
  }
  return (
    existsSync(join(dir, 'msg', 'attach')) ||
    existsSync(join(dir, 'db_storage')) ||
    existsSync(join(dir, 'FileStorage', 'Image')) ||
    existsSync(join(dir, 'FileStorage', 'Image2'))
  )
}

export type ImageKeyScope = {
  /** 参与本账号校验的模板目录，最可信的在前。 */
  dirs: string[]
  /** `rootDir` 下所有看起来像账号目录的子目录（用于诊断与兜底）。 */
  allAccountDirs: string[]
  /** 是否成功把范围收敛到某一个账号。 */
  scoped: boolean
}

/**
 * 把「数据目录 + wxid」收敛到一个账号目录。
 *
 * issue #20：`xwechat_files` 根目录下同时存在两个账号时，旧实现把根目录直接丢给
 * 模板扫描，于是 `*_t.dat` 可能来自**另一个账号** —— 拿 A 账号的密文去校验 B 账号
 * 的密钥，永远不可能通过，用户看到的却是"请在微信中打开 2-3 张图片大图"。
 * 模板（以及内存扫描要找的密钥）必须来自被选中的那个账号。
 */
export function resolveAccountImageDirs(rootDir: string, wxid?: string): ImageKeyScope {
  const root = String(rootDir || '').trim().replace(/[\\/]+$/, '')
  if (!root) return { dirs: [], allAccountDirs: [], scoped: false }

  // 用户直接选了账号目录（而不是 xwechat_files 根目录）时无需再收敛。
  if (looksLikeWeChatAccountDir(root)) {
    return { dirs: [root], allAccountDirs: [root], scoped: true }
  }

  let entries: string[] = []
  try {
    entries = readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(root, entry.name))
      .filter((full) => looksLikeWeChatAccountDir(full))
  } catch {
    return { dirs: [], allAccountDirs: [], scoped: false }
  }

  const allAccountDirs = entries
  const requested = String(wxid || '').trim()
  if (!requested) return { dirs: [], allAccountDirs, scoped: false }

  const variants = canonicalWxidVariants(requested).map((value) => value.toLowerCase())
  const nameOf = (full: string) => basename(full).toLowerCase()
  const exact = entries.filter((full) => variants.includes(nameOf(full)))
  const prefixed = entries.filter(
    (full) => !exact.includes(full) && variants.some((variant) => nameOf(full).startsWith(`${variant}_`))
  )
  const dirs = [...exact, ...prefixed]
  return { dirs, allAccountDirs, scoped: dirs.length > 0 }
}

/**
 * 上一次图片密钥提取作用在哪个账号上。
 *
 * `key:autoGetImageKey` 拿得到 wxid，而内存扫描的 IPC 通道（`key:scanImageKeyFromMemory`）
 * 只带目录，不带账号。两条通道都在主进程里，因此在这里记住上一次请求，内存扫描
 * 就能沿用同一个账号的模板 —— 这正是 issue #20 里"两个账号同机，其中一台上限超时"
 * 的根因：扫描用的密文与内存里那份密钥不属于同一个账号。
 */
let lastImageKeyAccount: { requested?: string; dirs: string[] } | null = null

/** 仅测试/诊断用：读取上一次记录。 */
export function getLastImageKeyAccount(): { requested?: string; dirs: string[] } | null {
  return lastImageKeyAccount
}

/** 与图片模板无关的候选 wxid 列表：只包含"当前请求这个账号"的几种写法。
 *
 * issue #20：旧实现在这里塞进了根目录下**所有**账号的目录名，于是校验循环可能
 * 拿另一个账号的密钥通过校验，然后按当前账号保存 —— 用户拿到一把属于别人的密钥。
 * 账号归属只能来自「选中的账号」和「收敛出来的账号目录」，不能来自"根目录下还有谁"。
 */
export function buildWxidCandidates(scopeDirs: string[], wxidParam?: string, rootDir?: string): string[] {
  const candidates: string[] = []
  const pushUnique = (value: string) => {
    const trimmed = String(value || '').trim()
    if (!trimmed || candidates.includes(trimmed)) return
    candidates.push(trimmed)
  }

  for (const variant of canonicalWxidVariants(String(wxidParam || ''))) pushUnique(variant)
  for (const dir of scopeDirs) {
    const name = basename(dir)
    pushUnique(name)
    for (const variant of canonicalWxidVariants(name)) pushUnique(variant)
  }
  // 选中的目录本身就是账号目录时，目录名就是账号名。
  if (rootDir && looksLikeWeChatAccountDir(String(rootDir))) {
    const name = basename(String(rootDir).replace(/[\\/]+$/, ''))
    pushUnique(name)
    for (const variant of canonicalWxidVariants(name)) pushUnique(variant)
  }

  return candidates
}

/** 用 AES-128-ECB 解出的前几字节是不是图片魔数（JPEG/PNG/RIFF/WXGF/GIF）。 */
export function verifyDerivedAesKey(aesKey: string, ciphertext: Buffer): boolean {
  try {
    if (!aesKey || aesKey.length < 16 || ciphertext.length !== 16) return false
    const decipher = crypto.createDecipheriv('aes-128-ecb', Buffer.from(aesKey, 'ascii').subarray(0, 16), null)
    decipher.setAutoPadding(false)
    const dec = Buffer.concat([decipher.update(ciphertext), decipher.final()])
    if (dec[0] === 0xFF && dec[1] === 0xD8 && dec[2] === 0xFF) return true
    if (dec[0] === 0x89 && dec[1] === 0x50 && dec[2] === 0x4E && dec[3] === 0x47) return true
    if (dec[0] === 0x52 && dec[1] === 0x49 && dec[2] === 0x46 && dec[3] === 0x46) return true
    if (dec[0] === 0x77 && dec[1] === 0x78 && dec[2] === 0x67 && dec[3] === 0x66) return true
    if (dec[0] === 0x47 && dec[1] === 0x49 && dec[2] === 0x46) return true
    return false
  } catch {
    return false
  }
}

export type ImageKeySelectionInput = {
  payload: ImageKeyCachePayload
  scope: ImageKeyScope
  rootDir?: string
  wxidParam?: string
  templates: { ciphertexts: Buffer[]; files: string[]; dirs: string[] }
  onProgress?: (message: string) => void
}

/**
 * 用「本账号自己的模板」校验并筛出唯一可用的图片密钥。
 *
 * 纯函数（不碰 DLL、不碰进程），因此可以被单元测试直接调用 —— issue #20 的回归
 * 测试就是拿两个账号的合成目录跑这里，断言 B 账号不会拿到 A 账号的密钥。
 *
 * 三条硬规则：
 * 1. 候选 wxid 只来自本账号（见 {@link buildWxidCandidates}），不来自"根目录下还有谁"；
 * 2. 校验密文只来自本账号目录（调用方负责收敛，见 {@link resolveAccountImageDirs}）；
 * 3. 一次都没通过就别假装成功，并说清"试了什么、下一步做什么"。
 */
export function selectVerifiedImageKey(options: ImageKeySelectionInput): ImageKeyResult {
  const { payload, scope, rootDir, wxidParam, templates, onProgress } = options
  const accounts = Array.isArray(payload.accounts) ? payload.accounts : []
  const keyEntries = accounts
    .flatMap((account) => (account.keys || []).map((key) => ({ wxid: String(account.wxid || ''), key })))
    .filter((entry) => Number.isFinite(Number(entry.key?.code)))

  if (keyEntries.length === 0) {
    return {
      success: false,
      tried: ['读取微信 kvcomm 缓存（key_<code>_*.statistic）'],
      error: '微信 kvcomm 缓存里没有可用的图片密钥码（缺少 key_<code>_*.statistic 文件）。'
        + '下一步：启动并登录微信，在任意聊天里打开 2-3 张图片后重试；'
        + '若微信刚安装或刚清过缓存，需要先在微信里收发/查看过图片才会生成密钥码'
    }
  }

  const triedAccountNames = (scope.scoped ? scope.dirs : []).map((dir) => basename(dir))
  const accountHint = triedAccountNames.length
    ? `账号目录 ${triedAccountNames.join(' / ')}`
    : (wxidParam ? `账号 ${wxidParam}` : '当前账号')

  if (templates.ciphertexts.length === 0) {
    const scanned = templates.dirs.length ? templates.dirs.join(' / ') : (rootDir ? String(rootDir) : '(未提供数据目录)')
    return {
      success: false,
      tried: [accountHint, `模板扫描目录：${scanned}`],
      error: `在${accountHint}的图片缓存目录里没有找到可用于校验的模板文件（*_t.dat）；已扫描：${scanned}。`
        + `下一步：用这个账号在微信里打开 2-3 张图片大图（缩略图要真实生成过），再点一次「获取图片密钥」；`
        + `若目录不对，请在连接页重新选择该账号的 xwechat_files 根目录`
    }
  }

  // codes 的归属：优先与当前账号匹配的条目；没有匹配则退回全部条目（code 来自
  // kvcomm，与账号无强绑定，多试几个 code 的成本只有几次 md5，校验会兜住错配）。
  const candidates = buildWxidCandidates(scope.scoped ? scope.dirs : scope.allAccountDirs, wxidParam, rootDir)
  if (candidates.length === 0) candidates.push('unknown')

  const matchedEntries = keyEntries.filter((entry) => candidates.some(
    (candidate) => candidate.toLowerCase() === entry.wxid.toLowerCase()
  ))
  const orderedEntries = [...matchedEntries, ...keyEntries.filter((entry) => !matchedEntries.includes(entry))]
  const codes: number[] = []
  for (const entry of orderedEntries) {
    const code = Number(entry.key?.code)
    if (!codes.includes(code)) codes.push(code)
  }

  onProgress?.(`正在用 ${templates.ciphertexts.length} 个模板校验 ${codes.length} 个密钥码（${accountHint}）...`)
  let attempts = 0
  for (const candidateWxid of candidates) {
    for (const code of codes) {
      const { xorKey, aesKey } = deriveImageKeysForWxid(code, candidateWxid)
      for (const ciphertext of templates.ciphertexts) {
        attempts++
        if (!verifyDerivedAesKey(aesKey, ciphertext)) continue
        onProgress?.(`密钥获取成功（wxid: ${candidateWxid}, code: ${code}）`)
        console.log('[ImageKey] 校验命中: wxid=', candidateWxid, 'code=', code, 'dirs=', templates.dirs)
        return { success: true, xorKey, aesKey, verified: true, accountDir: templates.dirs[0] }
      }
    }
  }

  const scanned = templates.dirs.length ? templates.dirs.join(' / ') : String(rootDir || '')
  return {
    success: false,
    tried: [accountHint, `模板 ${templates.ciphertexts.length} 个（${scanned}）`, `候选 wxid ${candidates.length} 个`, `code ${codes.length} 个`, `共 ${attempts} 次校验`],
    error: `kvcomm 里的密钥码与${accountHint}对不上：用该账号目录下的 ${templates.ciphertexts.length} 个图片模板`
      + `（${scanned}）校验了 ${candidates.length} 个候选 wxid × ${codes.length} 个 code，全部失败。`
      + `常见原因：微信当前登录的不是这个账号（两个账号同机时最容易发生）；或这个账号还没有本地图片缓存。`
      + `下一步：切到目标账号并重新登录微信 → 用该账号打开 2-3 张聊天图片大图 → 回到 Weport 重新点「获取图片密钥」`
  }
}

export class KeyService {
  private readonly isMac = process.platform === 'darwin'
  private koffi: any = null
  private lib: any = null
  private initialized = false
  private initHook: any = null
  private pollKeyData: any = null
  private getStatusMessage: any = null
  private cleanupHook: any = null
  private getLastErrorMsg: any = null
  private getImageKeyDll: any = null

  // Win32 APIs
  private kernel32: any = null
  private user32: any = null
  private advapi32: any = null

  // Kernel32
  private OpenProcess: any = null
  private CloseHandle: any = null
  private TerminateProcess: any = null
  private QueryFullProcessImageNameW: any = null

  // User32
  private EnumWindows: any = null
  private GetWindowTextW: any = null
  private GetWindowTextLengthW: any = null
  private GetClassNameW: any = null
  private GetWindowThreadProcessId: any = null
  private IsWindowVisible: any = null
  private EnumChildWindows: any = null
  private PostMessageW: any = null
  private WNDENUMPROC_PTR: any = null

  // Advapi32
  private RegOpenKeyExW: any = null
  private RegQueryValueExW: any = null
  private RegCloseKey: any = null

  // Constants
  private readonly PROCESS_ALL_ACCESS = 0x1F0FFF
  private readonly PROCESS_TERMINATE = 0x0001
  private readonly KEY_READ = 0x20019
  private readonly HKEY_LOCAL_MACHINE = 0x80000002
  private readonly HKEY_CURRENT_USER = 0x80000001
  private readonly ERROR_SUCCESS = 0
  private readonly WM_CLOSE = 0x0010
  private readonly DB_KEY_PROCESS_CHECK_INTERVAL_MS = 1000

  private getDllPath(): string {
    const isPackaged = typeof app !== 'undefined' && app ? app.isPackaged : process.env.NODE_ENV === 'production'
    const archDir = process.arch === 'arm64' ? 'arm64' : 'x64'
    const candidates: string[] = []

    if (process.env.WX_KEY_DLL_PATH) {
      candidates.push(process.env.WX_KEY_DLL_PATH)
    }

    if (isPackaged) {
      candidates.push(join(process.resourcesPath, 'resources', 'key', 'win32', archDir, 'wx_key.dll'))
      candidates.push(join(process.resourcesPath, 'resources', 'key', 'win32', 'x64', 'wx_key.dll'))
      candidates.push(join(process.resourcesPath, 'resources', 'key', 'win32', 'wx_key.dll'))
      candidates.push(join(process.resourcesPath, 'resources', 'wx_key.dll'))
      candidates.push(join(process.resourcesPath, 'wx_key.dll'))
    } else {
      const cwd = process.cwd()
      candidates.push(join(cwd, 'resources', 'key', 'win32', archDir, 'wx_key.dll'))
      candidates.push(join(cwd, 'resources', 'key', 'win32', 'x64', 'wx_key.dll'))
      candidates.push(join(cwd, 'resources', 'key', 'win32', 'wx_key.dll'))
      candidates.push(join(cwd, 'resources', 'wx_key.dll'))
      candidates.push(join(app.getAppPath(), 'resources', 'key', 'win32', archDir, 'wx_key.dll'))
      candidates.push(join(app.getAppPath(), 'resources', 'key', 'win32', 'x64', 'wx_key.dll'))
      candidates.push(join(app.getAppPath(), 'resources', 'key', 'win32', 'wx_key.dll'))
      candidates.push(join(app.getAppPath(), 'resources', 'wx_key.dll'))
    }

    for (const path of candidates) {
      if (existsSync(path)) return path
    }

    return candidates[0]
  }

  private isNetworkPath(path: string): boolean {
    if (path.startsWith('\\\\')) return true
    return false
  }

  private localizeNetworkDll(originalPath: string): string {
    try {
      const tempDir = join(os.tmpdir(), 'weflow_dll_cache')
      if (!existsSync(tempDir)) {
        mkdirSync(tempDir, { recursive: true })
      }
      const localPath = join(tempDir, 'wx_key.dll')
      if (existsSync(localPath)) return localPath

      copyFileSync(originalPath, localPath)
      return localPath
    } catch (e) {
      console.error('DLL 本地化失败:', e)
      return originalPath
    }
  }

  private ensureLoaded(): boolean {
    if (this.initialized) return true

    let dllPath = ''
    try {
      this.koffi = require('koffi')
      dllPath = this.getDllPath()

      if (!existsSync(dllPath)) {
        console.error(`wx_key.dll 不存在于路径: ${dllPath}`)
        return false
      }

      if (this.isNetworkPath(dllPath)) {
        dllPath = this.localizeNetworkDll(dllPath)
      }

      this.lib = this.koffi.load(dllPath)
      this.initHook = this.lib.func('bool InitializeHook(uint32 targetPid)')
      this.pollKeyData = this.lib.func('bool PollKeyData(_Out_ char *keyBuffer, int bufferSize)')
      this.getStatusMessage = this.lib.func('bool GetStatusMessage(_Out_ char *msgBuffer, int bufferSize, _Out_ int *outLevel)')
      this.cleanupHook = this.lib.func('bool CleanupHook()')
      this.getLastErrorMsg = this.lib.func('const char* GetLastErrorMsg()')
      this.getImageKeyDll = this.lib.func('bool GetImageKey(_Out_ char *resultBuffer, int bufferSize)')

      this.initialized = true
      return true
    } catch (e) {
      const errorMsg = e instanceof Error ? e.message : String(e)
      console.error(`加载 wx_key.dll 失败\n  路径: ${dllPath}\n  错误: ${errorMsg}`)
      return false
    }
  }

  private ensureWin32(): boolean {
    return process.platform === 'win32'
  }

  private ensureKernel32(): boolean {
    if (this.kernel32) return true
    try {
      this.koffi = require('koffi')
      this.kernel32 = this.koffi.load('kernel32.dll')
      this.OpenProcess = this.kernel32.func('OpenProcess', 'void*', ['uint32', 'bool', 'uint32'])
      this.CloseHandle = this.kernel32.func('CloseHandle', 'bool', ['void*'])
      this.TerminateProcess = this.kernel32.func('TerminateProcess', 'bool', ['void*', 'uint32'])
      this.QueryFullProcessImageNameW = this.kernel32.func('QueryFullProcessImageNameW', 'bool', ['void*', 'uint32', this.koffi.out('uint16*'), this.koffi.out('uint32*')])

      return true
    } catch (e) {
      console.error('初始化 kernel32 失败:', e)
      return false
    }
  }

  private decodeUtf8(buf: Buffer): string {
    const nullIdx = buf.indexOf(0)
    return buf.toString('utf8', 0, nullIdx > -1 ? nullIdx : undefined).trim()
  }

  private ensureUser32(): boolean {
    if (this.user32) return true
    try {
      this.koffi = require('koffi')
      this.user32 = this.koffi.load('user32.dll')

      const WNDENUMPROC = this.koffi.proto('bool __stdcall (void *hWnd, intptr_t lParam)')
      this.WNDENUMPROC_PTR = this.koffi.pointer(WNDENUMPROC)

      this.EnumWindows = this.user32.func('EnumWindows', 'bool', [this.WNDENUMPROC_PTR, 'intptr_t'])
      this.EnumChildWindows = this.user32.func('EnumChildWindows', 'bool', ['void*', this.WNDENUMPROC_PTR, 'intptr_t'])
      this.PostMessageW = this.user32.func('PostMessageW', 'bool', ['void*', 'uint32', 'uintptr_t', 'intptr_t'])
      this.GetWindowTextW = this.user32.func('GetWindowTextW', 'int', ['void*', this.koffi.out('uint16*'), 'int'])
      this.GetWindowTextLengthW = this.user32.func('GetWindowTextLengthW', 'int', ['void*'])
      this.GetClassNameW = this.user32.func('GetClassNameW', 'int', ['void*', this.koffi.out('uint16*'), 'int'])
      this.GetWindowThreadProcessId = this.user32.func('GetWindowThreadProcessId', 'uint32', ['void*', this.koffi.out('uint32*')])
      this.IsWindowVisible = this.user32.func('IsWindowVisible', 'bool', ['void*'])

      return true
    } catch (e) {
      console.error('初始化 user32 失败:', e)
      return false
    }
  }

  private ensureAdvapi32(): boolean {
    if (this.advapi32) return true
    try {
      this.koffi = require('koffi')
      this.advapi32 = this.koffi.load('advapi32.dll')

      const HKEY = this.koffi.alias('HKEY', 'intptr_t')
      const HKEY_PTR = this.koffi.pointer(HKEY)

      this.RegOpenKeyExW = this.advapi32.func('RegOpenKeyExW', 'long', [HKEY, 'uint16*', 'uint32', 'uint32', this.koffi.out(HKEY_PTR)])
      this.RegQueryValueExW = this.advapi32.func('RegQueryValueExW', 'long', [HKEY, 'uint16*', 'uint32*', this.koffi.out('uint32*'), this.koffi.out('uint8*'), this.koffi.out('uint32*')])
      this.RegCloseKey = this.advapi32.func('RegCloseKey', 'long', [HKEY])

      return true
    } catch (e) {
      console.error('初始化 advapi32 失败:', e)
      return false
    }
  }

  private decodeCString(ptr: any): string {
    try {
      if (typeof ptr === 'string') return ptr
      return this.koffi.decode(ptr, 'char', -1)
    } catch {
      return ''
    }
  }

  // --- WeChat Process & Path Finding ---

  private readRegistryString(rootKey: number, subKey: string, valueName: string): string | null {
    if (!this.ensureAdvapi32()) return null
    const subKeyBuf = Buffer.from(subKey + '\0', 'ucs2')
    const valueNameBuf = valueName ? Buffer.from(valueName + '\0', 'ucs2') : null
    const phkResult = Buffer.alloc(8)

    if (this.RegOpenKeyExW(rootKey, subKeyBuf, 0, this.KEY_READ, phkResult) !== this.ERROR_SUCCESS) return null

    const hKey = this.koffi.decode(phkResult, 'uintptr_t')

    try {
      const lpcbData = Buffer.alloc(4)
      lpcbData.writeUInt32LE(0, 0)

      let ret = this.RegQueryValueExW(hKey, valueNameBuf, null, null, null, lpcbData)
      if (ret !== this.ERROR_SUCCESS) return null

      const size = lpcbData.readUInt32LE(0)
      if (size === 0) return null

      const dataBuf = Buffer.alloc(size)
      ret = this.RegQueryValueExW(hKey, valueNameBuf, null, null, dataBuf, lpcbData)
      if (ret !== this.ERROR_SUCCESS) return null

      let str = dataBuf.toString('ucs2')
      if (str.endsWith('\0')) str = str.slice(0, -1)
      return str
    } finally {
      this.RegCloseKey(hKey)
    }
  }

  private async getProcessExecutablePath(pid: number): Promise<string | null> {
    if (!this.ensureKernel32()) return null
    const hProcess = this.OpenProcess(0x1000, false, pid)
    if (!hProcess) return null

    try {
      const sizeBuf = Buffer.alloc(4)
      sizeBuf.writeUInt32LE(1024, 0)
      const pathBuf = Buffer.alloc(1024 * 2)

      const ret = this.QueryFullProcessImageNameW(hProcess, 0, pathBuf, sizeBuf)
      if (ret) {
        const len = sizeBuf.readUInt32LE(0)
        return pathBuf.toString('ucs2', 0, len * 2)
      }
      return null
    } catch (e) {
      console.error('获取进程路径失败:', e)
      return null
    } finally {
      this.CloseHandle(hProcess)
    }
  }

  private async findWeChatInstallPath(): Promise<string | null> {
    try {
      const pid = await this.findWeChatPid()
      if (pid) {
        const runPath = await this.getProcessExecutablePath(pid)
        if (runPath && existsSync(runPath)) return runPath
      }
    } catch (e) {
      console.error('尝试获取运行中微信路径失败:', e)
    }

    const uninstallKeys = [
      'SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
      'SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall'
    ]
    const roots = [this.HKEY_LOCAL_MACHINE, this.HKEY_CURRENT_USER]
    const tencentKeys = [
      'Software\\Tencent\\WeChat',
      'Software\\WOW6432Node\\Tencent\\WeChat',
      'Software\\Tencent\\Weixin',
    ]

    for (const root of roots) {
      for (const key of tencentKeys) {
        const path = this.readRegistryString(root, key, 'InstallPath')
        if (path && existsSync(join(path, 'Weixin.exe'))) return join(path, 'Weixin.exe')
        if (path && existsSync(join(path, 'WeChat.exe'))) return join(path, 'WeChat.exe')
      }
    }

    for (const root of roots) {
      for (const parent of uninstallKeys) {
        const path = this.readRegistryString(root, parent + '\\WeChat', 'InstallLocation')
        if (path && existsSync(join(path, 'Weixin.exe'))) return join(path, 'Weixin.exe')
      }
    }

    const drives = ['C', 'D', 'E', 'F']
    const commonPaths = [
      'Program Files\\Tencent\\WeChat\\WeChat.exe',
      'Program Files (x86)\\Tencent\\WeChat\\WeChat.exe',
      'Program Files\\Tencent\\Weixin\\Weixin.exe',
      'Program Files (x86)\\Tencent\\Weixin\\Weixin.exe'
    ]

    for (const drive of drives) {
      for (const p of commonPaths) {
        const full = join(drive + ':\\', p)
        if (existsSync(full)) return full
      }
    }

    return null
  }

  private async findPidsByImageName(imageName: string): Promise<number[]> {
    try {
      const { stdout } = await execFileAsync('tasklist', ['/FI', `IMAGENAME eq ${imageName}`, '/FO', 'CSV', '/NH'])
      const lines = stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
      const pids: number[] = []
      for (const line of lines) {
        if (line.startsWith('INFO:')) continue
        const parts = line.split('","').map((p) => p.replace(/^"|"$/g, ''))
        if (parts[0]?.toLowerCase() === imageName.toLowerCase()) {
          const pid = Number(parts[1])
          if (!Number.isNaN(pid)) pids.push(pid)
        }
      }
      return pids
    } catch (e) {
      return []
    }
  }

  private async findWeChatPids(): Promise<number[]> {
    const pids: number[] = []
    const pushUnique = (pid: number | null | undefined) => {
      if (!pid || pids.includes(pid)) return
      pids.push(pid)
    }

    for (const name of ['Weixin.exe', 'WeChat.exe']) {
      const found = await this.findPidsByImageName(name)
      found.forEach(pushUnique)
    }
    return pids
  }

  private async isWeChatPidActive(pid: number): Promise<boolean> {
    const pids = await this.findWeChatPids()
    if (pids.includes(pid)) return true

    const fallbackPid = await this.waitForWeChatWindow(250)
    return fallbackPid === pid
  }

  private async waitForWeChatPid(timeoutMs: number): Promise<number | null> {
    const start = Date.now()
    while (Date.now() - start < timeoutMs) {
      const pids = await this.findWeChatPids()
      if (pids.length > 0) return pids[0]

      const fallbackPid = await this.waitForWeChatWindow(250)
      if (fallbackPid) return fallbackPid

      await new Promise(r => setTimeout(r, 500))
    }
    return null
  }

  private getRemainingMs(deadline: number): number {
    return Math.max(0, deadline - Date.now())
  }

  private async pollDbKeyFromHook(
      pid: number,
      deadline: number,
      logs: string[],
      onStatus?: (message: string, level: number) => void
  ): Promise<DbKeyPollResult> {
    const keyBuffer = Buffer.alloc(128)
    let loginRequiredDetected = false
    let nextProcessCheckAt = 0

    while (Date.now() < deadline) {
      const now = Date.now()
      if (now >= nextProcessCheckAt) {
        nextProcessCheckAt = now + this.DB_KEY_PROCESS_CHECK_INTERVAL_MS
        if (!await this.isWeChatPidActive(pid)) {
          return { status: 'process-ended', loginRequiredDetected }
        }
      }

      if (this.pollKeyData(keyBuffer, keyBuffer.length)) {
        const key = this.decodeUtf8(keyBuffer)
        if (key.length === 64) {
          onStatus?.('密钥获取成功', 1)
          return { status: 'success', key, loginRequiredDetected }
        }
      }

      for (let i = 0; i < 5; i++) {
        const statusBuffer = Buffer.alloc(256)
        const levelOut = [0]
        if (!this.getStatusMessage(statusBuffer, statusBuffer.length, levelOut)) break
        const msg = this.decodeUtf8(statusBuffer)
        const level = levelOut[0] ?? 0
        if (msg) {
          logs.push(msg)
          if (this.isLoginRelatedText(msg)) {
            loginRequiredDetected = true
          }
          onStatus?.(msg, level)
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 120))
    }

    return { status: 'timeout', loginRequiredDetected }
  }

  private cleanupDbKeyHook(): void {
    try {
      this.cleanupHook()
    } catch { }
  }

  private buildInitHookError(): string {
    const error = this.getLastErrorMsg ? this.decodeCString(this.getLastErrorMsg()) : ''
    if (error) {
      if (error.includes('0xC0000022') || error.includes('ACCESS_DENIED') || error.includes('打开目标进程失败')) {
        return '权限不足：无法访问微信进程。\n\n解决方法：\n1. 右键 Weport 图标，选择"以管理员身份运行"\n2. 关闭可能拦截的安全软件（如360、火绒等）\n3. 确保微信没有以管理员权限运行'
      }
      return error
    }

    const statusBuffer = Buffer.alloc(256)
    const levelOut = [0]
    const status = this.getStatusMessage && this.getStatusMessage(statusBuffer, statusBuffer.length, levelOut)
        ? this.decodeUtf8(statusBuffer)
        : ''
    return status || '初始化失败'
  }

  private async waitForNextDbKeyPid(deadline: number, onStatus?: (message: string, level: number) => void): Promise<number | null> {
    while (this.getRemainingMs(deadline) > 0) {
      onStatus?.('正在查找微信进程...', 0)
      const pid = await this.waitForWeChatPid(Math.min(this.getRemainingMs(deadline), 30_000))
      if (pid) return pid
    }
    return null
  }

  private shouldRetryAfterProcessLost(deadline: number): boolean {
    return this.getRemainingMs(deadline) > 1000
  }

  private async delayBeforeRetry(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 500))
  }

  private async waitForProcessRestart(deadline: number, onStatus?: (message: string, level: number) => void): Promise<number | null> {
    if (!this.shouldRetryAfterProcessLost(deadline)) return null
    onStatus?.('检测到微信已退出，已清理 Hook，等待重新打开微信...', 0)
    await this.delayBeforeRetry()
    return this.waitForNextDbKeyPid(deadline, onStatus)
  }

  private async detectLoginRequiredForLastPid(pid: number | null, loginRequiredDetected: boolean): Promise<boolean> {
    if (loginRequiredDetected) return true
    if (!pid) return false
    if (!await this.isWeChatPidActive(pid)) return false
    return await this.detectWeChatLoginRequired(pid)
  }

  private async findWeChatPid(): Promise<number | null> {
    const pids = await this.findWeChatPids()
    if (pids.length > 0) return pids[0]
    const fallbackPid = await this.waitForWeChatWindow(5000)
    return fallbackPid ?? null
  }

  private async waitForWeChatExit(timeoutMs = 8000): Promise<boolean> {
    const start = Date.now()
    while (Date.now() - start < timeoutMs) {
      const runningPids = await this.findWeChatPids()
      if (runningPids.length === 0) return true
      await new Promise(r => setTimeout(r, 400))
    }
    return false
  }

  private async closeWeChatWindows(): Promise<boolean> {
    if (!this.ensureUser32()) return false
    let requested = false

    // 注意：koffi.register 的回调从原生代码（EnumWindows 等）调用，JS 异常无法
    // 穿越 FFI 边界，未捕获会直接终止进程（表现为闪退）。回调体内一律 try/catch。
    const enumWindowsCallback = this.koffi.register((hWnd: any, lParam: any) => {
      try {
        if (!this.IsWindowVisible(hWnd)) return true
        const title = this.getWindowTitle(hWnd)
        const className = this.getClassName(hWnd)
        const classLower = (className || '').toLowerCase()
        const isWeChatWindow = this.isWeChatWindowTitle(title) || classLower.includes('wechat') || classLower.includes('weixin')
        if (!isWeChatWindow) return true

        requested = true
        try {
          this.PostMessageW?.(hWnd, this.WM_CLOSE, 0, 0)
        } catch { }
        return true
      } catch {
        return true
      }
    }, this.WNDENUMPROC_PTR)

    try {
      this.EnumWindows(enumWindowsCallback, 0)
    } finally {
      this.koffi.unregister(enumWindowsCallback)
    }

    return requested
  }

  private async killWeChatProcesses(): Promise<boolean> {
    const requested = await this.closeWeChatWindows()
    if (requested) {
      const gracefulOk = await this.waitForWeChatExit(1500)
      if (gracefulOk) return true
    }

    try {
      await execFileAsync('taskkill', ['/F', '/T', '/IM', 'Weixin.exe'])
      await execFileAsync('taskkill', ['/F', '/T', '/IM', 'WeChat.exe'])
    } catch (e) { }

    return await this.waitForWeChatExit(5000)
  }

  // --- Window Detection ---

  private getWindowTitle(hWnd: any): string {
    const len = this.GetWindowTextLengthW(hWnd)
    if (len === 0) return ''
    const buf = Buffer.alloc((len + 1) * 2)
    this.GetWindowTextW(hWnd, buf, len + 1)
    return buf.toString('ucs2', 0, len * 2)
  }

  private getClassName(hWnd: any): string {
    const buf = Buffer.alloc(512)
    const len = this.GetClassNameW(hWnd, buf, 256)
    return buf.toString('ucs2', 0, len * 2)
  }

  private isWeChatWindowTitle(title: string): boolean {
    const normalized = title.trim()
    if (!normalized) return false
    const lower = normalized.toLowerCase()
    return normalized === '微信' || lower === 'wechat' || lower === 'weixin'
  }

  private async waitForWeChatWindow(timeoutMs = 25000): Promise<number | null> {
    if (!this.ensureUser32()) return null
    const startTime = Date.now()
    while (Date.now() - startTime < timeoutMs) {
      let foundPid: number | null = null

      const enumWindowsCallback = this.koffi.register((hWnd: any, lParam: any) => {
        try {
          if (!this.IsWindowVisible(hWnd)) return true
          const title = this.getWindowTitle(hWnd)
          if (!this.isWeChatWindowTitle(title)) return true

          const pidBuf = Buffer.alloc(4)
          this.GetWindowThreadProcessId(hWnd, pidBuf)
          const pid = pidBuf.readUInt32LE(0)
          if (pid) {
            foundPid = pid
            return false
          }
          return true
        } catch {
          return true
        }
      }, this.WNDENUMPROC_PTR)

      try {
        this.EnumWindows(enumWindowsCallback, 0)
      } finally {
        this.koffi.unregister(enumWindowsCallback)
      }

      if (foundPid) return foundPid
      await new Promise(r => setTimeout(r, 500))
    }
    return null
  }

  private collectChildWindowInfos(parent: any): Array<{ title: string; className: string }> {
    const children: Array<{ title: string; className: string }> = []
    const enumChildCallback = this.koffi.register((hChild: any, lp: any) => {
      try {
        const title = this.getWindowTitle(hChild).trim()
        const className = this.getClassName(hChild).trim()
        children.push({ title, className })
        return true
      } catch {
        return true
      }
    }, this.WNDENUMPROC_PTR)
    try {
      this.EnumChildWindows(parent, enumChildCallback, 0)
    } finally {
      this.koffi.unregister(enumChildCallback)
    }
    return children
  }

  private hasReadyComponents(children: Array<{ title: string; className: string }>): boolean {
    if (children.length === 0) return false

    const readyTexts = ['聊天', '登录', '账号']
    const readyClassMarkers = ['WeChat', 'Weixin', 'TXGuiFoundation', 'Qt5', 'ChatList', 'MainWnd', 'BrowserWnd', 'ListView']
    const readyChildCountThreshold = 14

    let classMatchCount = 0
    let titleMatchCount = 0
    let hasValidClassName = false

    for (const child of children) {
      const normalizedTitle = child.title.replace(/\s+/g, '')
      if (normalizedTitle) {
        if (readyTexts.some(marker => normalizedTitle.includes(marker))) return true
        titleMatchCount += 1
      }
      const className = child.className
      if (className) {
        if (readyClassMarkers.some(marker => className.includes(marker))) return true
        if (className.length > 5) {
          classMatchCount += 1
          hasValidClassName = true
        }
      }
    }

    if (classMatchCount >= 3 || titleMatchCount >= 2) return true
    if (children.length >= readyChildCountThreshold) return true
    if (hasValidClassName && children.length >= 5) return true
    return false
  }

  private isLoginRelatedText(value: string): boolean {
    const normalized = String(value || '').replace(/\s+/g, '').toLowerCase()
    if (!normalized) return false
    const keywords = [
      '登录',
      '扫码',
      '二维码',
      '请在手机上确认',
      '手机确认',
      '切换账号',
      'wechatlogin',
      'qrcode',
      'scan'
    ]
    return keywords.some((keyword) => normalized.includes(keyword))
  }

  private async detectWeChatLoginRequired(pid: number): Promise<boolean> {
    if (!this.ensureUser32()) return false
    let loginRequired = false

    const enumWindowsCallback = this.koffi.register((hWnd: any, _lParam: any) => {
      try {
        if (!this.IsWindowVisible(hWnd)) return true
        const title = this.getWindowTitle(hWnd)
        if (!this.isWeChatWindowTitle(title)) return true

        const pidBuf = Buffer.alloc(4)
        this.GetWindowThreadProcessId(hWnd, pidBuf)
        const windowPid = pidBuf.readUInt32LE(0)
        if (windowPid !== pid) return true

        if (this.isLoginRelatedText(title)) {
          loginRequired = true
          return false
        }

        const children = this.collectChildWindowInfos(hWnd)
        for (const child of children) {
          if (this.isLoginRelatedText(child.title) || this.isLoginRelatedText(child.className)) {
            loginRequired = true
            return false
          }
        }
        return true
      } catch {
        return true
      }
    }, this.WNDENUMPROC_PTR)

    try {
      this.EnumWindows(enumWindowsCallback, 0)
    } finally {
      this.koffi.unregister(enumWindowsCallback)
    }

    return loginRequired
  }

  private async waitForWeChatWindowComponents(pid: number, timeoutMs = 15000): Promise<boolean> {
    if (!this.ensureUser32()) return true
    const startTime = Date.now()
    while (Date.now() - startTime < timeoutMs) {
      let ready = false
      const enumWindowsCallback = this.koffi.register((hWnd: any, lParam: any) => {
        try {
          if (!this.IsWindowVisible(hWnd)) return true
          const title = this.getWindowTitle(hWnd)
          if (!this.isWeChatWindowTitle(title)) return true

          const pidBuf = Buffer.alloc(4)
          this.GetWindowThreadProcessId(hWnd, pidBuf)
          const windowPid = pidBuf.readUInt32LE(0)
          if (windowPid !== pid) return true

          const children = this.collectChildWindowInfos(hWnd)
          if (this.hasReadyComponents(children)) {
            ready = true
            return false
          }
          return true
        } catch {
          return true
        }
      }, this.WNDENUMPROC_PTR)

      try {
        this.EnumWindows(enumWindowsCallback, 0)
      } finally {
        this.koffi.unregister(enumWindowsCallback)
      }

      if (ready) return true
      await new Promise(r => setTimeout(r, 500))
    }
    return true
  }

  // --- DB Key Logic (core hook/poll flow unchanged) ---

  async autoGetDbKey(
      timeoutMs = 60_000,
      onStatus?: (message: string, level: number) => void
  ): Promise<DbKeyResult> {
    if (!this.ensureWin32()) return { success: false, error: '仅支持 Windows' }
    if (!this.ensureLoaded()) return { success: false, error: 'wx_key.dll 未加载' }
    if (!this.ensureKernel32()) return { success: false, error: 'Kernel32 Init Failed' }

    const logs: string[] = []
    const deadline = Date.now() + timeoutMs
    onStatus?.('正在查找微信进程...', 0)
    let pid = await this.findWeChatPid()
    if (!pid) {
      const err = '未找到微信进程，请先启动微信'
      onStatus?.(err, 2)
      return { success: false, error: err }
    }
    let lastAttemptLoginRequiredDetected = false

    while (pid && this.getRemainingMs(deadline) > 0) {
      onStatus?.(`检测到微信窗口 (PID: ${pid})，正在获取...`, 0)
      onStatus?.('正在检测微信界面组件...', 0)
      await this.waitForWeChatWindowComponents(pid, Math.min(15000, this.getRemainingMs(deadline)))

      if (!await this.isWeChatPidActive(pid)) {
        pid = await this.waitForProcessRestart(deadline, onStatus)
        continue
      }

      // initHook 调用原生 wx_key.dll：koffi 层的 JS 级异常也要走结构化错误返回，
      // 否则 renderer 只会看到泛化的 handler 错误文本，丢失日志与友好提示。
      let ok = false
      try {
        ok = this.initHook(pid)
      } catch (e) {
        try { this.cleanupDbKeyHook() } catch { /* ignore */ }
        return { success: false, error: `初始化 Hook 异常: ${e instanceof Error ? e.message : String(e)}`, logs }
      }
      if (!ok) {
        if (!await this.isWeChatPidActive(pid)) {
          this.cleanupDbKeyHook()
          pid = await this.waitForProcessRestart(deadline, onStatus)
          continue
        }
        return { success: false, error: this.buildInitHookError(), logs }
      }

      let pollResult: DbKeyPollResult
      try {
        pollResult = await this.pollDbKeyFromHook(pid, deadline, logs, onStatus)
      } finally {
        this.cleanupDbKeyHook()
      }

      lastAttemptLoginRequiredDetected = pollResult.loginRequiredDetected
      if (pollResult.status === 'success') {
        return { success: true, key: pollResult.key, logs }
      }
      if (pollResult.status === 'process-ended') {
        lastAttemptLoginRequiredDetected = false
        pid = await this.waitForProcessRestart(deadline, onStatus)
        continue
      }
      break
    }

    const loginRequired = await this.detectLoginRequiredForLastPid(pid, lastAttemptLoginRequiredDetected)
    if (loginRequired) {
      return {
        success: false,
        error: '微信已启动但尚未完成登录，请先在微信客户端完成登录后再重试自动获取密钥。',
        logs
      }
    }

    return { success: false, error: '获取密钥超时', logs }
  }

  private deriveImageKeys(code: number, wxid: string): { xorKey: number; aesKey: string } {
    return deriveImageKeysForWxid(code, wxid)
  }

  private buildWxidCandidates(scopeDirs: string[], wxidParam?: string, rootDir?: string): string[] {
    return buildWxidCandidates(scopeDirs, wxidParam, rootDir)
  }

  private verifyDerivedAesKey(aesKey: string, ciphertext: Buffer): boolean {
    return verifyDerivedAesKey(aesKey, ciphertext)
  }

  /**
   * 实例侧入口：实现在模块级 {@link selectVerifiedImageKey}（见那里的三条硬规则），
   * 独立出来是为了让回归测试直接打到真实实现上。
   */
  private selectVerifiedImageKey(options: ImageKeySelectionInput): ImageKeyResult {
    return selectVerifiedImageKey(options)
  }

  async autoGetImageKey(
      manualDir?: string,
      onProgress?: (message: string) => void,
      wxidParam?: string
  ): Promise<ImageKeyResult> {
    if (!this.ensureWin32()) return { success: false, error: '仅支持 Windows' }
    if (!this.ensureLoaded()) {
      return {
        success: false,
        error: '图片密钥组件 wx_key.dll 未加载；请确认安装完整（resources/key/win32/x64/wx_key.dll），或改用「内存扫描」获取密钥'
      }
    }

    onProgress?.('正在从缓存目录扫描图片密钥...')

    const resultBuffer = Buffer.alloc(8192)
    const ok = this.getImageKeyDll(resultBuffer, resultBuffer.length)

    if (!ok) {
      const errMsg = this.getLastErrorMsg ? this.decodeCString(this.getLastErrorMsg()) : ''
      return {
        success: false,
        tried: ['读取微信 kvcomm 缓存（key_<code>_*.statistic）'],
        error: `未能从微信缓存读取图片密钥${errMsg ? `：${errMsg}` : ''}。`
          + `下一步：确认微信已启动并登录，随意打开 2-3 张聊天图片后重试；`
          + `若刚切换过账号，请先在微信里登录目标账号；仍失败可点「内存扫描」兜底（需先在微信中打开图片大图）`
      }
    }

    const jsonStr = this.decodeUtf8(resultBuffer)
    let parsed: ImageKeyCachePayload
    try {
      parsed = JSON.parse(jsonStr) as ImageKeyCachePayload
    } catch {
      return {
        success: false,
        tried: ['解析 wx_key.dll 返回的密钥 JSON'],
        error: '解析微信缓存里的图片密钥数据失败（wx_key.dll 返回了非法 JSON）；请重启微信后重试，并把这一条反馈给开发者'
      }
    }

    const accounts: ImageKeyCacheAccount[] = Array.isArray(parsed.accounts) ? parsed.accounts : []
    if (!accounts.length || !accounts.some((account) => (account.keys || []).length)) {
      return {
        success: false,
        tried: ['读取微信 kvcomm 缓存（key_<code>_*.statistic）'],
        error: '微信缓存里没有找到图片密钥码（kvcomm 缓存为空或缺 key_<code>_*.statistic 文件）。'
          + '下一步：启动并登录微信，在任意聊天里打开 2-3 张图片后重试；'
          + '若微信刚装好或刚清过缓存，需要先在微信里收发/查看过图片'
      }
    }

    const rootDir = String(manualDir || '').trim()
    const scope = resolveAccountImageDirs(rootDir, wxidParam)
    // 收敛不到账号时退回根目录扫描，但把"未收敛"如实带进后续文案 ——
    // 这时选出来的模板可能属于别的账号，用户需要知道。
    const templateDirs = scope.dirs.length > 0 ? scope.dirs : (rootDir && existsSync(rootDir) ? [rootDir] : [])
    const templates = await this.collectTemplateCiphertexts(templateDirs, 8)

    console.log('[ImageKey] scope:', {
      root: rootDir,
      wxid: wxidParam,
      scoped: scope.scoped,
      dirs: scope.dirs,
      accounts: accounts.map((account) => account.wxid),
      templates: templates.files
    })

    if (scope.scoped && wxidParam) lastImageKeyAccount = { requested: String(wxidParam), dirs: scope.dirs }
    // 即使没收敛成功也要记住"用户在问哪个账号"：内存扫描兜底沿用同一个请求，
    // 才能在归属不确定时返回 verified:false，而不是把别人的密钥当成本账号的。
    else if (wxidParam) lastImageKeyAccount = { requested: String(wxidParam), dirs: [] }

    const selection = this.selectVerifiedImageKey({
      payload: parsed,
      scope,
      rootDir,
      wxidParam,
      templates,
      onProgress
    })

    // 校验通过：把结果与"这份密钥属于哪个账号目录"一起交回去，UI 才知道该存给谁。
    if (selection.success) {
      // 收敛不到账号时（模板来自整棵根目录），归属只能算"未确认"。
      if (!scope.scoped && wxidParam && selection.verified !== false) {
        return {
          ...selection,
          verified: false,
          error: selection.error
            || `未能在数据目录里定位账号 ${wxidParam} 的文件夹，密钥按缓存码推导且未通过该账号的模板校验；若导出图片失败，请重新选择该账号的 xwechat_files 根目录`
        }
      }
      return selection
    }

    // 没有模板（例如该账号还没缓存过图片）时，回退到旧策略：给出"未校验"的候选，
    // 但绝不假装它可信 —— verified:false 会让 renderer 显示「未校验」提示。
    if (templates.ciphertexts.length === 0) {
      const fallbackWxid = this.buildWxidCandidates(scope.scoped ? scope.dirs : scope.allAccountDirs, wxidParam, rootDir)[0]
        || accounts[0]?.wxid
        || 'unknown'
      const fallbackCode = Number(accounts[0]?.keys?.[0]?.code)
      if (Number.isFinite(fallbackCode)) {
        const { xorKey, aesKey } = this.deriveImageKeys(fallbackCode, fallbackWxid)
        onProgress?.(`密钥已计算（未校验，wxid: ${fallbackWxid}, code: ${fallbackCode}）`)
        return {
          success: true,
          xorKey,
          aesKey,
          verified: false,
          error: selection.error,
          tried: selection.tried,
          accountDir: scope.dirs[0]
        }
      }
    }

    return selection
  }

  // --- 内存扫描备选方案（融合 Dart+Python 优点）---
  // 只扫 RW 可写区域（更快），同时支持 ASCII 和 UTF-16LE 两种密钥格式
  // 验证支持 JPEG/PNG/WEBP/WXGF/GIF 多种格式

  async autoGetImageKeyByMemoryScan(
    userDir: string,
    onProgress?: (message: string) => void,
    wxidParam?: string
  ): Promise<ImageKeyResult> {
    if (!this.ensureWin32()) return { success: false, error: '仅支持 Windows' }

    try {
      // issue #20：内存扫描要找的是「当前微信进程里那把密钥」，因此用来判定的密文
      // 必须来自**同一个账号**。IPC 通道只带目录，所以这里沿用上一次
      // autoGetImageKey 记录的账号；没有记录时退化为扫描所有账号目录的模板
      // （内存里那把密钥一定属于其中一个，命中后 accountDir 会告诉我们是谁）。
      const requested = String(wxidParam || lastImageKeyAccount?.requested || '').trim()
      const scope = resolveAccountImageDirs(userDir, requested)
      const templateDirs = scope.dirs.length > 0 ? scope.dirs : (scope.allAccountDirs.length > 0 ? scope.allAccountDirs : [])
      const dirsToScan = templateDirs.length > 0 ? templateDirs : (userDir && existsSync(userDir) ? [userDir] : [])

      onProgress?.('正在查找模板文件...')
      let templates = await this.collectTemplateCiphertexts(dirsToScan, 3)
      if (templates.ciphertexts.length > 0 && templates.xorKey === null) {
        onProgress?.('未找到有效密钥，尝试扫描更多文件...')
        templates = await this.collectTemplateCiphertexts(dirsToScan, 40)
      }

      const accountLabel = scope.scoped
        ? `账号目录 ${scope.dirs.map((dir) => basename(dir)).join(' / ')}`
        : (requested ? `账号 ${requested}` : '当前账号')
      const scannedLabel = dirsToScan.length ? dirsToScan.join(' / ') : '(未提供数据目录)'

      if (templates.ciphertexts.length === 0) {
        return {
          success: false,
          tried: [`扫描模板目录：${scannedLabel}`],
          error: `在${accountLabel}下没有找到 V2 模板文件（*_t.dat），无法确定内存里的密钥是否可用；已扫描：${scannedLabel}。`
            + `下一步：用这个账号在微信里打开 2-3 张图片大图（等缩略图真正生成），再重试；`
            + `若目录不对，请在连接页重新选择该账号的 xwechat_files 根目录`
        }
      }

      let xorKey = templates.xorKey
      if (xorKey === null) {
        return {
          success: false,
          tried: [`读取 ${templates.ciphertexts.length} 个模板的尾部字节`, `扫描目录：${scannedLabel}`],
          error: `这 ${templates.ciphertexts.length} 个 V2 模板都没能算出有效的 XOR 密钥（${scannedLabel}）。`
            + `下一步：在微信里再打开几张**不同**的图片大图后重试；同一张图反复打开不会产生新模板`
        }
      }

      onProgress?.(`XOR 密钥: 0x${xorKey.toString(16).padStart(2, '0')}，正在查找微信进程...`)

      // 2. 找微信 PID（每轮重查，避免 60s 窗口内进程重启导致持续失败）
      let pid = await this.findWeChatPid()
      if (!pid) {
        return {
          success: false,
          tried: [`扫描目录：${scannedLabel}`],
          error: '没有找到正在运行的微信进程（Weixin.exe / WeChat.exe）。'
            + '下一步：先启动微信并登录目标账号，再回来点「内存扫描」'
        }
      }

      onProgress?.(`已找到微信进程 PID=${pid}，正在扫描内存...`)

      // 3. 持续轮询内存扫描，最多 60 秒
      const deadline = Date.now() + 60_000
      let scanCount = 0
      let lastPid = pid
      while (Date.now() < deadline) {
        scanCount++
        onProgress?.(`第 ${scanCount} 次扫描内存，请在微信中打开图片大图...`)
        // 每轮重查 PID，兼容微信崩溃/重启场景
        const currentPid = await this.findWeChatPid()
        if (currentPid) { pid = currentPid; lastPid = currentPid }
        const matched = await this._scanMemoryForAesKey(pid, templates.ciphertexts, onProgress)
        if (matched) {
          // 哪一个模板被解开，就说明内存里那把密钥属于哪个账号目录 —— 这正是
          // issue #20 里缺少的归属信息（旧实现只回一把密钥，UI 只能猜着存）。
          const origin = templates.origins[matched.index]
          const matchedDir = origin ? origin.dir : undefined
          if (matchedDir && scope.scoped && !scope.dirs.some((dir) => dir.toLowerCase() === matchedDir.toLowerCase())) {
            onProgress?.(`注意：命中的密钥属于 ${basename(matchedDir)}，与所选账号可能不是同一个`)
          }
          onProgress?.('密钥获取成功')
          return {
            success: true,
            xorKey: xorKey as number,
            aesKey: matched.aesKey,
            // 「校验通过」与「归属确定」是两件事：收敛不到账号时（requested 有值但
            // 目录没匹配上），这把密钥一定属于*某个*账号，但未必是用户选的那个 ——
            // 这时返回 verified:false，UI 会显示「未校验」，不会静默存错账号。
            verified: scope.scoped || !requested,
            accountDir: matchedDir,
            tried: [`命中模板：${origin ? origin.file : '(未知)'}`]
          }
        }
        // 等 5 秒再试
        await new Promise(r => setTimeout(r, 5000))
      }

      const accountHint = scope.scoped
        ? `${accountLabel}（微信当前登录的账号如果与它不同，请先切换账号再试）`
        : accountLabel
      return {
        success: false,
        tried: [
          `扫描目录：${scannedLabel}`,
          `模板 ${templates.ciphertexts.length} 个（XOR 0x${xorKey.toString(16).padStart(2, '0')}）`,
          `微信进程 PID ${lastPid}`,
          `内存扫描 ${scanCount} 轮 / 60 秒`
        ],
        error: `60 秒内没有在微信进程内存里找到能解密${accountHint}图片的 AES 密钥`
          + `（已用 ${templates.ciphertexts.length} 个该账号的模板校验 ${lastPid} 号进程的 ${scanCount} 轮内存扫描）。`
          + `最常见原因是"模板属于另一个账号"或"微信当前登录的不是这个账号"。`
          + `下一步：1) 在微信里确认当前登录的就是目标账号（两个账号同机时先切换账号）；`
          + `2) 用该账号打开 2-3 张图片大图；3) 重新点「内存扫描」`
      }
    } catch (e) {
      return {
        success: false,
        tried: ['内存扫描'],
        error: `内存扫描过程出错：${e instanceof Error ? e.message : String(e)}；请重试，若持续失败请把这条信息反馈给开发者`
      }
    }
  }

  /**
   * 收集若干个账号目录里的模板密文（每个目录取最新的 limit 个文件）。
   *
   * 这是 issue #20 的关键收口：旧实现只接受**一个**目录，UI 传的是 xwechat_files
   * 根目录，于是两个账号的 `*_t.dat` 混在一起按修改时间排序取"最新"——很可能取到
   * 另一个账号的文件，后续校验必然失败（用户看到的是 60 秒内存扫描超时）。
   */
  private async collectTemplateCiphertexts(
    dirs: string[],
    limitPerDir: number
  ): Promise<{ ciphertexts: Buffer[]; origins: Array<{ file: string; dir: string }>; files: string[]; dirs: string[]; xorKey: number | null }> {
    const ciphertexts: Buffer[] = []
    const origins: Array<{ file: string; dir: string }> = []
    const files: string[] = []
    const usedDirs: string[] = []
    let xorKey: number | null = null

    for (const dir of dirs.slice(0, 6)) {
      const single = await this._findTemplateData(dir, limitPerDir)
      if (single.files.length === 0 && !single.ciphertext) continue
      usedDirs.push(dir)
      if (xorKey === null && single.xorKey !== null) xorKey = single.xorKey
      for (const file of single.files) {
        if (files.length >= 48) break
        files.push(file)
      }
      for (const entry of single.entries) {
        if (ciphertexts.length >= 24) break
        ciphertexts.push(entry.ciphertext)
        origins.push({ file: entry.file, dir })
      }
    }

    return { ciphertexts, origins, files, dirs: usedDirs, xorKey }
  }

  private async _findTemplateData(
    userDir: string,
    limit: number = 32
  ): Promise<{
    ciphertext: Buffer | null
    ciphertexts: Buffer[]
    entries: Array<{ file: string; ciphertext: Buffer }>
    xorKey: number | null
    files: string[]
  }> {
    const { readdirSync, readFileSync, statSync } = await import('fs')
    const V2_MAGIC = Buffer.from([0x07, 0x08, 0x56, 0x32, 0x08, 0x07])
    const empty = {
      ciphertext: null,
      ciphertexts: [] as Buffer[],
      entries: [] as Array<{ file: string; ciphertext: Buffer }>,
      xorKey: null as number | null,
      files: [] as string[]
    }

    const trimmedDir = String(userDir || '').trim()
    if (!trimmedDir) return empty
    // 拒绝 UNC/网络路径与超长路径（避免主进程同步遍历挂起或触发 SMB 凭据面）
    if (trimmedDir.startsWith('\\\\')) return empty
    try {
      const s = statSync(trimmedDir)
      if (!s.isDirectory()) return empty
    } catch { return empty }

    // 递归收集 *_t.dat 文件（带深度与条目上限，避免整盘遍历导致假死）
    //
    // 注意扫描上限与"取最新"的关系（issue #20）：旧实现直接 collect(dir, limit)，
    // 拿到的是**遍历顺序里的前 limit 个**文件，再对这 limit 个排序 —— 于是"最新"
    // 只在随机的一小撮里成立，多账号/多会话目录下极易取到一个陈旧甚至别的账号的
    // 模板。现在先多收一些（limit 的若干倍，设上限），再按修改时间真正取最新。
    let visitedDirs = 0
    const MAX_DIRS = 8000
    const MAX_DEPTH = 8
    const maxCollect = Math.min(Math.max(limit * 8, 128), 1200)
    const collect = (dir: string, results: string[], maxFiles: number, depth = 0) => {
      if (results.length >= maxFiles) return
      if (depth > MAX_DEPTH) return
      if (visitedDirs++ > MAX_DIRS) return
      try {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          if (results.length >= maxFiles) break
          if (visitedDirs > MAX_DIRS) break
          const full = join(dir, entry.name)
          if (entry.isDirectory()) collect(full, results, maxFiles, depth + 1)
          else if (entry.isFile() && entry.name.endsWith('_t.dat')) results.push(full)
        }
      } catch { /* 忽略无权限目录 */ }
    }

    const collected: string[] = []
    collect(trimmedDir, collected, maxCollect)

    // 按修改时间降序，真正取最新的 limit 个
    collected.sort((a, b) => {
      try { return statSync(b).mtimeMs - statSync(a).mtimeMs } catch { return 0 }
    })
    const files = collected.slice(0, Math.max(1, limit))

    const ciphertexts: Buffer[] = []
    let ciphertext: Buffer | null = null
    const entries: Array<{ file: string; ciphertext: Buffer }> = []
    const acceptedFiles: string[] = []
    const tailCounts: Record<string, number> = {}

    for (const f of files) {
      try {
        // 超大文件跳过（>10MB 可能是误命名或异常文件，避免 OOM）
        try {
          const st = statSync(f)
          if (st.size > 10 * 1024 * 1024) continue
        } catch { continue }
        const data = readFileSync(f)
        if (data.length < 8) continue
        const isV2 = data.subarray(0, 6).equals(V2_MAGIC)

        // 统计末尾两字节用于 XOR 密钥
        if (isV2 && data.length >= 2) {
          const key = `${data[data.length - 2]}_${data[data.length - 1]}`
          tailCounts[key] = (tailCounts[key] ?? 0) + 1
        }

        // 提取密文：单个模板可能损坏/截断，多收几个让校验有备选
        if (isV2 && data.length >= 0x1F) {
          acceptedFiles.push(f)
          if (ciphertexts.length < 8) {
            const slice = data.subarray(0xF, 0x1F)
            ciphertexts.push(slice)
            entries.push({ file: f, ciphertext: slice })
            if (!ciphertext) ciphertext = slice
          }
        }
      } catch { /* 忽略 */ }
    }

    // 计算 XOR 密钥
    let xorKey: number | null = null
    let maxCount = 0
    for (const [key, count] of Object.entries(tailCounts)) {
      if (count > maxCount) { maxCount = count; const [x, y] = key.split('_').map(Number); const k = x ^ 0xFF; if (k === (y ^ 0xD9)) xorKey = k }
    }

    return { ciphertext, ciphertexts, entries, xorKey, files: acceptedFiles }
  }

  private async _scanMemoryForAesKey(
    pid: number,
    ciphertexts: Buffer[],
    onProgress?: (msg: string) => void
  ): Promise<{ aesKey: string; index: number } | null> {
    if (!this.ensureKernel32()) return null
    const ciphertextList = (Array.isArray(ciphertexts) ? ciphertexts : [ciphertexts]).filter(
      (item): item is Buffer => Buffer.isBuffer(item) && item.length === 16
    )
    if (ciphertextList.length === 0) return null

    // 直接用已加载的 kernel32 实例，用 uintptr 传地址
    const VirtualQueryEx = this.kernel32.func('VirtualQueryEx', 'size_t', ['void*', 'uintptr', 'void*', 'size_t'])
    const ReadProcessMemory = this.kernel32.func('ReadProcessMemory', 'bool', ['void*', 'uintptr', 'void*', 'size_t', this.koffi.out('size_t*')])

    // RW 保护标志（只扫可写区域，速度更快）
    const RW_FLAGS = 0x04 | 0x08 | 0x40 | 0x80 // PAGE_READWRITE | PAGE_WRITECOPY | PAGE_EXECUTE_READWRITE | PAGE_EXECUTE_WRITECOPY
    const MEM_COMMIT = 0x1000
    const PAGE_NOACCESS = 0x01
    const PAGE_GUARD = 0x100
    const MBI_SIZE = 48 // MEMORY_BASIC_INFORMATION size on x64

    const hProcess = this.OpenProcess(0x1F0FFF, false, pid)
    if (!hProcess) return null

    try {
      // 枚举 RW 内存区域
      const regions: Array<[number, number]> = []
      let skippedLarge = 0
      let addr = 0
      const mbi = Buffer.alloc(MBI_SIZE)

      while (addr < 0x7FFFFFFFFFFF) {
        const ret = VirtualQueryEx(hProcess, addr, mbi, MBI_SIZE)
        if (ret === 0) break
        // MEMORY_BASIC_INFORMATION x64 布局:
        // 0:  BaseAddress (8)
        // 8:  AllocationBase (8)
        // 16: AllocationProtect (4) + 4 padding
        // 24: RegionSize (8)
        // 32: State (4)
        // 36: Protect (4)
        // 40: Type (4) + 4 padding = 48 total
        const base = Number(mbi.readBigUInt64LE(0))
        const size = Number(mbi.readBigUInt64LE(24))
        const state = mbi.readUInt32LE(32)
        const protect = mbi.readUInt32LE(36)

        if (state === MEM_COMMIT &&
            protect !== PAGE_NOACCESS &&
            (protect & PAGE_GUARD) === 0 &&
            (protect & RW_FLAGS) !== 0) {
          if (size <= 50 * 1024 * 1024) {
            regions.push([base, size])
          } else {
            skippedLarge++
          }
        }
        const next = base + size
        if (next <= addr) break
        addr = next
      }

      const totalMB = regions.reduce((s, [, sz]) => s + sz, 0) / 1024 / 1024
      if (skippedLarge > 0) {
        onProgress?.(`扫描 ${regions.length} 个 RW 区域 (${totalMB.toFixed(0)} MB)，已跳过 ${skippedLarge} 个 >50MB 超大区域`)
      } else {
        onProgress?.(`扫描 ${regions.length} 个 RW 区域 (${totalMB.toFixed(0)} MB)...`)
      }

      const CHUNK = 4 * 1024 * 1024
      const OVERLAP = 65

      for (let i = 0; i < regions.length; i++) {
        const [base, size] = regions[i]
        if (i % 20 === 0) {
          onProgress?.(`扫描进度 ${i}/${regions.length}...`)
          await new Promise(r => setTimeout(r, 1)) // 让出事件循环
        }

        let offset = 0
        let trailing: Buffer | null = null
        let chunkIdx = 0

        while (offset < size) {
          const chunkSize = Math.min(CHUNK, size - offset)
          const buf = Buffer.alloc(chunkSize)
          const bytesReadOut = [0]
          const ok = ReadProcessMemory(hProcess, base + offset, buf, chunkSize, bytesReadOut)
          if (!ok || bytesReadOut[0] === 0) { offset += chunkSize; trailing = null; continue }

          const data: Buffer = trailing ? Buffer.concat([trailing, buf.subarray(0, bytesReadOut[0])]) : buf.subarray(0, bytesReadOut[0])

          // 搜索 ASCII 32字节密钥
          const key = this._searchAsciiKey(data, ciphertextList)
          if (key) { return key }

          // 搜索 UTF-16LE 32字节密钥（每 4 块让出一次事件循环，避免主进程长时间冻结）
          // 注：UTF-16 密钥罕见，优先 ASCII 可稍快；此处合并报告一次
          const key16 = this._searchUtf16Key(data, ciphertextList)
          if (key16) { return key16 }

          trailing = data.subarray(Math.max(0, data.length - OVERLAP))
          offset += chunkSize
          chunkIdx++
          if (chunkIdx % 4 === 0) {
            await new Promise(r => setTimeout(r, 0))
          }
        }
      }

      return null
    } finally {
      this.CloseHandle(hProcess)
    }
  }

  private _searchAsciiKey(data: Buffer, ciphertexts: Buffer[]): { aesKey: string; index: number } | null {
    for (let i = 0; i < data.length - 34; i++) {
      if (this._isAlphaNum(data[i])) continue
      let valid = true
      for (let j = 1; j <= 32; j++) {
        if (!this._isAlphaNum(data[i + j])) { valid = false; break }
      }
      if (!valid) continue
      if (i + 33 < data.length && this._isAlphaNum(data[i + 33])) continue
      const keyBytes = data.subarray(i + 1, i + 33)
      const index = this._verifyAesKey(keyBytes, ciphertexts)
      if (index >= 0) return { aesKey: keyBytes.toString('ascii').substring(0, 16), index }
    }
    return null
  }

  private _searchUtf16Key(data: Buffer, ciphertexts: Buffer[]): { aesKey: string; index: number } | null {
    for (let i = 0; i < data.length - 65; i++) {
      let valid = true
      for (let j = 0; j < 32; j++) {
        if (data[i + j * 2 + 1] !== 0x00 || !this._isAlphaNum(data[i + j * 2])) { valid = false; break }
      }
      if (!valid) continue
      const keyBytes = Buffer.alloc(32)
      for (let j = 0; j < 32; j++) keyBytes[j] = data[i + j * 2]
      const index = this._verifyAesKey(keyBytes, ciphertexts)
      if (index >= 0) return { aesKey: keyBytes.toString('ascii').substring(0, 16), index }
    }
    return null
  }

  private _isAlphaNum(b: number): boolean {
    return (b >= 0x61 && b <= 0x7A) || (b >= 0x41 && b <= 0x5A) || (b >= 0x30 && b <= 0x39)
  }

  /** 返回命中的模板下标（-1 = 都不匹配），命中下标用于把结果归属到具体账号目录。 */
  private _verifyAesKey(keyBytes: Buffer, ciphertexts: Buffer[]): number {
    const list = Array.isArray(ciphertexts) ? ciphertexts : [ciphertexts]
    for (let index = 0; index < list.length; index++) {
      const ciphertext = list[index]
      if (!Buffer.isBuffer(ciphertext) || ciphertext.length !== 16) continue
      try {
        const decipher = crypto.createDecipheriv('aes-128-ecb', keyBytes.subarray(0, 16), null)
        decipher.setAutoPadding(false)
        const dec = Buffer.concat([decipher.update(ciphertext), decipher.final()])
        // 支持 JPEG / PNG / WEBP / WXGF / GIF
        if (dec[0] === 0xFF && dec[1] === 0xD8 && dec[2] === 0xFF) return index
        if (dec[0] === 0x89 && dec[1] === 0x50 && dec[2] === 0x4E && dec[3] === 0x47) return index
        if (dec[0] === 0x52 && dec[1] === 0x49 && dec[2] === 0x46 && dec[3] === 0x46) return index
        if (dec[0] === 0x77 && dec[1] === 0x78 && dec[2] === 0x67 && dec[3] === 0x66) return index
        if (dec[0] === 0x47 && dec[1] === 0x49 && dec[2] === 0x46) return index
      } catch { /* 这个模板试不出来就换下一个 */ }
    }
    return -1
  }
}
