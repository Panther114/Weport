import { describe, expect, it } from 'vitest'
import {
  appMsgKindOf,
  dayKeyOf,
  dayRangeFromInput,
  formatBytes,
  formatCount,
  formatDuration,
  imageMimeFromBase64,
  localMediaUrl,
  mediaUrlFromPayload,
  messageKindOf,
  messagePreviewText,
  messageToPlainText,
  normalizeMessage,
  normalizeSession,
  normalizeTimestamp,
  rangeToPlainText,
  sessionKindOf,
  sortSessions,
  splitHighlight,
  splitMentions,
  toEngineSeconds,
} from './readerMessage'
import type { EngineMessageLike } from './readerTypes'

/**
 * 阅读器的映射层（v1.2 §3）。
 *
 * 这里断言的都是"错了不会报错、只会在界面上静默显示错东西"的地方：localType 分派
 * （分派错了就是一条文本被当成转账）、秒/毫秒（差 1000 倍就是 1970 年）、@ 与高亮的
 * 切分（切错会丢字符）、以及引擎 raw 字段缺失时的兜底。
 *
 * vitest 的 environment 是 `node`（`vitest.config.mts`），没有 jsdom —— 组件渲染
 * 测不了，所以本文件只测纯函数。
 */
describe('normalizeTimestamp', () => {
  it('秒 → 毫秒（引擎与实测都是秒）', () => {
    expect(normalizeTimestamp(1790390545)).toBe(1790390545000)
  })

  it('毫秒原样保留，不会二次放大', () => {
    expect(normalizeTimestamp(1790390545000)).toBe(1790390545000)
  })

  it('空值 / 负数 / 非数字 → 0（界面显示"时间未知"，而不是 1970）', () => {
    expect(normalizeTimestamp(0)).toBe(0)
    expect(normalizeTimestamp(-5)).toBe(0)
    expect(normalizeTimestamp(undefined)).toBe(0)
    expect(normalizeTimestamp('abc')).toBe(0)
    expect(normalizeTimestamp(null)).toBe(0)
  })

  it('toEngineSeconds 与它互为逆运算', () => {
    expect(toEngineSeconds(1790390545000)).toBe(1790390545)
    expect(toEngineSeconds(0)).toBe(0)
  })
})

describe('sessionKindOf', () => {
  it('按 wxid 形态判类型', () => {
    expect(sessionKindOf('45106047164@chatroom')).toBe('group')
    expect(sessionKindOf('gh_f0a92aa7146c')).toBe('official')
    expect(sessionKindOf('wxid_gsnpwh6vh2z012')).toBe('private')
  })
})

describe('normalizeSession', () => {
  it('缺 username 的行直接丢掉（不是渲染成空名字）', () => {
    expect(normalizeSession({})).toBeNull()
    expect(normalizeSession({ displayName: '没有 id' })).toBeNull()
  })

  it('messageCountHint 缺失是 null 而不是 0', () => {
    const session = normalizeSession({ username: 'a@chatroom', displayName: '群' })
    expect(session?.messageCount).toBeNull()
    expect(formatCount(session?.messageCount ?? null)).toBe('—')
  })

  it('名字回退顺序：displayName → sessionDisplayName → id', () => {
    expect(normalizeSession({ username: 'x' })?.name).toBe('x')
    expect(normalizeSession({ username: 'x', sessionDisplayName: '备用名' })?.name).toBe('备用名')
    expect(normalizeSession({ username: 'x', displayName: '主名', sessionDisplayName: '备用名' })?.name).toBe('主名')
  })

  it('sortTimestamp 作为 lastTimestamp 的回退，并归一成毫秒', () => {
    const session = normalizeSession({ username: 'x', sortTimestamp: 1790388300 })
    expect(session?.lastAt).toBe(1790388300000)
  })
})

describe('sortSessions', () => {
  it('按最近活跃降序，时间相同时保持原顺序（稳定）', () => {
    const sorted = sortSessions([
      { id: 'a', name: 'a', kind: 'private', lastAt: 100, messageCount: null, unreadCount: 0, summary: '' },
      { id: 'b', name: 'b', kind: 'private', lastAt: 300, messageCount: null, unreadCount: 0, summary: '' },
      { id: 'c', name: 'c', kind: 'private', lastAt: 300, messageCount: null, unreadCount: 0, summary: '' },
    ])
    expect(sorted.map((session) => session.id)).toEqual(['b', 'c', 'a'])
  })
})

