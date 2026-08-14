/**
 * 朋友圈（SNS）解析工具 —— 从 WeFlow SnsPostItem 提取的纯函数部分，
 * 用于从原始 XML / URL 中还原链接卡片、位置、媒体地址等。
 * 保持与 WeFlow 行为一致（相同正则与归一化顺序）。
 */
import type { SnsLinkCardData, SnsLocation, SnsPost } from '../types/sns'

const LINK_XML_URL_TAGS = ['url', 'shorturl', 'weburl', 'webpageurl', 'jumpurl']
const LINK_XML_DIRECT_URL_TAGS = ['contentUrl', ...LINK_XML_URL_TAGS]
const LINK_XML_TITLE_TAGS = ['title', 'linktitle', 'webtitle']
const MEDIA_HOST_HINTS = ['mmsns.qpic.cn', 'vweixinthumb', 'snstimeline', 'snsvideodownload']

export const isSnsVideoUrl = (url?: string): boolean => {
  if (!url) return false
  const lower = url.toLowerCase()
  return (lower.includes('snsvideodownload') || lower.includes('.mp4') || lower.includes('video')) && !lower.includes('vweixinthumb')
}

export const decodeHtmlEntities = (text: string): string => {
  if (!text) return ''
  return text
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .trim()
}

const normalizeRawXmlForParsing = (xml: string): string => {
  if (!xml) return ''
  return decodeHtmlEntities(xml)
    .replace(/\\+"/g, '"')
    .replace(/\\+'/g, "'")
}

const normalizeUrlCandidate = (raw: string): string | null => {
  const value = decodeHtmlEntities(raw).replace(/[)\],.;]+$/, '').trim()
  if (!value) return null
  if (!/^https?:\/\//i.test(value)) return null
  return value
}

const simplifyUrlForCompare = (value: string): string => {
  const normalized = value.trim().toLowerCase().replace(/^https?:\/\//, '')
  const [withoutQuery] = normalized.split('?')
  return withoutQuery.replace(/\/+$/, '')
}

const getXmlTagValues = (xml: string, tags: string[]): string[] => {
  const normalizedXml = normalizeRawXmlForParsing(xml)
  if (!normalizedXml) return []
  const results: string[] = []
  for (const tag of tags) {
    const reg = new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, 'ig')
    let match: RegExpExecArray | null
    while ((match = reg.exec(normalizedXml)) !== null) {
      if (match[1]) results.push(match[1])
    }
  }
  return results
}

const getUrlLikeStrings = (text: string): string[] => {
  if (!text) return []
  return text.match(/https?:\/\/[^\s<>"']+/gi) || []
}

const isLikelyMediaAssetUrl = (url: string): boolean => {
  const lower = url.toLowerCase()
  return MEDIA_HOST_HINTS.some((hint) => lower.includes(hint))
}

export const normalizeSnsAssetUrl = (url: string, token?: string, encIdx?: string): string => {
  const base = decodeHtmlEntities(url).trim()
  if (!base) return ''

  let fixed = base.replace(/^http:\/\//i, 'https://')

  const normalizedToken = decodeHtmlEntities(String(token || '')).trim()
  const normalizedEncIdx = decodeHtmlEntities(String(encIdx || '')).trim()
  const effectiveIdx = normalizedEncIdx || (normalizedToken ? '1' : '')
  const appendParams: string[] = []
  if (normalizedToken && !/[?&]token=/i.test(fixed)) {
    appendParams.push(`token=${normalizedToken}`)
  }
  if (effectiveIdx && !/[?&]idx=/i.test(fixed)) {
    appendParams.push(`idx=${effectiveIdx}`)
  }
  if (appendParams.length > 0) {
    const connector = fixed.includes('?') ? '&' : '?'
    fixed = `${fixed}${connector}${appendParams.join('&')}`
  }
  return fixed
}

const extractCardThumbMetaFromXml = (xml: string): { thumb?: string; thumbKey?: string } => {
  const normalizedXml = normalizeRawXmlForParsing(xml)
  if (!normalizedXml) return {}
  const mediaMatch = normalizedXml.match(/<media>([\s\S]*?)<\/media>/i)
  if (!mediaMatch?.[1]) return {}

  const mediaXml = mediaMatch[1]
  const thumbMatch = mediaXml.match(/<thumb([^>]*)>([^<]+)<\/thumb>/i)
  if (!thumbMatch) return {}

  const attrs = thumbMatch[1] || ''
  const getAttr = (name: string): string | undefined => {
    const reg = new RegExp(`${name}\\s*=\\s*(?:\"([^\"]+)\"|'([^']+)'|([^\\s>]+))`, 'i')
    const m = attrs.match(reg)
    return decodeHtmlEntities((m?.[1] || m?.[2] || m?.[3] || '').trim()) || undefined
  }
  const thumbRawUrl = thumbMatch[2] || ''
  const thumbToken = getAttr('token')
  const thumbKey = getAttr('key')
  const thumbEncIdx = getAttr('enc_idx')
  const thumb = normalizeSnsAssetUrl(thumbRawUrl, thumbToken, thumbEncIdx)

  return {
    thumb: thumb || undefined,
    thumbKey: thumbKey ? decodeHtmlEntities(thumbKey).trim() : undefined,
  }
}

const pickCardTitle = (post: SnsPost): string => {
  const titleCandidates = [
    post.linkTitle || '',
    ...getXmlTagValues(post.rawXml || '', LINK_XML_TITLE_TAGS),
    post.contentDesc || '',
  ]
  return (
    titleCandidates
      .map((value) => decodeHtmlEntities(value))
      .find((value) => Boolean(value) && !/^https?:\/\//i.test(value)) || '网页链接'
  )
}

export const buildLinkCardData = (post: SnsPost): SnsLinkCardData | null => {
  // type 3 / 5 是链接卡片类型，优先按卡片链接解析
  if (post.type === 3 || post.type === 5) {
    const thumbMeta = extractCardThumbMetaFromXml(post.rawXml || '')
    const directUrlCandidates = [
      post.linkUrl || '',
      ...getXmlTagValues(post.rawXml || '', LINK_XML_DIRECT_URL_TAGS),
      ...post.media.map((item) => item.url || ''),
    ]
    const url = directUrlCandidates.map(normalizeUrlCandidate).find((value): value is string => Boolean(value))
    if (!url) return null
    return {
      url,
      title: pickCardTitle(post),
      thumb: thumbMeta.thumb || post.media[0]?.thumb || post.media[0]?.url,
      thumbKey: thumbMeta.thumbKey || post.media[0]?.key,
    }
  }

  const hasVideoMedia = post.type === 15 || post.media.some((item) => isSnsVideoUrl(item.url))
  if (hasVideoMedia) return null

  const mediaValues = post.media.flatMap((item) => [item.url, item.thumb]).filter((value): value is string => Boolean(value))
  const mediaSet = new Set(mediaValues.map((value) => simplifyUrlForCompare(value)))

  const urlCandidates: string[] = [
    post.linkUrl || '',
    ...getXmlTagValues(post.rawXml || '', LINK_XML_URL_TAGS),
    ...getUrlLikeStrings(post.rawXml || ''),
    ...getUrlLikeStrings(post.contentDesc || ''),
  ]

  const normalizedCandidates = urlCandidates.map(normalizeUrlCandidate).filter((value): value is string => Boolean(value))

  const dedupedCandidates: string[] = []
  const seen = new Set<string>()
  for (const candidate of normalizedCandidates) {
    if (seen.has(candidate)) continue
    seen.add(candidate)
    dedupedCandidates.push(candidate)
  }

  const linkUrl = dedupedCandidates.find((candidate) => {
    const simplified = simplifyUrlForCompare(candidate)
    if (mediaSet.has(simplified)) return false
    if (isLikelyMediaAssetUrl(candidate)) return false
    return true
  })

  if (!linkUrl) return null

  return {
    url: linkUrl,
    title: pickCardTitle(post),
    thumb: post.media[0]?.thumb || post.media[0]?.url,
  }
}

export const buildLocationText = (location?: SnsLocation): string => {
  if (!location) return ''

  const normalize = (value?: string): string => decodeHtmlEntities(String(value || '')).replace(/\s+/g, ' ').trim()

  const primary =
    [normalize(location.poiName), normalize(location.poiAddressName), normalize(location.label), normalize(location.poiAddress)].find(Boolean) ||
    ''

  const region = [normalize(location.country), normalize(location.city)].filter(Boolean).join(' ')

  if (primary && region && !primary.includes(region)) {
    return `${primary} · ${region}`
  }
  return primary || region
}

export const formatSnsTime = (ts: number): string => {
  const date = new Date(ts * 1000)
  const isCurrentYear = date.getFullYear() === new Date().getFullYear()
  return date.toLocaleString('zh-CN', {
    year: isCurrentYear ? undefined : 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

export const snsMediaProtocolUrl = (filePath: string): string => {
  const normalized = filePath.replace(/\\/g, '/')
  // 整个路径放进 pathname 并百分号编码：盘符放 host 会被 Chromium 规范化为
  // host `c`（冒号被当作端口分隔符），导致路径解析丢失盘符冒号
  return `weport-media://local/${encodeURIComponent(normalized)}`
}
