import { app } from 'electron'
import { basename, join } from 'path'
import { existsSync, readdirSync, statSync, readFileSync } from 'fs'
import { execFile, exec, spawn } from 'child_process'
import { promisify } from 'util'
import crypto from 'crypto'
import { createRequire } from 'module';
const require = createRequire(__filename);

const execFileAsync = promisify(execFile)
const execAsync = promisify(exec)

type DbKeyResult = { success: boolean; key?: string; error?: string; logs?: string[] }
type ImageKeyResult = { success: boolean; xorKey?: number; aesKey?: string; verified?: boolean; error?: string }

export class KeyServiceLinux {
  private sudo: any
  /** Process names used by native, UOS and Flatpak WeChat builds. */
  private readonly wechatProcessNames = ['xwechat', 'wechat-uos', 'weixin', 'wechat', 'wechat-bin']
  /** Ordered launch candidates.  At most one candidate is ever started. */
  private readonly wechatLaunchCandidates = [
    { command: 'xwechat', args: [], label: 'xwechat' },
    { command: 'wechat-uos', args: [], label: 'wechat-uos' },
    { command: 'weixin', args: [], label: 'weixin' },
    { command: 'wechat', args: [], label: 'wechat' },
    { command: 'wechat-bin', args: [], label: 'wechat-bin' },
    { command: '/opt/wechat/wechat', args: [], label: '/opt/wechat/wechat' },
    { command: '/opt/apps/com.tencent.wechat/files/wechat', args: [], label: 'UOS WeChat' },
    { command: '/usr/bin/wechat', args: [], label: '/usr/bin/wechat' },
    { command: '/usr/local/bin/wechat', args: [], label: '/usr/local/bin/wechat' },
    { command: '/usr/bin/wechat-bin', args: [], label: '/usr/bin/wechat-bin' },
    { command: '/usr/local/bin/wechat-bin', args: [], label: '/usr/local/bin/wechat-bin' },
    { command: 'flatpak', args: ['run', 'com.tencent.WeChat'], label: 'Flatpak com.tencent.WeChat' },
  ]

  constructor() {
    try {
      this.sudo = require('@vscode/sudo-prompt');
    } catch (e) {
      console.error('Failed to load @vscode/sudo-prompt', e);
    }
  }

  private getCommandEnvironment(): NodeJS.ProcessEnv {
    const pathEntries = [
      ...(process.env.PATH || '').split(':').filter(Boolean),
      '/bin',
      '/usr/bin',
      '/sbin',
      '/usr/sbin',
      '/usr/local/bin',
    ]
    return {
      ...process.env,
      PATH: [...new Set(pathEntries)].join(':'),
    }
  }

  private parsePidOutput(stdout: string): number[] {
    return String(stdout || '')
      .split(/\s+/)
      .map((value) => Number.parseInt(value, 10))
      .filter((pid) => Number.isInteger(pid) && pid > 0)
  }

  /**
   * Find exact WeChat process names without shell interpolation.  `pgrep -x`
   * is preferred; the `ps` fallback keeps this working on minimal distros
   * where pgrep is not installed.
   */
  private async findWeChatPids(env: NodeJS.ProcessEnv): Promise<number[]> {
    const found = new Set<number>()
    const pgrepPaths = ['/usr/bin/pgrep', '/bin/pgrep']

    for (const pgrepPath of pgrepPaths) {
      if (!existsSync(pgrepPath)) continue
      for (const name of this.wechatProcessNames) {
        try {
          const { stdout } = await execFileAsync(pgrepPath, ['-x', name], { env })
          for (const pid of this.parsePidOutput(stdout)) found.add(pid)
        } catch {
          // Exit code 1 means the exact name is not running.
        }
      }
      if (found.size > 0) break
    }

    if (found.size === 0) {
      try {
        const psPath = existsSync('/bin/ps') ? '/bin/ps' : '/usr/bin/ps'
        const { stdout } = await execFileAsync(psPath, ['-A', '-o', 'pid=,comm='], { env })
        for (const line of String(stdout || '').split(/\r?\n/)) {
          const match = line.trim().match(/^(\d+)\s+(\S+)$/)
          if (!match) continue
          const pid = Number.parseInt(match[1], 10)
          const comm = basename(match[2])
          if (this.wechatProcessNames.includes(comm) && pid > 0) found.add(pid)
        }
      } catch {
        // Report no process; the caller provides the actionable message.
      }
    }

    return [...found].sort((a, b) => a - b)
  }

