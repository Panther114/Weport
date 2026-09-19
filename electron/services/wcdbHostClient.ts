/**
 * WCDB 宿主进程客户端（替代 worker_threads 的传输层）。
 *
 * wcdb_api.dll 的 -1006 安全检查要求宿主可执行文件名为 WeFlow.exe（Windows）
 * / WeFlow（macOS，同名规则）。Windows/Linux：在当前 exe 同目录创建硬链接
 * WeFlow[.exe] -> 当前 exe（NTFS 零磁盘开销，与 exe 同目录可复用
 * electron.dll / 共享库 / resources）。
 *
 * macOS 例外：绝不在 app bundle 内创建任何文件。在 `Contents/MacOS/` 下多加
 * 一个文件会直接破坏 bundle 密封（`codesign --verify --deep --strict` 报
 * `file added: .../Contents/MacOS/WeFlow`，实测见 v1.0.0 用户反馈），而 CI 的
 * `verify-mac-pack.sh` 跑在首次启动之前，拦不住这种运行期自改。因此 darwin
 * 永远把宿主部署到 `{userData}/wcdb-host/Contents/MacOS/WeFlow`（bundle 结构
 * + 软链回真实 Frameworks，见 createMacHostBundle），并尽力清理旧版遗留的
 * bundle 内硬链接以自愈密封。
 *
 * 宿主以 ELECTRON_RUN_AS_NODE=1 启动（0.9.3 起）：同一个二进制以纯 Node.js
 * 运行 wcdbHost.js，不初始化 Chromium 浏览器进程 —— 省掉宿主侧 ~100MB 常驻
 * 与网络服务 utility 子进程（~50MB）。-1006 检查只认可执行文件文件名，与
 * 运行时无关，因此纯 Node 模式同样通过。
 *
 * 脚本路径：dev 用 dist-electron/wcdbHost.js（koffi 从项目 node_modules
 * 解析）；打包版用 resources/host/wcdbHost.js（electron-builder extraResources
 * 复制，纯 Node 读不了 app.asar；koffi 及其平台二进制复制到
 * resources/host/libs/ —— 不能用 node_modules 目录名，electron-builder 的
 * 复制过滤器会排除根级 node_modules —— 通过 NODE_PATH 解析，见
 * scripts/prepare-host-bundle.cjs）。
 *
 * 该实例进入 wcdbHost.ts 的 IPC 循环（process.on('message') / process.send），
 * 协议与 wcdbWorker.ts 完全一致，因此 WcdbService 无需改动其余任何逻辑。
 *
 * 注意：不用 stdio JSON-lines —— Electron 主进程的 stdin 在 Windows 上
 * 会立即 EOF（即便父进程提供了管道），必须使用 IPC 通道（'ipc' stdio）。
 */
import { EventEmitter } from 'events'
import { spawn, type ChildProcess } from 'child_process'
import { join, dirname, delimiter } from 'path'
import { existsSync, linkSync, unlinkSync, statSync, copyFileSync, mkdirSync, utimesSync, chmodSync, symlinkSync, readlinkSync } from 'fs'

/**
 * macOS 宿主归宿：`{userData}/wcdb-host/Contents/MacOS/WeFlow`。
 *
 * 为什么不能只复制二进制：Electron 的可执行文件用
 * `@executable_path/../Frameworks` 解析 `Electron Framework.framework`。
 * 把一个孤零零的二进制复制到 `~/Library/Application Support/.../wcdb-host/`
 * 后，`../Frameworks` 不存在，宿主进程直接起不来 —— 用户只会看到一个没有
 * 解释的错误码。
 *
 * 这里重建最小可用结构：
 *   {fallback}/Contents/MacOS/WeFlow          ← 真·二进制（文件名满足 -1006 自检）
 *   {fallback}/Contents/Frameworks            → 软链到真实 app 的 Frameworks
 *   {fallback}/Contents/Info.plist            ← 复制（部分 Electron 版本会读）
 * `@executable_path` 指向 MacOS 目录，`../Frameworks` 因此能穿过软链解析成功。
 *
 * 为什么所有 darwin 启动都走这里（而不只在 exe 目录不可写时）：
 * 在 bundle 内（`Contents/MacOS/WeFlow`）放硬链接会破坏 bundle 密封，
 * `codesign --verify --deep --strict` 报 `file added`，Gatekeeper 判损坏；
 * CI 的签名门跑在首次启动之前，拦不住运行期自改。userData 不在密封范围内，
 * 在那里放宿主永远不影响签名。
 */
