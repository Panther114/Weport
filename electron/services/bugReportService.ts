import { basename, extname } from 'path'
import { readFileSync, statSync } from 'fs'
import { randomUUID } from 'crypto'
import type { Clipboard, NativeImage } from 'electron'

const MAX_IMAGES = 5
const MAX_IMAGE_BYTES = 10 * 1024 * 1024
const PREVIEW_WIDTH = 480
const PREVIEW_HEIGHT = 320
const MAX_ISSUE_URL_LENGTH = 7000
const ALLOWED_IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp'])
const ISSUE_URL = 'https://github.com/Panther114/Weport/issues/new'

interface BugReportSender {
  once: (event: 'destroyed', listener: () => void) => unknown
}

interface BugReportInvokeEvent {
  sender: BugReportSender
}

interface BugReportIpcMain {
  handle: (
    channel: string,
    listener: (event: BugReportInvokeEvent, ...args: any[]) => unknown
  ) => unknown
}

export interface BugReportServiceDependencies {
  ipcMain: BugReportIpcMain
  dialog: {
    showOpenDialog: (options: {
      title: string
      properties: Array<'openFile' | 'multiSelections'>
      filters: Array<{ name: string; extensions: string[] }>
    }) => Promise<{ canceled: boolean; filePaths: string[] }>
  }
  clipboard: Pick<Clipboard, 'writeImage' | 'writeText'>
  nativeImage: { createFromBuffer: (buffer: Buffer) => NativeImage }
  shell: { openExternal: (url: string) => Promise<void> }
  appVersion: string
  platform: string
  platformRelease: string
  arch: string
}

interface StoredImage {
  id: string
  name: string
  sizeBytes: number
  bytes: Buffer
}

export interface BugReportOpenIssuePayload {
  title: string
  body: string
  includeEnvironment: boolean
}

/** Build only the fixed Weport issue URL; report text is query data, never a destination. */
export function createBugReportIssueUrl(
  payload: BugReportOpenIssuePayload,
  environment: { appVersion: string; platform: string; platformRelease: string; arch: string }
): string {
  const title = payload.title.trim()
  const body = payload.body.trim()
  const url = new URL(ISSUE_URL)
  url.searchParams.set('title', title)
  url.searchParams.set('body', composeIssueBody(body, payload.includeEnvironment === true, environment))
  return url.toString()
}

function composeIssueBody(
  body: string,
  includeEnvironment: boolean,
  environment: { appVersion: string; platform: string; platformRelease: string; arch: string }
): string {
  if (!includeEnvironment) return body
  return `${body}\n\n---\n\nEnvironment\n- Weport: ${cleanMetadata(environment.appVersion)}\n- Platform: ${cleanMetadata(environment.platform)} ${cleanMetadata(environment.platformRelease)}\n- Architecture: ${cleanMetadata(environment.arch)}`
}

function cleanMetadata(value: string): string {
  return String(value || '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160)
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error || '未知错误')
}

