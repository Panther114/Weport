import { Worker } from 'node:worker_threads'

export interface WeBotMessageTrigger {
  kind: 'message'
  pattern: string
  flags: string
  cooldownSeconds: number
  accountId: string
}

export function normalizeMessageTrigger(input: WeBotMessageTrigger, accountId: string): WeBotMessageTrigger {
  if (!accountId) throw new Error('请先连接账号，再创建消息触发任务。')
  const pattern = String(input.pattern || '')
  const flags = String(input.flags || '')
  if (!pattern || pattern.length > 512) throw new Error('正则表达式须为 1–512 个字符。')
  if (!/^[imsu]*$/.test(flags) || new Set(flags).size !== flags.length) throw new Error('正则标志仅支持不重复的 i、m、s、u。')
  try { new RegExp(pattern, flags) } catch { throw new Error('正则表达式无效。') }
  return { kind: 'message', pattern, flags, cooldownSeconds: Math.max(1, Math.min(86400, Math.floor(Number(input.cooldownSeconds) || 60))), accountId }
}

/** An isolated, reused worker bounds regex execution without blocking Electron. */
export class BoundedRegexMatcher {
  private worker: Worker | null = null
  private ready: Promise<void> | null = null
  private queue: Promise<unknown> = Promise.resolve()
  private closed = false

  match(pattern: string, flags: string, text: string): Promise<boolean> {
    const result = this.queue.then(() => this.execute(pattern, flags, text))
    this.queue = result.catch(() => undefined)
    return result
  }

  private async execute(pattern: string, flags: string, text: string): Promise<boolean> {
    if (this.closed) throw new Error('消息匹配器已停止。')
    if (text.length > 1048576) throw new Error('消息超过正则匹配长度上限，请缩小来源范围。')
    if (!this.worker) {
      const worker = new Worker(`const { parentPort } = require('node:worker_threads'); parentPort.on('message', ({ pattern, flags, text }) => { try { parentPort.postMessage({ matched: new RegExp(pattern, flags).test(text) }); } catch(error) { parentPort.postMessage({ error: String(error) }); } });`, { eval: true, resourceLimits: { maxOldGenerationSizeMb: 32, stackSizeMb: 2 } })
      this.worker = worker
      this.ready = new Promise((resolve, reject) => {
        const finish = () => { clearTimeout(timer); worker.off('online', online); worker.off('error', failed); worker.off('exit', exited) }
        const online = () => { finish(); resolve() }
        const failed = (error: Error) => { finish(); reject(error) }
        const exited = () => failed(new Error('消息匹配器已停止。'))
        const timer = setTimeout(() => { failed(new Error('消息匹配器启动超时。')); void worker.terminate() }, 2000)
        worker.once('online', online); worker.once('error', failed); worker.once('exit', exited)
      })
      worker.on('error', () => { if (this.worker === worker) { this.worker = null; this.ready = null } })
      worker.unref()
    }
    const worker = this.worker
    await this.ready
    if (this.closed || !worker) throw new Error('消息匹配器已停止。')
    return new Promise<boolean>((resolve, reject) => {
      const finish = () => { clearTimeout(timer); worker.off('message', onMessage); worker.off('error', onError); worker.off('exit', onExit); worker.unref() }
      const onError = (error: Error) => { finish(); reject(error) }
      const onExit = () => onError(new Error('消息匹配器已停止。'))
      const onMessage = (result: { matched?: boolean; error?: string }) => { finish(); result.error ? reject(new Error(result.error)) : resolve(result.matched === true) }
      const timer = setTimeout(() => {
        finish()
        if (this.worker === worker) { this.worker = null; this.ready = null }
        void worker.terminate()
        reject(new Error('正则匹配超时，请简化表达式。'))
      }, 100)
      worker.ref()
      worker.once('message', onMessage)
      worker.once('error', onError)
      worker.once('exit', onExit)
      worker.postMessage({ pattern, flags, text })
    })
  }

  close(): void { this.closed = true; if (this.worker) void this.worker.terminate(); this.worker = null }
}
