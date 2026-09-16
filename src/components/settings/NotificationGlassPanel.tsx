import { useEffect, useState } from 'react'
import { NotificationToast } from '../NotificationToast'
import '../../styles/notificationGlass.scss'
import {
    GRADIENT_PRESETS,
    NOTIFICATION_GLASS_DEFAULT,
    NOTIFICATION_GLASS_KEYS,
    glassTextPolarity,
    normalizeNotificationGlass,
    notificationGlassTextVars,
    type FillMode,
    type NotificationGlass
} from '../../utils/notificationGlass'

/**
 * 通知玻璃的设置面板（设置 → 消息通知）。
 *
 * 设计要点：预览用的是**真组件**（NotificationToast 本身），不是另画一个近似图。
 * 玻璃的观感全部由 --glass-* 变量驱动，而变量就挂在卡片容器上，所以预览与真实
 * 弹窗走的是同一条渲染路径 —— 不存在"预览好看、实际不一样"的漂移。
 *
 * 默认值刻意与用户的要求一致：浅白填充（不全透）+ 发丝描边（不是原来那圈 1.5px
 * 白边）。每一项都能单独调，也都能关掉。
 */

const SAMPLE = {
    id: 'glass-preview',
    sessionId: 'preview',
    title: '张同学',
    content: '预览：这条通知只有卡片填充，文字背后没有任何单独的底色。',
    timestamp: Math.floor(Date.now() / 1000),
    persistent: true,
}

interface RowProps {
    label: string
    hint?: string
    children: React.ReactNode
}

function Row({ label, hint, children }: RowProps) {
    return (
        <div className="setting-row">
            <div className="setting-label">
                <div>
                    <strong>{label}</strong>
                    {hint ? <span className="hint">{hint}</span> : null}
                </div>
            </div>
            <div className="appearance-actions">{children}</div>
        </div>
    )
}

