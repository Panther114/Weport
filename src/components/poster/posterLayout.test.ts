import { describe, expect, it } from 'vitest'
import {
    applyCrop,
    applyMaskBox,
    applyReorder,
    applyVisibility,
    applyVisibilityAll,
    buildPosterBlocks,
    buildPosterPages,
    clampCrop,
    collectRedactionDictionary,
    cropImageStyle,
    estimateCaptureCost,
    estimateTextLines,
    estimateTextWidth,
    gridSlots,
    isolateKeys,
    pagePadding,
    paginateBlocks,
    posterMetrics,
    visibleItems,
} from './posterLayout.ts'
import type { PosterItem, PosterSummaryStats } from './posterTypes.ts'
import { DEFAULT_POSTER_OPTIONS, POSTER_WIDTH } from './posterTypes.ts'

/**
 * 排版与三个纯 reducer（v1.2 §4）。
 *
 * 断言的都是"错了不报错、只在导出的图里显形"的地方：一条消息被劈成两页、
 * 拖动排序把条目弄丢、裁剪框越界（换成别的图片比例就漂）、九宫格槽位错位、
 * 长图分页把一张图切到画布之外。
 *
 * vitest 的 environment 是 `node`，所以这里只有纯函数（DOM 渲染在
 * posterDom 里，靠 fixtures 抓图验证）。
 */

function item(overrides: Partial<PosterItem> = {}): PosterItem {
    return {
        key: overrides.key ?? `k${Math.random().toString(36).slice(2, 8)}`,
        sessionId: 's1',
        senderName: '张三',
        isSend: false,
        ts: 1_790_390_545_000,
        kind: 'text',
        text: '你好',
        visible: true,
        ...overrides,
    }
}

describe('reorder / visibility 三个 reducer', () => {
    const items = [item({ key: 'a' }), item({ key: 'b' }), item({ key: 'c' }), item({ key: 'd' })]

    it('把第 0 条拖到第 2 条：数组顺序按 arrayMove 语义变', () => {
        expect(applyReorder(items, 0, 2).map((i) => i.key)).toEqual(['b', 'c', 'a', 'd'])
    })

    it('往回拖也对', () => {
        expect(applyReorder(items, 3, 1).map((i) => i.key)).toEqual(['a', 'd', 'b', 'c'])
    })

    it('越界不丢条目（拖到列表外的下标被夹回区间内）', () => {
        expect(applyReorder(items, 0, 99).map((i) => i.key)).toEqual(['b', 'c', 'd', 'a'])
        expect(applyReorder(items, 3, -5).map((i) => i.key)).toEqual(['d', 'a', 'b', 'c'])
        expect(applyReorder(items, 0, 0).map((i) => i.key)).toEqual(['a', 'b', 'c', 'd'])
    })

    it('非法起点原样返回（不返回空数组）', () => {
        expect(applyReorder(items, -1, 2)).toBe(items)
        expect(applyReorder(items, 9, 2)).toBe(items)
    })

    it('单条显隐只改那一条，且不改原数组', () => {
        const next = applyVisibility(items, 'b', false)
        expect(next.map((i) => i.visible)).toEqual([true, false, true, true])
        expect(items[1].visible).toBe(true)
    })

    it('全选 / 全不选 / 仅选中', () => {
        expect(applyVisibilityAll(items, false).every((i) => !i.visible)).toBe(true)
        expect(isolateKeys(items, ['a', 'c']).map((i) => i.visible)).toEqual([true, false, true, false])
    })

    it('裁剪与遮挡被夹回 0..1（越界框会让图片画到画布外）', () => {
        const cropped = applyCrop(items, 'a', { x: 0.9, y: 0.9, w: 0.5, h: 0.5 })
        expect(cropped[0].crop).toEqual({ x: 0.9, y: 0.9, w: 0.1, h: 0.1 })
        expect(applyMaskBox(items, 'a', { x: -1, y: -1, w: 9, h: 9 })[0].maskBox).toEqual({ x: 0, y: 0, w: 1, h: 1 })
        expect(applyMaskBox(items, 'a', null)[0].maskBox).toBeNull()
    })

    it('clampCrop 保底 5% 边长（拖成 0 会让图消失且拖不回来）', () => {
        expect(clampCrop({ x: 0.5, y: 0.5, w: 0, h: 0 })).toEqual({ x: 0.5, y: 0.5, w: 0.05, h: 0.05 })
    })

    it('visibleItems 只留可见', () => {
        expect(visibleItems(applyVisibility(items, 'c', false)).map((i) => i.key)).toEqual(['a', 'b', 'd'])
    })
})