function createMacHostBundle(targetExe: string, exeDir: string, fallbackDir: string): string | null {
  try {
    // exeDir 在打包版是 `.../Weport.app/Contents/MacOS`。用 '..' 拼 Frameworks
    // 是刻意的：dev（node_modules/electron/dist）、打包版、DMG 挂载都满足
    // `MacOS/../Frameworks`，而按 bundle 名回溯在 dev 下不成立。
    const appContents = join(exeDir, '..')
    const sourceFrameworks = join(appContents, 'Frameworks')
    if (!existsSync(sourceFrameworks)) return null

    const destContents = join(fallbackDir, 'Contents')
    const destMacOs = join(destContents, 'MacOS')
    mkdirSync(destMacOs, { recursive: true })

    const destHost = join(destMacOs, 'WeFlow')
    copyFileSync(targetExe, destHost)
    chmodSync(destHost, 0o755)
    try {
      const t = statSync(targetExe)
      utimesSync(destHost, t.atime, t.mtime)
    } catch { /* mtime 尽力而为 */ }

    const destFrameworks = join(destContents, 'Frameworks')
    try {
      // 悬空软链（app 更新/搬家后常见）：existsSync 跟随链接返回 false，
      // 但路径本身存在，直接 symlink 会 EEXIST —— 先删再建。
      unlinkSync(destFrameworks)
    } catch { /* 不存在最好 */ }
    try {
      symlinkSync(sourceFrameworks, destFrameworks, 'dir')
    } catch {
      return null
    }

    const sourcePlist = join(appContents, 'Info.plist')
    if (existsSync(sourcePlist)) {
      try {
        copyFileSync(sourcePlist, join(destContents, 'Info.plist'))
      } catch { /* 尽力而为 */ }
    }

    return destHost
  } catch {
    return null
  }
}

/**
 * 清理 v1.0.0 及更早版本遗留在 bundle 内的宿主硬链接。
 *
 * 旧版在 darwin 上与 win/linux 一样往 `Contents/MacOS/WeFlow` 写硬链接，
 * 该文件不在密封清单里 —— 一旦存在，`codesign --verify --deep --strict`
 * 永久失败直到它被删掉。删除它即自愈密封（密封清单本身未被改动，只是
 * 多了一个清单外的文件）。
 *
 * 只删恰好叫 `WeFlow` 且与当前 exe 内容一致（size+mtime）的那个文件，
 * 避免误删用户自己放的东西；删不掉（只读挂载）也不致命 —— 下面的解析
 * 本来就不依赖它。
 */
function cleanupLegacyMacHostLink(targetExe: string, exeDir: string): void {
  try {
    const legacy = join(exeDir, 'WeFlow')
    if (!existsSync(legacy)) return
    let same = false
    try {
      const s = statSync(legacy)
      const t = statSync(targetExe)
      same = s.size === t.size && Math.floor(s.mtimeMs) === Math.floor(t.mtimeMs)
    } catch { /* 读不到 stat 就不动它 */ }
    if (!same) return
    try {
      unlinkSync(legacy)
      console.warn('[wcdb-host] 已清理 bundle 内旧版宿主链接 Contents/MacOS/WeFlow（恢复代码签名密封）')
    } catch (e) {
      console.warn(`[wcdb-host] bundle 内旧版宿主链接无法删除（只读挂载？）：${String((e as Error)?.message || e)}`)
    }
  } catch { /* 自愈尽力而为，绝不阻塞启动 */ }
}

