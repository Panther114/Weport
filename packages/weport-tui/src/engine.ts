/**
 * JSON-RPC client for the Weport TUI engine.
 *
 * The engine is a Weport process started with `--cli`: it opens the same services
 * the GUI uses and answers commands over its IPC channel. The client here owns the
 * protocol (ids, handshake, shutdown) so the UI only ever sees `call(name, args)`.
 *
 * Why IPC instead of stdin/stdout: on Windows Electron's main-process stdin hits
 * EOF immediately, so a pipe-based JSON protocol silently loses messages. The
 * child's stdout is left inherited, which keeps engine logs visible in the
 * terminal — useful when a command fails for a reason only the main process sees.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'

export interface EngineInfo {
  version: string
  pid: number
  dbPath?: string
}

interface Pending {
  resolve: (value: { success: boolean; data?: unknown; error?: string; text?: string }) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

export class EngineUnavailable extends Error {}

export class WeportEngine {
  private child: ChildProcess | null = null
  private pending = new Map<string, Pending>()
  readonly token = randomUUID()
  info: EngineInfo | null = null

  constructor(private readonly exe: string, private readonly cwd?: string) {}

  async start(timeoutMs = 45000): Promise<EngineInfo> {
    if (this.info) return this.info
    const child = spawn(this.exe, ['--cli', '--disable-gpu', '--weport-token', this.token], {
      // 'inherit' for the standard streams would put engine logs on top of the TUI;
      // they are still useful, so stderr is piped and shown in the log pane. stdin
      // is ignored — nothing on the engine side reads it (that is the documented
      // Windows EOF trap). The extra 'ipc' entry is the actual channel.
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      windowsHide: true,
      cwd: this.cwd,
      env: { ...process.env, WEPORT_CLI_TOKEN: this.token },
    })
    this.child = child
    child.stdout?.on('data', (chunk: Buffer) => this.emitLog(chunk.toString('utf8')))
    child.stderr?.on('data', (chunk: Buffer) => this.emitLog(chunk.toString('utf8')))

    child.on('message', (raw: unknown) => this.onMessage(raw))
    child.on('exit', (code) => {
      this.child = null
      this.info = null
      const error = new EngineUnavailable(`引擎已退出（code=${code ?? 'null'}）`)
      for (const [id, entry] of this.pending) {
        clearTimeout(entry.timer)
        entry.reject(error)
        this.pending.delete(id)
      }
      this.onExit?.(code)
    })

    const ready = new Promise<EngineInfo>((resolve, reject) => {
      const timer = setTimeout(() => reject(new EngineUnavailable('引擎启动超时')), timeoutMs)
      this.readyResolve = (info) => {
        clearTimeout(timer)
        resolve(info)
      }
      this.readyReject = (error) => {
        clearTimeout(timer)
        reject(error)
      }
    })
    child.send?.({ kind: 'hello', token: this.token })
    return ready
  }

  private readyResolve: ((info: EngineInfo) => void) | null = null
  private readyReject: ((error: Error) => void) | null = null

  /** Engine stdout/stderr lines, forwarded to the TUI's log pane. */
  onLog: ((line: string) => void) | null = null
  onExit: ((code: number | null) => void) | null = null

  private emitLog(text: string): void {
    if (!this.onLog) return
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim()
      if (trimmed) this.onLog(trimmed)
    }
  }

  private onMessage(raw: unknown): void {
    const message = raw as { id?: string; kind?: string; success?: boolean; data?: unknown; error?: string; text?: string; version?: string; pid?: number; dbPath?: string }
    if (message.kind === 'ready') {
      this.info = { version: String(message.version || ''), pid: Number(message.pid) || 0, dbPath: message.dbPath }
      this.readyResolve?.(this.info)
      return
    }
    if (message.kind === 'error') {
      this.readyReject?.(new EngineUnavailable(String(message.error || '引擎拒绝握手')))
      return
    }
    if (!message.id) return
    const entry = this.pending.get(message.id)
    if (!entry) return
    this.pending.delete(message.id)
    clearTimeout(entry.timer)
    entry.resolve({ success: message.success !== false, data: message.data, error: message.error, text: message.text })
  }

  async call(command: string, args: Record<string, unknown> = {}, timeoutMs = 600000): Promise<{ success: boolean; data?: unknown; error?: string; text?: string }> {
    const child = this.child
    if (!child?.connected) throw new EngineUnavailable('引擎未连接')
    const id = randomUUID()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`命令超时：${command}`))
      }, timeoutMs)
      timer.unref?.()
      this.pending.set(id, { resolve, reject, timer })
      child.send?.({ kind: 'call', id, command, args })
    })
  }

  stop(): void {
    try { this.child?.send?.({ kind: 'bye' }) } catch { /* ignore */ }
    const child = this.child
    this.child = null
    // The engine exits on its own; kill only as a backstop so a wedged native call
    // cannot hold the terminal hostage.
    setTimeout(() => { try { child?.kill() } catch { /* ignore */ } }, 1500).unref?.()
  }
}
