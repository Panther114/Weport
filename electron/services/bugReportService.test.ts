import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  registerBugReportHandlers,
  type BugReportServiceDependencies,
} from './bugReportService'

type TestSender = {
  once: (event: 'destroyed', listener: () => void) => unknown
  destroy: () => void
}
type Handler = (event: { sender: TestSender }, ...args: any[]) => unknown

const tempDirs: string[] = []

function makeImageFile(name: string, size = 100): string {
  const dir = mkdtempSync(join(tmpdir(), 'weport-bug-report-'))
  tempDirs.push(dir)
  const path = join(dir, name)
  writeFileSync(path, Buffer.alloc(size, 1))
  return path
}

function makeSender(): TestSender {
  let destroyed: (() => void) | undefined
  return {
    once: (_event, listener) => { destroyed = listener },
    destroy: () => destroyed?.(),
  }
}

function makeHarness() {
  const handlers = new Map<string, Handler>()
  const pickedPaths: string[] = []
  const clipboardImages: unknown[] = []
  const clipboardTexts: string[] = []
  const openedUrls: string[] = []
  const dialogCalls = vi.fn(async () => ({ canceled: false, filePaths: pickedPaths.splice(0) }))
  const imageFactory = vi.fn(() => ({
    isEmpty: () => false,
    getSize: () => ({ width: 1920, height: 1080 }),
    resize: () => ({ toDataURL: () => 'data:image/png;base64,preview' }),
  }))
  const deps = {
    ipcMain: { handle: (channel: string, handler: Handler) => { handlers.set(channel, handler) } },
    dialog: { showOpenDialog: dialogCalls },
    clipboard: {
      writeImage: (image: unknown) => clipboardImages.push(image),
      writeText: (text: string) => clipboardTexts.push(text),
    },
    nativeImage: { createFromBuffer: imageFactory },
    shell: { openExternal: async (url: string) => { openedUrls.push(url) } },
    appVersion: '1.2.0',
    platform: 'win32',
    platformRelease: '10.0.26100',
    arch: 'x64',
  } as unknown as BugReportServiceDependencies

  registerBugReportHandlers(deps)
  return {
    pickedPaths,
    clipboardImages,
    clipboardTexts,
    openedUrls,
    dialogCalls,
    imageFactory,
    invoke: async (channel: string, sender: TestSender, ...args: unknown[]) => {
      const handler = handlers.get(channel)
      if (!handler) throw new Error(`Missing IPC handler: ${channel}`)
      return await handler({ sender }, ...args)
    },
  }
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('bugReportService', () => {
  it('only accepts picker-selected images within count and file-size limits', async () => {
    const harness = makeHarness()
    const sender = makeSender()
    const oversized = makeImageFile('large.png', 10 * 1024 * 1024 + 1)
    const unsupported = makeImageFile('vector.svg')
    const selected = Array.from({ length: 6 }, (_, index) => makeImageFile(`shot-${index}.png`))
    harness.pickedPaths.push(oversized, unsupported, ...selected)

    const result = await harness.invoke('bug-report:choose-images', sender) as {
      images: Array<{ id: string; name: string; sizeBytes: number; previewDataUrl: string }>
      errors: string[]
    }
    expect(result.images).toHaveLength(5)
    expect(result.images.every((image) => image.previewDataUrl.startsWith('data:image/'))).toBe(true)
    expect(result.errors).toHaveLength(3)
    expect(harness.imageFactory).toHaveBeenCalledTimes(5)

    const atLimit = await harness.invoke('bug-report:choose-images', sender) as { images: unknown[]; error: string }
    expect(atLimit.images).toEqual([])
    expect(atLimit.error).toContain('5')
    expect(harness.dialogCalls).toHaveBeenCalledTimes(1)
  })

  it('scopes opaque image tokens to their selecting sender and rejects invalid tokens', async () => {
    const harness = makeHarness()
    const senderA = makeSender()
    const senderB = makeSender()
    const picked = makeImageFile('private-shot.png')
    harness.pickedPaths.push(picked)
    const chosen = await harness.invoke('bug-report:choose-images', senderA) as {
      images: Array<{ id: string }>
    }
    const [image] = chosen.images

    expect(await harness.invoke('bug-report:copy-image', senderB, image.id)).toMatchObject({ success: false })
    expect(await harness.invoke('bug-report:copy-image', senderA, 'C:\\Users\\someone\\secret.png')).toMatchObject({ success: false })
    expect(await harness.invoke('bug-report:remove-image', senderB, image.id)).toMatchObject({ success: false })
    expect(harness.clipboardImages).toHaveLength(0)

    expect(await harness.invoke('bug-report:copy-image', senderA, image.id)).toEqual({ success: true })
    expect(harness.clipboardImages).toHaveLength(1)
    expect(await harness.invoke('bug-report:remove-image', senderA, image.id)).toEqual({ success: true })
    expect(await harness.invoke('bug-report:copy-image', senderA, image.id)).toMatchObject({ success: false })
  })

  it('releases image tokens when the selecting webContents is destroyed', async () => {
    const harness = makeHarness()
    const sender = makeSender()
    harness.pickedPaths.push(makeImageFile('temporary.png'))
    const chosen = await harness.invoke('bug-report:choose-images', sender) as { images: Array<{ id: string }> }
    sender.destroy()

    expect(await harness.invoke('bug-report:copy-image', sender, chosen.images[0].id)).toMatchObject({ success: false })
  })

  it('opens only the fixed Weport issue editor with the draft and opt-in environment data', async () => {
    const harness = makeHarness()
    const sender = makeSender()
    const result = await harness.invoke('bug-report:open-issue', sender, {
      title: 'https://attacker.example/?steal=1',
      body: 'Steps and expected behavior',
      includeEnvironment: true,
    })

    expect(result).toEqual({ success: true })
    const url = new URL(harness.openedUrls[0])
    expect(url.origin).toBe('https://github.com')
    expect(url.pathname).toBe('/Panther114/Weport/issues/new')
    expect([...url.searchParams.keys()].sort()).toEqual(['body', 'title'])
    expect(url.searchParams.get('title')).toBe('https://attacker.example/?steal=1')
    expect(url.searchParams.get('body')).toContain('Steps and expected behavior')
    expect(url.searchParams.get('body')).toContain('Weport: 1.2.0')
    expect(url.searchParams.get('body')).toContain('Platform: win32 10.0.26100')
    expect(url.searchParams.get('body')).toContain('Architecture: x64')
    expect(harness.clipboardTexts).toHaveLength(0)
  })

  it('keeps long Unicode report bodies out of the URL until the user copies them explicitly', async () => {
    const harness = makeHarness()
    const sender = makeSender()
    const body = '故障步骤和预期结果'.repeat(300)
    const opened = await harness.invoke('bug-report:open-issue', sender, {
      title: '界面显示异常',
      body,
      includeEnvironment: false,
    })

    expect(opened).toEqual({ success: true, bodyNeedsPaste: true })
    const url = new URL(harness.openedUrls[0])
    expect(url.origin).toBe('https://github.com')
    expect(url.pathname).toBe('/Panther114/Weport/issues/new')
    expect(url.searchParams.get('title')).toBe('界面显示异常')
    expect(url.searchParams.has('body')).toBe(false)
    expect(harness.clipboardTexts).toHaveLength(0)

    expect(await harness.invoke('bug-report:copy-draft-text', sender, { body, includeEnvironment: false }))
      .toEqual({ success: true })
    expect(harness.clipboardTexts).toEqual([body])
  })

  it('requires a bounded title and body before opening GitHub', async () => {
    const harness = makeHarness()
    const sender = makeSender()
    expect(await harness.invoke('bug-report:open-issue', sender, { title: ' ', body: 'details' })).toMatchObject({ success: false })
    expect(await harness.invoke('bug-report:open-issue', sender, { title: 'x'.repeat(121), body: 'details' })).toMatchObject({ success: false })
    expect(harness.openedUrls).toHaveLength(0)
  })
})
