/**
 * 快速桌面采集（Windows）：koffi 直调 GDI，**一条 BitBlt + 一次 GetDIBits**。
 *
 * 为什么不用 `desktopCapturer.getSources()`：它在本机实测 **150~208ms/帧**，且成本
 * 与输出分辨率几乎无关（320×180 与 90×50 都是 ~200ms）—— 那是 Chromium 采集管线的
 * 固定开销，也直接决定了定帧折射的帧率上限（实测 0.7fps，用户看到的就是"玻璃跟不
 * 上桌面、一顿一顿"）。
 *
 * 裸 GDI 的实测（主屏 1280×720@1.5 → 桌面 1920×1080）：
 *   - 420×144 区域（卡片 + 模糊边距）BitBlt+GetDIBits ≈ **5~22ms**（中位 ~12ms）
 *   - 1920×1080 全屏                              ≈ 35.6ms
 * 约 10~17 倍，而且抓的永远是玻璃所在的小区域。
 *
 * 只在 WGC 采集流不可用时作为定帧推送的**加速路径**：任何一步失败（koffi 缺失、
 * DC 拿不到、BitBlt 返回 0）都返回 null，调用方回落到原来的 desktopCapturer 路径。
 */

import { screen } from 'electron'

/**
 * koffi 只在第一次真的要抓帧时才加载（`loadApi` 里 require）。
 *
 * 顶层 `import koffi from 'koffi'` 会让主进程在**启动时**就加载整个 FFI 运行时 ——
 * `npm run bench` 的首屏 RSS 因此从 482MB 涨到 688MB（+206MB，超了门限）。这条路径
 * 只有 Windows 弹窗玻璃用得到，没有理由让每个进程启动都付这份内存。
 */
type KoffiModule = {
  load: (lib: string) => { func: (signature: string) => (...args: unknown[]) => unknown }
}
let koffiModule: KoffiModule | null = null

const SRCCOPY = 0x00cc0020
const DIB_RGB_COLORS = 0

interface GdiApi {
  GetDC: (hwnd: null) => unknown
  ReleaseDC: (hwnd: null, hdc: unknown) => number
  CreateCompatibleDC: (hdc: unknown) => unknown
  CreateCompatibleBitmap: (hdc: unknown, cx: number, cy: number) => unknown
  SelectObject: (hdc: unknown, h: unknown) => unknown
  DeleteObject: (h: unknown) => number
  DeleteDC: (hdc: unknown) => number
  BitBlt: (dst: unknown, x: number, y: number, cx: number, cy: number, src: unknown, x1: number, y1: number, rop: number) => number
  GetDIBits: (hdc: unknown, hbm: unknown, start: number, lines: number, bits: Buffer, info: Buffer, usage: number) => number
}

let api: GdiApi | null = null
let apiFailed = false

function loadApi(): GdiApi | null {
  if (api || apiFailed) return api
  if (process.platform !== 'win32') {
    apiFailed = true
    return null
  }
  try {
    // 惰性加载：见上面 `KoffiModule` 的说明（启动时加载它会多 200MB 首屏 RSS）
    if (!koffiModule) {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      koffiModule = require('koffi') as KoffiModule
    }
    const koffi = koffiModule
    const user32 = koffi.load('user32.dll')
    const gdi32 = koffi.load('gdi32.dll')
    api = {
      GetDC: user32.func('void *GetDC(void *hWnd)'),
      ReleaseDC: user32.func('int ReleaseDC(void *hWnd, void *hDC)'),
      CreateCompatibleDC: gdi32.func('void *CreateCompatibleDC(void *hdc)'),
      CreateCompatibleBitmap: gdi32.func('void *CreateCompatibleBitmap(void *hdc, int cx, int cy)'),
      SelectObject: gdi32.func('void *SelectObject(void *hdc, void *h)'),
      DeleteObject: gdi32.func('int DeleteObject(void *ho)'),
      DeleteDC: gdi32.func('int DeleteDC(void *hdc)'),
      BitBlt: gdi32.func('int BitBlt(void *hdcDest, int x, int y, int cx, int cy, void *hdcSrc, int x1, int y1, uint32 rop)'),
      GetDIBits: gdi32.func('int GetDIBits(void *hdc, void *hbm, uint32 start, uint32 cLines, void *lpvBits, void *lpbmi, uint32 usage)'),
    } as GdiApi
    return api
  } catch (error) {
    apiFailed = true
    console.warn('[GlassCapture] koffi/GDI unavailable, falling back to desktopCapturer:', (error as Error)?.message || error)
    return null
  }
}

