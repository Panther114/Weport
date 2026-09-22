import { useCallback, useEffect, useMemo, useState } from 'react'
import {
    ArrowLeftRight,
    Eye,
    Layers,
    Maximize2,
    RotateCcw,
    Ruler,
    Sparkles,
    Type,
    Wand2,
} from 'lucide-react'
import { NotificationToast, type NotificationData } from '../NotificationToast'
import '../../styles/notificationGlass.scss'
import { ColorPicker } from './ColorPicker'
import {
    COLOR_PALETTE,
    GRADIENT_PRESETS,
    NOTIFICATION_CARD_MAX_EXTRA_WIDTH,
    NOTIFICATION_CARD_MAX_WIDTH,
    NOTIFICATION_CARD_MIN_WIDTH,
    NOTIFICATION_GLASS_DEFAULT,
    NOTIFICATION_GLASS_KEYS,
    glassTextPolarity,
    normalizeNotificationGlass,
    notificationGlassRepresentativeRgba,
    notificationGlassTextVars,
    type FillMode,
    type NotificationGlass
} from '../../utils/notificationGlass'

/**
 * 消息通知设置 → 通知玻璃（v1.0.1 重做）。
 *
 * ## 为什么重做（旧版的四个结构性问题，不是审美问题）
 *
 * 1. **一行塞了整组控件。** 旧版把面板塞进全局 `.setting-row` 的两列栅格，右列被
 *    限制在 260px，而"填充"一行要放开关 + 纯色/渐变分段 + 色块 + 滑块 + 数值。
 *    结果是换行、错位、分段按钮被挤出可视区 —— 用户看到的"填充只有一个开关"
 *    其实是控件被布局吃掉了。
 * 2. **色彩全部走 `<input type="color">`。** 30×24 的系统色板方块，点开是一个与
 *    页面无关的 Windows 对话框：没有 hex、没有预设、没有取色管；纯色模式下它
 *    连标签都没有，所以"没法选颜色"的观感是准确的。渐变两端也只是两个无标签的小方块。
 * 3. **预览离控件太远。** 预览只有 104px 高、垫了一张假渐变桌面，控件全在它下面：
 *    改一下要滚动、看不到结果。而且样本只有一条短昵称 —— 长昵称/长消息这两种
 *    真正会出问题的输入根本没得看。
 * 4. **分组缺失。** 填充、文字、描边、圆角、折射、投影六件事平铺成一列，
 *    每行的视觉权重相同，用户每读一行都要重新判断"这行在调什么"。
 *
 * ## 新版结构
 *
 *   ┌ 预览（整幅宽，真组件，样本可切，可切深/浅桌面）────────────────┐
 *   ├ 填充 ─────────┬ 文字 ─────────┐
 *   ├ 形状与材质 ───┴ 卡片（尺寸/行数）┘
 *
 * 控件自己实现（`.ng-*`），不再借用 `.setting-row`：分组内是"标签在上、控件占满"
 * 的两列栅格，滑块旁边永远有可输入的数值框，色块是 48×28 的大触发按钮。
 *
 * 预览用的仍然是**真组件**（NotificationToast），因此预览里的自适应加宽、
 * 行数上限、模糊、渐变两端都跟真弹窗走同一条渲染路径 —— 不存在"预览好看、
 * 实际不一样"的漂移。
 */

const SAMPLE_SETS: Array<{ id: string; label: string; title: string; content: string }> = [
    {
        id: 'plain',
        label: '普通',
        title: '张同学',
        content: '预览：这条通知只有卡片填充，文字背后没有任何单独的底色。',
    },
    {
        id: 'long-name',
        label: '超长昵称',
        title: '不想上班只想睡觉的咸鱼本鱼（勿扰模式）',
        content: '昵称太长时，卡片会自己变宽，右上角的时间不会被压住。',
    },
    {
        id: 'long-message',
        label: '长消息',
        title: '李工',
        content:
            '这条消息故意写得很长，用来确认正文在卡片里到底能完整显示几行：会议改到明天下午三点，会议室还是 302，记得带上上周的报表和两版样稿，另外客户那边希望我们提前一天把演示环境搭好。',
    },
    {
        id: 'recall',
        label: '撤回提醒',
        title: '群聊 · 老同学',
        content: '「老王」撤回了一条消息：明天下午三点，302 会议室。',
    },
]

interface GroupProps {
    icon: React.ReactNode
    title: string
    hint?: string
    children: React.ReactNode
}