  private async findWeChatPid(env: NodeJS.ProcessEnv): Promise<number | null> {
    const pids = await this.findWeChatPids(env)
    if (pids.length === 0) return null

    // Prefer an oldest root process over a newer helper/renderer with the same
    // executable name. Picking the highest PID commonly attaches to a child.
    const pidSet = new Set(pids)
    for (const pid of pids) {
      try {
        const status = readFileSync(`/proc/${pid}/status`, 'utf8')
        const parentPid = Number.parseInt(status.match(/^PPid:\s*(\d+)/m)?.[1] || '0', 10)
        if (!pidSet.has(parentPid)) return pid
      } catch {
        // Fall through to the oldest discovered PID when /proc is restricted.
      }
    }
    return pids[0]
  }

  private resolveExecutable(command: string, env: NodeJS.ProcessEnv): string | null {
    if (command.includes('/')) {
      try {
        if (existsSync(command) && (statSync(command).mode & 0o111) !== 0) return command
      } catch { }
      return null
    }

    for (const directory of String(env.PATH || '').split(':').filter(Boolean)) {
      const candidate = join(directory, command)
      try {
        if (existsSync(candidate) && (statSync(candidate).mode & 0o111) !== 0) return candidate
      } catch { }
    }
    return null
  }

  /** Start one known client only when no exact-name process is already alive. */
  private launchOneWeChat(env: NodeJS.ProcessEnv, onStatus?: (message: string, level: number) => void): boolean {
    const candidate = this.wechatLaunchCandidates.find((item) => this.resolveExecutable(item.command, env))
    if (!candidate) return false

    const executable = this.resolveExecutable(candidate.command, env)
    if (!executable) return false

    const cleanEnv = { ...env }
    delete cleanEnv.ELECTRON_RUN_AS_NODE
    delete cleanEnv.ELECTRON_NO_ATTACH_CONSOLE
    delete cleanEnv.APPDIR
    delete cleanEnv.APPIMAGE

    try {
      const child = spawn(executable, candidate.args, {
        detached: true,
        stdio: 'ignore',
        env: cleanEnv,
      })
      child.once('error', (error) => {
        console.warn(`[KeyServiceLinux] 启动 ${candidate.label} 失败:`, error.message)
      })
      child.unref()
      console.log(`[KeyServiceLinux] 已尝试启动单个微信客户端: ${candidate.label}`)
      onStatus?.(`正在启动微信客户端（${candidate.label}）...`, 0)
      return true
    } catch (error: any) {
      console.warn(`[KeyServiceLinux] 启动 ${candidate.label} 发生异常:`, error?.message || error)
      return false
    }
  }

  private getWcdbLibraryPath(): string {
    const archDir = process.arch === 'arm64' ? 'arm64' : 'x64'
    const resourcesRoot = app.isPackaged
      ? join(process.resourcesPath, 'resources')
      : join(app.getAppPath(), 'resources')
    return join(resourcesRoot, 'wcdb', 'linux', archDir, 'libwcdb_api.so')
  }

