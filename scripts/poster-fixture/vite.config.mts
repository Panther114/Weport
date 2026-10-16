import { defineConfig } from 'vite'

/**
 * 海报抓取夹具的构建配置（**只用于验证**，不进产品包）。
 *
 * 目的：在真实浏览器里跑一遍 `posterLayout` + `posterDom` + `posterCapture`，
 * 产出一张真的 PNG 并读回它的像素尺寸与字节数 —— vitest 的 environment 是 node，
 * 没有 DOM，`html2canvas` 在那里根本跑不起来。
 *
 * 构建产物写进仓库根的 `.poster-fixture/`（临时目录），由
 * `scripts/poster-capture-fixture.mjs` 用 playwright-core 打开。
 */
export default defineConfig({
    root: 'scripts/poster-fixture',
    base: './',
    build: {
        outDir: '../../.poster-fixture',
        emptyOutDir: true,
        // 两个夹具页：海报 DOM 抓图（main）与整页挂载（page）
        rollupOptions: { input: { index: 'scripts/poster-fixture/index.html', page: 'scripts/poster-fixture/page.html' } },
        // 夹具要能在无 GPU 的 headless 里跑完，别做无谓的压缩优化
        minify: false,
        sourcemap: false,
        target: 'chrome120',
    },
})
