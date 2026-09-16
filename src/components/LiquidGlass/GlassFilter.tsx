import type { LensDisplacementMap } from './lensDisplacementMap'

/**
 * SVG 滤镜：透镜折射 + 边缘色散 + 镜面高光（v1.0.4 重写）
 *
 * 通道约定与 lensDisplacementMap 严格对应：R = X 位移、G = Y 位移、B = 镜面高光。
 * 旧版把 Y 同时写进 G 和 B、滤镜读 R/B；现在 B 是真正的高光通道，所以 Y 必须读
 * **G**（`yChannelSelector="G"`）—— 这一处如果漏改，折射会在垂直方向完全失效。
 *
 * 高光取代了旧版那两层写死的白色渐变边框（index.tsx 里的 borderGradient）：
 * 位移贴图的蓝通道已经是"朝向光源的那侧最亮、背光侧一道微弱回光"，这里把它当作
 * 白光（RGB=1，alpha=B）合成到内容之上。方向/锐度/强度因此由 optics 参数控制，
 * 而不是固定的一圈白边。
 *
 * 几何约定（Chromium 实测，保持不变）：feImage 的像素几何 (0,0,w,h) 与元素原点精确
 * 对齐，负坐标/百分比几何解析不可靠；滤镜区域收紧为元素本身，位移不会画出卡片之外。
 * `colorInterpolationFilters="sRGB"` 是**必须**的：SVG 滤镜默认走 linearRGB，
 * 那会把贴图的中性灰 128 重新映射、在整个元素上注入一层恒定位移。
 */
export default function GlassFilter({ id, map, displacementScale, aberrationIntensity, specular = true }: {
    id: string
    map: LensDisplacementMap
    displacementScale: number
    aberrationIntensity: number
    /** 是否把贴图蓝通道的镜面高光合成上来（关掉就只剩纯折射） */
    specular?: boolean
}) {
    const scale = 2 * map.maxScale * (displacementScale / 70)
    // 色散：三通道用略微不同的位移量 —— 对应 optics 里三通道折射率之差
    const stagger = Math.max(0, aberrationIntensity)
    return (
        <svg style={{ position: 'absolute', width: 0, height: 0, pointerEvents: 'none' }} aria-hidden="true">
            <defs>
                {/* 滤镜区域正好等于元素本身：范围越大，逐帧的滤镜代价越高 */}
                <filter id={id} x="0%" y="0%" width="100%" height="100%" colorInterpolationFilters="sRGB">
                    <feImage x="0" y="0" width={map.width} height={map.height} result="DISPLACEMENT_MAP" href={map.url} preserveAspectRatio="none" />

                    <feDisplacementMap in="SourceGraphic" in2="DISPLACEMENT_MAP" scale={scale} xChannelSelector="R" yChannelSelector="G" result="RED_DISPLACED" />
                    <feColorMatrix
                        in="RED_DISPLACED"
                        type="matrix"
                        values="1 0 0 0 0
                 0 0 0 0 0
                 0 0 0 0 0
                 0 0 0 1 0"
                        result="RED_CHANNEL"
                    />

                    <feDisplacementMap in="SourceGraphic" in2="DISPLACEMENT_MAP" scale={scale * (1 - stagger * 0.05)} xChannelSelector="R" yChannelSelector="G" result="GREEN_DISPLACED" />
                    <feColorMatrix
                        in="GREEN_DISPLACED"
                        type="matrix"
                        values="0 0 0 0 0
                 0 1 0 0 0
                 0 0 0 0 0
                 0 0 0 1 0"
                        result="GREEN_CHANNEL"
                    />

                    <feDisplacementMap in="SourceGraphic" in2="DISPLACEMENT_MAP" scale={scale * (1 - stagger * 0.1)} xChannelSelector="R" yChannelSelector="G" result="BLUE_DISPLACED" />
                    <feColorMatrix
                        in="BLUE_DISPLACED"
                        type="matrix"
                        values="0 0 0 0 0
                 0 0 0 0 0
                 0 0 1 0 0
                 0 0 0 1 0"
                        result="BLUE_CHANNEL"
                    />

                    {/* screen 混合合并三通道：位移一致的区域无损还原原色，
                        位移有差异的边缘渗出很淡的彩边（真实玻璃的色散） */}
                    <feBlend in="GREEN_CHANNEL" in2="BLUE_CHANNEL" mode="screen" result="GB_COMBINED" />
                    <feBlend in="RED_CHANNEL" in2="GB_COMBINED" mode="screen" result="REFRACTED" />

                    {specular ? (
                        <>
                            {/* 高光通道 → 白光（RGB=1），用贴图的 B 通道当 alpha：
                                只有"朝向光源的斜面"会亮，其余全透明 */}
                            <feColorMatrix
                                in="DISPLACEMENT_MAP"
                                type="matrix"
                                values="0 0 0 0 1
                         0 0 0 0 1
                         0 0 0 0 1
                         0 0 1 0 0"
                                result="SPECULAR"
                            />
                            {/* 镜面反射是"加光"，不是叠一层白纱：合成到折射结果之上 */}
                            <feComposite in="SPECULAR" in2="REFRACTED" operator="over" result="WITH_SPECULAR" />
                            <feGaussianBlur in="WITH_SPECULAR" stdDeviation={Math.max(0.1, 0.5 - stagger * 0.1)} />
                        </>
                    ) : (
                        <feGaussianBlur in="REFRACTED" stdDeviation={Math.max(0.1, 0.5 - stagger * 0.1)} />
                    )}
                </filter>
            </defs>
        </svg>
    )
}
