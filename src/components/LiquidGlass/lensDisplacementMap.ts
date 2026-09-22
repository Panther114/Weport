/**
 * 透镜位移贴图生成器（v1.0.4 重写，物理化）
 *
 * 这是 Aave《Building Glass for the Web》里"可移植的那一半"：一张按玻璃形状现算出来的
 * 小图 —— 红通道编码 X 位移、绿通道编码 Y 位移、**蓝通道编码镜面高光** —— 交给一个
 * `feDisplacementMap` 去弯折真实内容。镜片之外全部是中性值（128 = 不位移）。
 *
 * 相对旧实现的三处重写：
 *  1. **剖面对了**：位移来自 glassPhysics 的球冠斜率 + 斯涅尔定律，而不是凭观感调的
 *     smoothstep 曲线（旧版那条 "meniscus"）。斜率有封顶，位移场因此是单射的 ——
 *     边缘压缩、但永不折叠翻面。
 *  2. **多了高光通道**：蓝通道不再重复 Y 位移（那是浪费），改为输出镜面高光；
 *     旧版高光是 index.tsx 里两层写死的白色渐变（用户报的"那圈白边"）。
 *  3. **只算四分之一**：圆角矩形四重对称，只算左上象限再按 X/Y 取负镜像 ——
 *     逐像素最贵的一步（SDF、斜率、法线）直接降到 1/4，这是文章里
 *     "让贴图生成留在帧预算内"的那一招。
 *
 * 贴图尺寸 = 元素尺寸、放在滤镜坐标 (0,0)：Chromium 实测 feImage 像素几何
 * (0,0,w,h) 与元素原点精确对齐，负坐标/百分比几何解析不可靠。
 */

import {
    GLASS_OPTICS_MODEL_DEFAULT,
    resolveBevel,
    roundedRectSDF,
    snellBendFactor,
    specularAt,
    surfaceNormal,
    surfaceSlope,
    type GlassOpticsModel,
} from './glassPhysics'

export interface LensDisplacementMap {
    /** 贴图 dataURL，生成失败时为空串（此时滤镜退化为无位移） */
    url: string
    /**
     * **只含镜面高光**的贴图（白色 + alpha = 高光强度），生成失败时为空串。
     *
     * 为什么要单独一张：位移贴图把高光编码在蓝通道里，直接当背景图画出来会是
     * 一片灰蓝（R/G 通道的 128 中性值），只有 `feDisplacementMap` 能挑出蓝通道。
     * 而"镜面高光"恰恰是玻璃在**没有折射**时最需要的一层（Aave 文章里的
     * "edge highlight / specular angle"）：它沿着圆角走，一眼就能读出曲面。
     */
    specularUrl: string
    /** 贴图编码的最大位移像素数；SVG 滤镜 scale 取 2×maxScale 时还原几何精确的折射 */
    maxScale: number
    /** 贴图（=元素）尺寸，feImage 的像素几何 */
    width: number
    height: number
    /** 实际计算了多少像素（象限优化后应约为 w×h/4，供性能断言） */
    computedPixels: number
    totalPixels: number
    /** 生成耗时 ms（诊断用） */
    generateMs: number
}

/**
 * 通道约定（与 GlassFilter 严格对应）：
 *   R = X 位移，G = Y 位移，B = 镜面高光，A = 255
 *   128 = 中性（不位移）；高光通道 0 = 无高光。
 */