export function registerBugReportHandlers(deps: BugReportServiceDependencies): void {
  // The map is keyed by the actual WebContents object, so tokens cannot cross windows.
  // Store bounded compressed snapshots, not decoded bitmaps or renderer paths.
  const attachments = new Map<BugReportSender, Map<string, StoredImage>>()
  const destructionListeners = new WeakSet<object>()

  const getAttachments = (sender: BugReportSender): Map<string, StoredImage> => {
    let images = attachments.get(sender)
    if (!images) {
      images = new Map()
      attachments.set(sender, images)
    }
    if (!destructionListeners.has(sender)) {
      destructionListeners.add(sender)
      sender.once('destroyed', () => attachments.delete(sender))
    }
    return images
  }

  deps.ipcMain.handle('bug-report:choose-images', async (event) => {
    const senderImages = getAttachments(event.sender)
    const remaining = MAX_IMAGES - senderImages.size
    if (remaining <= 0) {
      return { canceled: false, images: [], error: '最多只能添加 5 张图片。' }
    }

    try {
      const result = await deps.dialog.showOpenDialog({
        title: '选择问题截图',
        properties: ['openFile', 'multiSelections'],
        filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp'] }],
      })
      if (result.canceled) return { canceled: true, images: [] }

      const images: Array<{ id: string; name: string; sizeBytes: number; previewDataUrl: string }> = []
      const errors: string[] = []
      for (const pickedPath of result.filePaths) {
        if (senderImages.size >= MAX_IMAGES) {
          errors.push('最多只能添加 5 张图片。')
          break
        }
        const extension = extname(pickedPath).toLowerCase()
        if (!ALLOWED_IMAGE_EXTENSIONS.has(extension)) {
          errors.push(`${basename(pickedPath)}：不支持此图片格式。`)
          continue
        }

        let sizeBytes: number
        try {
          const stats = statSync(pickedPath)
          if (!stats.isFile()) {
            errors.push(`${basename(pickedPath)}：请选择图片文件。`)
            continue
          }
          sizeBytes = stats.size
        } catch {
          errors.push('无法读取所选图片。')
          continue
        }
        if (sizeBytes > MAX_IMAGE_BYTES) {
          errors.push(`${basename(pickedPath)}：图片不能超过 10 MB。`)
          continue
        }

        try {
          const bytes = readFileSync(pickedPath)
          if (bytes.length > MAX_IMAGE_BYTES) throw new Error('Image size changed')
          const image = deps.nativeImage.createFromBuffer(bytes)
          const size = image.getSize()
          if (image.isEmpty() || size.width <= 0 || size.height <= 0) {
            errors.push(`${basename(pickedPath)}：图片无法解码。`)
            continue
          }
          // Limit pathological decoded dimensions while allowing high-resolution screenshots.
          if (size.width * size.height > 24_000_000) {
            errors.push(`${basename(pickedPath)}：图片分辨率过大。`)
            continue
          }
          const id = randomUUID()
          const name = basename(pickedPath)
          const scale = Math.min(1, PREVIEW_WIDTH / size.width, PREVIEW_HEIGHT / size.height)
          const previewImage = scale < 1
            ? size.width / size.height >= PREVIEW_WIDTH / PREVIEW_HEIGHT
              ? image.resize({ width: Math.max(1, Math.round(size.width * scale)) })
              : image.resize({ height: Math.max(1, Math.round(size.height * scale)) })
            : image
          const previewDataUrl = previewImage.toDataURL()
          senderImages.set(id, { id, name, sizeBytes: bytes.length, bytes })
          images.push({ id, name, sizeBytes, previewDataUrl })
        } catch {
          errors.push(`${basename(pickedPath)}：无法处理此图片。`)
        }
      }

      return { canceled: false, images, ...(errors.length ? { errors } : {}) }
    } catch (error) {
      return { canceled: false, images: [], error: `选择图片失败：${messageOf(error)}` }
    }
  })

  deps.ipcMain.handle('bug-report:remove-image', (event, imageId: unknown) => {
    if (typeof imageId !== 'string') return { success: false }
    return { success: attachments.get(event.sender)?.delete(imageId) ?? false }
  })

  deps.ipcMain.handle('bug-report:clear-images', (event) => {
    attachments.delete(event.sender)
    return { success: true }
  })

  deps.ipcMain.handle('bug-report:copy-image', (event, imageId: unknown) => {
    if (typeof imageId !== 'string') return { success: false, error: '图片不存在或已移除。' }
    const image = attachments.get(event.sender)?.get(imageId)
    if (!image) return { success: false, error: '图片不存在或已移除。' }
    try {
      deps.clipboard.writeImage(deps.nativeImage.createFromBuffer(image.bytes))
      return { success: true }
    } catch {
      return { success: false, error: '复制图片失败。' }
    }
  })

  deps.ipcMain.handle('bug-report:copy-draft-text', (_event, rawPayload: unknown) => {
    if (!rawPayload || typeof rawPayload !== 'object') {
      return { success: false, error: '问题详情不能为空。' }
    }
    const payload = rawPayload as { body?: unknown; includeEnvironment?: unknown }
    if (typeof payload.body !== 'string' || !payload.body.trim() || payload.body.length > 3000) {
      return { success: false, error: '问题详情不能为空，且最多 3000 字。' }
    }
    try {
      deps.clipboard.writeText(composeIssueBody(payload.body.trim(), payload.includeEnvironment === true, deps))
      return { success: true }
    } catch {
      return { success: false, error: '复制问题详情失败。' }
    }
  })

  deps.ipcMain.handle('bug-report:open-issue', async (_event, rawPayload: unknown) => {
    if (!rawPayload || typeof rawPayload !== 'object') {
      return { success: false, error: '问题标题和详情不能为空。' }
    }
    const payload = rawPayload as Partial<BugReportOpenIssuePayload>
    if (typeof payload.title !== 'string' || typeof payload.body !== 'string') {
      return { success: false, error: '问题标题和详情不能为空。' }
    }
    const title = payload.title.trim()
    const body = payload.body.trim()
    if (!title || !body) return { success: false, error: '问题标题和详情不能为空。' }
    if (title.length > 120 || body.length > 3000) {
      return { success: false, error: '标题最多 120 字，问题详情最多 3000 字。' }
    }

    try {
      const url = createBugReportIssueUrl({
        title,
        body,
        includeEnvironment: payload.includeEnvironment === true,
      }, deps)
      if (url.length > MAX_ISSUE_URL_LENGTH) {
        const titleOnlyUrl = new URL(ISSUE_URL)
        titleOnlyUrl.searchParams.set('title', title)
        await deps.shell.openExternal(titleOnlyUrl.toString())
        return { success: true, bodyNeedsPaste: true }
      }
      // This opens GitHub's official editor; the report is never submitted by Weport.
      await deps.shell.openExternal(url)
      return { success: true }
    } catch (error) {
      return { success: false, error: `无法打开 GitHub：${messageOf(error)}` }
    }
  })
}