function getMacFallbackDir(): string {
  const { app } = require('electron') as typeof import('electron')
  const dir = join(app.getPath('userData'), 'wcdb-host')
  mkdirSync(dir, { recursive: true })
  return dir
}

/** 部署（或复用）macOS 宿主。返回宿主可执行文件路径，失败返回 null。 */
function ensureMacHost(targetExe: string, exeDir: string): string | null {
  cleanupLegacyMacHostLink(targetExe, exeDir)
  let fallbackDir = ''
  try {
    // app 仅在主进程可用；本模块只在主进程使用
    fallbackDir = getMacFallbackDir()
  } catch {
    return null
  }
  const destHost = join(fallbackDir, 'Contents', 'MacOS', 'WeFlow')
  // 已部署且与当前 exe 一致 → 复用（覆盖安装/更新后 exe 变化则重建；
  // 只比大小会漏掉「新 exe 与旧版本恰好同尺寸」的更新）
  try {
    const s = statSync(destHost)
    const t = statSync(targetExe)
    if (s.size === t.size && Math.floor(s.mtimeMs) === Math.floor(t.mtimeMs)) {
      // 软链可能在 app 更新/搬家后断掉 —— 每次都修一次，便宜且无副作用。
      repairMacFrameworksSymlink(exeDir, fallbackDir)
      return destHost
    }
  } catch { /* 不存在或读不到 → 重新部署 */ }
  const bundledHost = createMacHostBundle(targetExe, exeDir, fallbackDir)
  if (bundledHost) {
    console.warn(`[wcdb-host] macOS 宿主已部署到 ${bundledHost}（bundle 内不写文件，签名密封不受影响）`)
    return bundledHost
  }
  return null
}

/** app 更新/搬家后，已部署宿主的 Frameworks 软链可能断掉 —— 每次启动修一次。 */
function repairMacFrameworksSymlink(exeDir: string, fallbackDir: string): void {
  try {
    const sourceFrameworks = join(exeDir, '..', 'Frameworks')
    if (!existsSync(sourceFrameworks)) return
    const destFrameworks = join(fallbackDir, 'Contents', 'Frameworks')
    let stale = false
    try {
      const current = readlinkSync(destFrameworks)
      stale = current !== sourceFrameworks
    } catch {
      stale = !existsSync(destFrameworks)
    }
    if (!stale) return
    try { unlinkSync(destFrameworks) } catch { /* 可能是目录而非软链？只处理软链 */ }
    symlinkSync(sourceFrameworks, destFrameworks, 'dir')
  } catch { /* 尽力而为 */ }
}