export function fastCaptureAvailable(): boolean {
  return loadApi() !== null
}

/** BITMAPINFOHEADER，32bpp BI_RGB；height 传负值 = top-down（与 canvas 行序一致） */
function bitmapInfo(width: number, height: number): Buffer {
  const info = Buffer.alloc(40)
  info.writeUInt32LE(40, 0)
  info.writeInt32LE(width, 4)
  info.writeInt32LE(-height, 8)
  info.writeUInt16LE(1, 12)
  info.writeUInt16LE(32, 14)
  info.writeUInt32LE(0, 16)
  info.writeUInt32LE(0, 20)
  info.writeInt32LE(0, 24)
  info.writeInt32LE(0, 28)
  info.writeUInt32LE(0, 32)
  info.writeUInt32LE(0, 36)
  return info
}

export interface FastCaptureTarget {
  /** 物理像素矩形，原点 = 虚拟屏幕原点 */
  x: number
  y: number
  width: number
  height: number
}

export interface FastCaptureResult {
  /** BGRA 像素（top-down，可直接喂 `new ImageData(...)`） */
  pixels: Buffer
  width: number
  height: number
  costMs: number
}

/** 屏幕区域（DIP / CSS 像素）→ 物理像素矩形（按主屏缩放；越界由 BitBlt 裁成黑边） */
export function dipRectToPhysical(dipX: number, dipY: number, dipW: number, dipH: number): FastCaptureTarget {
  const scale = screen.getPrimaryDisplay().scaleFactor || 1
  return {
    x: Math.round(dipX * scale),
    y: Math.round(dipY * scale),
    width: Math.max(1, Math.round(dipW * scale)),
    height: Math.max(1, Math.round(dipH * scale)),
  }
}

/**
 * 抓一块屏幕区域，返回 BGRA 像素；失败返回 null（调用方回落 desktopCapturer）。
 *
 * 同步（BitBlt 本身就是同步的），一次 ~5-22ms：调用方在主进程里直接调即可，
 * 但不要放在弹窗弹出路径上（见 notificationWindow.ts "弹窗弹出路径上不做任何采集"）。
 *
 * **返回的 Buffer 同一尺寸下复用同一块内存**：10fps × 200KB 的逐帧分配会让主进程
 * RSS 缓慢爬升（`npm run bench` 的首屏 RSS 门限就是这么被顶掉的）。调用方必须在
 * 下一帧之前把数据消费掉（base64/写文件都算），不要长期持有。
 */
let reusableBuffer: Buffer | null = null

export function captureScreenRegion(target: FastCaptureTarget): FastCaptureResult | null {
  const gdi = loadApi()
  if (!gdi) return null
  const startedAt = Date.now()
  const { width, height } = target
  const byteLength = width * height * 4
  if (!reusableBuffer || reusableBuffer.length !== byteLength) reusableBuffer = Buffer.alloc(byteLength)
  const pixels = reusableBuffer
  let screenDC: unknown = null
  let memDC: unknown = null
  let bitmap: unknown = null
  let previous: unknown = null
  try {
    screenDC = gdi.GetDC(null)
    if (!screenDC) return null
    memDC = gdi.CreateCompatibleDC(screenDC)
    if (!memDC) return null
    bitmap = gdi.CreateCompatibleBitmap(screenDC, width, height)
    if (!bitmap) return null
    previous = gdi.SelectObject(memDC, bitmap)
    const ok = gdi.BitBlt(memDC, 0, 0, width, height, screenDC, target.x, target.y, SRCCOPY)
    if (!ok) return null
    const lines = gdi.GetDIBits(memDC, bitmap, 0, height, pixels, bitmapInfo(width, height), DIB_RGB_COLORS)
    if (!lines) return null
    return { pixels, width, height, costMs: Date.now() - startedAt }
  } catch (error) {
    console.warn('[GlassCapture] BitBlt capture failed:', (error as Error)?.message || error)
    return null
  } finally {
    try {
      if (memDC && previous) gdi.SelectObject(memDC, previous)
      if (bitmap) gdi.DeleteObject(bitmap)
      if (memDC) gdi.DeleteDC(memDC)
      if (screenDC) gdi.ReleaseDC(null, screenDC)
    } catch { /* 清理失败不影响结果 */ }
  }
}
