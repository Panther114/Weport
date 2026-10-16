/**
 * 海报抓取夹具（v1.2 §4 的验证入口，**不进产品包**）。
 *
 * 它做的事就是 `PosterPage` 导出时做的那一串：`buildPosterBlocks` →
 * `paginateBlocks` → `renderPosterPages`（真实 DOM）→ `html2canvas`（2× 设备像素比）
 * → `toDataURL('image/png')`。跑在真实浏览器里，所以量出来的是**真尺寸、真字节**。
 *
 * 三份产物交给 `scripts/poster-capture-fixture.mjs`：
 *  - `fixture`：含手机号 / wxid / 昵称 / 图片遮挡块的 12 条长图，抓一张（PNG data URL）
 *  - `budget`：同样的渲染管线跑 200 条，只报页数/耗时（不保留 data URL，省内存）
 *  - 页面上的可见 DOM 本身（脚本会截图，用来看打码在**画面上**是什么样）
 */
import '../../src/components/poster/poster.css'
import { buildPosterBlocks, paginateBlocks } from '../../src/components/poster/posterLayout.ts'
import { renderPosterPages, type PosterRenderContext } from '../../src/components/poster/posterDom.ts'
import { capturePoster, detectQrBoxes } from '../../src/components/poster/posterCapture.ts'
import { effectiveRedactionOptions } from '../../src/components/poster/posterRedaction.ts'
import { applyTemplate } from '../../src/components/poster/posterTemplates.ts'
import { DEFAULT_POSTER_OPTIONS, type PosterItem, type PosterOptions } from '../../src/components/poster/posterTypes.ts'

declare global {
    interface Window {
        __posterFixture?: Record<string, unknown>
    }
}

/** 一张真的图片（渐变 + 二维码样式的方格），用 canvas 生成 data URL —— 不依赖外部资源。 */
function makeImageDataUrl(size = 420): string {
    const canvas = document.createElement('canvas')
    canvas.width = size
    canvas.height = size
    const ctx = canvas.getContext('2d')
    if (ctx) {
        const gradient = ctx.createLinearGradient(0, 0, size, size)
        gradient.addColorStop(0, '#5b8eff')
        gradient.addColorStop(1, '#1c2029')
        ctx.fillStyle = gradient
        ctx.fillRect(0, 0, size, size)
        // 右下角画一块"二维码"：验证遮挡块能不能盖住它
        ctx.fillStyle = '#ffffff'
        ctx.fillRect(size * 0.55, size * 0.55, size * 0.4, size * 0.4)
        ctx.fillStyle = '#000000'
        for (let y = 0; y < 6; y++) {
            for (let x = 0; x < 6; x++) {
                if ((x + y) % 2 === 0) ctx.fillRect(size * 0.57 + x * size * 0.062, size * 0.57 + y * size * 0.062, size * 0.06, size * 0.06)
            }
        }
        ctx.fillStyle = '#ffffff'
        ctx.font = `${Math.round(size * 0.09)}px "Microsoft YaHei", sans-serif`
        ctx.fillText('图片标题', size * 0.06, size * 0.18)
    }
    return canvas.toDataURL('image/png')
}

const TS = 1_790_390_545_000

function fixtureItems(imageUrl: string): PosterItem[] {
    const base = (index: number, overrides: Partial<PosterItem>): PosterItem => ({
        key: `f${index}`,
        sessionId: 'family@chatroom',
        senderName: '张三丰',
        isSend: index % 3 === 0,
        ts: TS + index * 60_000,
        kind: 'text',
        text: '',
        visible: true,
        ...overrides,
    })
    return [
        base(1, { text: '明天下午三点在老地方见，我的手机号 13812345678，到了打我电话。' }),
        base(2, { senderName: '李四', text: '我的 wxid_abc1234xyz，你加一下我，验证码 867530 别告诉别人。', isSend: false }),
        base(3, { text: '收到，我后天回国，寄到北京市海淀区中关村大街1号就行。', isSend: true }),
        base(4, { kind: 'image', text: '图片 1', imageSrc: imageUrl, imageUnavailable: false, imageAlt: '图片 1', maskBox: { x: 0.52, y: 0.52, w: 0.44, h: 0.44 } }),
        base(5, { senderName: '张三丰', text: '这是上周拍的那张照片，你看二维码还在不在。', isSend: false }),
        base(6, { kind: 'voice', text: '语音 12″', imageAlt: '语音 12″' }),
        base(7, { text: '银行卡号 4242 4242 4242 4242 是测试卡号，别当真的用。', isSend: false }),
        base(8, { text: '邮箱 zhangsan+weport@example.com 也能找到我。', isSend: true }),
        base(9, { senderName: '王五', text: '春节回家吃饭，妈说给你留了饺子。', isSend: false }),
        base(10, { text: '好，我买晚上的高铁票。', isSend: true }),
        base(11, { text: '身份证 11010519491231002X 我拍给你（这句话故意写一个真格式的号）。', isSend: false }),
        base(12, { text: '最后一条：群里那段话就别往外发了。', isSend: false }),
    ]
}