function resolveHostExe(): string {
  const override = process.env.WEPORT_WCDB_HOST_EXE
  if (override && existsSync(override)) return override

  const target = process.execPath
  const exeDir = dirname(target)

  // macOS：永远走 userData bundle 结构 —— bundle 内写文件即破密封（v1.0.0 实测）。
  // 放在 resolveHostExe 最前面：连「已存在硬链接可复用」都不检查，因为复用
  // 本身就是 bug（那个文件就不该存在）。
  if (process.platform === 'darwin') {
    const macHost = ensureMacHost(target, exeDir)
    if (macHost) return macHost
    // userData 都拿不到（理论不可达）才退回旧行为，总比起不来强。
    console.warn('[wcdb-host] userData 不可用，回退到 bundle 内硬链接（签名密封将被破坏）')
  }

  const hostName = process.platform === 'win32' ? 'WeFlow.exe' : 'WeFlow'
  const hostPath = join(exeDir, hostName)

  // 已存在且大小+修改时间一致 → 直接复用（覆盖安装/更新后 exe 变化则重建链接；
  // 只比大小会漏掉「新 exe 与旧版本恰好同尺寸」的更新——硬链接指向的仍是旧文件）
  const matchesTarget = (p: string): boolean => {
    try {
      const s = statSync(p)
      const t = statSync(target)
      return s.size === t.size && Math.floor(s.mtimeMs) === Math.floor(t.mtimeMs)
    } catch {
      return false
    }
  }
  if (!matchesTarget(hostPath)) {
    try {
      if (existsSync(hostPath)) unlinkSync(hostPath)
      linkSync(target, hostPath)
    } catch (e) {
      // Windows/Linux 常见：exe 目录只读（AppImage squashfs、/usr/bin、deb /opt）。
      // 硬链接必须同文件系统 —— 退化为复制到 userData（跨设备只能复制，
      // mtime 对齐以复用上面的「同版本跳过」检查；-1006 检查的是宿主进程
      // 自身路径名，复制出的 WeFlow 同样满足）。
      //
      // darwin 走不到这里：resolveHostExe 开头已返回 userData bundle 宿主，
      // 只有 userData 都不可用（理论不可达）才会沿旧路径掉下来，此时直接报错，
      // 不再尝试裸复制（裸二进制在 macOS 上找不到 Frameworks，必起不来）。
      if (process.platform === 'darwin') {
        throw new Error(
          `无法部署 WCDB 宿主进程 (${String((e as Error)?.message || e)})。` +
          '请确认 ~/Library/Application Support/Weport 可写。'
        )
      }
      let fallbackDir = ''
      try {
        // app 仅在主进程可用；本模块只在主进程使用
        const { app } = require('electron') as typeof import('electron')
        fallbackDir = join(app.getPath('userData'), 'wcdb-host')
        mkdirSync(fallbackDir, { recursive: true })
      } catch {
        /* 无 electron（理论不可达），保持原错误 */
      }
      if (fallbackDir) {
        const copiedPath = join(fallbackDir, hostName)
        try {
          copyFileSync(target, copiedPath)
          try {
            const t = statSync(target)
            utimesSync(copiedPath, t.atime, t.mtime)
            chmodSync(copiedPath, 0o755)
          } catch { /* 权限位/mtime 尽力而为 */ }
          console.warn(`[wcdb-host] exe 目录不可写，宿主已复制到 ${copiedPath}`)
          return copiedPath
        } catch (e2) {
          throw new Error(
            `无法创建 WCDB 宿主进程：硬链接失败于 ${hostPath} (${String((e as Error)?.message || e)})，` +
            `复制兜底也失败于 ${copiedPath} (${String((e2 as Error)?.message || e2)})。`
          )
        }
      }
      throw new Error(
        `无法创建 WCDB 宿主进程 (${hostPath}): ${String((e as Error)?.message || e)}。` +
        '请确认安装目录可写（Windows: NTFS / Linux: 非 AppImage 只读挂载），或以管理员身份运行。'
      )
    }
  }
  return hostPath
}

export class WcdbHostClient extends EventEmitter {
  private child: ChildProcess | null = null
  private killed = false
  /** 单次调用超时（默认 3 分钟；超出视为宿主卡死，报错而不是挂死应用） */
  private readonly requestTimeoutMs = Number(process.env.WEPORT_WCDB_TIMEOUT_MS || 180_000)

  constructor() {
    super()
    try {
      this.spawnHost()
    } catch (e) {
      // 延迟抛错，让 callWorker 侧拿到明确错误
      process.nextTick(() => {
        this.emit('error', e)
      })
    }
  }

