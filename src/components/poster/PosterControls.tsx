import { useCallback, useState } from 'react'
import { createPortal } from 'react-dom'
import { AlertTriangle, LayoutTemplate, ShieldCheck, ShieldOff } from 'lucide-react'
import { ColorPicker } from '../settings/ColorPicker'
import { useEscape } from '../../utils/useEscape'
import type { PosterOptions, PosterTemplateId, RedactionKind, RedactionStrength } from './posterTypes.ts'
import { POSTER_TEMPLATES } from './posterTemplates.ts'
import { REDACTION_LABELS, summarizeMatches, type RedactionMatch } from './posterRedaction.ts'

/** Inline template choices keep the primary design decision visible in workflow step 2. */
export function PosterTemplatePicker({
    options,
    onApply,
}: {
    options: PosterOptions
    onApply: (id: PosterTemplateId) => void
}) {
    return (
        <div className="poster-template-chooser" role="group" aria-label="选择模板">
            <div className="poster-template-chooser-heading">
                <LayoutTemplate size={15} aria-hidden="true" />
                <div>
                    <strong>选择模板</strong>
                    <span>先确定内容的排版方式，之后仍可随时切换。</span>
                </div>
            </div>
            <div className="poster-template-grid">
                {POSTER_TEMPLATES.map((template) => (
                    <button
                        key={template.id}
                        type="button"
                        className="poster-template-card"
                        data-active={template.id === options.template}
                        aria-pressed={template.id === options.template}
                        onClick={() => onApply(template.id)}
                    >
                        <span className="poster-thumb" data-shape={template.preview} aria-hidden="true">
                            <i />
                            <i />
                            <i />
                            <i />
                            <i />
                            <i />
                            <i />
                            <i />
                            <i />
                        </span>
                        <b>{template.name}</b>
                        <span>{template.hint}</span>
                    </button>
                ))}
            </div>
            <span className="poster-redaction-note">
                切换模板会更新字号、气泡、头像和时间戳；打码设置、页脚与标题会保留。
            </span>
        </div>
    )
}

const STRENGTHS: Array<{ id: RedactionStrength; label: string; hint: string }> = [
    { id: 'light', label: '轻', hint: '留头 3 尾 2' },
    { id: 'normal', label: '标准', hint: '留头 1 尾 1' },
    { id: 'strong', label: '强', hint: '整段遮蔽' },
]

const KIND_ORDER: RedactionKind[] = ['phone', 'wxid', 'idcard', 'bankcard', 'email', 'address', 'code', 'name']

/**
 * 打码面板。
 *
 * **关掉要一次明确确认**（§4 硬要求）：打码是"默认开、关掉要负责"的功能，所以
 * 关闭走一个真正的模态确认（`role="dialog" aria-modal`，`createPortal` 到 body），
 * 而不是一个静默的开关。确认之后本次会话内不再重复询问（状态留在页面里）。
 */