  /**
   * Return actionable diagnostics before invoking a native helper.  Missing
   * execute bits and dynamic libraries otherwise surface as opaque EACCES or
   * ELF loader errors from child_process.
   */
  private async getLinuxRuntimeDiagnostics(checkPtrace = false): Promise<{ fatal: string[]; warnings: string[] }> {
    const fatal: string[] = []
    const warnings: string[] = []
    let helperPath: string | null = null

    try {
      helperPath = this.getHelperPath()
      const mode = statSync(helperPath).mode
      if ((mode & 0o111) === 0) {
        fatal.push(`xkey_helper_linux 没有执行权限：${helperPath}（可尝试 chmod +x）`)
      }
    } catch (error: any) {
      fatal.push(String(error?.message || '找不到 xkey_helper_linux'))
    }

    const env = this.getCommandEnvironment()
    const ldd = this.resolveExecutable('ldd', env)
    if (ldd) {
      const targets = [helperPath, this.getWcdbLibraryPath()].filter((value): value is string => !!value && existsSync(value))
      for (const target of targets) {
        const recordLddFailures = (output: string) => {
          const missing = output
            .split(/\r?\n/)
            .map((line) => line.match(/^\s*([^\s]+)\s*=>\s*not found\s*$/)?.[1])
            .filter((name): name is string => !!name)
          for (const name of [...new Set(missing)]) {
            fatal.push(`${name} 未找到（请安装对应系统运行库）`)
          }
          for (const match of output.matchAll(/version\s+([A-Za-z0-9_.+-]+)\s+not found/gi)) {
            fatal.push(`${match[1]} 版本不兼容（请升级 glibc/libstdc++/OpenSSL）`)
          }
        }
        try {
          const { stdout, stderr } = await execFileAsync(ldd, [target], { env, maxBuffer: 256 * 1024 })
          recordLddFailures(`${stdout || ''}\n${stderr || ''}`)
        } catch (error: any) {
          // ldd can return non-zero for an incompatible ELF while still
          // printing useful diagnostics; keep the child invocation as the
          // final authority and only expose a bounded warning here.
          const detail = String(error?.stdout || error?.stderr || '').trim()
          recordLddFailures(detail)
          if (detail) warnings.push(`ldd 检查 ${target}：${detail.split(/\r?\n/)[0]}`)
        }
      }
    } else {
      warnings.push('系统未找到 ldd，无法预检 Linux 原生依赖')
    }

    if (checkPtrace) {
      try {
        const scope = Number.parseInt(readFileSync('/proc/sys/kernel/yama/ptrace_scope', 'utf8').trim(), 10)
        if (scope >= 3) {
          fatal.push('Yama ptrace_scope=3 禁止进程附加；请改用缓存密钥或在确认安全风险后调整内核策略')
        } else if (scope >= 2) {
          warnings.push(`Yama ptrace_scope=${scope} 需要 CAP_SYS_PTRACE，管理员授权可能仍被策略拒绝`)
        } else if (scope === 1) {
          warnings.push('Yama ptrace_scope=1 仅允许受信任的进程附加，若 Hook 被拒绝请检查调试权限')
        }
      } catch {
        // Non-Yama kernels or restricted containers simply omit this hint.
      }
    }

    return { fatal: [...new Set(fatal)], warnings: [...new Set(warnings)] }
  }

  private getHelperPath(): string {
    const isPackaged = app.isPackaged
    const archDir = process.arch === 'arm64' ? 'arm64' : 'x64'
    const candidates: string[] = []
    if (process.env.WX_KEY_HELPER_PATH) candidates.push(process.env.WX_KEY_HELPER_PATH)
    if (isPackaged) {
      candidates.push(join(process.resourcesPath, 'resources', 'key', 'linux', archDir, 'xkey_helper_linux'))
      candidates.push(join(process.resourcesPath, 'resources', 'key', 'linux', 'x64', 'xkey_helper_linux'))
      candidates.push(join(process.resourcesPath, 'resources', 'key', 'linux', 'xkey_helper_linux'))
      candidates.push(join(process.resourcesPath, 'resources', 'xkey_helper_linux'))
      candidates.push(join(process.resourcesPath, 'xkey_helper_linux'))
    } else {
      candidates.push(join(app.getAppPath(), 'resources', 'key', 'linux', archDir, 'xkey_helper_linux'))
      candidates.push(join(app.getAppPath(), 'resources', 'key', 'linux', 'x64', 'xkey_helper_linux'))
      candidates.push(join(app.getAppPath(), 'resources', 'key', 'linux', 'xkey_helper_linux'))
      candidates.push(join(app.getAppPath(), 'resources', 'xkey_helper_linux'))
      candidates.push(join(process.cwd(), 'resources', 'key', 'linux', archDir, 'xkey_helper_linux'))
      candidates.push(join(process.cwd(), 'resources', 'key', 'linux', 'x64', 'xkey_helper_linux'))
      candidates.push(join(process.cwd(), 'resources', 'key', 'linux', 'xkey_helper_linux'))
      candidates.push(join(app.getAppPath(), '..', 'Xkey', 'build', 'xkey_helper_linux'))
    }
    for (const p of candidates) {
      if (existsSync(p)) return p
    }
    throw new Error('找不到 xkey_helper_linux，请检查路径')
  }

