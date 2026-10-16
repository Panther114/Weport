import { describe, expect, it } from 'vitest'
import {
    REDACTION_LABELS,
    effectiveRedactionOptions,
    findRedactions,
    luhnOk,
    maskValue,
    redactSegments,
    redactText,
    summarizeMatches,
} from './posterRedaction.ts'
import { DEFAULT_REDACTION_KINDS } from './posterTypes.ts'

/**
 * 自动打码的匹配器（v1.2 §4）。
 *
 * 这个文件里**反例和正例一样重要**：打码漏了会把号码留在导出的图里，打码过度会把
 * 一句正常的话涂掉。两者都不会报错、只会静静地出现在用户发出去的图片里，所以每加
 * 一条规则都要同时写"它不该命中的东西"。
 *
 * vitest 的 environment 是 `node`（`vitest.config.mts`），没有 DOM —— 这里只测纯函数。
 */

describe('手机号', () => {
    it('11 位手机号被命中（含 +86 与分组书写）', () => {
        expect(findRedactions('我的手机 13812345678 你记一下').map((m) => m.raw)).toEqual(['13812345678'])
        expect(findRedactions('138 1234 5678').map((m) => m.raw)).toEqual(['138 1234 5678'])
        expect(findRedactions('138-1234-5678').map((m) => m.raw)).toEqual(['138-1234-5678'])
        expect(findRedactions('+86 13912345678').map((m) => m.raw)).toEqual(['+86 13912345678'])
    })

    it('反例：订单号 / 长度不对 / 号段不对的数字不算手机号', () => {
        // 11 位但以 2 开头（订单号、流水号）
        expect(findRedactions('订单号 20250925123')).toEqual([])
        // 10 位
        expect(findRedactions('编号 1381234567')).toEqual([])
        // 12 位（多了 1 位）
        expect(findRedactions('138123456789')).toEqual([])
        // 号段必须是 1[3-9]
        expect(findRedactions('11212345678')).toEqual([])
    })
})

describe('wxid', () => {
    it('wxid_ 开头的标识被命中', () => {
        expect(findRedactions('加我 wxid_abc123xyz 谢谢').map((m) => m.raw)).toEqual(['wxid_abc123xyz'])
    })

    it('反例：wx_id / wxid（无下划线）/ 太短的都不算', () => {
        expect(findRedactions('wx_id1234')).toEqual([])
        expect(findRedactions('wxid')).toEqual([])
        expect(findRedactions('wxid_ab')).toEqual([])
    })
})

describe('身份证号', () => {
    it('18 位与 15 位都被命中', () => {
        expect(findRedactions('身份证 11010519491231002X').map((m) => m.raw)).toEqual(['11010519491231002X'])
        expect(findRedactions('老号 110105491231002').map((m) => m.raw)).toEqual(['110105491231002'])
    })

    it('反例：月份 13 / 日期 32 不命中（避免把流水号当身份证）', () => {
        expect(findRedactions('11010519491331002X')).toEqual([])
        expect(findRedactions('11010519491232002X')).toEqual([])
    })
})

describe('银行卡号', () => {
    it('Luhn 通过的 16~19 位连续数字命中', () => {
        // 4111 1111 1111 1111 / 4242 4242 4242 4242 都是行业标准的测试卡号（Luhn 通过）
        expect(findRedactions('卡号 4111111111111111').map((m) => m.kind)).toEqual(['bankcard'])
        expect(findRedactions('4242424242424242').map((m) => m.kind)).toEqual(['bankcard'])
        expect(findRedactions('5555555555554444').map((m) => m.kind)).toEqual(['bankcard'])
    })

    it('分组书写即使 Luhn 不过也命中（分组本身就是强信号）', () => {
        expect(findRedactions('1234 5678 9012 3456').map((m) => m.raw)).toEqual(['1234 5678 9012 3456'])
    })

    it('反例：Luhn 不过的 16 位流水号、20 位长串、15 位数字都不算卡号', () => {
        expect(findRedactions('流水 1234567890123456')).toEqual([])
        expect(findRedactions('12345678901234567890')).toEqual([])
        expect(findRedactions('123456789012345')).toEqual([])
    })

    it('luhnOk 的边界', () => {
        expect(luhnOk('4111111111111111')).toBe(true)
        expect(luhnOk('4111111111111112')).toBe(false)
        expect(luhnOk('')).toBe(false)
        expect(luhnOk('4111x')).toBe(false)
    })

    it('18 位身份证不会被当成银行卡（优先级裁决）', () => {
        const [match] = findRedactions('11010519491231002X')
        expect(match.kind).toBe('idcard')
    })
})