/** 200 条：长图分页与抓取代价的实测数据。 */
function budgetItems(): PosterItem[] {
    return Array.from({ length: 200 }, (_, index) => ({
        key: `b${index}`,
        sessionId: 'family@chatroom',
        senderName: index % 2 === 0 ? '张三丰' : '李四',
        isSend: index % 3 === 0,
        ts: TS + index * 30_000,
        kind: 'text' as const,
        text: `第 ${index + 1} 条：今天天气不错，我们下午三点在老地方见，记得带上相机和那本画册。`,
        visible: true,
    }))
}

async function main() {
    const stage = document.getElementById('stage')
    if (!stage) throw new Error('缺少 #stage')

    const report: Record<string, unknown> = { startedAt: new Date().toISOString() }
    const imageUrl = makeImageDataUrl()

    // ---- 1) 夹具长图：一份真的 PNG -----------------------------------------
    const items = fixtureItems(imageUrl)
    const options: PosterOptions = {
        ...applyTemplate(DEFAULT_POSTER_OPTIONS, 'long'),
        title: '家庭群',
        footer: '2026 春节 · 家庭群',
        pageMaxHeight: 12000,
    }
    const dictionary = ['家庭群', '张三丰', '李四', '王五']
    const ctx: PosterRenderContext = { options, redaction: effectiveRedactionOptions(options.redaction, dictionary), dictionary }

    // 预览用的可见容器：截图就是看它（打码在画面上长什么样）
    const previewHost = document.createElement('div')
    previewHost.dataset.role = 'preview'
    stage.appendChild(previewHost)
    const blocks = buildPosterBlocks(items, options, { sessionName: '家庭群' })
    const pages = paginateBlocks(blocks, options, { repeatHeader: true })
    const rendered = renderPosterPages(previewHost, pages, ctx)
    report.previewPages = pages.length
    report.previewMaskedSpans = rendered.masked
    report.previewPageHeights = pages.map((page) => page.height)

    // 抓取用的离屏容器：与预览同源（同一个 renderPosterPages），未缩放
    const exportHost = document.createElement('div')
    exportHost.style.cssText = 'position:fixed;top:0;left:-20000px;width:1080px;pointer-events:none;'
    document.body.appendChild(exportHost)

    const shot = await capturePoster({
        host: exportHost,
        items,
        options,
        extras: { sessionName: '家庭群' },
        ctx,
        scale: 2,
    })
    const first = shot.pages[0]
    report.fixture = {
        pages: shot.pageCount,
        masked: shot.masked,
        repaginated: shot.repaginated,
        elapsedMs: shot.elapsedMs,
        width: first?.width ?? 0,
        height: first?.height ?? 0,
        bytes: first?.bytes ?? 0,
        failures: shot.failures,
        dataUrl: first?.dataUrl ?? '',
    }

    // ---- 2) 二维码识别能力（如实报告：没有就说没有） -----------------------
    const qr = await detectQrBoxes(imageUrl)
    report.qrDetection = { supported: qr.supported, boxes: qr.boxes.length, error: qr.error ?? null }

    // ---- 3) 200 条长图的抓取代价（只留数字，不留 data URL） ----------------
    const heavy = budgetItems()
    const heavyOptions: PosterOptions = { ...options, title: '家庭群（200 条压测）', footer: '' }
    const heavyBlocks = buildPosterBlocks(heavy, heavyOptions, { sessionName: '家庭群' })
    const heavyPages = paginateBlocks(heavyBlocks, heavyOptions, { repeatHeader: true })
    const heavyShot = await capturePoster({
        host: exportHost,
        items: heavy,
        options: heavyOptions,
        extras: { sessionName: '家庭群' },
        ctx: { options: heavyOptions, redaction: ctx.redaction, dictionary },
        scale: 2,
    })
    report.budget = {
        items: heavy.length,
        blockCount: heavyBlocks.length,
        estimatedPages: heavyPages.length,
        pages: heavyShot.pageCount,
        repaginated: heavyShot.repaginated,
        totalMs: heavyShot.elapsedMs,
        perPageMs: heavyShot.pages.map((page) => ({ width: page.width, height: page.height, bytes: page.bytes, ms: page.elapsedMs })),
        failures: heavyShot.failures,
        warnings: heavyShot.warnings,
    }

    // ---- 4) 同样的 200 条用 1× 再抓一次：证明"倍率"才是主要杠杆 --------------
    const cheapShot = await capturePoster({
        host: exportHost,
        items: heavy,
        options: heavyOptions,
        extras: { sessionName: '家庭群' },
        ctx: { options: heavyOptions, redaction: ctx.redaction, dictionary },
        scale: 1,
    })
    report.budgetScale1 = {
        pages: cheapShot.pageCount,
        totalMs: cheapShot.elapsedMs,
        perPageMs: cheapShot.pages.map((page) => ({ width: page.width, height: page.height, bytes: page.bytes, ms: page.elapsedMs })),
    }

    stage.removeChild(previewHost)
    stage.appendChild(previewHost)

    report.done = true
    window.__posterFixture = report
}

void main().catch((error) => {
    window.__posterFixture = { done: true, fatal: String(error), stack: (error as Error)?.stack }
})