  private spawnHost() {
    const hostExe = resolveHostExe()
    // 启动自检：把宿主解析结果写进日志。旧版这条路径完全没有输出，于是
    // 「宿主起不来」和「数据库读不出来」在日志里长得一模一样 —— 靠这段
    // 才能一眼区分是解析失败还是宿主自身失败。
    console.log(`[wcdb-host] exe=${hostExe} platform=${process.platform} electron=${process.versions.electron || 'n/a'}`)
    // 纯 Node 模式：ELECTRON_RUN_AS_NODE=1 时 Electron 二进制按 node 运行，
    // 第一个非 flag 参数即脚本路径（不再需要 --wcdb-host 与 app 路径参数）
    let hostScript: string
    if (process.env.WEPORT_DEV_MODE === '1') {
      hostScript = join(process.cwd(), 'dist-electron', 'wcdbHost.js')
    } else {
      hostScript = join(process.resourcesPath, 'host', 'wcdbHost.js')
    }
    const args: string[] = [hostScript]

    const exeDir = dirname(hostExe)
    const originExeDir = dirname(process.execPath)
    const resourcesPath = process.env.WEPORT_RESOURCES_PATH || ''
    // exeDir：宿主（硬链接/复制件）所在目录；originExeDir：真实 Electron 发行目录 ——
    // Linux 复制兜底时二者不同，复制的二进制靠 LD_LIBRARY_PATH 找回同发行版的
    // 共享库（AppImage 场景还需继承 $APPDIR，spawn 默认透传 process.env 已覆盖）
    const extraPathParts: string[] = [exeDir]
    if (originExeDir !== exeDir) extraPathParts.push(originExeDir)
    if (resourcesPath) {
      extraPathParts.push(join(resourcesPath, 'wcdb', process.platform, process.arch))
      extraPathParts.push(join(resourcesPath, 'runtime', process.platform))
    }

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      WEFLOW_WORKER: '1',
      WEFLOW_USER_DATA_PATH: process.env.WEPORT_USER_DATA_PATH || '',
      WEFLOW_CONFIG_CWD: process.env.WEPORT_USER_DATA_PATH || '',
      PATH: [...extraPathParts, process.env.PATH || ''].filter(Boolean).join(delimiter),
      // 兼容 wcdbCore.getDllPath() 探测 WCDB_RESOURCES_PATH（历史仅 annualReportWorker 设置）
      WCDB_RESOURCES_PATH: process.env.WEPORT_RESOURCES_PATH || resourcesPath || ''
    }
    // Linux：dlopen 依赖库查找路径（libwcdb_api.so 及其依赖）
    if (process.platform !== 'win32') {
      env.LD_LIBRARY_PATH = [...extraPathParts, process.env.LD_LIBRARY_PATH || ''].filter(Boolean).join(delimiter)
    }
    // 打包版：koffi 不在脚本的 node_modules 走查链上（resources/host/libs，
    // 见 scripts/prepare-host-bundle.cjs），用 NODE_PATH 补解析；dev 走项目
    // node_modules 正常解析，无需设置
    if (process.env.WEPORT_DEV_MODE !== '1') {
      env.NODE_PATH = join(process.resourcesPath, 'host', 'libs')
    }

    this.child = spawn(hostExe, args, {
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      windowsHide: true,
      env
    })

    this.child.on('message', (msg: any) => {
      this.emit('message', msg)
    })

    this.child.stderr!.on('data', (chunk: Buffer) => {
      const text = chunk.toString().trim()
      if (text) console.error('[wcdb-host]', text)
    })

    this.child.on('error', (err) => {
      this.emit('error', err)
    })

    this.child.on('exit', (code) => {
      this.emit('exit', code)
      this.child = null
    })
  }

  postMessage(msg: any): boolean {
    if (!this.child || this.child.killed) {
      this.emit('error', new Error('WCDB 宿主进程不可用'))
      return false
    }
    try {
      return this.child.send(msg)
    } catch (e) {
      this.emit('error', e instanceof Error ? e : new Error(String(e)))
      return false
    }
  }

  /** 同步强杀宿主进程（退出兜底路径使用：app.exit 会等待 IPC 子进程回收） */
  killNow(): void {
    const child = this.child
    this.child = null
    this.killed = true
    if (child) {
      try { child.kill() } catch { /* noop */ }
    }
  }

  async terminate(): Promise<void> {
    if (!this.child) return
    const child = this.child
    this.killed = true
    // 先发 shutdown 让宿主自行收尾，兜底 2 秒后强杀
    try {
      child.send({ id: -2, type: 'shutdown', payload: {} })
    } catch { /* noop */ }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        try { child.kill() } catch { /* noop */ }
        resolve()
      }, 2000)
      child.once('exit', () => {
        clearTimeout(timer)
        resolve()
      })
    })
    this.child = null
  }
}
