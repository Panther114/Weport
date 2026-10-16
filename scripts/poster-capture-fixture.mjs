/**
 * 海报夹具的驱动器（v1.2 §4 的验证步骤，**不进产品包**）。
 *
 * 用途：把 `scripts/poster-fixture` 构建出来的页面在真实 Chromium 里跑一遍，
 * 读回 `html2canvas` 抓出来的 PNG 的真实尺寸与字节数，并截一张预览图供肉眼核对
 * 打码效果（"预览里看得见"这件事只能看，不能只断言）。
 *
 * 为什么自带一个静态服务器：Vite 的产物是 ES module，`file://` 下会被 CORS 拦掉
 * （`<script type="module">` 在 file 协议里不执行）。起一个只读、只对本机端口生效的
 * 静态服务器是最省事也最诚实的办法 —— 顺便让 html2canvas 的 canvas 不被 file 协议
 * 的跨源规则搅局。
 *
 * 用法（先构建，再跑）：
 *   npx vite build --config scripts/poster-fixture/vite.config.mts
 *   node scripts/poster-capture-fixture.mjs
 */
import { createServer } from 'node:http'
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { extname, join, normalize, resolve } from 'node:path'
import { chromium } from 'playwright-core'

const ROOT = resolve(process.cwd(), '.poster-fixture')
const OUT = join(ROOT, 'out')
const CHROME_CANDIDATES = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
]

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.svg': 'image/svg+xml',
    '.woff2': 'font/woff2',
}

function findBrowser() {
    for (const candidate of CHROME_CANDIDATES) if (existsSync(candidate)) return candidate
    return null
}

function serve(root) {
    const server = createServer((request, response) => {
        try {
            const url = new URL(request.url ?? '/', 'http://127.0.0.1')
            const relative = normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, '')
            const target = join(root, relative === '' ? 'index.html' : relative)
            if (!target.startsWith(root)) {
                response.writeHead(403).end('forbidden')
                return
            }
            const body = readFileSync(target)
            response.writeHead(200, { 'content-type': MIME[extname(target).toLowerCase()] ?? 'application/octet-stream' })
            response.end(body)
        } catch (error) {
            response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end(String(error))
        }
    })
    return new Promise((resolvePromise) => {
        server.listen(0, '127.0.0.1', () => resolvePromise({ server, port: server.address().port }))
    })
}

function dataUrlToBuffer(dataUrl) {
    const comma = dataUrl.indexOf(',')
    if (comma < 0) return Buffer.alloc(0)
    return Buffer.from(dataUrl.slice(comma + 1), 'base64')
}

async function main() {
    if (!existsSync(join(ROOT, 'index.html'))) {
        console.error(`没有找到构建产物：${join(ROOT, 'index.html')}\n先跑：npx vite build --config scripts/poster-fixture/vite.config.mts`)
        process.exitCode = 1
        return
    }
    const executablePath = findBrowser()
    if (!executablePath) {
        console.error('没有找到 Chrome/Edge 可执行文件，无法抓图。')
        process.exitCode = 1
        return
    }

    mkdirSync(OUT, { recursive: true })
    const { server, port } = await serve(ROOT)
    const browser = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox', '--disable-gpu'] })
    const page = await browser.newPage({ viewport: { width: 1200, height: 900 }, deviceScaleFactor: 1 })

    const consoleLines = []
    page.on('console', (message) => consoleLines.push(`${message.type()}: ${message.text()}`))
    page.on('pageerror', (error) => consoleLines.push(`pageerror: ${String(error)}`))

    try {
        await page.goto(`http://127.0.0.1:${port}/index.html`, { waitUntil: 'load', timeout: 60_000 })
        await page.waitForFunction(() => Boolean(window.__posterFixture?.done), null, { timeout: 300_000 })
        const report = await page.evaluate(() => window.__posterFixture)

        if (report?.fatal) {
            console.error('夹具内部报错：', report.fatal)
            console.error(report.stack)
            process.exitCode = 1
            return
        }

        const fixture = report.fixture ?? {}
        if (fixture.dataUrl) {
            const buffer = dataUrlToBuffer(fixture.dataUrl)
            const file = join(OUT, 'poster-long.png')
            writeFileSync(file, buffer)
            console.log(`[capture] ${file}  ${fixture.width}×${fixture.height}px  ${buffer.length} bytes`)
        }

        const previewFile = join(OUT, 'poster-preview.png')
        await page.locator('[data-role="preview"]').screenshot({ path: previewFile })
        console.log(`[preview] ${previewFile}`)

        console.log('[report] ' + JSON.stringify({ ...report, fixture: { ...fixture, dataUrl: undefined } }, null, 2))
        if (consoleLines.length > 0) console.log('[console]\n' + consoleLines.join('\n'))

        // ---- 整页夹具：挂真正的 <PosterPage/> 并走一遍"选会话 → 载入 → 导出" --------
        const pageErrors = []
        const pageConsole = []
        page.on('pageerror', (error) => pageErrors.push(String(error)))
        page.on('console', (message) => {
            if (message.type() === 'error') pageConsole.push(message.text())
        })
        await page.goto(`http://127.0.0.1:${port}/page.html`, { waitUntil: 'load', timeout: 60_000 })
        await page.waitForFunction(() => Boolean(window.__posterPageReady), null, { timeout: 60_000 })

        const sessionsLoaded = await page.locator('.poster-session-row').count()
        await page.locator('.poster-session-row').first().click()
        await page.getByRole('button', { name: /载入「/ }).click()
        await page.waitForFunction(() => document.querySelectorAll('.pp-bubble').length > 0, null, { timeout: 60_000 })
        const bubbles = await page.locator('.pp-bubble').count()
        const maskCount = await page.locator('.pp-mask').count()
        const redactionStrip = (await page.locator('.poster-mask-strip').first().innerText()).replace(/\s+/g, ' ').trim()

        // 导出：poster.saveImage 故意缺失 → 必须走回退并**如实说明**
        const downloads = []
        const notFound = []
        page.on('download', (download) => downloads.push(download.suggestedFilename()))
        page.on('response', (response) => {
            if (response.status() === 404) notFound.push(response.url())
        })
        await page.getByRole('button', { name: /导出 PNG/ }).click()
        // 等**导出结果**这条状态（只看"有没有状态条"会被左边面板的"引擎未接入"提前满足 ——
        // 这是本 harness 自己踩过的坑：第一次读到的就是那条横幅）
        await page.waitForFunction(
            () =>
                Array.from(document.querySelectorAll('.poster-ok, .poster-warn, .poster-error')).some((node) =>
                    /已保存|保存失败|导出异常|poster:saveImage|引擎保存通道/.test(node.textContent || '')
                ),
            null,
            { timeout: 120_000 }
        )
        const statusText = (
            await page
                .locator('.poster-ok, .poster-warn, .poster-error')
                .filter({ hasText: /已保存|保存失败|导出异常|poster:saveImage|引擎保存通道/ })
                .first()
                .innerText()
        )
            .replace(/\s+/g, ' ')
            .trim()
        await page.waitForTimeout(1500)
        const pageShot = join(OUT, 'page.png')
        await page.screenshot({ path: pageShot, fullPage: false })

        console.log(
            '[page] ' +
                JSON.stringify(
                    { sessionsLoaded, bubbles, maskCount, redactionStrip, statusText, downloads, notFound, pageErrors, pageConsole, screenshot: pageShot },
                    null,
                    2
                )
        )
    } finally {
        await browser.close()
        server.close()
    }
}

void main()
