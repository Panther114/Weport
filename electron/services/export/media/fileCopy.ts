import * as fs from 'fs'
import * as path from 'path'
import { randomUUID } from 'crypto'

async function sameFileBytes(sourcePath: string, destPath: string): Promise<boolean> {
  let source: fs.promises.FileHandle | undefined
  let destination: fs.promises.FileHandle | undefined
  try {
    source = await fs.promises.open(sourcePath, 'r')
    destination = await fs.promises.open(destPath, 'r')
    const beforeSource = await source.stat(), beforeDestination = await destination.stat()
    if (!beforeSource.isFile() || !beforeDestination.isFile() || beforeSource.size !== beforeDestination.size) return false
    const left = Buffer.alloc(1024 * 1024), right = Buffer.alloc(left.length)
    for (let offset = 0; offset < beforeSource.size;) {
      const size = Math.min(left.length, beforeSource.size - offset)
      const a = await source.read(left, 0, size, offset), b = await destination.read(right, 0, size, offset)
      if (a.bytesRead !== size || b.bytesRead !== size || !left.subarray(0, size).equals(right.subarray(0, size))) return false
      offset += size
    }
    const afterSource = await source.stat(), afterDestination = await destination.stat()
    return beforeSource.size === afterSource.size && beforeSource.mtimeMs === afterSource.mtimeMs &&
      beforeDestination.size === afterDestination.size && beforeDestination.mtimeMs === afterDestination.mtimeMs
  } catch { return false } finally {
    await source?.close().catch(() => {})
    await destination?.close().catch(() => {})
  }
}

function isCloneUnsupportedError(code?: string): boolean {
  return code === 'ENOTSUP' || code === 'ENOSYS' || code === 'EXDEV'
}

function isHardlinkFallbackError(code?: string): boolean {
  return code === 'EXDEV' || code === 'EPERM' || code === 'EACCES' || code === 'EINVAL' || code === 'ENOSYS' || code === 'ENOTSUP'
}

export async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.promises.access(p)
    return true
  } catch {
    return false
  }
}

export async function ensureExportDir(dirPath: string, control?: { recordCreatedDir?: (path: string) => void }, dirCache?: Set<string>): Promise<void> {
  if (dirCache?.has(dirPath)) return
  const existed = await pathExists(dirPath)
  await fs.promises.mkdir(dirPath, { recursive: true })
  dirCache?.add(dirPath)
  if (!existed) {
    control?.recordCreatedDir?.(dirPath)
  }
}

export async function copyFileOptimized(sourcePath: string, destPath: string): Promise<{ success: boolean; code?: string }> {
  if (path.resolve(sourcePath) === path.resolve(destPath)) {
    try { return { success: (await fs.promises.stat(sourcePath)).isFile() } }
    catch (error) { return { success: false, code: (error as NodeJS.ErrnoException).code } }
  }
  const tempPath = path.join(path.dirname(destPath), `.weport-copy-${randomUUID()}.tmp`)
  const cloneFlag = typeof fs.constants.COPYFILE_FICLONE === 'number' ? fs.constants.COPYFILE_FICLONE : 0
  let oldMode: number | undefined
  try {
    try {
      await fs.promises.copyFile(sourcePath, tempPath, cloneFlag | fs.constants.COPYFILE_EXCL)
    } catch (error) {
      if (!isCloneUnsupportedError((error as NodeJS.ErrnoException).code)) throw error
      await fs.promises.copyFile(sourcePath, tempPath, fs.constants.COPYFILE_EXCL)
    }
    // Windows CopyFile preserves the source's read-only flag. The new temporary
    // copy is ours; normalize it without ever chmod'ing the WeChat source.
    const tempStat = await fs.promises.stat(tempPath)
    if (!(tempStat.mode & 0o200)) await fs.promises.chmod(tempPath, tempStat.mode | 0o200)
    try { await fs.promises.rename(tempPath, destPath) } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'EPERM' && code !== 'EACCES') throw error
      const target = await fs.promises.lstat(destPath)
      if (target.isFile() && await sameFileBytes(sourcePath, destPath)) return { success: true }
      // Repair a legacy read-only export only when it has no other hardlinks.
      // Clearing a shared inode's flag could otherwise alter source permissions.
      if (!target.isFile() || target.nlink !== 1 || (target.mode & 0o200)) throw error
      oldMode = target.mode
      await fs.promises.chmod(destPath, target.mode | 0o200)
      await fs.promises.rename(tempPath, destPath)
      oldMode = undefined
    }
    return { success: true }
  } catch (e) {
    if (oldMode !== undefined) await fs.promises.chmod(destPath, oldMode).catch(() => {})
    return { success: false, code: (e as NodeJS.ErrnoException | undefined)?.code }
  } finally {
    await fs.promises.unlink(tempPath).catch(() => {})
  }
}

export async function hardlinkOrCopyFile(sourcePath: string, destPath: string): Promise<{ success: boolean; code?: string; linked?: boolean }> {
  try {
    await fs.promises.link(sourcePath, destPath)
    return { success: true, linked: true }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code
    if (code === 'EEXIST') {
      return { success: true, linked: true }
    }
    if (!isHardlinkFallbackError(code)) {
      return { success: false, code }
    }
  }

  const copied = await copyFileOptimized(sourcePath, destPath)
  if (!copied.success) return copied
  return { success: true, linked: false }
}
