/**
 * 原子写（v1.2 §10.1 ①）。
 *
 * 所有导出产物都必须走这条路径：**先写同目录临时文件 → fsync → 同卷原子替换**。
 *
 * 为什么必须是同目录：替换的原子性只在同一卷内成立（跨卷退化成"复制 + 删除"，
 * 中断就留下半截文件）。为什么必须 fsync：替换只保证"目录项切换"原子，
 * 不保证数据已落盘 —— 断电后可能出现"文件名换了、内容是空/半截"的文件，
 * 正是 §10.1 要消灭的"看起来完成"的目录。
 *
 * 关于 `os.replace`（**实现说明，踩过的坑**）：§10.1 写的是 `os.replace`，
 * 但 Node 的 `os` 模块**没有** `replace` 这个导出 —— 实测 `node -p "Object.keys(require('os'))"`
 * 里根本没有它（顺带一提，Python 的 `os.replace` 才是那个 API，容易串台）。
 * 真正等价的是 `fs.promises.rename`：POSIX 上就是 `rename(2)`，
 * Windows 上映射到 `MoveFileEx(..., MOVEFILE_REPLACE_EXISTING)`，
 * 与 `os.replace` 语义一致（覆盖已存在的目标、同卷原子）。
 * 注意**不能**用 `fs.rename` 的同步版做"先删再改名"来凑：那会在两次系统调用之间
 * 留出一个"目标不存在"的窗口，正是要消灭的半截状态。
 *
 * 约定：临时文件名 `<target>.tmp-<pid>`（§10.1 明确要求这个形状；并发写同一目标时
 * 再加一个进程内序号 `<target>.tmp-<pid>-<n>`，理由见 `nextTempPathFor`），
 * 失败/中止一律删除临时文件。
 */
import * as fs from 'fs'
import * as path from 'path'

/** 临时文件后缀：`<target>.tmp-<pid>`（与 §10.1 的约定一致，便于人工辨认与清理）。 */
export function tempPathFor(targetPath: string, pid: number = process.pid): string {
  return `${targetPath}.tmp-${pid}`
}

/**
 * 进程内唯一的临时文件序号。
 *
 * 为什么必须有：同一个目标路径可能被**并发**写入（导出器按会话并发跑，两个会话在
 * 极端情况会算出同一份产物名；媒体导出也会并发）。如果两个写者共用
 * `<target>.tmp-<pid>`，就是经典的 tmp 撞名：先提交的那个把临时文件改名走了，
 * 后一个的 `os.replace` 直接 ENOENT（实测：`rename '会话5.txt.tmp-10948' -> '会话5.txt'`
 * 失败、目录里留下一个孤零零的 `.tmp-10948`）。加一个进程内序号即可彻底消除，
 * 同时仍然是 §10.1 要求的 `.tmp-<pid>` 形状（清理逻辑按 `/\.tmp-\d+$/` 匹配，照样认）。
 */
let tempSequence = 0

export function nextTempPathFor(targetPath: string, pid: number = process.pid): string {
  tempSequence = (tempSequence + 1) % Number.MAX_SAFE_INTEGER
  return `${targetPath}.tmp-${pid}-${tempSequence}`
}

/**
 * 替换目标：同卷原子、覆盖已存在目标。见文件头关于 `os.replace` 的说明。
 * 单一入口，便于审计"所有落地都走这一条路"。
 *
 * **Windows 的 EPERM 重试**：`MoveFileEx(..., MOVEFILE_REPLACE_EXISTING)` 在目标
 * 正被其它句柄打开时（杀毒软件扫目录、索引器、另一个并发写者刚提交完还没关句柄）
 * 会直接失败 `EPERM: operation not permitted`。实测在"24 个并发写者写同一个目标"
 * 下必现。这不是调用方写错了，是 Win32 的共享冲突；标准处理是**有界重试 + 退避**
 * （总预算约 0.6s）：既不无限重试，也不把一次可恢复的共享冲突当成导出失败。
 */
export async function replacePath(from: string, to: string): Promise<void> {
  const retryable = new Set(['EPERM', 'EACCES', 'EBUSY'])
  let delayMs = 10
  for (let attempt = 0; ; attempt += 1) {
    try {
      await fs.promises.rename(from, to)
      return
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | undefined)?.code
      if (!code || !retryable.has(code) || attempt >= 5) throw error
      await sleep(delayMs)
      delayMs *= 2
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    timer.unref?.()
  })
}