describe('裁剪 → 图片样式（与像素尺寸无关）', () => {
    it('整图不裁剪时没有位移', () => {
        expect(cropImageStyle({ x: 0, y: 0, w: 1, h: 1 })).toEqual({ width: '100.00%', height: '100.00%', objectPosition: '50.00% 50.00%' })
    })

    it('取右下四分之一：放大 2×，位移 -100%', () => {
        const style = cropImageStyle({ x: 0.5, y: 0.5, w: 0.5, h: 0.5 })
        expect(style).toEqual({ width: '200.00%', height: '200.00%', objectPosition: '100.00% 100.00%' })
    })

    it('不裁剪时返回 null（不要写一堆无意义的样式）', () => {
        expect(cropImageStyle(undefined)).toBeNull()
    })
})

describe('九宫格槽位', () => {
    it('9 个归一化方格，按行铺满', () => {
        const slots = gridSlots(9)
        expect(slots).toHaveLength(9)
        expect(slots[0]).toEqual({ x: 0, y: 0, w: 1 / 3, h: 1 / 3 })
        expect(slots[4].x).toBeCloseTo(1 / 3, 5)
        expect(slots[8].y).toBeCloseTo(2 / 3, 5)
    })

    it('少于 9 张不多给槽位，超过 9 张被截断', () => {
        expect(gridSlots(4)).toHaveLength(4)
        expect(gridSlots(20)).toHaveLength(9)
    })
})

