/**
 * 把「解密出来的图片数据」变成模型能看的图片块。
 *
 * 抽成独立模块有两个原因：
 * 1. 这些判定（mime 嗅探、体积上限、data URL 展开）全是纯逻辑，值得单测；
 * 2. `weportAiService.ts` 里 import 了 electron，测试没法直接加载那个模块。
 *
 * 上游是 `chatService.getImageData()` —— 和「导出图片」走**同一条**解密链路，
 * 所以"密钥没配 / `.dat` 不在了 / 版本不适配"这些情况会在那里变成原因字符串，
 * 这一层只负责形状转换与挡住过大的文件。
 */

/** 一张要交给模型的图片。`data` 是裸 base64（不含 `data:…;base64,` 前缀）。 */
export interface AiImagePart {
  mimeType: string
  data: string
}

/** 单张图片的大小上限（base64 解码后）。超过就只在文本里说明，不送给模型。 */
export const MAX_IMAGE_BYTES = 4 * 1024 * 1024

/** 从 `data:image/png;base64,xxx` 里取 mime 与裸 base64；不是 data URL 时返回 null。 */
export function parseDataUrl(value: unknown): { mimeType: string; data: string } | null {
  const text = String(value || '')
  const match = /^data:([a-z0-9.+/-]+);base64,(.+)$/i.exec(text)
  if (!match) return null
  return { mimeType: match[1].toLowerCase(), data: match[2] }
}

/**
 * base64 → 图片块。
 *
 * mime 靠魔数嗅探（微信图片基本是 jpg/png/gif，偶尔 webp）：猜错 mime 时
 * 多数服务商会直接 400，而错误信息不会说"是 mime 错了"。
 */
export function imagePartFromData(raw: string, declaredMime?: string): { part?: AiImagePart; reason?: string } {
  const data = String(raw || '')
  if (!data) return { reason: '解密结果是空的' }
  const approxBytes = Math.floor((data.length * 3) / 4)
  if (approxBytes > MAX_IMAGE_BYTES) {
    return { reason: `图片过大（约 ${Math.round(approxBytes / 1024 / 1024)} MB），已跳过` }
  }
  const mimeType = declaredMime
    || (data.startsWith('iVBORw0KGgo') ? 'image/png'
      : data.startsWith('R0lGOD') ? 'image/gif'
        : data.startsWith('UklGR') ? 'image/webp'
          : 'image/jpeg')
  return { part: { mimeType, data } }
}

/** base64（或某些版本直接返回的 data URL）→ 图片块。 */
export function imagePartFromBase64(base64: string | undefined): { part?: AiImagePart; reason?: string } {
  const raw = String(base64 || '')
  if (!raw) return { reason: '解密结果是空的' }
  const dataUrl = parseDataUrl(raw)
  if (dataUrl) return imagePartFromData(dataUrl.data, dataUrl.mimeType)
  return imagePartFromData(raw)
}