async function fsyncFile(filePath: string): Promise<void> {
  const handle = await fs.promises.open(filePath, 'r+')
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

/**
 * fsync 目标文件所在的目录项。Windows 上目录不能被 `fs.open` 打开再 sync
 * （EPERM/EISDIR），这里按平台降级：POSIX 尽力做，Windows 直接返回。
 * 失败不致命 —— 目录项丢失只影响"断电后文件仍在不在"，不影响本次导出的正确性。
 */
async function fsyncParentDir(dirPath: string): Promise<void> {
  if (process.platform === 'win32') return
  try {
    const handle = await fs.promises.open(dirPath, 'r')
    try {
      await handle.sync()
    } finally {
      await handle.close()
    }
  } catch {
    /* 目录 fsync 尽力而为 */
  }
}

async function unlinkQuiet(filePath: string): Promise<void> {
  await fs.promises.rm(filePath, { force: true }).catch(() => { /* noop */ })
}

export interface AtomicWriteHooks {
  /**
   * 临时文件写入完整内容之后、替换目标之前调用（临时文件此刻已存在）。
   * 测试用来在"内容已写、尚未替换"的窗口里制造失败，验证不留半截文件。
   */
  onBeforeReplace?: (tmpPath: string) => Promise<void> | void
}

/**
 * 原子写文件：tmp → fsync → 同卷原子替换（见 `replacePath`）。
 * 任一步失败都会删掉临时文件并抛出（调用方按"这一条导出失败"处理）。
 */
export async function atomicWriteFile(
  targetPath: string,
  data: string | Buffer,
  encoding?: BufferEncoding,
  hooks: AtomicWriteHooks = {},
): Promise<{ bytes: number }> {
  const normalizedTarget = path.resolve(targetPath)
  const tmpPath = nextTempPathFor(normalizedTarget)
  let replaced = false
  try {
    await fs.promises.mkdir(path.dirname(normalizedTarget), { recursive: true })
    await fs.promises.writeFile(tmpPath, data, encoding === undefined ? undefined : { encoding })
    await fsyncFile(tmpPath)
    if (hooks.onBeforeReplace) await hooks.onBeforeReplace(tmpPath)
    // 同卷原子替换：目标已存在时直接覆盖（见文件头 replacePath 的说明）
    await replacePath(tmpPath, normalizedTarget)
    replaced = true
    await fsyncParentDir(path.dirname(normalizedTarget))
    const stat = await fs.promises.stat(normalizedTarget)
    return { bytes: stat.size }
  } catch (error) {
    if (!replaced) await unlinkQuiet(tmpPath)
    throw error
  }
}

export async function atomicWriteText(
  targetPath: string,
  text: string,
  hooks: AtomicWriteHooks = {},
): Promise<{ bytes: number }> {
  return atomicWriteFile(targetPath, text, 'utf-8', hooks)
}

export async function atomicWriteBuffer(
  targetPath: string,
  buffer: Buffer,
  hooks: AtomicWriteHooks = {},
): Promise<{ bytes: number }> {
  return atomicWriteFile(targetPath, buffer, undefined, hooks)
}

/** 用某个"写临时文件"的回调生成产物，再原子替换到目标路径（exceljs 之类的库用）。 */
export async function atomicWriteWith(
  targetPath: string,
  writeTmp: (tmpPath: string) => Promise<void>,
  hooks: AtomicWriteHooks = {},
): Promise<{ bytes: number }> {
  const normalizedTarget = path.resolve(targetPath)
  const tmpPath = nextTempPathFor(normalizedTarget)
  let replaced = false
  try {
    await fs.promises.mkdir(path.dirname(normalizedTarget), { recursive: true })
    await writeTmp(tmpPath)
    await fsyncFile(tmpPath)
    if (hooks.onBeforeReplace) await hooks.onBeforeReplace(tmpPath)
    await replacePath(tmpPath, normalizedTarget)
    replaced = true
    await fsyncParentDir(path.dirname(normalizedTarget))
    const stat = await fs.promises.stat(normalizedTarget)
    return { bytes: stat.size }
  } catch (error) {
    if (!replaced) await unlinkQuiet(tmpPath)
    throw error
  }
}

export interface AtomicWriteTarget {
  stream: fs.WriteStream
  commit: () => Promise<void>
  abort: () => void
  tmpPath: string
}

/**
 * 流式原子写的目标（HTML / TXT / Markdown / SQL / WeClone 等大产物用）。
 * 调用方按原有方式向 `stream` 写；`commit()` 收尾并原子替换，`abort()` 丢弃临时文件。
 * - 写中途失败：旧产物保持原样，临时文件被清理；
 * - 流错误立即捕获（不再等到 end() 才挂 error 监听，避免崩溃/挂死）。
 */
export function createAtomicWriteTarget(outputPath: string, encoding: BufferEncoding = 'utf-8'): AtomicWriteTarget {
  const normalizedTarget = path.resolve(outputPath)
  const tmpPath = nextTempPathFor(normalizedTarget)
  const stream = fs.createWriteStream(tmpPath, { encoding })
  let writeError: Error | null = null
  stream.on('error', (err) => {
    writeError = err
  })
  const commit = (): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      stream.end(() => {
        void (async () => {
          if (writeError) {
            await unlinkQuiet(tmpPath)
            reject(writeError)
            return
          }
          try {
            await fsyncFile(tmpPath)
            await replacePath(tmpPath, normalizedTarget)
            await fsyncParentDir(path.dirname(normalizedTarget))
            resolve()
          } catch (e) {
            await unlinkQuiet(tmpPath)
            reject(e)
          }
        })()
      })
    })
  const abort = (): void => {
    try { stream.destroy() } catch { /* noop */ }
    // 同步删：abort 之后调用方可能立刻去数目录里的文件，异步 unlink 会留下一个
    // "看起来还在写"的窗口（测试与"中断后立即续跑"都会撞上）。
    try { fs.unlinkSync(tmpPath) } catch { /* 本来就不存在 */ }
  }
  return { stream, commit, abort, tmpPath }
}

/** 清掉导出目录里遗留的临时文件（上次崩溃留下的）。只匹配本模块的命名形状。 */
export async function cleanupStaleAtomicTemps(rootDir: string): Promise<string[]> {
  const removed: string[] = []
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > 6) return
    let entries: fs.Dirent[]
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        await walk(full, depth + 1)
        continue
      }
      // 临时名是 `<目标>.tmp-<pid>-<seq>`（见 nextTempPathFor），只匹配 `.tmp-数字` 的话
      // 并发写留下的那批永远清不掉，会一直堆在导出目录里，还会被当成产物文件索引进去。
      if (!/\.tmp-\d+(-\d+)?$/.test(entry.name)) continue
      await unlinkQuiet(full)
      removed.push(full)
    }
  }
  await walk(rootDir, 0)
  return removed
}