describe('文本度量与分页', () => {
    const options = { ...DEFAULT_POSTER_OPTIONS, showBubble: true, showAvatar: true, showTimestamp: true }

    it('汉字按 1 个字宽、ASCII 按 0.55 估算', () => {
        expect(estimateTextWidth('你好', 30)).toBe(60)
        expect(estimateTextWidth('ab', 30)).toBeCloseTo(33, 5)
    })

    it('长文本按行数计入高度（不能按"一条 48px"算）', () => {
        const metrics = posterMetrics(options)
        expect(estimateTextLines('好'.repeat(10), metrics)).toBe(1)
        expect(estimateTextLines('好'.repeat(1000), metrics)).toBeGreaterThan(1)
        // 换行符各自成行
        expect(estimateTextLines('a\nb\nc', metrics)).toBe(3)
    })

    it('一条消息只出现在一页里（不被劈成两半）', () => {
        const items = Array.from({ length: 40 }, (_, index) => item({ key: `m${index}`, text: `第 ${index} 条消息，内容够长够占地方，用来触发分页。` }))
        const pages = buildPosterPages(items, { ...options, pageMaxHeight: 3000 })
        expect(pages.length).toBeGreaterThan(1)
        const seen = new Set<string>()
        for (const page of pages) {
            const keys = page.blocks.map((b) => b.itemKey).filter(Boolean)
            for (const key of keys) {
                expect(seen.has(key as string)).toBe(false)
                seen.add(key as string)
            }
            expect(page.height).toBeLessThanOrEqual(3000)
        }
        expect(seen.size).toBe(40)
    })

    it('长图的第二页起会重画标题块（否则用户不知道这是什么对话）', () => {
        const items = Array.from({ length: 40 }, (_, index) => item({ key: `m${index}`, text: '内容'.repeat(80) }))
        const pages = buildPosterPages(items, { ...options, title: '家庭群', pageMaxHeight: 3000 })
        expect(pages.length).toBeGreaterThan(1)
        expect(pages[0].blocks[0].key).toBe('header')
        expect(pages[1].blocks[0].key).toBe('header')
    })

    it('实测高度回填后重新分页：页数会随真实高度变化（而不是沿用估算）', () => {
        const blocks = Array.from({ length: 10 }, (_, index) => ({
            key: `b${index}`,
            kind: 'message' as const,
            itemKey: `b${index}`,
            text: 'x',
            height: 100,
        }))
        const estimated = paginateBlocks(blocks, { ...options, pageMaxHeight: 1000 })
        const measured = paginateBlocks(
            blocks.map((block) => ({ ...block, height: 900 })),
            { ...options, pageMaxHeight: 1000 }
        )
        expect(estimated.length).toBeLessThan(measured.length)
    })

    it('空内容也有 1 页（不返回空数组：导出时不该抓 0 个节点）', () => {
        const pages = buildPosterPages([], options)
        expect(pages).toHaveLength(1)
        // 水印默认开着，所以这一页可能只有一个页脚块（它是设计的一部分，不是内容）
        expect(pages[0].blocks.every((block) => block.kind === 'footer')).toBe(true)
    })

    it('页面高度 = 块高之和 + 块间距 + 上下留白（间距漏了会让每页超出预算）', () => {
        const items = Array.from({ length: 6 }, (_, index) => item({ key: `m${index}`, text: `第 ${index} 条` }))
        const pages = buildPosterPages(items, options)
        const padding = pagePadding(options)
        const gap = posterMetrics(options).gap
        const blocks = pages[0].blocks
        const expected = Math.round(
            padding.top + blocks.reduce((total, block) => total + block.height, 0) + (blocks.length - 1) * gap + padding.bottom
        )
        expect(pages[0].height).toBe(expected)
    })

    it('分页预算把块间距算进去：实测过 12000px 预算却出 13691px 的那次超限', () => {
        const items = Array.from({ length: 200 }, (_, index) => item({ key: `m${index}`, text: '一条长度普通的消息，占一到两行。' }))
        const pages = buildPosterPages(items, { ...options, title: '家庭群', pageMaxHeight: 12000 })
        for (const page of pages) {
            expect(page.height).toBeLessThanOrEqual(12000)
        }
    })
})