describe('messageKindOf —— localType 分派', () => {
  const kind = (localType: number, extra: Partial<EngineMessageLike> = {}) => messageKindOf({ localType, ...extra })

  it('基础类型按 chatService.parseMessageContent 的表分派', () => {
    expect(kind(1)).toBe('text')
    expect(kind(3)).toBe('image')
    expect(kind(34)).toBe('voice')
    expect(kind(42)).toBe('card')
    expect(kind(43)).toBe('video')
    expect(kind(47)).toBe('sticker')
    expect(kind(48)).toBe('location')
    expect(kind(50)).toBe('call')
    expect(kind(10000)).toBe('system')
    expect(kind(244813135921)).toBe('quote')
    expect(kind(266287972401)).toBe('pat')
    expect(kind(81604378673)).toBe('chatrecord')
    expect(kind(8594229559345)).toBe('redpacket')
    expect(kind(8589934592049)).toBe('transfer')
  })

  it('type 49 的变体 localType 也走 appmsg 细分（3 个文件类变体）', () => {
    expect(kind(49, { fileName: 'a.pdf' })).toBe('file')
    expect(kind(34359738417, { fileName: 'a.pdf' })).toBe('file')
    expect(kind(103079215153, { fileName: 'a.pdf' })).toBe('file')
    expect(kind(25769803825, { linkUrl: 'https://x' })).toBe('link')
  })

  it('未知 localType 落到 other，而不是被当成文本', () => {
    expect(kind(999999)).toBe('other')
  })

  it('声明了 messageCountHint 之外的字段也不会误判', () => {
    expect(kind(1, { fileName: 'a.pdf', linkUrl: 'https://x' })).toBe('text')
  })
})

describe('appMsgKindOf —— type 49 细分', () => {
  it('xmlType 表命中', () => {
    expect(appMsgKindOf({ xmlType: '5' })).toBe('link')
    expect(appMsgKindOf({ xmlType: '6' })).toBe('file')
    expect(appMsgKindOf({ xmlType: '19' })).toBe('chatrecord')
    expect(appMsgKindOf({ xmlType: '33' })).toBe('miniprogram')
    expect(appMsgKindOf({ xmlType: '36' })).toBe('miniprogram')
    expect(appMsgKindOf({ xmlType: '51' })).toBe('finder')
    expect(appMsgKindOf({ xmlType: '53' })).toBe('announcement')
    expect(appMsgKindOf({ xmlType: '57' })).toBe('quote')
    expect(appMsgKindOf({ xmlType: '87' })).toBe('announcement')
    expect(appMsgKindOf({ xmlType: '2000' })).toBe('transfer')
    expect(appMsgKindOf({ xmlType: '2001' })).toBe('redpacket')
    expect(appMsgKindOf({ xmlType: '3' })).toBe('music')
  })

  it('appMsgKind 优先于 xmlType', () => {
    expect(appMsgKindOf({ appMsgKind: 'file', xmlType: '5' })).toBe('file')
  })

  it('没有 xmlType 时按已解析出的字段兜底', () => {
    expect(appMsgKindOf({ fileName: 'x.docx' })).toBe('file')
    expect(appMsgKindOf({ linkUrl: 'https://a' })).toBe('link')
    expect(appMsgKindOf({ chatRecordList: [{}] })).toBe('chatrecord')
    expect(appMsgKindOf({ locationLabel: '公司' })).toBe('location')
    expect(appMsgKindOf({ transferPayerUsername: 'me' })).toBe('transfer')
  })

  it('什么线索都没有时给 link（type 49 的绝大多数是应用消息卡片）', () => {
    expect(appMsgKindOf({})).toBe('link')
  })
})

