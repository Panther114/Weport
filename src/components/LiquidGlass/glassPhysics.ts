/**
 * 玻璃光学模型 —— 纯数学，无 DOM 依赖。
 *
 * 重写自 Aave《Building Glass for the Web》所描述的做法
 * (https://aave.com/design/building-glass-for-the-web)：把镜片当成一个真实的
 * 凸面圆角穹顶 —— 中心平坦、只在一圈边缘带（bevel）里向外倾泻而下；对每个像素取
 * 穹顶的**斜率**，用**斯涅尔定律**在 IOR=1.5（真实玻璃）下折射一条垂直入射的视线，
 * 得到位移量。位移是那个高度场的梯度，所以弯曲全部集中在边缘、中心保持清晰 ——
 * 这正是一块厚玻璃的真实行为。
 *
 * 旧实现是一条凭观感调出来的 smoothstep "meniscus" 曲线：没有折射率、没有斜率封顶；
 * 边缘高光则是 index.tsx 里两层写死的白色渐变（用户报的"外面那圈白边"就是它）。
 *
 * 三条硬约束（都来自那篇文章）：
 *  1. **斜率必须封顶**：封顶后位移场才是单射 —— 边缘压缩画面但永不折叠翻面
 *     （不封顶时 (1-t)/√(1-(1-t)²) 在边缘发散，会撕裂）。
 *  2. **带内缘归零**：位移在斜面内缘归零，才能无缝并入清晰中心。
 *  3. **镜片外是中性值**：feDisplacementMap 把 128 当作"不位移"，镜片外的像素
 *     必须原样通过。
 */

/** 系统是否要求减少动态效果 —— 运动响应（跟随指针的柔光）据此整体关闭。 */
export function prefersReducedMotion(): boolean {
    if (typeof window === 'undefined') return false
    return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
}

export interface GlassOpticsModel {
    /** 折射率。真实玻璃 1.5；越大越"鱼缸"，1.0 等于不存在。 */
    ior: number
    /** 斜面宽度占短边一半的比例上限 */
    bevelRatio: number
    /** 斜面宽度绝对上限（px） */
    bevelMaxPx: number
    /** 穹顶陡峭度倍率 */
    curvature: number
    /** 整体位移强度倍率 */
    strength: number
    /** 斜率封顶（数学必需，见文件头 1） */
    slopeCap: number
    /** 色散：三通道 IOR 之差造成的边缘彩边 */
    dispersion: number
    /** 高光方向（弧度） */
    lightAngle: number
    /** 高光锐度（dot 的幂次） */
    specularPower: number
    /** 高光强度 0-1 */
    specularStrength: number
    /** 背光侧回光强度 0-1 */
    rimStrength: number
    /**
     * 表面霜化（backdrop 模糊半径 px）。**刻意很轻**：重模糊会把折射洗掉 ——
     * 玻璃的观感来自背景基本不被压暗、边缘明显弯曲，而不是糊成毛玻璃。
     */
    frost: number
}

export const GLASS_OPTICS_MODEL_DEFAULT: GlassOpticsModel = {
    ior: 1.5,
    bevelRatio: 0.75,
    bevelMaxPx: 34,
    curvature: 1,
    strength: 1,
    slopeCap: 1.6,
    dispersion: 0.2,
    // 左上打光，与旧版两层白色渐变的 135deg 同一盏灯
    lightAngle: (-135 * Math.PI) / 180,
    specularPower: 3,
    /**
     * 高光**刻意压得很轻**。第一版按"物理强度"给到 0.55/0.35，结果贴图蓝通道在
     * 迎光侧直接到 ~0.9 → 合成出来是一道近乎不透明的白弧 —— 那正是用户要求去掉的
     * "外面那圈白边"，只是这次是算出来的而不是写死的（实测卡片平均 alpha
     * 57 → 102、不透明像素 6.5% → 14.1%）。
     * 真实玻璃的边缘只是"亮一点"，不是白漆：0.18/0.10 的峰值约 0.28。
     */
    specularStrength: 0.18,
    rimStrength: 0.1,
    frost: 3,
}

/** 边缘斜面宽度：小药丸几乎整个都是透镜，大面板只留一圈。 */
export function resolveBevel(halfW: number, halfH: number, optics: GlassOpticsModel): number {
    const half = Math.min(halfW, halfH)
    return Math.max(1, Math.min(optics.bevelMaxPx, half * optics.bevelRatio, half * 0.98))
}

/**
 * 球冠剖面斜率。t = 0 在**边缘**，t = 1 在斜面内缘（平坦中心边界）。
 * 单位球冠 h(u)=√(1-(1-u)²) ⇒ dh/dt = (1-t)/√(1-(1-t)²)：边缘最陡、中心为 0。
 * 再用 slopeCap 截断 —— 这一步是数学必需，不是审美。
 */
export function surfaceSlope(t: number, optics: GlassOpticsModel): number {
    const cl = Math.min(0.999, Math.max(0.001, t))
    const s = 1 - cl
    const raw = s / Math.max(Math.sqrt(Math.max(1 - s * s, 0)), 0.001)
    return Math.min(raw * optics.curvature, optics.slopeCap)
}

/** 斯涅尔小角度近似：垂直入射的视线被弯折的比例 = 1 - 1/n。 */
export function snellBendFactor(ior: number): number {
    return 1 - 1 / Math.max(1.0001, ior)
}

/** 圆角矩形 SDF（像素坐标，原点在中心；内部为负）。 */
export function roundedRectSDF(x: number, y: number, halfW: number, halfH: number, radius: number): number {
    const qx = Math.abs(x) - halfW + radius
    const qy = Math.abs(y) - halfH + radius
    return Math.min(Math.max(qx, qy), 0) + Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) - radius
}

/** 外法线（平滑化的 max(q,0)，圆角处连续旋转、不留对角线折痕）。 */
export function surfaceNormal(px: number, py: number, halfW: number, halfH: number, radius: number): { nx: number; ny: number } {
    const qx = Math.abs(px) - halfW + radius
    const qy = Math.abs(py) - halfH + radius
    const soft = Math.max(radius * 0.8, 1)
    const sx = 0.5 * (qx + Math.hypot(qx, soft))
    const sy = 0.5 * (qy + Math.hypot(qy, soft))
    const len = Math.hypot(sx, sy)
    if (len < 1e-4) return { nx: 0, ny: 0 }
    return { nx: (sx / len) * Math.sign(px || 1), ny: (sy / len) * Math.sign(py || 1) }
}

/**
 * 镜面高光 = 菲涅尔反射的近似：掠射角反射率升高 ⇒ 边缘比中心亮，朝向光源那侧最亮，
 * 背光侧留一道微弱回光。这两项一起进贴图的**蓝通道**，由 SVG 滤镜合成到内容上，
 * 取代旧版那两层写死的白色渐变边框。
 * @param edge 0 = 斜面内缘，1 = 玻璃边缘
 */
export function specularAt(nx: number, ny: number, edge: number, optics: GlassOpticsModel): number {
    if (edge <= 0) return 0
    const lx = Math.cos(optics.lightAngle)
    const ly = Math.sin(optics.lightAngle)
    const facing = Math.max(0, nx * lx + ny * ly)
    const spec = Math.pow(facing, optics.specularPower) * edge * optics.specularStrength
    const rim = Math.pow(edge, 2.5) * optics.rimStrength
    return Math.min(1, spec + rim)
}