export function generateLensDisplacementMap(
    width: number,
    height: number,
    cornerRadius: number,
    optics: GlassOpticsModel = GLASS_OPTICS_MODEL_DEFAULT
): LensDisplacementMap {
    const started = performance.now()
    const w = Math.max(1, Math.round(width))
    const h = Math.max(1, Math.round(height))
    const empty: LensDisplacementMap = { url: '', specularUrl: '', maxScale: 0, width: w, height: h, computedPixels: 0, totalPixels: w * h, generateMs: 0 }
    const canvas = document.createElement('canvas')
    canvas.width = w
    canvas.height = h
    const context = canvas.getContext('2d')
    if (!context) return empty
    // 高光单独一张：白 + alpha
    const specCanvas = document.createElement('canvas')
    specCanvas.width = w
    specCanvas.height = h
    const specContext = specCanvas.getContext('2d')
    if (!specContext) return empty

    const halfW = w / 2
    const halfH = h / 2
    const radius = Math.max(0, Math.min(cornerRadius, halfW, halfH))
    const bevel = resolveBevel(halfW, halfH, optics)
    const bend = snellBendFactor(optics.ior) * optics.strength

    const imageData = context.createImageData(w, h)
    const data = imageData.data
    const specData = specContext.createImageData(w, h).data
    // 全图先填中性：位移 128、高光 0。镜片外的像素因此原样通过。
    for (let i = 0; i < data.length; i += 4) {
        data[i] = 128
        data[i + 1] = 128
        data[i + 2] = 0
        data[i + 3] = 255
        specData[i] = 255
        specData[i + 1] = 255
        specData[i + 2] = 255
        specData[i + 3] = 0
    }

    // ---- 第一步：只算左上象限的几何量（最贵的一步） ----
    interface Sample { x: number; y: number; dx: number; dy: number; nx: number; ny: number; edge: number }
    const samples: Sample[] = []
    let maxScale = 0
    const qw = Math.ceil(w / 2)
    const qh = Math.ceil(h / 2)
    for (let y = 0; y < qh; y++) {
        for (let x = 0; x < qw; x++) {
            const px = x + 0.5 - halfW
            const py = y + 0.5 - halfH
            const depth = -roundedRectSDF(px, py, halfW, halfH, radius)
            if (depth <= 0 || depth >= bevel) continue // 玻璃外 / 平坦中心：保持中性
            const t = depth / bevel // 0 在边缘，1 在斜面内缘
            const amount = surfaceSlope(t, optics) * bend * bevel * 0.5
            const { nx, ny } = surfaceNormal(px, py, halfW, halfH, radius)
            if (nx === 0 && ny === 0) continue
            const dx = nx * amount
            const dy = ny * amount
            if (Math.abs(dx) > maxScale) maxScale = Math.abs(dx)
            if (Math.abs(dy) > maxScale) maxScale = Math.abs(dy)
            samples.push({ x, y, dx, dy, nx, ny, edge: 1 - t })
        }
    }
    maxScale = Math.max(maxScale, 1)
    const normalize = 2 * maxScale // [-max,max] → [0,1]，不裁剪、无平顶色带

    // ---- 第二步：按四重对称写出（X 取负镜像到右、Y 取负镜像到下） ----
    const write = (x: number, y: number, s: Sample, sx: number, sy: number) => {
        const p = (x + y * w) * 4
        data[p] = Math.max(0, Math.min(255, Math.round(((s.dx * sx) / normalize + 0.5) * 255)))
        data[p + 1] = Math.max(0, Math.min(255, Math.round(((s.dy * sy) / normalize + 0.5) * 255)))
        // 高光由**镜像后的法线**重算：光有方向，镜像会改变它朝向光源的那一侧
        const spec = specularAt(s.nx * sx, s.ny * sy, s.edge, optics)
        data[p + 2] = Math.round(spec * 255)
        // 单独那张：白色 + alpha = 高光强度（屏幕混合层直接用）
        specData[p + 3] = Math.round(Math.max(0, Math.min(1, spec)) * 255)
    }
    for (const s of samples) {
        const xr = w - 1 - s.x
        const yb = h - 1 - s.y
        write(s.x, s.y, s, 1, 1)
        if (xr !== s.x) write(xr, s.y, s, -1, 1)
        if (yb !== s.y) write(s.x, yb, s, 1, -1)
        if (xr !== s.x && yb !== s.y) write(xr, yb, s, -1, -1)
    }

    context.putImageData(imageData, 0, 0)
    specContext.putImageData(new ImageData(specData, w, h), 0, 0)
    return {
        url: canvas.toDataURL(),
        specularUrl: specCanvas.toDataURL(),
        maxScale,
        width: w,
        height: h,
        computedPixels: samples.length,
        totalPixels: w * h,
        generateMs: Math.round((performance.now() - started) * 100) / 100,
    }
}