describe('normalizeMessage', () => {
  it('createTime 秒转毫秒，isSend 归一成布尔', () => {
    const message = normalizeMessage({ localId: 5, createTime: 1790388300, isSend: 1, localType: 1, parsedContent: 'hi' }, 's1')
    expect(message.ts).toBe(1790388300000)
    expect(message.isSend).toBe(true)
    expect(message.text).toBe('hi')
    expect(message.localId).toBe(5)
  })

  it('没有 messageKey 时用 sessionId + localId + 时间兜底（key 必须是会话内唯一的）', () => {
    const a = normalizeMessage({ localId: 7, createTime: 1790388300, localType: 1 }, 's1', 0)
    const b = normalizeMessage({ localId: 7, createTime: 1790388300, localType: 1 }, 's1', 1)
    expect(a.key).not.toBe(b.key)
    expect(a.key).toContain('s1')
  })

  it('fallback keys keep distinct exact local IDs when the IPC Numbers round together', () => {
    const first = normalizeMessage({
      localId: Number('9007199254740992'),
      localIdRaw: '9007199254740992',
      createTime: 1790388300,
      localType: 1,
    }, 's1')
    const second = normalizeMessage({
      localId: Number('9007199254740993'),
      localIdRaw: '9007199254740993',
      createTime: 1790388300,
      localType: 1,
    }, 's1')

    expect(first.localId).toBe(0)
    expect(second.localId).toBe(0)
    expect(first.messageId).toBe('9007199254740992')
    expect(second.messageId).toBe('9007199254740993')
    expect(first.key).not.toBe(second.key)
  })

  it('有 messageKey 就用它', () => {
    expect(normalizeMessage({ messageKey: 'k1', localId: 1, localType: 1 }, 's1').key).toBe('k1')
  })

  it('引用消息解出 sender/text', () => {
    const message = normalizeMessage(
      { localId: 1, createTime: 1, localType: 244813135921, parsedContent: '回复内容', quotedContent: '被引用', quotedSender: '张三' },
      's1',
    )
    expect(message.quote).toEqual({ sender: '张三', text: '被引用' })
  })

  it('只有 quotedSender 也给引用块（不丢信息）', () => {
    const message = normalizeMessage({ localId: 1, localType: 244813135921, quotedSender: '张三' }, 's1')
    expect(message.quote?.sender).toBe('张三')
  })

  it('表情包字段复用 emojiCdnUrl / emojiThumbUrl', () => {
    const message = normalizeMessage({ localId: 1, localType: 47, emojiThumbUrl: 'https://cdn/x' }, 's1')
    expect(message.kind).toBe('sticker')
    expect(message.stickerUrl).toBe('https://cdn/x')
  })

  it('撤回系统消息被标成 revoked（防撤回原文要靠通道，见上报的引擎缺口）', () => {
    const revoked = normalizeMessage({ localId: 1, localType: 10000, parsedContent: '"张三" 撤回了一条消息' }, 's1')
    expect(revoked.revoked).toBe(true)
    const ordinary = normalizeMessage({ localId: 2, localType: 10000, parsedContent: '你邀请了李四加入了群聊' }, 's1')
    expect(ordinary.revoked).toBe(false)
  })

  it('聊天记录条数来自 chatRecordList', () => {
    const message = normalizeMessage({ localId: 1, localType: 81604378673, chatRecordList: [{}, {}, {}] }, 's1')
    expect(message.chatRecordCount).toBe(3)
  })
})

describe('splitMentions', () => {
  it('@ 名字切出来，其它文字一字不差', () => {
    const text = '早上好 @张三 你看看'
    const segments = splitMentions(text)
    expect(segments.filter((segment) => segment.type === 'mention').map((segment) => segment.value)).toEqual(['@张三'])
    expect(segments.map((segment) => segment.value).join('')).toBe(text)
  })

  it('没有 @ 时只有一段文本', () => {
    expect(splitMentions('普通文本')).toEqual([{ type: 'text', value: '普通文本' }])
  })

  it('空文本 → 空数组（渲染层不产出空节点）', () => {
    expect(splitMentions('')).toEqual([])
  })

  it('@ 后面带标点时不会把标点吞进名字', () => {
    const segments = splitMentions('@李四，明天见')
    expect(segments.find((segment) => segment.type === 'mention')?.value).toBe('@李四')
    expect(segments.map((segment) => segment.value).join('')).toBe('@李四，明天见')
  })
})