  public async autoGetDbKey(
      timeoutMs = 60_000,
      onStatus?: (message: string, level: number) => void
  ): Promise<DbKeyResult> {
    try {
      const diagnostics = await this.getLinuxRuntimeDiagnostics(true)
      diagnostics.warnings.forEach((warning) => onStatus?.(`Linux 环境提示：${warning}`, 0))
      if (diagnostics.fatal.length > 0) {
        const error = `Linux 原生组件无法运行：${diagnostics.fatal.join('；')}`
        onStatus?.(error, 2)
        return { success: false, error }
      }

      const envWithPath = this.getCommandEnvironment()
      onStatus?.('正在查找已运行的微信进程...', 0)
      let pid = await this.findWeChatPid(envWithPath)

      if (!pid) {
        onStatus?.('未检测到微信，尝试启动一个可用客户端...', 0)
        const launched = this.launchOneWeChat(envWithPath, onStatus)
        if (!launched) {
          onStatus?.('未找到可自动启动的微信客户端，请先手动启动并登录微信。', 2)
        }
      }

      if (!pid) {
        onStatus?.('等待微信进程出现...', 0)
        for (let i = 0; i < 15; i++) { // 最多等 15 秒
          await new Promise(r => setTimeout(r, 1000))
          pid = await this.findWeChatPid(envWithPath)
          if (pid) {
            console.log(`[KeyServiceLinux] 第 ${i + 1} 秒检测到微信 PID=${pid}`)
            break
          }
        }
      }

      if (!pid) {
        const err = '未检测到微信主进程。请先启动并登录微信，再重试密钥获取。'
        onStatus?.(err, 2)
        return { success: false, error: err }
      }

      onStatus?.(`捕获到微信 PID: ${pid}，准备获取密钥...`, 0)

      await new Promise(r => setTimeout(r, 2000))

      return await this.getDbKey(pid, onStatus, timeoutMs)
    } catch (err: any) {
      console.error('[Debug] 自动获取流程彻底崩溃:', err);
      const errMsg = '自动获取微信 PID 失败: ' + err.message
      onStatus?.(errMsg, 2)
      return { success: false, error: errMsg }
    }
  }

  public async getDbKey(pid: number, onStatus?: (message: string, level: number) => void, timeoutMs = 180_000): Promise<DbKeyResult> {
    try {
      const helperPath = this.getHelperPath()

      onStatus?.('正在扫描数据库基址...', 0)
      const { stdout: scanOut } = await execFileAsync(helperPath, ['db_scan', pid.toString()])
      const scanRes = JSON.parse(scanOut.trim())

      if (!scanRes.success) {
        const err = scanRes.result || '扫描失败，请确保微信已完全登录'
        onStatus?.(err, 2)
        return { success: false, error: err }
      }

      const targetAddr = scanRes.target_addr
      onStatus?.('基址扫描成功，正在请求管理员权限进行内存 Hook...', 0)

      if (!this.sudo || typeof this.sudo.exec !== 'function') {
        const err = 'Linux 授权组件 @vscode/sudo-prompt 未加载，请确认依赖已安装并重新启动 Weport'
        onStatus?.(err, 2)
        return { success: false, error: err }
      }

      return await new Promise((resolve) => {
        const options = {
          name: 'Weport',
          env: {
            PATH: `${process.env.PATH || ''}:/bin:/usr/bin:/sbin:/usr/sbin:/usr/local/bin`
          }
        }
        const timeoutSec = Math.ceil((timeoutMs + 15_000) / 1000)
        const command = `timeout -k 5s ${timeoutSec}s "${helperPath}" db_hook ${pid} ${targetAddr} ${timeoutMs}`
        let settled = false
        const finish = (result: DbKeyResult) => {
          if (settled) return
          settled = true
          clearTimeout(watchdog)
          resolve(result)
        }
        const watchdog = setTimeout(() => {
          execAsync(`kill -CONT ${pid}`).catch(() => {})
          const err = `Hook 等待超时（${Math.round(timeoutMs / 1000)} 秒）。请确认微信登录确认已完成，或重启微信后重试。`
          onStatus?.(err, 2)
          finish({ success: false, error: err })
        }, timeoutMs + 30_000)

        onStatus?.('授权通过后请在手机上确认登录微信，正在等待密钥回调...', 0)

        this.sudo.exec(command, options, (error: Error | null, stdout: string, stderr: string) => {
          execAsync(`kill -CONT ${pid}`).catch(() => {})
          if (error) {
            const detail = String(stderr || '').trim()
            const message = detail ? `${error.message}: ${detail}` : error.message
            onStatus?.('授权失败或 Hook 执行失败', 2)
            finish({ success: false, error: `授权失败或 Hook 执行失败: ${message}` })
            return
          }
          try {
            const output = String(stdout || '').trim()
            if (!output) {
              const detail = String(stderr || '').trim()
              throw new Error(detail ? `Hook 无输出: ${detail}` : 'Hook 无输出')
            }
            const hookRes = JSON.parse(output)
            if (hookRes.success) {
              onStatus?.('密钥获取成功', 1)
              finish({ success: true, key: hookRes.key })
            } else {
              onStatus?.(hookRes.result, 2)
              finish({ success: false, error: hookRes.result })
            }
          } catch (e: any) {
            onStatus?.('解析 Hook 结果失败', 2)
            finish({ success: false, error: e?.message || '解析 Hook 结果失败' })
          }
        })
      })
    } catch (err: any) {
      onStatus?.(err.message, 2)
      return { success: false, error: err.message }
    }
  }

