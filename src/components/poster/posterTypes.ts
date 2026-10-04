/**
 * 分享海报工作室（v1.2 §4）的形状定义。
 *
 * 这一层只描述"渲染一张海报需要什么"，不碰引擎、不碰 DOM。布局（`posterLayout`）、
 * 绘制（`posterDom`）、打码（`posterRedaction`）三个纯模块都只认这里的类型 ——
 * 于是同一份几何既能被 React 预览用，也能被导出前的实测高度覆盖，
 * 而 vitest（environment: node，没有 DOM）还能对整个排版做断言。
 *
 * 坐标约定：**页面用像素（画布宽度恒为 1080），裁剪框用 0..1 的归一化比例**。
 * 混用两种坐标是这类编辑器最容易出的错（换一张图裁剪框就跑偏），所以分开写死。
 */

/** 四种模板（D16：模板编辑器 + 竖版长图 + 九宫格拼贴 都要有）。 */
export type PosterTemplateId = 'long' | 'quote' | 'grid9' | 'summary'

/** 海报自己的明暗，**与 App 主题无关** —— 导出的图片要能在别人的手机上读。 */
export type PosterTheme = 'light' | 'dark'

/**
 * 自动打码的种类。规则与词表在 `posterRedaction`。
 *
 * `name` 是**词表型**（会话昵称 / 群昵称），其余都是正则型 —— 词表来源于本次
 * 选中的会话与发送者，见 `collectRedactionDictionary`。
 */
export type RedactionKind = 'phone' | 'wxid' | 'idcard' | 'bankcard' | 'email' | 'address' | 'code' | 'name'

/**
 * 打码强度。区别只在"留不留边角"：
 * - `light`  留头 3 尾 2（结构可读，中段遮蔽）—— 核对"这是不是同一个号码"时用；
 * - `normal` 留头 1 尾 1；
 * - `strong` 全遮蔽（等长占位，版面不跳动）。
 * 验证码**任何强度都全遮蔽**：4~6 位里留下一位就等于没打码。
 */
export type RedactionStrength = 'light' | 'normal' | 'strong'

/** 9 宫格的归一化裁剪框。 */
export interface PosterCrop {
    x: number
    y: number
    w: number
    h: number
}

/** 帖子/消息条目类型。只留海报会画的几种，其余归 `other`。 */
export type PosterItemKind = 'text' | 'image' | 'voice' | 'file' | 'link' | 'sticker' | 'quote' | 'system' | 'other'

/**
 * 海报里的一个条目。
 *
 * `visible` / `order` / `crop` 都由 `posterLayout` 的纯 reducer 改（数组顺序即顺序），
 * 页面只负责把它们交给 reducer 并回写 —— 这样"拖动排序"和"隐藏某条"是**可测的
 * 数据变换**，而不是散在事件处理函数里的数组操作。
 */
export interface PosterItem {
    /** 会话内唯一（引擎 messageKey / 朋友圈 postId / 手写引用的本地 id） */
    key: string
    sessionId: string
    /** 引擎消息身份：图片解密必须包含分片、表、时间与 id 类型，避免同 id 跨库错图。 */
    localId?: number
    /** Exact decimal ID text; keeps large server IDs intact. */
    messageId?: string
    serverId?: string
    idKind?: 'local' | 'server'
    db?: string
    table?: string
    senderName: string
    senderUsername?: string
    senderAvatarUrl?: string
    /** 引擎的 isSend：自己发的气泡靠右 */
    isSend: boolean
    /** 毫秒时间戳；0 = 引擎没给（界面显示"时间未知"而不是 1970） */
    ts: number
    kind: PosterItemKind
    /** 正文（已由引擎解出的可读文本） */
    text: string
    quote?: { sender: string; text: string }
    /**
     * 图片地址。**必须是能直接画进 canvas 的形式**（data URL / 已解密的本机
     * 可读地址）：SNS 走 `sns:proxyImage` 拿 dataUrl，聊天图片目前没有解密通道，
     * 因此 `imageUnavailable` 为 true 的条目会画成占位块而不是空气。
     */
    imageSrc?: string
    imageUnavailable?: boolean
    /** 媒体替代文字（文件名 / 时长 / "图片"），画在占位块与无障碍标签上 */
    imageAlt?: string
    /** 9 宫格裁剪框；缺省 = 居中 cover */
    crop?: PosterCrop
    /** 手动遮挡框（归一化，是相对图片自身的矩形）—— 二维码/工牌这类无法用正则识别的东西 */
    maskBox?: PosterCrop | null
    visible: boolean
}

/** 小结卡用的统计形状：**照抄 `analyticsService.ChatStatistics`**（唯一真源在引擎侧）。 */
export interface PosterSummaryStats {
    totalMessages: number
    textMessages: number
    imageMessages: number
    voiceMessages: number
    sentMessages: number
    receivedMessages: number
    firstMessageTime: number | null
    lastMessageTime: number | null
    activeDays: number
}

/** 打码设置。`enabled` 默认 true（D15/D16：自动打码默认开）。 */
export interface PosterRedactionOptions {
    enabled: boolean
    strength: RedactionStrength
    kinds: RedactionKind[]
}

/** 海报的全部可调项。模板 = 这套选项的一组预设（`posterTemplates`）。 */
export interface PosterOptions {
    template: PosterTemplateId
    theme: PosterTheme
    /** 强调色 `#rrggbb` */
    accent: string
    /** 字号倍率 0.8 ~ 1.6 */
    fontScale: number
    showAvatar: boolean
    showBubble: boolean
    showWatermark: boolean
    showTimestamp: boolean
    /** 页脚自由文本（空 = 只有水印） */
    footer: string
    /** 标题（海报顶部；空 = 不画标题块） */
    title: string
    redaction: PosterRedactionOptions
    /** 长图单页最大高度（px）。超过就分页 —— canvas 有尺寸上限，见 posterLayout */
    pageMaxHeight: number
    /** 预览缩放（**只影响预览**，不参与导出） */
    zoom: number
}

/** 固定导出宽度：1080（公众号/朋友圈长图的通用宽度）。 */
export const POSTER_WIDTH = 1080

/** 默认打码种类：手机号 / wxid / 身份证 / 银行卡 / 邮箱 / 地址 / 验证码 / 昵称。 */
export const DEFAULT_REDACTION_KINDS: RedactionKind[] = [
    'phone',
    'wxid',
    'idcard',
    'bankcard',
    'email',
    'address',
    'code',
    'name',
]

export const DEFAULT_POSTER_OPTIONS: PosterOptions = {
    template: 'long',
    theme: 'dark',
    accent: '#5b8eff',
    fontScale: 1,
    showAvatar: true,
    showBubble: true,
    showWatermark: true,
    showTimestamp: true,
    footer: '',
    title: '',
    redaction: { enabled: true, strength: 'normal', kinds: [...DEFAULT_REDACTION_KINDS] },
    pageMaxHeight: 12000,
    zoom: 0.42,
}

/** 一行会话（`chat:getSessions` 的可用字段，归一化后）。 */
export interface PosterSession {
    id: string
    name: string
    kind: 'group' | 'private' | 'official'
    lastAt: number
    summary: string
    avatarUrl?: string
    messageCount: number | null
}

/** 内容来源：会话 / 朋友圈 / 手写引用。 */
export type PosterSourceKind = 'session' | 'sns' | 'manual'