describe('splitHighlight', () => {
  it('大小写不敏感命中，且拼接结果等于原文', () => {
    const segments = splitHighlight('Hello world hello', 'hello')
    expect(segments.map((segment) => segment.value).join('')).toBe('Hello world hello')
    expect(segments.filter((segment) => segment.hit)).toHaveLength(2)
  })

  it('没有关键词时整段返回', () => {
    expect(splitHighlight('abc', '')).toEqual([{ value: 'abc', hit: false }])
  })

  it('关键词不在文本里时同样原文返回', () => {
    expect(splitHighlight('abc', 'zzz')).toEqual([{ value: 'abc', hit: false }])
  })

  it('空文本 → 空数组', () => {
    expect(splitHighlight('', 'a')).toEqual([])
  })

  it('CJK 也能命中', () => {
    const segments = splitHighlight('今天的会议取消了', '会议')
    expect(segments.filter((segment) => segment.hit).map((segment) => segment.value)).toEqual(['会议'])
  })
})

describe('messagePreviewText', () => {
  const base = normalizeMessage({ localId: 1, localType: 1, parsedContent: '你好' }, 's1')
  const withKind = (patch: Partial<typeof base>) => ({ ...base, ...patch })

  it('文本原样，其它类型写成人话', () => {
    expect(messagePreviewText(base)).toBe('你好')
    expect(messagePreviewText(withKind({ kind: 'image' }))).toBe('[图片]')
    expect(messagePreviewText(withKind({ kind: 'video' }))).toBe('[视频]')
    expect(messagePreviewText(withKind({ kind: 'sticker' }))).toBe('[表情]')
    expect(messagePreviewText(withKind({ kind: 'file', fileName: 'a.pdf' }))).toBe('[文件] a.pdf')
    expect(messagePreviewText(withKind({ kind: 'link', linkTitle: '标题' }))).toBe('[链接] 标题')
  })

  it('语音带时长', () => {
    expect(messagePreviewText(withKind({ kind: 'voice', voiceDurationSeconds: 7 }))).toBe('[语音 7″]')
  })

  it('微信原生转写作为语音显示文本和列表摘要', () => {
    const message = normalizeMessage({ localId: 9, localType: 34, voiceTranscript: '会议改到下午三点' }, 's1')
    expect(message.text).toBe('会议改到下午三点')
    expect(message.voiceTranscript).toBe('会议改到下午三点')
    expect(messagePreviewText(message)).toBe('[语音转文字] 会议改到下午三点')
  })

  it('超长摘要被截断并加省略号', () => {
    const long = messagePreviewText(withKind({ text: 'a'.repeat(100) }), 10)
    expect(long.endsWith('…')).toBe(true)
    expect(long.length).toBeLessThanOrEqual(11)
  })

  it('换行被压成空格（列表里只有一行）', () => {
    expect(messagePreviewText(withKind({ text: 'a\n\nb' }))).toBe('a b')
  })

  it('空内容有兜底文案，不会渲染成空白行', () => {
    expect(messagePreviewText(withKind({ text: '' }))).toBe('[空消息]')
  })
})

describe('messageToPlainText', () => {
  it('带上时间、发送者与内容', () => {
    const message = normalizeMessage(
      { localId: 1, createTime: 1790388300, isSend: 1, localType: 1, parsedContent: '在的', senderDisplayName: '我' },
      's1',
    )
    const text = messageToPlainText(message)
    expect(text).toContain('我：')
    expect(text).toContain('在的')
  })

  it('引用消息把引用行也带上', () => {
    const message = normalizeMessage(
      { localId: 1, localType: 244813135921, parsedContent: '同意', quotedContent: '要不要发版', quotedSender: '张三' },
      's1',
    )
    expect(messageToPlainText(message)).toContain('张三：要不要发版')
  })

  it('媒体写成方括号说明，不假装有原文', () => {
    const image = normalizeMessage({ localId: 1, localType: 3 }, 's1')
    expect(messageToPlainText(image)).toContain('[图片]')
    const file = normalizeMessage({ localId: 2, localType: 49, fileName: 'report.pdf', fileSize: 2048 }, 's1')
    const fileText = messageToPlainText(file)
    expect(fileText).toContain('[文件] report.pdf')
    expect(fileText).toContain('2.0 KB')
  })

  it('复制语音时包含微信原生转写', () => {
    const message = normalizeMessage({
      localId: 9,
      createTime: 1790388300,
      senderUsername: 'wxid_fixture',
      localType: 34,
      voiceTranscript: '会议改到下午三点',
    }, 's1')
    expect(messageToPlainText(message)).toContain('[语音转文字] 会议改到下午三点')
  })

  it('rangeToPlainText 逐条换行拼接', () => {
    const a = normalizeMessage({ localId: 1, localType: 1, parsedContent: 'A' }, 's1')
    const b = normalizeMessage({ localId: 2, localType: 1, parsedContent: 'B' }, 's1')
    const text = rangeToPlainText([a, b])
    expect(text.split('\n').filter((line) => line.includes('A') || line.includes('B'))).toHaveLength(2)
  })
})

