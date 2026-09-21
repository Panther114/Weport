import { describe, expect, it } from 'vitest'
import { MAX_IMAGE_BYTES, imagePartFromBase64, imagePartFromData, parseDataUrl } from './imageParts'

/**
 * 把解密出来的图片交给模型（v1.0.1）。
 *
 * 起因：WeBot 任务「看看群里布置了什么作业」拿不到任何图片 —— 图片是加密的
 * `.dat`，文字工具只能看到 `[图片]`。这条链路是 chatService.getImageData →
 * 这里 → 视觉模型，所以这里的每个判定（mime、体积、data URL）都要钉住：
 * mime 猜错时服务商只会回一个 400，不会告诉你"是 mime 错了"。
 */

// 真实 PNG / GIF / WebP / JPEG 的 base64 前缀（够嗅探，不用完整文件）
const PNG = 'iVBORw0KGgoAAAANSUhEUg'
const GIF = 'R0lGODlhAQABAIAAAP'
const WEBP = 'UklGRiIAAABXRUJQVlA4'
const JPEG = '/9j/4AAQSkZJRgABAQ'

describe('mime 靠魔数嗅探', () => {
  it('PNG / GIF / WebP 各自认出来', () => {
    expect(imagePartFromData(PNG).part?.mimeType).toBe('image/png')
    expect(imagePartFromData(GIF).part?.mimeType).toBe('image/gif')
    expect(imagePartFromData(WEBP).part?.mimeType).toBe('image/webp')
  })

  it('认不出时回落 jpeg（微信图片绝大多数是 jpg）', () => {
    expect(imagePartFromData(JPEG).part?.mimeType).toBe('image/jpeg')
    expect(imagePartFromData('YWJjZA==').part?.mimeType).toBe('image/jpeg')
  })

  it('调用方给了 mime 就以它为准（data URL 的声明优先）', () => {
    expect(imagePartFromData(PNG, 'image/webp').part?.mimeType).toBe('image/webp')
  })

  it('数据原样带出去，不做二次编码', () => {
    expect(imagePartFromData(PNG).part?.data).toBe(PNG)
  })
})

describe('体积上限：宁可不给，也不要让整个请求 400', () => {
  it('超过上限时不产出图片，只给一个能读的原因', () => {
    const huge = 'A'.repeat(Math.ceil((MAX_IMAGE_BYTES + 1024) * 4 / 3))
    const result = imagePartFromData(huge)
    expect(result.part).toBeUndefined()
    expect(result.reason).toContain('过大')
  })

  it('刚好在上限内仍然会给出去', () => {
    const ok = 'A'.repeat(Math.floor(MAX_IMAGE_BYTES * 4 / 3) - 8)
    expect(imagePartFromData(ok).part).toBeDefined()
  })
})

describe('空值不炸', () => {
  it('空串 / undefined 分别是原因而不是异常', () => {
    expect(imagePartFromData('').reason).toBe('解密结果是空的')
    expect(imagePartFromBase64(undefined).reason).toBe('解密结果是空的')
  })
})

describe('data URL：有些版本直接返回它', () => {
  it('解析出 mime 与裸 base64', () => {
    expect(parseDataUrl(`data:image/png;base64,${PNG}`)).toEqual({ mimeType: 'image/png', data: PNG })
  })

  it('不是 data URL 时返回 null（不要把普通 base64 误判）', () => {
    expect(parseDataUrl(PNG)).toBeNull()
    expect(parseDataUrl('')).toBeNull()
  })

  it('data URL 入口会剥掉前缀，且用声明里的 mime', () => {
    const part = imagePartFromBase64(`data:image/webp;base64,${PNG}`)
    expect(part.part).toEqual({ mimeType: 'image/webp', data: PNG })
  })

  it('裸 base64 走嗅探', () => {
    expect(imagePartFromBase64(PNG).part?.mimeType).toBe('image/png')
  })
})
