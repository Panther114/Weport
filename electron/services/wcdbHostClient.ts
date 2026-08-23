/**
 * WCDB 宿主进程客户端（替代 worker_threads 的传输层）。
 *
 * wcdb_api.dll 的 -1006 安全检查要求宿主可执行文件名为 WeFlow.exe（Windows）
 * / WeFlow（macOS，同名规则）。方案：在当前 exe 同目录创建硬链接
 * WeFlow[.exe] -> 当前 exe（NTFS / APFS 零磁盘开销，与 exe 同目录可复用
 * electron.dll / Electron.framework / resources）。
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
import { existsSync, linkSync, unlinkSync, statSync } from 'fs'

function resolveHostExe(): string {
  const override = process.env.WEPORT_WCDB_HOST_EXE
  if (override && existsSync(override)) return override

  const target = process.execPath
  const hostName = process.platform === 'win32' ? 'WeFlow.exe' : 'WeFlow'
  const hostPath = join(dirname(target), hostName)

  // 已存在且大小+修改时间一致 → 直接复用（覆盖安装/更新后 exe 变化则重建链接；
  // 只比大小会漏掉「新 exe 与旧版本恰好同尺寸」的更新——硬链接指向的仍是旧文件）
  const needRefresh = (() => {
    try {
      const s = statSync(hostPath)
      const t = statSync(target)
      return s.size !== t.size || Math.floor(s.mtimeMs) !== Math.floor(t.mtimeMs)
    } catch {
      return true
    }
  })()
  if (needRefresh) {
    try {
      if (existsSync(hostPath)) unlinkSync(hostPath)
      linkSync(target, hostPath)
    } catch (e) {
      throw new Error(
        `无法创建 WCDB 宿主进程 (${hostPath}): ${String((e as Error)?.message || e)}。` +
        '请确认安装目录可写（Windows: NTFS / macOS: APFS），或以管理员身份运行。'
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
    const resourcesPath = process.env.WEPORT_RESOURCES_PATH || ''
    const extraPathParts: string[] = [exeDir]
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