describe('时间与数值格式化', () => {
  it('dayKeyOf 用本地时区（用户说的"这一天"是本地的那一天）', () => {
    const noon = new Date(2026, 8, 27, 12, 0, 0).getTime()
    expect(dayKeyOf(noon)).toBe('2026-09-27')
  })

  it('dayRangeFromInput 是左闭右开的整天', () => {
    const range = dayRangeFromInput('2026-09-27')
    expect(range).not.toBeNull()
    expect(range?.end).toBe((range?.start || 0) + 86400000)
    expect(dayKeyOf(range?.start || 0)).toBe('2026-09-27')
  })

  it('dayRangeFromInput 拒绝非法输入（不给引擎一个编出来的日期）', () => {
    expect(dayRangeFromInput('')).toBeNull()
    expect(dayRangeFromInput('2026/09/27')).toBeNull()
    expect(dayRangeFromInput('today')).toBeNull()
  })

  it('formatDuration 分秒两档', () => {
    expect(formatDuration(7)).toBe('7″')
    expect(formatDuration(65)).toBe('1′05″')
  })

  it('formatBytes 空值不产出 "0 B"（调用方据此隐藏这一栏）', () => {
    expect(formatBytes(0)).toBe('')
    expect(formatBytes(2048)).toBe('2.0 KB')
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB')
  })

  it('formatCount 大数用"万"，缺失用破折号', () => {
    expect(formatCount(5072)).toBe('5072')
    expect(formatCount(26669)).toBe('2.7 万')
    expect(formatCount(null)).toBe('—')
  })
})

describe('媒体 URL', () => {
  it('localMediaUrl 走 weport-media 协议，盘符被百分号编码（不然 host 会被吃掉）', () => {
    const url = localMediaUrl('D:\\xwechat_files\\a\\b.jpg')
    expect(url.startsWith('weport-media://local/')).toBe(true)
    expect(url).toContain('D%3A')
  })

  it('imageMimeFromBase64 按文件头嗅探', () => {
    expect(imageMimeFromBase64('/9j/4AAQ')).toBe('image/jpeg')
    expect(imageMimeFromBase64('iVBORw0KGgo')).toBe('image/png')
    expect(imageMimeFromBase64('R0lGODlh')).toBe('image/gif')
    expect(imageMimeFromBase64('UklGRg==')).toBe('image/webp')
  })

  it('mediaUrlFromPayload 认 data / 本地路径两种返回', () => {
    expect(mediaUrlFromPayload({ success: true, data: '/9j/4AAQ' }).url).toBe('data:image/jpeg;base64,/9j/4AAQ')
    expect(mediaUrlFromPayload({ success: true, data: 'data:image/png;base64,AAA' }).url).toBe('data:image/png;base64,AAA')
    expect(mediaUrlFromPayload({ success: true, localPath: 'D:\\a\\b.jpg' }).url).toContain('weport-media://local/')
    // 引擎真的回了本地路径时应该走协议，而不是把文件读成 base64 塞进 IPC
    expect(mediaUrlFromPayload({ success: true, filePath: '/tmp/a.jpg' }).url).toContain('weport-media://local/')
  })

  it('失败与空返回给出人话错误（不返回一个空 src）', () => {
    expect(mediaUrlFromPayload({ success: false, error: '解密失败' })).toEqual({ error: '解密失败' })
    expect(mediaUrlFromPayload({ success: true }).error).toBeTruthy()
    expect(mediaUrlFromPayload(null).error).toBeTruthy()
  })
})