describe('模板取内容', () => {
    const items = [
        item({ key: 't1', kind: 'text', text: '第一句话' }),
        item({ key: 'i1', kind: 'image', imageSrc: 'data:image/png;base64,AAA', imageUnavailable: false, imageAlt: '图1' }),
        item({ key: 'i2', kind: 'image', imageSrc: 'data:image/png;base64,BBB', imageUnavailable: false, imageAlt: '图2' }),
        item({ key: 'hidden', kind: 'text', text: '隐藏的', visible: false }),
    ]

    it('长图把可见条目按顺序铺开，隐藏条目不入画', () => {
        const blocks = buildPosterBlocks(items, { ...DEFAULT_POSTER_OPTIONS, template: 'long' })
        expect(blocks.filter((b) => b.kind === 'message').map((b) => b.itemKey)).toEqual(['t1'])
        expect(blocks.filter((b) => b.kind === 'media').map((b) => b.itemKey)).toEqual(['i1', 'i2'])
    })

    it('引用卡只取第一条', () => {
        const many = Array.from({ length: 5 }, (_, index) => item({ key: `q${index}`, text: `第 ${index} 句` }))
        const blocks = buildPosterBlocks(many, { ...DEFAULT_POSTER_OPTIONS, template: 'quote' })
        expect(blocks.filter((b) => b.kind === 'message')).toHaveLength(1)
        expect(blocks.find((b) => b.kind === 'message')?.itemKey).toBe('q0')
    })

    it('九宫格只取图片，最多 9 格，且槽位序号连续', () => {
        const images = Array.from({ length: 12 }, (_, index) => item({ key: `g${index}`, kind: 'image', imageUnavailable: true }))
        const blocks = buildPosterBlocks([...images, item({ key: 'text' })], { ...DEFAULT_POSTER_OPTIONS, template: 'grid9' })
        const media = blocks.filter((b) => b.kind === 'media')
        expect(media).toHaveLength(9)
        expect(media.map((b) => b.image?.slot)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8])
    })

    it('小结卡用统计形状出块（复用分析页的数据形状）', () => {
        const stats: PosterSummaryStats = {
            totalMessages: 12345,
            textMessages: 9000,
            imageMessages: 300,
            voiceMessages: 40,
            sentMessages: 6000,
            receivedMessages: 6345,
            firstMessageTime: 1_700_000_000_000,
            lastMessageTime: 1_790_000_000_000,
            activeDays: 210,
        }
        const blocks = buildPosterBlocks([], { ...DEFAULT_POSTER_OPTIONS, template: 'summary' }, { summary: stats })
        const statBlocks = blocks.filter((b) => b.kind === 'stat')
        expect(statBlocks).toHaveLength(4)
        expect(statBlocks[0].stat?.value).toBe('12,345')
        expect(statBlocks[3].stat?.value).toBe('210')
    })

    it('页脚 = 自由文本 + 水印，两者都关就没有页脚块', () => {
        const withFooter = buildPosterBlocks([], { ...DEFAULT_POSTER_OPTIONS, footer: '给妈妈的', showWatermark: true })
        expect(withFooter.find((b) => b.kind === 'footer')?.text).toBe('给妈妈的 · Weport')
        const none = buildPosterBlocks([], { ...DEFAULT_POSTER_OPTIONS, footer: '', showWatermark: false })
        expect(none.find((b) => b.kind === 'footer')).toBeUndefined()
    })
})

describe('词表与代价估算', () => {
    it('词表去掉单字昵称、去重、带上会话名', () => {
        const dictionary = collectRedactionDictionary(
            [item({ senderName: '张三丰' }), item({ senderName: '张三丰' }), item({ senderName: '李' })],
            ['家庭群']
        )
        expect(dictionary).toHaveLength(2)
        expect(dictionary).toContain('张三丰')
        expect(dictionary).toContain('家庭群')
        expect(dictionary).not.toContain('李')
    })

    it('200 条长图：页数与像素量在可解释范围，且能给出耗时量级', () => {
        const items = Array.from({ length: 200 }, (_, index) =>
            item({ key: `m${index}`, text: `第 ${index} 条：今天天气不错，我们下午三点在老地方见，记得带上那个东西。` })
        )
        const cost = estimateCaptureCost(items, { ...DEFAULT_POSTER_OPTIONS, pageMaxHeight: 12000 })
        expect(cost.pages).toBeGreaterThanOrEqual(2)
        expect(cost.blocks).toBeGreaterThanOrEqual(200)
        // 每页不超过上限 + 留白，总像素 = 页数 × 1080 宽 × 页高
        expect(cost.pixels).toBeGreaterThan(POSTER_WIDTH * 12000)
        expect(cost.estMs).toBeGreaterThan(0)
        expect(cost.over2s).toBe(cost.estMs > 2000)
    })

    it('同样的 200 条换成更小的分页上限会变多页（"避免 canvas 上限"是可控的）', () => {
        const items = Array.from({ length: 200 }, (_, index) => item({ key: `m${index}`, text: '内容'.repeat(40) }))
        const big = estimateCaptureCost(items, { ...DEFAULT_POSTER_OPTIONS, pageMaxHeight: 12000 })
        const small = estimateCaptureCost(items, { ...DEFAULT_POSTER_OPTIONS, pageMaxHeight: 6000 })
        expect(small.pages).toBeGreaterThanOrEqual(big.pages)
    })
})