describe('邮箱 / 地址 / 验证码', () => {
    it('邮箱命中', () => {
        expect(findRedactions('邮箱 zhang.san+wx@example.com.cn').map((m) => m.kind)).toEqual(['email'])
    })

    it('详细地址命中（省市 + 区 + 路 + 号）', () => {
        const text = '寄到北京市海淀区中关村大街1号谢谢'
        expect(findRedactions(text).map((m) => m.kind)).toEqual(['address'])
        expect(findRedactions('上海市浦东新区张江路88号').map((m) => m.kind)).toEqual(['address'])
    })

    it('地址的尾巴只到门牌，不吞后面的句子（夹具抓图里肉眼发现过这个 bug）', () => {
        const [match] = findRedactions('收到，我后天回国，寄到北京市海淀区中关村大街1号就行。')
        expect(match.raw.endsWith('号')).toBe(true)
        expect(match.raw).not.toContain('就行')
        // 打码后的文本里，"就行"原样留着
        expect(redactText('寄到北京市海淀区中关村大街1号就行。').text).toContain('就行')
    })

    it('反例：只提到城市名不算地址（否则每一句"我在北京"都会被涂）', () => {
        expect(findRedactions('我今天在北京出差')).toEqual([])
        expect(findRedactions('广州市天河区')).toEqual([])
    })

    it('验证码只取数字部分，且关键词后 6 字内的数字才算', () => {
        const hit = findRedactions('【某某】验证码 867530，5 分钟内有效')
        expect(hit.map((m) => m.raw)).toEqual(['867530'])
        // 反例：没有关键词的一串数字（时间戳）
        expect(findRedactions('时间戳 1712345')).toEqual([])
    })
})

describe('昵称（词表型）', () => {
    it('词表里的名字被命中，单字名字被忽略（命中率太高）', () => {
        const options = { dictionary: ['张三丰', '李'] }
        expect(findRedactions('张三丰说下周见', options).map((m) => m.raw)).toEqual(['张三丰'])
        expect(findRedactions('李说了什么', options)).toEqual([])
    })

    it('同一名字出现多次都命中', () => {
        const hit = findRedactions('张三丰问张三丰答', { dictionary: ['张三丰'] })
        expect(hit).toHaveLength(2)
    })
})

describe('重叠裁决与打码结果', () => {
    it('地址吞掉其中的手机号（起点更早者优先）', () => {
        const text = '北京市海淀区中关村大街1号 13812345678'
        const kinds = findRedactions(text).map((m) => m.kind)
        expect(kinds).toContain('address')
        expect(kinds).toContain('phone')
    })

    it('redactText 返回等长替换，位置不乱（wxid 也一样只留首尾，不保留 wxid_ 前缀）', () => {
        const result = redactText('电话 13812345678 与 wxid_abc1234 都别外传')
        expect(result.matches).toHaveLength(2)
        expect(result.text).toBe('电话 1*********8 与 w**********4 都别外传')
        // 长度不变：界面排版不会因为打码而跳动
        expect([...result.text]).toHaveLength([...'电话 13812345678 与 wxid_abc1234 都别外传'].length)
    })

    it('强度只影响留不留边角，长度不变', () => {
        expect(maskValue('13812345678', 'phone', 'light')).toBe('138******78')
        expect(maskValue('13812345678', 'phone', 'normal')).toBe('1*********8')
        expect(maskValue('13812345678', 'phone', 'strong')).toBe('●'.repeat(11))
        expect([...maskValue('13812345678', 'phone', 'strong')]).toHaveLength(11)
    })

    it('验证码任何强度都不留边角（留一位等于没打码）', () => {
        expect(maskValue('867530', 'code', 'light')).toBe('●●●●●●')
        expect(maskValue('867530', 'code', 'normal')).toBe('●●●●●●')
    })

    it('昵称只留首字', () => {
        expect(maskValue('张三丰', 'name', 'normal')).toBe('张**')
    })

    it('redactSegments 切出的片段能原样拼回打码后的文本', () => {
        const text = '电话 13812345678 找我'
        const segments = redactSegments(text)
        expect(segments.map((s) => s.text).join('')).toBe('电话 1*********8 找我')
        expect(segments.filter((s) => s.kind).map((s) => s.kind)).toEqual(['phone'])
    })
})

describe('开关与汇总', () => {
    it('关闭后一条规则都不跑（不是"少跑几条"）', () => {
        const options = effectiveRedactionOptions(
            { enabled: false, strength: 'normal', kinds: DEFAULT_REDACTION_KINDS },
            ['张三丰']
        )
        expect(findRedactions('张三丰 13812345678 wxid_abc1234', options)).toEqual([])
        expect(redactText('13812345678', options).text).toBe('13812345678')
    })

    it('开启时词表生效、种类可裁剪', () => {
        const options = effectiveRedactionOptions({ enabled: true, strength: 'normal', kinds: ['phone'] }, ['张三丰'])
        expect(findRedactions('张三丰 13812345678', options).map((m) => m.kind)).toEqual(['phone'])
    })

    it('汇总按固定顺序输出（界面说明条的文字要稳定）', () => {
        const matches = findRedactions('13812345678 wxid_abc1234 a@b.com')
        const summary = summarizeMatches(matches)
        expect(summary.map((item) => item.label)).toEqual([REDACTION_LABELS.phone, REDACTION_LABELS.email, REDACTION_LABELS.wxid])
        expect(summary.reduce((sum, item) => sum + item.count, 0)).toBe(3)
    })
})