  public async autoGetImageKey(
      accountPath?: string,
      onProgress?: (msg: string) => void,
      wxid?: string
  ): Promise<ImageKeyResult> {
    try {
      const diagnostics = await this.getLinuxRuntimeDiagnostics(false)
      if (diagnostics.fatal.length > 0) {
        return { success: false, error: `Linux 原生组件无法运行：${diagnostics.fatal.join('；')}` }
      }
      onProgress?.('正在初始化缓存扫描...');
      const helperPath = this.getHelperPath()
      const { stdout } = await execFileAsync(helperPath, ['image_local'])
      const res = JSON.parse(stdout.trim())
      if (!res.success) return { success: false, error: res.result }

      const accounts = res.data.accounts || []
      let account = accounts.find((a: any) => a.wxid === wxid)
      if (!account && accounts.length > 0) account = accounts[0]

      if (account && account.keys && account.keys.length > 0) {
        onProgress?.(`已找到匹配的图片密钥 (wxid: ${account.wxid})`);
        const keyObj = account.keys[0]
        const aesKey = String(keyObj.aesKey || '')
        const verified = await this.verifyImageKeyByTemplate(accountPath, aesKey)
        if (verified === true) {
          onProgress?.('缓存密钥校验成功，已确认可用')
        } else if (verified === false) {
          onProgress?.('已从缓存计算密钥，但未通过本地模板校验')
        }
        return { success: true, xorKey: keyObj.xorKey, aesKey, verified: verified === true }
      }
      return { success: false, error: '未在缓存中找到匹配的图片密钥' }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  }

  private async verifyImageKeyByTemplate(accountPath: string | undefined, aesKey: string): Promise<boolean | null> {
    const normalizedPath = String(accountPath || '').trim()
    if (!normalizedPath || !aesKey || aesKey.length < 16 || !existsSync(normalizedPath)) return null
    try {
      const template = await this._findTemplateData(normalizedPath, 32)
      if (!template.ciphertext) return null
      return this.verifyDerivedAesKey(aesKey, template.ciphertext)
    } catch {
      return null
    }
  }

  private verifyDerivedAesKey(aesKey: string, ciphertext: Buffer): boolean {
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

  public async autoGetImageKeyByMemoryScan(
      accountPath: string,
      onProgress?: (msg: string) => void
  ): Promise<ImageKeyResult> {
    try {
      const diagnostics = await this.getLinuxRuntimeDiagnostics(true)
      diagnostics.warnings.forEach((warning) => onProgress?.(`Linux 环境提示：${warning}`))
      if (diagnostics.fatal.length > 0) {
        return { success: false, error: `Linux 原生组件无法运行：${diagnostics.fatal.join('；')}` }
      }
      onProgress?.('正在查找模板文件...')
      let result = await this._findTemplateData(accountPath, 32)
      let { ciphertext, xorKey } = result

      if (ciphertext && xorKey === null) {
        onProgress?.('未找到有效密钥，尝试扫描更多文件...')
        result = await this._findTemplateData(accountPath, 100)
        xorKey = result.xorKey
      }

      if (!ciphertext) return { success: false, error: '未找到 V2 模板文件，请先在微信中查看几张图片' }
      if (xorKey === null) return { success: false, error: '未能从模板文件中计算出有效的 XOR 密钥' }

      onProgress?.(`XOR 密钥: 0x${xorKey.toString(16).padStart(2, '0')}，正在查找微信进程...`)

      // 2. 找微信 PID（仅匹配已知的精确进程名，避免 shell 注入/误匹配）
      const pid = await this.findWeChatPid(this.getCommandEnvironment())
      if (!pid) return { success: false, error: '微信未运行，无法扫描内存' }

      onProgress?.(`已找到微信进程 PID=${pid}，正在提权扫描进程内存...`);

      // 3. 将 Buffer 转换为 hex 传递给 helper
      const ciphertextHex = ciphertext.toString('hex')
      const helperPath = this.getHelperPath()

      try {
        console.log(`[Debug] 准备执行 Helper: ${helperPath} image_mem ${pid} ${ciphertextHex}`);

        const { stdout: memOut, stderr } = await execFileAsync(helperPath, ['image_mem', pid.toString(), ciphertextHex])

        console.log(`[Debug] Helper stdout: ${memOut}`);
        if (stderr) {
          console.warn(`[Debug] Helper stderr: ${stderr}`);
        }

        if (!memOut || memOut.trim() === '') {
          return { success: false, error: 'Helper 返回为空，请检查是否有足够的权限(如需sudo)读取进程内存。' }
        }

        const res = JSON.parse(memOut.trim())

        if (res.success) {
          onProgress?.('内存扫描成功');
          return { success: true, xorKey, aesKey: res.key }
        }
        return { success: false, error: res.result || '未知错误' }

      } catch (err: any) {
        console.error('[Debug] 执行或解析 Helper 时发生崩溃:', err);
        return {
          success: false,
          error: `内存扫描失败: ${err.message}\nstdout: ${err.stdout || '无'}\nstderr: ${err.stderr || '无'}`
        }
      }
    } catch (err: any) {
      return { success: false, error: `内存扫描失败: ${err.message}` }
    }
  }

  private async _findTemplateData(userDir: string, limit: number = 32): Promise<{ ciphertext: Buffer | null; xorKey: number | null }> {
    const V2_MAGIC = Buffer.from([0x07, 0x08, 0x56, 0x32, 0x08, 0x07])

    // 递归收集 *_t.dat 文件
    const collect = (dir: string, results: string[], maxFiles: number) => {
      if (results.length >= maxFiles) return
      try {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          if (results.length >= maxFiles) break
          const full = join(dir, entry.name)
          if (entry.isDirectory()) collect(full, results, maxFiles)
          else if (entry.isFile() && entry.name.endsWith('_t.dat')) results.push(full)
        }
      } catch { /* 忽略无权限目录 */ }
    }

    const files: string[] = []
    collect(userDir, files, limit)

    // 按修改时间降序
    files.sort((a, b) => {
      try { return statSync(b).mtimeMs - statSync(a).mtimeMs } catch { return 0 }
    })

    let ciphertext: Buffer | null = null
    const tailCounts: Record<string, number> = {}

    for (const f of files.slice(0, 32)) {
      try {
        const data = readFileSync(f)
        if (data.length < 8) continue

        // 统计末尾两字节用于 XOR 密钥
        if (data.subarray(0, 6).equals(V2_MAGIC) && data.length >= 2) {
          const key = `${data[data.length - 2]}_${data[data.length - 1]}`
          tailCounts[key] = (tailCounts[key] ?? 0) + 1
        }

        // 提取密文（取第一个有效的）
        if (!ciphertext && data.subarray(0, 6).equals(V2_MAGIC) && data.length >= 0x1F) {
          ciphertext = data.subarray(0xF, 0x1F)
        }
      } catch { /* 忽略 */ }
    }

    // 计算 XOR 密钥
    let xorKey: number | null = null
    let maxCount = 0
    for (const [key, count] of Object.entries(tailCounts)) {
      if (count > maxCount) {
        maxCount = count
        const [x, y] = key.split('_').map(Number)
        const k = x ^ 0xFF
        if (k === (y ^ 0xD9)) xorKey = k
      }
    }

    return { ciphertext, xorKey }
  }
}