export function PosterRedactionPanel({
    options,
    onChange,
    matches,
    confirmRequired,
    onConfirmDisable,
}: {
    options: PosterOptions
    onChange: (patch: Partial<PosterOptions['redaction']>) => void
    /** 当前预览里真实命中的打码（**证据**：预览里到底涂了什么） */
    matches: RedactionMatch[]
    /** 关闭时需要确认（第一次关闭时由页面置 true） */
    confirmRequired: boolean
    onConfirmDisable: () => void
}) {
    const [confirmOpen, setConfirmOpen] = useState(false)
    const { enabled, strength, kinds } = options.redaction
    const summary = summarizeMatches(matches)

    const requestDisable = useCallback(() => {
        if (confirmRequired) setConfirmOpen(true)
        else onChange({ enabled: false })
    }, [confirmRequired, onChange])

    const toggleKind = (kind: RedactionKind) => {
        const next = kinds.includes(kind) ? kinds.filter((k) => k !== kind) : [...kinds, kind]
        onChange({ kinds: KIND_ORDER.filter((k) => next.includes(k)) })
    }

    return (
        <div className="poster-field">
            <div className="poster-toggle-row">
                <span className="poster-redaction-control-icon" data-enabled={enabled}>
                    {enabled ? <ShieldCheck size={13} /> : <ShieldOff size={13} />}
                    自动打码
                </span>
                <button
                    type="button"
                    className="poster-mini-btn"
                    data-on={enabled}
                    aria-pressed={enabled}
                    onClick={() => (enabled ? requestDisable() : onChange({ enabled: true }))}
                >
                    {enabled ? '已开启' : '已关闭'}
                </button>
            </div>

            <div className="poster-field">
                <span className="poster-field-label">强度</span>
                <div className="poster-kind-chips">
                    {STRENGTHS.map((item) => (
                        <button
                            key={item.id}
                            type="button"
                            className="poster-kind-chip"
                            data-on={strength === item.id}
                            aria-pressed={strength === item.id}
                            title={item.hint}
                            disabled={!enabled}
                            onClick={() => onChange({ strength: item.id })}
                        >
                            {item.label}
                        </button>
                    ))}
                </div>
            </div>

            <div className="poster-field">
                <span className="poster-field-label">命中种类</span>
                <div className="poster-kind-chips">
                    {KIND_ORDER.map((kind) => (
                        <button
                            key={kind}
                            type="button"
                            className="poster-kind-chip"
                            data-on={kinds.includes(kind)}
                            aria-pressed={kinds.includes(kind)}
                            disabled={!enabled}
                            onClick={() => toggleKind(kind)}
                        >
                            {REDACTION_LABELS[kind]}
                        </button>
                    ))}
                </div>
            </div>

            <div className="poster-mask-strip" data-enabled={enabled}>
                {enabled ? (
                    summary.length > 0 ? (
                        <>
                            <ShieldCheck size={13} />
                            预览中已遮挡 {matches.length} 处：
                            {summary.map((item) => `${item.label} ${item.count}`).join(' · ')}
                        </>
                    ) : (
                        <>
                            <ShieldCheck size={13} />
                            已开启，当前内容未命中任何规则（手机号 / 微信 ID / 身份证 / 银行卡 / 邮箱 / 地址 / 验证码 / 昵称）
                        </>
                    )
                ) : (
                    <>
                        <AlertTriangle size={13} />
                        打码已关闭：导出的图片会包含原始号码与昵称
                    </>
                )}
            </div>

            <span className="poster-redaction-note">
                名片头像与图片里的画面不会被自动遮挡（正则识别不了像素）。图片里的二维码：本机若提供条码识别接口会列出来，
                否则请在条目编辑里用「遮挡」手动框选 —— 遮挡块会画进导出的图里。
            </span>

            {confirmOpen
                ? createPortal(
                      <ConfirmDisableRedaction
                          onCancel={() => setConfirmOpen(false)}
                          onConfirm={() => {
                              setConfirmOpen(false)
                              onConfirmDisable()
                              onChange({ enabled: false })
                          }}
                      />,
                      document.body
                  )
                : null}
        </div>
    )
}

function ConfirmDisableRedaction({ onCancel, onConfirm }: { onCancel: () => void; onConfirm: () => void }) {
    const titleId = 'poster-redaction-disable-title'
    useEscape(onCancel)
    return (
        <div className="modal-backdrop" onClick={onCancel}>
            <div className="modal danger" role="dialog" aria-modal="true" aria-labelledby={titleId} onClick={(e) => e.stopPropagation()}>
                <h3 id={titleId}>关闭自动打码？</h3>
                <p className="v09-sub">
                    关闭后，手机号、微信 ID、身份证、银行卡、邮箱、地址、验证码与昵称都会原样出现在海报与导出的图片里。
                    这条确认只问一次；之后可以在同一个开关上重新打开。
                </p>
                <div className="modal-actions">
                    <button type="button" className="ghost-btn" onClick={onCancel}>
                        保持开启
                    </button>
                    <button type="button" className="danger-btn" onClick={onConfirm}>
                        确认关闭
                    </button>
                </div>
            </div>
        </div>
    )
}