function Group({ icon, title, hint, children }: GroupProps) {
    return (
        <section className="ng-group">
            <header className="ng-group-head">
                <span className="ng-group-icon" aria-hidden>{icon}</span>
                <div className="ng-group-titles">
                    <strong>{title}</strong>
                    {hint ? <span className="ng-group-hint">{hint}</span> : null}
                </div>
            </header>
            <div className="ng-group-body">{children}</div>
        </section>
    )
}

interface RowProps {
    label: string
    hint?: string
    children: React.ReactNode
}

/** 一行 = 一件事。标签列固定，控件列占满剩余宽度。 */
function Row({ label, hint, children }: RowProps) {
    return (
        <div className="ng-row">
            <div className="ng-row-label">
                <strong>{label}</strong>
                {hint ? <span>{hint}</span> : null}
            </div>
            <div className="ng-row-control">{children}</div>
        </div>
    )
}

interface NumberFieldProps {
    value: number
    min: number
    max: number
    step?: number
    unit?: string
    label: string
    disabled?: boolean
    onChange: (value: number) => void
}

/**
 * 数值框：与滑块成对出现。
 *
 * 只有滑块的面板无法"输入准确值"（用户要 344 就得拖），只有输入框的面板无法
 * "扫一眼大概"。两者都要，而且输入框自己保留草稿 —— 否则输入 `28` 的中间态 `2`
 * 会被立刻夹到下限、光标位置丢失。
 */
function NumberField({ value, min, max, step = 1, unit, label, disabled, onChange }: NumberFieldProps) {
    const [draft, setDraft] = useState(String(value))
    useEffect(() => setDraft(String(value)), [value])
    return (
        <span className="ng-number" data-disabled={disabled ? 'true' : undefined}>
            <input
                type="number"
                className="ng-number-input"
                value={draft}
                min={min}
                max={max}
                step={step}
                disabled={disabled}
                aria-label={label}
                onChange={(event) => {
                    const text = event.target.value
                    setDraft(text)
                    const parsed = Number(text)
                    if (text === '' || !Number.isFinite(parsed)) return
                    onChange(Math.min(max, Math.max(min, parsed)))
                }}
                onBlur={() => setDraft(String(value))}
            />
            {unit ? <span className="ng-number-unit">{unit}</span> : null}
        </span>
    )
}

interface SliderProps {
    label: string
    hint?: string
    value: number
    min: number
    max: number
    step?: number
    unit?: string
    disabled?: boolean
    onChange: (value: number) => void
}

function Slider({ label, hint, value, min, max, step = 1, unit, disabled, onChange }: SliderProps) {
    return (
        <Row label={label} hint={hint}>
            <input
                className="ng-range"
                type="range"
                min={min}
                max={max}
                step={step}
                value={value}
                disabled={disabled}
                aria-label={label}
                onChange={(event) => onChange(Number(event.target.value))}
            />
            <NumberField
                label={`${label}（数值）`}
                value={value}
                min={min}
                max={max}
                step={step}
                unit={unit}
                disabled={disabled}
                onChange={onChange}
            />
        </Row>
    )
}

interface ToggleProps {
    checked: boolean
    label: string
    disabled?: boolean
    onChange: (next: boolean) => void
}

function Toggle({ checked, label, disabled, onChange }: ToggleProps) {
    return (
        <label className="switch ng-toggle">
            <input
                type="checkbox"
                checked={checked}
                disabled={disabled}
                aria-label={label}
                onChange={(event) => onChange(event.target.checked)}
            />
            <span className="track" />
        </label>
    )
}

