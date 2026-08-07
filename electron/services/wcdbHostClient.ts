/**
 * WCDB 宿主进程客户端（替代 worker_threads 的传输层）。
 *
 * wcdb_api.dll 的 -1006 安全检查要求宿主可执行文件名为 WeFlow.exe。
 * 方案：在当前 exe 同目录创建硬链接 WeFlow.exe -> 当前 exe（NTFS 零磁盘开销，
 * 与 exe 同目录可复用 electron.dll / resources），再以 --wcdb-host 参数启动。
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
  const hostPath = join(dirname(target), 'WeFlow.exe')

  // 已存在且大小一致 → 直接复用（覆盖安装/更新后 exe 大小变化则重建链接）
  const needRefresh = (() => {
    try {
      return !existsSync(hostPath) || statSync(hostPath).size !== statSync(target).size
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
        '请确认安装目录可写（NTFS），或以管理员身份运行。'
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
    // 打包版：不带 app 路径（加载 exe 旁默认 app）；开发版：显式传项目根目录
    const args: string[] = []
    if (process.env.WEPORT_DEV_MODE === '1') {
      args.push(process.cwd())
    }
    args.push('--wcdb-host')

    const exeDir = dirname(hostExe)
    const resourcesPath = process.env.WEPORT_RESOURCES_PATH || ''
    const extraPathParts: string[] = [exeDir]
    if (resourcesPath) {
      extraPathParts.push(join(resourcesPath, 'wcdb', process.platform, process.arch))
      extraPathParts.push(join(resourcesPath, 'runtime', process.platform))
    }

    this.child = spawn(hostExe, args, {
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      windowsHide: true,
      env: {
        ...process.env,
        WEFLOW_WORKER: '1',
        WEFLOW_USER_DATA_PATH: process.env.WEPORT_USER_DATA_PATH || '',
        WEFLOW_CONFIG_CWD: process.env.WEPORT_USER_DATA_PATH || '',
        PATH: [...extraPathParts, process.env.PATH || ''].filter(Boolean).join(delimiter)
      }
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

  postMessage(msg: any): void {
    if (!this.child || this.child.killed) {
      this.emit('error', new Error('WCDB 宿主进程不可用'))
      return
    }
    this.child.send(msg)
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