/** 颜色 + 字号 + 开关的样式区（取色器复用设置页的 `ColorPicker`，同样是浮层）。 */
export function PosterStylePanel({
    options,
    onChange,
    showAvatarToggle,
}: {
    options: PosterOptions
    onChange: (patch: Partial<PosterOptions>) => void
    showAvatarToggle: boolean
}) {
    return (
        <div className="poster-control-groups">
            <section className="poster-control-group" aria-label="配色与主题">
                <div className="poster-control-group-title">配色与主题</div>
                <div className="poster-field">
                    <span className="poster-field-label">强调色</span>
                    <ColorPicker value={options.accent} label="海报强调色" onChange={(hex) => onChange({ accent: hex })} />
                </div>

                <div className="poster-field">
                    <span className="poster-field-label">主题（只影响海报，与 App 主题无关）</span>
                    <div className="poster-kind-chips">
                        {(['dark', 'light'] as const).map((theme) => (
                            <button
                                key={theme}
                                type="button"
                                className="poster-kind-chip"
                                data-on={options.theme === theme}
                                aria-pressed={options.theme === theme}
                                onClick={() => onChange({ theme })}
                            >
                                {theme === 'dark' ? '深色' : '浅色'}
                            </button>
                        ))}
                    </div>
                </div>
            </section>

            <section className="poster-control-group" aria-label="消息排版">
                <div className="poster-control-group-title">消息排版</div>
                <div className="poster-field">
                    <label className="poster-field-label" htmlFor="poster-font-scale">字号 {Math.round(options.fontScale * 100)}%</label>
                    <input
                        id="poster-font-scale"
                        type="range"
                        min={80}
                        max={160}
                        step={2}
                        value={Math.round(options.fontScale * 100)}
                        aria-label="字号倍率"
                        onChange={(event) => onChange({ fontScale: Number(event.target.value) / 100 })}
                    />
                </div>

                <Toggle label="微信风格气泡" value={options.showBubble} onChange={(v) => onChange({ showBubble: v })} />
                {showAvatarToggle ? (
                    <Toggle label="显示头像占位" value={options.showAvatar} onChange={(v) => onChange({ showAvatar: v })} />
                ) : null}
                <Toggle label="显示时间戳" value={options.showTimestamp} onChange={(v) => onChange({ showTimestamp: v })} />
                <Toggle label="页脚水印" value={options.showWatermark} onChange={(v) => onChange({ showWatermark: v })} />
            </section>

            <section className="poster-control-group" aria-label="标题与页脚">
                <div className="poster-control-group-title">标题与页脚</div>
                <div className="poster-field">
                    <label className="poster-field-label" htmlFor="poster-footer-text">页脚自由文本</label>
                    <input
                        id="poster-footer-text"
                        type="text"
                        className="pp-input"
                        value={options.footer}
                        placeholder="例如：2026 年春节 · 家庭群"
                        maxLength={60}
                        onChange={(event) => onChange({ footer: event.target.value })}
                    />
                </div>

                <div className="poster-field">
                    <label className="poster-field-label" htmlFor="poster-title-text">标题</label>
                    <input
                        id="poster-title-text"
                        type="text"
                        className="pp-input"
                        value={options.title}
                        placeholder="留空则用会话名"
                        maxLength={40}
                        onChange={(event) => onChange({ title: event.target.value })}
                    />
                </div>
            </section>
        </div>
    )
}

function Toggle({ label, value, onChange }: { label: string; value: boolean; onChange: (value: boolean) => void }) {
    return (
        <div className="poster-toggle-row">
            <span>{label}</span>
            <button type="button" className="poster-mini-btn" data-on={value} aria-pressed={value} onClick={() => onChange(!value)}>
                {value ? '开' : '关'}
            </button>
        </div>
    )
}