export function NotificationGlassPanel() {
    const [glass, setGlass] = useState<NotificationGlass>(NOTIFICATION_GLASS_DEFAULT)
    const [loaded, setLoaded] = useState(false)
    const [sampleId, setSampleId] = useState(SAMPLE_SETS[0].id)
    const [wallpaper, setWallpaper] = useState<'dark' | 'light'>('dark')
    /** 预览卡片的实测尺寸（含自适应加宽），用来把"现在到底多宽"写给人看 */
    const [measured, setMeasured] = useState({ width: NOTIFICATION_GLASS_DEFAULT.width, height: 0 })

    useEffect(() => {
        let cancelled = false
        const load = async () => {
            const api = window.electronAPI
            if (!api?.config?.get) {
                setLoaded(true)
                return
            }
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
            setLoaded(true)
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
        for (const field of Object.keys(patch) as Array<keyof NotificationGlass>) {
            void window.electronAPI?.config?.set(NOTIFICATION_GLASS_KEYS[field], next[field])
        }
    }

    const reset = () => {
        setGlass(NOTIFICATION_GLASS_DEFAULT)
        for (const field of Object.keys(NOTIFICATION_GLASS_KEYS) as Array<keyof NotificationGlass>) {
            void window.electronAPI?.config?.set(NOTIFICATION_GLASS_KEYS[field], NOTIFICATION_GLASS_DEFAULT[field])
        }
    }

    const sample = useMemo(() => SAMPLE_SETS.find((s) => s.id === sampleId) ?? SAMPLE_SETS[0], [sampleId])
    const sampleData: NotificationData = useMemo(
        () => ({
            id: `glass-preview-${sample.id}`,
            sessionId: 'preview',
            title: sample.title,
            content: sample.content,
            timestamp: Math.floor(Date.now() / 1000),
            persistent: true,
        }),
        [sample]
    )

    const onMeasure = useCallback((size: { width: number; height: number }) => {
        setMeasured((prev) => (prev.width === size.width && prev.height === size.height ? prev : size))
    }, [])

    const extra = Math.max(0, Math.round(measured.width - glass.width))
    const polarity = glassTextPolarity(glass)

    return (
        <div className="ng">
            {/* ── 预览：整幅宽，真组件 ───────────────────────────────────── */}
            <section className="ng-preview">
                <header className="ng-preview-head">
                    <div className="ng-preview-title">
                        <Eye size={14} aria-hidden />
                        <strong>实时预览</strong>
                        <span>
                            卡片 {measured.width}px
                            {extra > 0 ? `（基础 ${glass.width} + 自适应 ${extra}）` : `（基础 ${glass.width}）`}
                        </span>
                    </div>
                    <div className="ng-preview-tools">
                        <div className="ng-seg" role="radiogroup" aria-label="预览样本">
                            {SAMPLE_SETS.map((item) => (
                                <button
                                    key={item.id}
                                    type="button"
                                    role="radio"
                                    aria-checked={sampleId === item.id}
                                    className="ng-seg-item"
                                    data-active={sampleId === item.id}
                                    onClick={() => setSampleId(item.id)}
                                >
                                    {item.label}
                                </button>
                            ))}
                        </div>
                        <div className="ng-seg" role="radiogroup" aria-label="预览桌面">
                            {([['dark', '深色桌面'], ['light', '浅色桌面']] as Array<['dark' | 'light', string]>).map(([id, label]) => (
                                <button
                                    key={id}
                                    type="button"
                                    role="radio"
                                    aria-checked={wallpaper === id}
                                    className="ng-seg-item"
                                    data-active={wallpaper === id}
                                    onClick={() => setWallpaper(id)}
                                >
                                    {label}
                                </button>
                            ))}
                        </div>
                    </div>
                </header>

                {/* 舞台背后是一张假桌面：玻璃得有"背后的东西"才看得出来。深浅两套
                    是**必须**的 —— 弹窗要同时在亮壁纸和暗壁纸上成立，只给一套预览
                    等于让用户凭运气调。 */}
                <div className="ng-preview-stage" data-wallpaper={wallpaper}>
                    <div className="ng-preview-stage-inner" style={notificationGlassTextVars(glass)}>
                        {loaded ? (
                            <NotificationToast
                                data={sampleData}
                                onClose={() => { /* 预览不关闭 */ }}
                                initialVisible
                                animationEnabled={false}
                                duration={0}
                                glass={glass}
                                onMeasure={onMeasure}
                            />
                        ) : null}
                    </div>
                </div>

                <footer className="ng-preview-foot">
                    <span>
                        文字按填充色取{polarity === 'dark' ? '深色' : '浅色'}
                        {glass.textColor ? '（已手动指定）' : ''}；昵称过长时自动加宽最多 +{NOTIFICATION_CARD_MAX_EXTRA_WIDTH}px，
                        正文最多 {glass.maxLines} 行。
                    </span>
                    <button className="ng-reset" type="button" onClick={reset}>
                        <RotateCcw size={13} />
                        恢复默认
                    </button>
                </footer>
            </section>

            {/* ── 控件：四组，两列 ──────────────────────────────────────── */}
            <div className="ng-groups">
                <Group icon={<Layers size={14} />} title="填充" hint="整张卡片一层底，不会只垫在文字后面">
                    <Row label="填充" hint="关掉＝完全透明，只剩文字与光晕">
                        <Toggle checked={glass.fill} label="启用填充" onChange={(fill) => update({ fill })} />
                    </Row>

                    <Row label="形态">
                        <div className="ng-seg" role="radiogroup" aria-label="填充形态">
                            {([['solid', '纯色'], ['gradient', '渐变']] as Array<[FillMode, string]>).map(([id, label]) => (
                                <button
                                    key={id}
                                    type="button"
                                    role="radio"
                                    aria-checked={glass.fillMode === id}
                                    className="ng-seg-item"
                                    data-active={glass.fillMode === id}
                                    disabled={!glass.fill}
                                    onClick={() => update({ fillMode: id })}
                                >
                                    {label}
                                </button>
                            ))}
                        </div>
                    </Row>

                    {glass.fillMode === 'solid' ? (
                        <>
                            <Row label="颜色" hint="纯色填充">
                                <ColorPicker
                                    label="填充颜色"
                                    value={glass.fillColor}
                                    disabled={!glass.fill}
                                    onChange={(fillColor) => update({ fillColor })}
                                />
                            </Row>
                            <Row label="快捷色" hint="点一下即用">
                                <div className="ng-swatches" role="group" aria-label="纯色快捷色板">
                                    {COLOR_PALETTE.flat().map((hex) => (
                                        <button
                                            key={hex}
                                            type="button"
                                            className="ng-swatch"
                                            style={{ background: hex }}
                                            data-active={glass.fillColor.toLowerCase() === hex}
                                            disabled={!glass.fill}
                                            title={hex.toUpperCase()}
                                            aria-label={hex.toUpperCase()}
                                            onClick={() => update({ fillColor: hex })}
                                        />
                                    ))}
                                </div>
                            </Row>
                        </>
                    ) : (
                        <>
                            <Row label="渐变两端" hint="只支持从左到右">
                                <div className="ng-gradient-row">
                                    <ColorPicker
                                        label="渐变起点（左）"
                                        value={glass.fillGradientFrom}
                                        disabled={!glass.fill}
                                        compact
                                        onChange={(fillGradientFrom) => update({ fillGradientFrom })}
                                    />
                                    <span className="ng-gradient-bar" aria-hidden style={{ background: `linear-gradient(90deg, ${glass.fillGradientFrom}, ${glass.fillGradientTo})` }} />
                                    <ColorPicker
                                        label="渐变终点（右）"
                                        value={glass.fillGradientTo}
                                        disabled={!glass.fill}
                                        compact
                                        onChange={(fillGradientTo) => update({ fillGradientTo })}
                                    />
                                    <button
                                        type="button"
                                        className="ng-icon-btn"
                                        title="左右互换"
                                        aria-label="左右互换渐变两端"
                                        disabled={!glass.fill}
                                        onClick={() =>
                                            update({ fillGradientFrom: glass.fillGradientTo, fillGradientTo: glass.fillGradientFrom })
                                        }
                                    >
                                        <ArrowLeftRight size={14} />
                                    </button>
                                </div>
                            </Row>
                            <Row label="渐变预设" hint={`${GRADIENT_PRESETS.length} 组 · 色块本身就是预览 · 上下滚动`}>
                                <div className="ng-presets" role="group" aria-label="渐变预设">
                                    {GRADIENT_PRESETS.map((preset) => {
                                        const active =
                                            glass.fillGradientFrom.toLowerCase() === preset.from &&
                                            glass.fillGradientTo.toLowerCase() === preset.to
                                        return (
                                            <button
                                                key={preset.id}
                                                type="button"
                                                className="ng-preset"
                                                data-active={active}
                                                disabled={!glass.fill}
                                                title={preset.label}
                                                aria-label={preset.label}
                                                aria-pressed={active}
                                                onClick={() => update({ fillGradientFrom: preset.from, fillGradientTo: preset.to })}
                                            >
                                                <span className="ng-preset-chip" style={{ background: `linear-gradient(90deg, ${preset.from}, ${preset.to})` }} />
                                                <span className="ng-preset-name">{preset.label}</span>
                                            </button>
                                        )
                                    })}
                                </div>
                            </Row>
                        </>
                    )}

                    <Slider
                        label="不透明度"
                        hint="0 = 完全透明，100 = 实色"
                        value={glass.fillOpacity}
                        min={0}
                        max={100}
                        unit="%"
                        disabled={!glass.fill}
                        onChange={(fillOpacity) => update({ fillOpacity })}
                    />
                </Group>

                <Group icon={<Type size={14} />} title="文字" hint="描边光晕由自适应引擎负责，保证亮暗桌面上都读得清">
                    <Row label="文字颜色" hint="默认跟随填充色极性">
                        <div className="ng-inline">
                            <Toggle
                                checked={glass.textColor !== ''}
                                label="手动指定文字颜色"
                                onChange={(on) => update({ textColor: on ? (polarity === 'dark' ? '#000000' : '#ffffff') : '' })}
                            />
                            <span className="ng-inline-label">手动指定</span>
                        </div>
                    </Row>
                    <Row label="颜色">
                        <ColorPicker
                            label="文字颜色"
                            value={glass.textColor || (polarity === 'dark' ? '#000000' : '#ffffff')}
                            disabled={glass.textColor === ''}
                            onChange={(textColor) => update({ textColor })}
                        />
                    </Row>
                    <Row label="当前判断" hint="由填充色算出，不跟随壁纸">
                        {/* 这枚小牌子直接**画出结果**：底色就是这张卡片的填充（渐变取两端
                            中点），字色就是将要用的文字色。只写"深色文字"四个字的话，
                            用户还得自己在脑子里合成一遍。
                            用 rgba 单色而不是 CSS 渐变：内联的 `background: linear-gradient()`
                            会把 background-color 重置为透明，对比度审计就只看得到面板底色，
                            把"浅色玻璃上的黑字"报成 1.1 的假失败。 */}
                        <span
                            className="ng-readout"
                            data-polarity={polarity}
                            style={{
                                backgroundColor: glass.fill
                                    ? `rgba(${notificationGlassRepresentativeRgba(glass).join(', ')})`
                                    : undefined,
                                color: polarity === 'dark' ? '#0a0a0a' : '#ffffff'
                            }}
                        >
                            {polarity === 'dark' ? '深色文字' : '浅色文字'}
                        </span>
                    </Row>
                </Group>

                <Group icon={<Wand2 size={14} />} title="形状与材质" hint="圆角、描边、投影与玻璃厚度">
                    <Slider label="圆角" value={glass.radius} min={0} max={40} unit="px" onChange={(radius) => update({ radius })} />
                    <Slider
                        label="描边"
                        hint="0 = 完全没有边"
                        value={glass.borderWidth}
                        min={0}
                        max={3}
                        step={0.25}
                        unit="px"
                        onChange={(borderWidth) => update({ borderWidth })}
                    />
                    <Row label="描边颜色">
                        <ColorPicker
                            label="描边颜色"
                            value={glass.borderColor}
                            disabled={glass.borderWidth === 0}
                            onChange={(borderColor) => update({ borderColor })}
                        />
                    </Row>
                    <Slider
                        label="描边浓度"
                        value={glass.borderOpacity}
                        min={0}
                        max={100}
                        unit="%"
                        disabled={glass.borderWidth === 0}
                        onChange={(borderOpacity) => update({ borderOpacity })}
                    />
                    <Slider
                        label="投影"
                        hint="卡片与桌面的层次"
                        value={glass.shadow}
                        min={0}
                        max={100}
                        onChange={(shadow) => update({ shadow })}
                    />
                    <Slider
                        label="折射强度"
                        hint="边缘弯曲与色散"
                        value={glass.blur}
                        min={0}
                        max={100}
                        onChange={(blur) => update({ blur })}
                    />
                    <Slider
                        label="玻璃模糊"
                        hint="背后磨砂，0 = 清晰"
                        value={glass.frost}
                        min={0}
                        max={100}
                        onChange={(frost) => update({ frost })}
                    />
                </Group>

                <Group icon={<Ruler size={14} />} title="卡片尺寸" hint="昵称太长会自动加宽，长消息会往下长">
                    <Slider
                        label="基础宽度"
                        hint={`可调 ${NOTIFICATION_CARD_MIN_WIDTH}-${NOTIFICATION_CARD_MAX_WIDTH}px`}
                        value={glass.width}
                        min={NOTIFICATION_CARD_MIN_WIDTH}
                        max={NOTIFICATION_CARD_MAX_WIDTH}
                        step={4}
                        unit="px"
                        onChange={(width) => update({ width })}
                    />
                    <Slider
                        label="正文行数"
                        hint="超出才截断"
                        value={glass.maxLines}
                        min={1}
                        max={6}
                        unit="行"
                        onChange={(maxLines) => update({ maxLines })}
                    />
                    <div className="ng-note">
                        <Maximize2 size={13} aria-hidden />
                        <span>
                            昵称放不下时卡片最多再加宽 {NOTIFICATION_CARD_MAX_EXTRA_WIDTH}px（上限{' '}
                            {NOTIFICATION_CARD_MAX_WIDTH}px），正文超过 {glass.maxLines} 行才截断 ——
                            上限刻意留得宽松，中等长度的昵称与消息能完整显示。
                        </span>
                    </div>
                </Group>
            </div>

            <p className="ng-foot-note">
                <Sparkles size={13} aria-hidden />
                <span>
                    这些设置只影响新消息弹窗。弹窗出现在屏幕一角，右键卡片可立即关闭；
                    想立刻看真弹窗，用页面顶部的「测试弹窗」。
                </span>
            </p>
        </div>
    )
}