export function NotificationGlassPanel() {
    const [glass, setGlass] = useState<NotificationGlass>(NOTIFICATION_GLASS_DEFAULT)

    useEffect(() => {
        let cancelled = false
        const load = async () => {
            const api = window.electronAPI
            if (!api?.config?.get) return
            const fields = Object.keys(NOTIFICATION_GLASS_KEYS) as Array<keyof NotificationGlass>
            const values = await Promise.all(
                fields.map(async (field) => {
                    try {
                        return await api.config.get(NOTIFICATION_GLASS_KEYS[field])
                    } catch {
                        return undefined
                    }
                })
            )
            if (cancelled) return
            const raw: Partial<Record<keyof NotificationGlass, unknown>> = {}
            fields.forEach((field, index) => {
                raw[field] = values[index]
            })
            setGlass(normalizeNotificationGlass(raw))
        }
        void load()
        return () => {
            cancelled = true
        }
    }, [])

    /** 改一项就落盘一项：玻璃是"边拖边看"的东西，攒着一起存反而容易丢改动。 */
    const update = (patch: Partial<NotificationGlass>) => {
        const next = normalizeNotificationGlass({ ...glass, ...patch })
        setGlass(next)
        const fields = Object.keys(patch) as Array<keyof NotificationGlass>
        for (const field of fields) {
            void window.electronAPI?.config?.set(NOTIFICATION_GLASS_KEYS[field], next[field])
        }
    }

    const reset = () => {
        setGlass(NOTIFICATION_GLASS_DEFAULT)
        for (const field of Object.keys(NOTIFICATION_GLASS_KEYS) as Array<keyof NotificationGlass>) {
            void window.electronAPI?.config?.set(NOTIFICATION_GLASS_KEYS[field], NOTIFICATION_GLASS_DEFAULT[field])
        }
    }

    return (
        <div className="glass-settings">
            {/* 预览放在最上面：所有控件都是"改一下、上面那张卡片就变"，不用滚动找结果 */}
            {/*
              * 必须自己写文字变量。`--noti-title-color`/`--noti-body-color`/`--noti-title-tertiary`
              * 只由弹窗里的 applyNotificationTheme() 写进**那个**文档的 <html>；主窗口文档里
              * 它们从未被定义过，于是 NotificationToast.scss 的兜底 `#ffffff` 生效 ——
              * 预览会永远显示白字，哪怕填充是 16% 白（正好是本轮要修掉的"浅色卡片 + 白字"），
              * 而下面那行提示却写着"深色字"。整套 --glass-* 变量本来就是为"预览与真实弹窗
              * 同一条路径"设计的，这一项之前漏了。
              */}
            <div className="glass-preview" aria-hidden="true" style={notificationGlassTextVars(glass)}>
                <NotificationToast
                    data={{ ...SAMPLE }}
                    onClose={() => { /* 预览不关闭 */ }}
                    initialVisible
                    animationEnabled={false}
                    duration={0}
                    glass={glass}
                />
            </div>

            <Row label="填充" hint="关掉＝完全透明，只剩文字与光晕；开＝整张卡片一层玻璃底">
                <label className="glass-switch">
                    <input
                        type="checkbox"
                        checked={glass.fill}
                        onChange={(e) => update({ fill: e.target.checked })}
                    />
                    <span>启用</span>
                </label>
                <div className="segmented" role="radiogroup" aria-label="填充形态">
                    {([['solid', '纯色'], ['gradient', '渐变']] as Array<[FillMode, string]>).map(([id, label]) => (
                        <button
                            key={id}
                            type="button"
                            role="radio"
                            aria-checked={glass.fillMode === id}
                            className="segmented-item"
                            data-active={glass.fillMode === id}
                            disabled={!glass.fill}
                            onClick={() => update({ fillMode: id })}
                        >
                            {label}
                        </button>
                    ))}
                </div>
                {glass.fillMode === 'solid' ? (
                    <input
                        type="color"
                        value={glass.fillColor}
                        disabled={!glass.fill}
                        aria-label="填充色"
                        onChange={(e) => update({ fillColor: e.target.value })}
                    />
                ) : null}
                <input
                    className="glass-range"
                    type="range"
                    min={0}
                    max={60}
                    value={glass.fillOpacity}
                    disabled={!glass.fill}
                    aria-label="填充不透明度"
                    onChange={(e) => update({ fillOpacity: Number(e.target.value) })}
                />
                <span className="glass-value">{glass.fillOpacity}%</span>
            </Row>

            {glass.fillMode === 'gradient' ? (
                <Row
                    label="渐变"
                    hint="只支持从左到右 —— 卡片只有 344×114，斜向渐变在这个尺寸上会像渲染错误而不是设计"
                >
                    <input
                        type="color"
                        value={glass.fillGradientFrom}
                        disabled={!glass.fill}
                        aria-label="渐变起点（左）"
                        title="起点（左）"
                        onChange={(e) => update({ fillGradientFrom: e.target.value })}
                    />
                    <span className="glass-value" aria-hidden="true">→</span>
                    <input
                        type="color"
                        value={glass.fillGradientTo}
                        disabled={!glass.fill}
                        aria-label="渐变终点（右）"
                        title="终点（右）"
                        onChange={(e) => update({ fillGradientTo: e.target.value })}
                    />
                    <div className="glass-presets" role="group" aria-label="渐变预设">
                        {GRADIENT_PRESETS.map((preset) => {
                            const active =
                                glass.fillGradientFrom.toLowerCase() === preset.from.toLowerCase() &&
                                glass.fillGradientTo.toLowerCase() === preset.to.toLowerCase()
                            return (
                                <button
                                    key={preset.id}
                                    type="button"
                                    className="glass-preset"
                                    data-active={active}
                                    disabled={!glass.fill}
                                    title={preset.label}
                                    aria-label={preset.label}
                                    aria-pressed={active}
                                    style={{ background: `linear-gradient(90deg, ${preset.from}, ${preset.to})` }}
                                    onClick={() => update({ fillGradientFrom: preset.from, fillGradientTo: preset.to })}
                                />
                            )
                        })}
                    </div>
                </Row>
            ) : null}

            <Row
                label="文字颜色"
                hint={
                    glass.textColor === ''
                        ? `默认由填充色决定（当前这套填充 → ${glassTextPolarity(glass) === 'dark' ? '深色' : '浅色'}字），不会随桌面背景变来变去`
                        : '已手动指定，任何桌面都用这个颜色'
                }
            >
                <label className="glass-switch">
                    <input
                        type="checkbox"
                        checked={glass.textColor !== ''}
                        onChange={(e) => update({ textColor: e.target.checked ? '#ffffff' : '' })}
                    />
                    <span>手动指定</span>
                </label>
                <input
                    type="color"
                    value={glass.textColor || '#ffffff'}
                    disabled={glass.textColor === ''}
                    aria-label="文字颜色"
                    onChange={(e) => update({ textColor: e.target.value })}
                />
            </Row>

            <Row label="描边" hint="0 = 完全没有边。默认 0.5px 发丝边（旧版是 1.5px 白边）">
                <input
                    className="glass-range"
                    type="range"
                    min={0}
                    max={3}
                    step={0.25}
                    value={glass.borderWidth}
                    aria-label="描边宽度"
                    onChange={(e) => update({ borderWidth: Number(e.target.value) })}
                />
                <span className="glass-value">{glass.borderWidth}px</span>
                <input
                    type="color"
                    value={glass.borderColor}
                    disabled={glass.borderWidth === 0}
                    aria-label="描边颜色"
                    onChange={(e) => update({ borderColor: e.target.value })}
                />
                <input
                    className="glass-range"
                    type="range"
                    min={0}
                    max={100}
                    value={glass.borderOpacity}
                    disabled={glass.borderWidth === 0}
                    aria-label="描边不透明度"
                    onChange={(e) => update({ borderOpacity: Number(e.target.value) })}
                />
                <span className="glass-value">{glass.borderOpacity}%</span>
            </Row>

            <Row label="圆角">
                <input
                    className="glass-range"
                    type="range"
                    min={0}
                    max={28}
                    value={glass.radius}
                    aria-label="圆角"
                    onChange={(e) => update({ radius: Number(e.target.value) })}
                />
                <span className="glass-value">{glass.radius}px</span>
            </Row>

            <Row label="折射强度" hint="越高越像厚玻璃（边缘弯曲与色散更明显），0 就是一块平板">
                <input
                    className="glass-range"
                    type="range"
                    min={0}
                    max={100}
                    value={glass.blur}
                    aria-label="折射强度"
                    onChange={(e) => update({ blur: Number(e.target.value) })}
                />
                <span className="glass-value">{glass.blur}</span>
            </Row>

            <Row label="投影" hint="卡片与桌面之间的层次；0 = 完全不要投影">
                <input
                    className="glass-range"
                    type="range"
                    min={0}
                    max={100}
                    value={glass.shadow}
                    aria-label="投影强度"
                    onChange={(e) => update({ shadow: Number(e.target.value) })}
                />
                <span className="glass-value">{glass.shadow}</span>
            </Row>

            <div className="setting-row">
                <div className="setting-label">
                    <div>
                        <strong>恢复默认</strong>
                        <span className="hint">浅白填充 + 发丝描边 + 由填充色决定的文字色（不随桌面变化）</span>
                    </div>
                </div>
                <div className="appearance-actions">
                    <button className="secondary-btn" type="button" onClick={reset}>
                        恢复默认
                    </button>
                </div>
            </div>
        </div>
    )
}
