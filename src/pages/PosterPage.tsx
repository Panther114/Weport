import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import {
    ArrowLeft,
    ArrowRight,
    AlertTriangle,
    Camera,
    ClipboardCopy,
    Download,
    Images,
    FileInput,
    FileOutput,
    Loader2,
    Palette,
    QrCode,
    Save,
    ShieldCheck,
    ShieldOff,
    Trash2,
} from 'lucide-react'
import '../components/poster/poster.css'
import type { PosterItem, PosterOptions, PosterSession, PosterSourceKind } from '../components/poster/posterTypes.ts'
import { DEFAULT_POSTER_OPTIONS, POSTER_WIDTH } from '../components/poster/posterTypes.ts'
import type { SavedPosterTemplate } from '../components/poster/posterTemplates.ts'
import {
    applyTemplate,
    contrastTextOn,
    getTemplate,
    parseSavedPosterTemplates,
    serializeSavedPosterTemplates,
    templateSupportsCrop,
    templateSupportsReorder,
} from '../components/poster/posterTemplates.ts'
import {
    applyCrop,
    applyMaskBox,
    applyReorder,
    applyVisibility,
    applyVisibilityAll,
    buildPosterPages,
    collectRedactionDictionary,
    estimateCaptureCost,
    isolateKeys,
} from '../components/poster/posterLayout.ts'
import { effectiveRedactionOptions, findRedactions, summarizeMatches, type RedactionMatch } from '../components/poster/posterRedaction.ts'
import type { PosterRenderContext } from '../components/poster/posterDom.ts'
import { PosterPreview, PREVIEW_PAGE_GAP, type PosterPreviewHandle } from '../components/poster/PosterPreview.tsx'
import { PosterItemEditor } from '../components/poster/PosterItemEditor.tsx'
import { PosterRedactionPanel, PosterStylePanel, PosterTemplatePicker } from '../components/poster/PosterControls.tsx'
import { PosterSourcePanel, type PosterSessionFilters } from '../components/poster/PosterSourcePanel.tsx'
import {
    capturePoster,
    copyImageToClipboard,
    detectQrBoxes,
    formatBytes,
    hasNativeSave,
    inlineItemImages,
    saveImage,
} from '../components/poster/posterCapture.ts'
import {
    loadSessionItems,
    loadSessions,
    loadSnsItems,
    loadItemImage,
    manualQuoteItem,
    posterChannelStatus,
    posterItemsFromReaderMessages,
    type PosterChannelStatus,
} from '../components/poster/posterSource.ts'
import type { ReaderPosterRequest } from './ReaderPage'

const SAVED_TEMPLATE_KEY = 'weport.poster.savedTemplates.v1'

const POSTER_WORKFLOW_STEPS = [
    { id: 'content', label: '内容', hint: '选择来源与条目', icon: FileInput },
    { id: 'style', label: '样式', hint: '模板、配色与排版', icon: Palette },
    { id: 'privacy', label: '隐私检查', hint: '确认遮挡后导出', icon: ShieldCheck },
] as const

type PosterWorkflowStep = (typeof POSTER_WORKFLOW_STEPS)[number]['id']

function readSavedPosterTemplates(): SavedPosterTemplate[] {
    try {
        if (typeof window === 'undefined') return []
        const raw = window.localStorage.getItem(SAVED_TEMPLATE_KEY)
        return raw ? parseSavedPosterTemplates(JSON.parse(raw)) : []
    } catch {
        return []
    }
}

/**
 * 分享海报工作室（v1.2 §4）。
 *
 * ## 页面纪律
 *
 * 1. **打码是渲染期的事，不是导出期的事**：预览与导出共用 `posterDom` 的同一份
 *    DOM（`PosterPreview` 里用 `useLayoutEffect` 把 `renderPosterPages` 画进去），
 *    所以"预览里看得见马赛克"就等于"导出的图里有马赛克"。页面上还有一条说明条
 *    列出**实际命中**的种类与条数。
 * 2. **预览重绘要防抖**：改页脚文本、拖字号滑块时不能每个按键都重排 1080px 的
 *    整页（那是 `longTasks` 的来源）。所有输入先进 state，`useDebounced` 之后才
 *    参与 `buildPosterPages`。
 * 3. **拖动中不抓图**：`PosterItemEditor` 会把"正在拖"报上来，导出按钮此时禁用。
 * 4. **抓取库懒加载**：`html2canvas` 只在 `capturePoster` 里动态 import —— 打开
 *    这一页不该为它付解析成本（`App.tsx` 顶部注释点名过这件事）。
 * 5. **长任务的进度不放在页面 state 里**（铁律 3 的适用边界）：这里的"任务"是
 *    **渲染进程内的 DOM 抓取**，切页会连同 canvas 一起消失，主进程没有任何状态
 *    可恢复，所以它不该冒充主进程任务（`liveTask` + `BackgroundTasks` 是给
 *    主进程任务用的）。代价说清楚：抓取过程中切页 = 这次导出没了，界面上会提示
 *    "导出中请勿切页"。真正长的那部分（写盘）在主进程里，由 `poster:saveImage`
 *    的 Promise 负责。
 */
export default function PosterPage({ sourceRequest }: { sourceRequest?: ReaderPosterRequest }) {
    const [workflowStep, setWorkflowStep] = useState<PosterWorkflowStep>('content')
    const [options, setOptions] = useState<PosterOptions>(DEFAULT_POSTER_OPTIONS)
    const [items, setItems] = useState<PosterItem[]>([])
    const [source, setSource] = useState<PosterSourceKind>('session')
    const [channel, setChannel] = useState<PosterChannelStatus>(() => ({ sessions: false, messages: false, images: false, sns: false, missing: [] }))
    const [sessions, setSessions] = useState<PosterSession[]>([])
    const [sessionSearch, setSessionSearch] = useState('')
    const [sessionsLoading, setSessionsLoading] = useState(false)
    const [sessionsError, setSessionsError] = useState<string | null>(null)
    const [activeSession, setActiveSession] = useState<PosterSession | null>(null)
    const [filters, setFilters] = useState<PosterSessionFilters>({ startDate: '', endDate: '', limit: 60, onlyMine: false, onlyText: false })
    const [loadingItems, setLoadingItems] = useState(false)
    const [manualText, setManualText] = useState('')
    const [manualSender, setManualSender] = useState('')
    const [snsUsername, setSnsUsername] = useState('')
    const [snsKeyword, setSnsKeyword] = useState('')
    const [status, setStatus] = useState<{ kind: 'ok' | 'error' | 'warn'; text: string } | null>(null)
    const [maskedCount, setMaskedCount] = useState(0)
    const [redactionConfirmSeen, setRedactionConfirmSeen] = useState(false)
    const [imageBusyKey, setImageBusyKey] = useState<string | null>(null)
    const [dragging, setDragging] = useState(false)
    const [exporting, setExporting] = useState(false)
    const [exportStage, setExportStage] = useState('')
    const [exportScale, setExportScale] = useState<1 | 2 | 3>(2)
    const [savedTemplates, setSavedTemplates] = useState<SavedPosterTemplate[]>(readSavedPosterTemplates)
    const [templateName, setTemplateName] = useState('')
    const importTemplateRef = useRef<HTMLInputElement | null>(null)
    const consumedSourceRef = useRef<ReaderPosterRequest | null>(null)
    const [qrNote, setQrNote] = useState<string | null>(null)
    const previewRef = useRef<PosterPreviewHandle | null>(null)

    // ---- 通道探测（挂载时一次）---------------------------------------------
    useEffect(() => {
        setChannel(posterChannelStatus())
    }, [])

    useEffect(() => {
        if (!sourceRequest || consumedSourceRef.current === sourceRequest) return
        consumedSourceRef.current = sourceRequest
        const sourceItems = posterItemsFromReaderMessages(sourceRequest.messages)
        setSource('session')
        setActiveSession({
            id: sourceRequest.sessionId,
            name: sourceRequest.sessionName,
            kind: sourceRequest.sessionId.endsWith('@chatroom') ? 'group' : 'private',
            lastAt: sourceItems[sourceItems.length - 1]?.ts ?? 0,
            summary: sourceItems[sourceItems.length - 1]?.text ?? '',
            messageCount: sourceItems.length,
        })
        setItems(sourceItems)
        setStatus({ kind: sourceItems.length ? 'ok' : 'warn', text: sourceItems.length ? `已从阅读器载入 ${sourceItems.length} 条选中消息` : '阅读器没有可用于海报的消息' })
    }, [sourceRequest])

    useEffect(() => {
        try {
            window.localStorage.setItem(SAVED_TEMPLATE_KEY, serializeSavedPosterTemplates(savedTemplates))
        } catch {
            if (savedTemplates.length) setStatus({ kind: 'error', text: '保存模板失败：本机浏览器存储不可用或空间不足。' })
        }
    }, [savedTemplates])

    const reloadSessions = useCallback(async () => {
        setSessionsLoading(true)
        setSessionsError(null)
        const result = await loadSessions()
        setSessions(result.sessions)
        setSessionsError(result.error ?? null)
        setSessionsLoading(false)
    }, [])

    useEffect(() => {
        void reloadSessions()
    }, [reloadSessions])

    // ---- 防抖：输入 → 预览 ------------------------------------------------
    /**
     * 只对**逐字符/逐像素变化**的字段做防抖（页脚文本、标题、字号、强调色）。
     * 条目级的改动（显隐 / 排序 / 裁剪 / 载入）是离散动作，立刻生效才有反馈。
     */
    const debouncedOptions = useDebounced(options, 160, ['footer', 'title', 'fontScale', 'accent'])
    const debouncedItems = items

    const dictionary = useMemo(
        () => collectRedactionDictionary(debouncedItems, [activeSession?.name ?? '', options.title]),
        [debouncedItems, activeSession?.name, options.title]
    )
    const redaction = useMemo(() => effectiveRedactionOptions(debouncedOptions.redaction, dictionary), [debouncedOptions.redaction, dictionary])

    const extras = useMemo(() => ({ sessionName: activeSession?.name ?? '' }), [activeSession?.name])

    /**
     * 渲染签名：**只包含真正影响画面的字段**（zoom 不在其中）。
     *
     * 预览与导出的模型都按它记忆。为什么不用 `options` 对象本身当依赖：预览缩放
     * （`options.zoom`）会换掉对象引用，于是每点一次缩放按钮就要把 1080px 的整页
     * 重排一遍 —— 那正是页面切换/交互预算里的长任务。签名字符串不变就一定不重排。
     */
    const renderSignature = useMemo(
        () =>
            JSON.stringify([
                debouncedOptions.template,
                debouncedOptions.theme,
                debouncedOptions.accent,
                debouncedOptions.fontScale,
                debouncedOptions.showAvatar,
                debouncedOptions.showBubble,
                debouncedOptions.showWatermark,
                debouncedOptions.showTimestamp,
                debouncedOptions.footer,
                debouncedOptions.title,
                debouncedOptions.pageMaxHeight,
                debouncedOptions.redaction.enabled,
                debouncedOptions.redaction.strength,
                debouncedOptions.redaction.kinds,
                dictionary,
            ]),
        [debouncedOptions, dictionary]
    )

    const model = useMemo(() => {
        const nextPages = debouncedItems.some(item => item.visible)
            ? buildPosterPages(debouncedItems, debouncedOptions, extras) : []
        const ctx: PosterRenderContext = { options: debouncedOptions, redaction, dictionary }
        const nextMatches: RedactionMatch[] = []
        if (redaction.kinds && redaction.kinds.length > 0) {
            for (const item of debouncedItems) {
                if (!item.visible) continue
                nextMatches.push(...findRedactions(item.text, redaction), ...findRedactions(item.senderName, redaction))
                if (item.quote) nextMatches.push(...findRedactions(item.quote.text, redaction))
            }
        }
        return { pages: nextPages, ctx, matches: nextMatches }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [debouncedItems, renderSignature, extras])

    const pages = model.pages
    const renderCtx = model.ctx
    const matches = model.matches
    const previewHeight = useMemo(
        () => pages.reduce((sum, page) => sum + page.height, 0) + Math.max(0, pages.length - 1) * PREVIEW_PAGE_GAP,
        [pages]
    )

    const cost = useMemo(() => estimateCaptureCost(debouncedItems, debouncedOptions, extras), [debouncedItems, renderSignature, extras])
    const activeTemplate = getTemplate(options.template)

    const patchOptions = useCallback((patch: Partial<PosterOptions>) => {
        setOptions((prev) => ({ ...prev, ...patch }))
    }, [])

    // ---- 内容装载 ----------------------------------------------------------
    const onLoadSession = useCallback(async () => {
        if (!activeSession) return
        setLoadingItems(true)
        setStatus(null)
        const startTs = filters.startDate ? new Date(`${filters.startDate}T00:00:00`).getTime() : 0
        const endTs = filters.endDate ? new Date(`${filters.endDate}T23:59:59`).getTime() : 0
        const result = await loadSessionItems({
            sessionId: activeSession.id,
            startTs,
            endTs,
            onlyMine: filters.onlyMine,
            onlyText: filters.onlyText,
            max: filters.limit,
        })
        setItems(result.items)
        setLoadingItems(false)
        if (result.channelMissing) setStatus({ kind: 'warn', text: result.error ?? '消息通道未接入' })
        else if (result.error) setStatus({ kind: 'error', text: result.error })
        else
            setStatus({
                kind: result.items.length > 0 ? 'ok' : 'warn',
                text:
                    result.items.length > 0
                        ? `已载入 ${result.items.length} 条（扫描 ${result.scanned} 条${result.truncated ? '，已按上限截断' : ''}）`
                        : '这段范围内没有符合条件的消息',
            })
    }, [activeSession, filters])

    const onLoadSns = useCallback(async () => {
        setLoadingItems(true)
        setStatus(null)
        const result = await loadSnsItems({
            usernames: snsUsername.trim() ? [snsUsername.trim()] : undefined,
            keyword: snsKeyword.trim() || undefined,
            limit: 30,
            inlineImages: true,
        })
        setItems(result.items)
        setLoadingItems(false)
        if (result.channelMissing) setStatus({ kind: 'warn', text: result.error ?? '朋友圈通道未接入' })
        else if (result.error) setStatus({ kind: 'error', text: result.error })
        else setStatus({ kind: result.items.length > 0 ? 'ok' : 'warn', text: `已载入 ${result.items.length} 条朋友圈动态` })
    }, [snsUsername, snsKeyword])

    const onAddManualQuote = useCallback(() => {
        const text = manualText.trim()
        if (!text) return
        setItems((prev) => [...prev, manualQuoteItem({ text, senderName: manualSender.trim() || '我' })])
        setManualText('')
        setStatus({ kind: 'ok', text: '已加入 1 条手写引用' })
    }, [manualText, manualSender])

    const onLoadImage = useCallback(async (key: string) => {
        const item = items.find((entry) => entry.key === key)
        if (!item) return
        setImageBusyKey(key)
        const result = await loadItemImage(item)
        setImageBusyKey(null)
        if (!result.success || !result.src) {
            setStatus({ kind: 'error', text: `图片载入失败：${result.error ?? '未知原因'}` })
            return
        }
        setItems((prev) => prev.map((entry) => (entry.key === key ? { ...entry, imageSrc: result.src, imageUnavailable: false } : entry)))
        setStatus({ kind: 'ok', text: '图片已解密并放入海报' })
    }, [items])

    const onLoadVisibleImages = useCallback(async () => {
        const targets = items.filter((item) => item.visible && item.kind === 'image' && item.imageUnavailable).slice(0, 9)
        if (targets.length === 0) {
            setStatus({ kind: 'warn', text: '没有待解密的图片（可能都已载入，或模板没有图片条目）' })
            return
        }
        setLoadingItems(true)
        let ok = 0
        // 一批解密完再提交一次 state。
        // 以前每张图都 setItems 一次，而 `model` / `cost` 都依赖 items —— 也就是每张图都会重跑
        // 一遍 `buildPosterPages` + 整张 1080px 的 `renderPosterPages`：点一次"载入可见图片"
        // 就是 9 轮渲染（bench 的 longTasks == 0 门限就是被这个打穿的）。
        const loaded = new Map<string, string>()
        for (const target of targets) {
            const result = await loadItemImage(target)
            if (result.success && result.src) {
                ok += 1
                loaded.set(target.key, result.src)
            }
        }
        if (loaded.size > 0) {
            setItems((prev) =>
                prev.map((entry) => {
                    const src = loaded.get(entry.key)
                    return src ? { ...entry, imageSrc: src, imageUnavailable: false } : entry
                })
            )
        }
        setLoadingItems(false)
        setStatus({ kind: ok > 0 ? 'ok' : 'error', text: ok > 0 ? `已载入 ${ok}/${targets.length} 张图片` : '图片全部载入失败（通道未接入或解密失败）' })
    }, [items])

    const onDetectQr = useCallback(async () => {
        const images = items.filter((item) => item.visible && item.imageSrc)
        if (images.length === 0) {
            setQrNote('没有可检测的图片：先载入图片（朋友圈图片自带 data URL）。')
            return
        }
        let supported = false
        let hits = 0
        for (const item of images) {
            const result = await detectQrBoxes(item.imageSrc as string)
            if (!result.supported) {
                setQrNote(`本机没有条码识别能力（${result.error ?? 'BarcodeDetector 不可用'}）：二维码请用条目上的「遮挡」手动框选 —— 遮挡块会画进导出的图。`)
                return
            }
            supported = true
            for (const box of result.boxes) {
                hits += 1
                setItems((prev) => prev.map((entry) => (entry.key === item.key ? { ...entry, maskBox: { x: box.x, y: box.y, w: box.w, h: box.h } } : entry)))
            }
        }
        if (!supported) setQrNote('本机没有条码识别能力：二维码请手动框选遮挡。')
        else setQrNote(hits > 0 ? `检测到 ${hits} 个二维码并已遮挡。` : '没有检测到二维码。')
    }, [items])

    // ---- 导出 --------------------------------------------------------------
    const runExport = useCallback(
        async (mode: 'save' | 'clipboard') => {
            if (dragging) {
                setStatus({ kind: 'warn', text: '正在拖动排序：松手之后再导出（拖动中抓图会抓到半张）' })
                return
            }
            if (!debouncedItems.some((item) => item.visible)) {
                setStatus({ kind: 'warn', text: '目前没有可见内容：先载入消息，并至少保留一条可见条目。' })
                return
            }
            const host = previewRef.current?.exportHost()
            if (!host) {
                setStatus({ kind: 'error', text: '离屏导出容器没准备好（页面可能刚重挂载），请重试。' })
                return
            }
            setExporting(true)
            setStatus(null)
            setExportStage('准备图片…')
            try {
                // 跨源图片先 inline：weport-media:// 与 CDN 直接画进 canvas 会把它标脏，
                // toDataURL 抛 SecurityError（见 posterCapture 顶部注释）。
                const prepared = await inlineItemImages(debouncedItems)
                if (prepared.some((item) => item.imageUnavailable && item.kind === 'image')) {
                    setExportStage('部分图片没能内联，继续导出（会在图里标成占位块）…')
                }
                const result = await capturePoster({
                    host,
                    items: prepared,
                    options: debouncedOptions,
                    extras,
                    ctx: renderCtx,
                    scale: exportScale,
                    onStage: (stage, done, total) => {
                        if (stage === 'capture') setExportStage(`抓取第 ${done}/${total} 页…`)
                        else if (stage === 'relayout') setExportStage('按实测高度重新分页…')
                        else setExportStage('排版…')
                    },
                })
                if (result.pages.length === 0) {
                    setStatus({ kind: 'error', text: `导出失败：${result.failures[0]?.error ?? '没有可抓取的页面'}` })
                    return
                }

                if (mode === 'clipboard') {
                    const copied = await copyImageToClipboard(result.pages[0].dataUrl)
                    setStatus(
                        copied.success
                            ? { kind: 'ok', text: `已复制第 1 页到剪贴板（${result.pages[0].width}×${result.pages[0].height}，${formatBytes(result.pages[0].bytes)}）` }
                            : { kind: 'error', text: `复制失败：${copied.error ?? '当前环境不支持'}。请改用「导出 PNG」。` }
                    )
                    return
                }

                const fallback = !hasNativeSave()
                const saved: string[] = []
                const failures: string[] = []
                for (const page of result.pages) {
                    const outcome = await saveImage({ dataUrl: page.dataUrl, fileName: page.name })
                    if (outcome.success) saved.push(outcome.path ?? page.name)
                    else failures.push(`${page.name}：${outcome.error ?? '未知原因'}`)
                }
                const sizeText = result.pages.map((page) => `${page.width}×${page.height} ${formatBytes(page.bytes)}`).join('，')
                const costText = `实测 ${result.elapsedMs}ms${result.repaginated ? '（按实测高度重排过一次）' : ''}`
                // canvas 超限预警优先显示：它意味着"图可能被裁"，比一个漂亮的"已保存"重要
                const warningText = result.warnings.length > 0 ? `⚠ ${result.warnings.join(' ')} ` : ''
                if (failures.length > 0 && saved.length === 0) {
                    setStatus({ kind: 'error', text: `${warningText}保存失败：${failures.join('；')}` })
                } else if (fallback) {
                    setStatus({
                        kind: 'warn',
                        text: `${warningText}引擎保存通道未接入（poster:saveImage），已改用浏览器下载：${saved.length} 个文件进入下载目录，路径由浏览器决定（不是我们写的路径）。尺寸 ${sizeText}。`,
                    })
                } else {
                    setStatus({
                        kind: result.warnings.length > 0 ? 'warn' : 'ok',
                        text: `${warningText}已保存 ${saved.length} 张：${sizeText}；${costText}${failures.length > 0 ? `；${failures.length} 张失败` : ''}`,
                    })
                }
            } catch (e) {
                setStatus({ kind: 'error', text: `导出异常：${String(e)}` })
            } finally {
                setExporting(false)
                setExportStage('')
            }
        },
        [debouncedItems, debouncedOptions, dragging, exportScale, extras, renderCtx]
    )

    const saveTemplate = useCallback(() => {
        const name = templateName.trim()
        if (!name) return
        const template: SavedPosterTemplate = {
            id: `poster-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
            name: name.slice(0, 60),
            options: { ...options, redaction: { ...options.redaction, kinds: [...options.redaction.kinds] } },
            createdAt: Date.now(),
        }
        setSavedTemplates((current) => [template, ...current])
        setTemplateName('')
        setStatus({ kind: 'ok', text: `已保存模板「${template.name}」` })
    }, [options, templateName])

    const exportTemplates = useCallback(() => {
        if (savedTemplates.length === 0) {
            setStatus({ kind: 'warn', text: '还没有可导出的个人模板。' })
            return
        }
        const blob = new Blob([serializeSavedPosterTemplates(savedTemplates)], { type: 'application/json;charset=utf-8' })
        const url = URL.createObjectURL(blob)
        const anchor = document.createElement('a')
        anchor.href = url
        anchor.download = `weport-poster-templates-${new Date().toISOString().slice(0, 10)}.json`
        anchor.click()
        window.setTimeout(() => URL.revokeObjectURL(url), 1000)
        setStatus({ kind: 'ok', text: `已导出 ${savedTemplates.length} 个个人模板 JSON。` })
    }, [savedTemplates])

    const importTemplates = useCallback(async (file?: File) => {
        if (!file) return
        try {
            const imported = parseSavedPosterTemplates(JSON.parse(await file.text()))
            if (imported.length === 0) {
                setStatus({ kind: 'error', text: '文件中没有有效的 Weport 海报模板。' })
                return
            }
            setSavedTemplates((current) => {
                const byId = new Map(current.map((item) => [item.id, item]))
                for (const item of imported) {
                    const previous = byId.get(item.id)
                    if (previous && previous.name !== item.name) {
                        const id = `${item.id}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`
                        byId.set(id, { ...item, id })
                    } else {
                        byId.set(item.id, item)
                    }
                }
                return [...byId.values()]
            })
            setStatus({ kind: 'ok', text: `已导入 ${imported.length} 个个人模板。` })
        } catch (error) {
            setStatus({ kind: 'error', text: `模板文件无法读取：${String((error as Error)?.message || error)}` })
        } finally {
            if (importTemplateRef.current) importTemplateRef.current.value = ''
        }
    }, [])

    const summary = summarizeMatches(matches)
    const visibleItems = items.filter((item) => item.visible)
    const visibleImages = visibleItems.filter((item) => item.kind === 'image')
    const maskedImages = visibleImages.filter((item) => Boolean(item.maskBox)).length
    const pendingImages = visibleImages.filter((item) => item.imageUnavailable).length
    const loadedImages = visibleImages.filter((item) => Boolean(item.imageSrc)).length
    const exportDisabled = visibleItems.length === 0 || exporting || dragging
    const currentStepIndex = POSTER_WORKFLOW_STEPS.findIndex((step) => step.id === workflowStep)
    const nextStep = POSTER_WORKFLOW_STEPS[currentStepIndex + 1]
    const previousStep = POSTER_WORKFLOW_STEPS[currentStepIndex - 1]
    const stepSummary = {
        content: items.length > 0 ? `${visibleItems.length}/${items.length} 条可见` : '选择会话或写引用',
        style: activeTemplate.name,
        privacy: options.redaction.enabled ? `自动打码 · ${matches.length} 处命中` : '自动打码已关闭',
    }

    return (
        <div className="v09-page poster-root" style={{ '--pp-accent': options.accent, '--pp-accent-ink': contrastTextOn(options.accent) } as CSSProperties}>
            <div className="annual-head">
                <div>
                    <h2>
                        <Images size={18} />
                        分享海报工作室
                    </h2>
                    <p className="v09-sub">选内容 → 定样式 → 检查隐私 → 导出 PNG。预览与导出保持一致，自动打码默认开启。</p>
                </div>
                <div className="annual-actions">
                    <label className="poster-scale-control" title="导出像素倍率：3× 最清晰，文件也最大">
                        <span>PNG</span>
                        <select value={exportScale} disabled={exporting} onChange={(event) => setExportScale(Number(event.target.value) as 1 | 2 | 3)} aria-label="导出像素倍率">
                            <option value={1}>1×</option>
                            <option value={2}>2×</option>
                            <option value={3}>3×</option>
                        </select>
                    </label>
                    <button type="button" className="ghost-btn" disabled={exportDisabled} onClick={() => void runExport('clipboard')} title={dragging ? '拖动中不能抓图' : '复制第 1 页到剪贴板'}>
                        <ClipboardCopy size={14} />
                        复制到剪贴板
                    </button>
                    <button type="button" className="ghost-btn" disabled={exportDisabled} onClick={() => void runExport('save')} title={dragging ? '拖动中不能抓图' : `按 ${exportScale}× 倍率导出 PNG`}>
                        {exporting ? <Loader2 size={14} className="spin" /> : <Download size={14} />}
                        {exporting ? '导出中…' : `导出 PNG（${exportScale}×）`}
                    </button>
                </div>
            </div>

            {status ? (
                <div
                    className={status.kind === 'ok' ? 'poster-ok' : status.kind === 'warn' ? 'poster-warn' : 'poster-error'}
                    role={status.kind === 'error' ? 'alert' : 'status'}
                >
                    {status.text}
                </div>
            ) : null}

            <nav className="poster-workflow" aria-label="海报制作步骤">
                {POSTER_WORKFLOW_STEPS.map((step, index) => {
                    const StepIcon = step.icon
                    const active = workflowStep === step.id
                    const ready = step.id === 'content' ? items.length > 0 : step.id === 'privacy' ? options.redaction.enabled : true
                    return (
                        <button
                            key={step.id}
                            type="button"
                            className="poster-workflow-step"
                            data-step={step.id}
                            data-active={active}
                            data-ready={ready}
                            aria-current={active ? 'step' : undefined}
                            onClick={() => setWorkflowStep(step.id)}
                        >
                            <span className="poster-flow-icon"><StepIcon size={17} strokeWidth={2} aria-hidden="true" /></span>
                            <span className="poster-flow-copy">
                                <span className="poster-flow-kicker">第 {index + 1} 步</span>
                                <strong>{step.label}</strong>
                                <small>{step.id === 'content' ? stepSummary.content : step.id === 'style' ? stepSummary.style : stepSummary.privacy}</small>
                            </span>
                            {ready && !active ? <span className="poster-flow-ready" aria-label="已准备"><ShieldCheck size={13} /></span> : null}
                        </button>
                    )
                })}
            </nav>

            <div className="poster-grid">
                <section className="poster-workflow-column" aria-label="海报设置">
                    <div key={workflowStep} className="poster-step-scroll" data-step={workflowStep}>
                        {workflowStep === 'content' ? (
                            <>
                                <PosterSourcePanel
                                    source={source}
                                    onSourceChange={setSource}
                                    searchValue={sessionSearch}
                                    onSearchChange={setSessionSearch}
                                    sessions={sessions}
                                    sessionsLoading={sessionsLoading}
                                    sessionsError={sessionsError}
                                    channel={channel}
                                    activeSessionId={activeSession?.id ?? null}
                                    onSelectSession={setActiveSession}
                                    onReloadSessions={() => void reloadSessions()}
                                    filters={filters}
                                    onFilterChange={(patch) => setFilters((prev) => ({ ...prev, ...patch }))}
                                    onLoadSession={() => void onLoadSession()}
                                    loadingItems={loadingItems}
                                    snsUsername={snsUsername}
                                    onSnsUsernameChange={setSnsUsername}
                                    snsKeyword={snsKeyword}
                                    onSnsKeywordChange={setSnsKeyword}
                                    onLoadSns={() => void onLoadSns()}
                                    manualText={manualText}
                                    onManualTextChange={setManualText}
                                    manualSender={manualSender}
                                    onManualSenderChange={setManualSender}
                                    onAddManualQuote={onAddManualQuote}
                                    itemCount={items.length}
                                />

                                <section className="poster-items-panel v09-panel" id="poster-content-items" aria-label="海报条目">
                                    <div className="poster-items-panel-heading">
                                        <div>
                                            <h3>整理条目</h3>
                                            <span className="v09-sub">选择显示内容，可排序，也可为图片裁剪或手动遮挡</span>
                                        </div>
                                        <span className="poster-item-count">{visibleItems.length}/{items.length}</span>
                                    </div>
                                    <PosterItemEditor
                                        items={items}
                                        onReorder={(from, to) => setItems((prev) => applyReorder(prev, from, to))}
                                        onToggleVisible={(key, visible) => setItems((prev) => applyVisibility(prev, key, visible))}
                                        onSetAllVisible={(visible) => setItems((prev) => applyVisibilityAll(prev, visible))}
                                        onIsolate={(keys) => setItems((prev) => isolateKeys(prev, keys))}
                                        onCrop={(key, crop) => setItems((prev) => applyCrop(prev, key, crop))}
                                        onMaskBox={(key, box) => setItems((prev) => applyMaskBox(prev, key, box))}
                                        onLoadImage={(key) => void onLoadImage(key)}
                                        reorderEnabled={templateSupportsReorder(options.template)}
                                        cropEnabled={templateSupportsCrop(options.template)}
                                        onDragStateChange={setDragging}
                                        busyKey={imageBusyKey}
                                    />
                                </section>
                            </>
                        ) : null}

                        {workflowStep === 'style' ? (
                            <section className="poster-step-card v09-panel" aria-label="样式与排版">
                                <div className="poster-step-card-heading" data-step="style">
                                    <span className="poster-step-card-icon"><Palette size={17} aria-hidden="true" /></span>
                                    <div>
                                        <span className="poster-step-card-kicker">第 2 步</span>
                                        <h3>设计画面</h3>
                                        <p>先选内容结构，再调整颜色、字号和标题。</p>
                                    </div>
                                </div>

                                <PosterTemplatePicker options={options} onApply={(id) => setOptions((prev) => applyTemplate(prev, id))} />
                                <div className="poster-template-current">
                                    <span className="poster-template-current-dot" />
                                    <span>当前：<strong>{activeTemplate.name}</strong> · {activeTemplate.hint}</span>
                                </div>

                                <div className="poster-step-section">
                                    <div className="poster-step-section-heading">
                                        <strong>我的模板</strong>
                                        <span>将常用配色与排版保存在本机</span>
                                    </div>
                                    <div className="poster-saved-template-add">
                                        <input
                                            className="pp-input"
                                            value={templateName}
                                            maxLength={60}
                                            placeholder="模板名称"
                                            aria-label="个人模板名称"
                                            onChange={(event) => setTemplateName(event.target.value)}
                                            onKeyDown={(event) => { if (event.key === 'Enter') saveTemplate() }}
                                        />
                                        <button type="button" className="poster-mini-btn" disabled={!templateName.trim()} onClick={saveTemplate}>
                                            <Save size={11} />保存
                                        </button>
                                    </div>
                                    <div className="poster-saved-template-actions">
                                        <button type="button" className="poster-mini-btn" onClick={() => importTemplateRef.current?.click()}>
                                            <FileInput size={11} />导入 JSON
                                        </button>
                                        <button type="button" className="poster-mini-btn" onClick={exportTemplates}>
                                            <FileOutput size={11} />导出 JSON
                                        </button>
                                        <input
                                            ref={importTemplateRef}
                                            type="file"
                                            accept="application/json,.json"
                                            hidden
                                            onChange={(event) => void importTemplates(event.target.files?.[0])}
                                        />
                                    </div>
                                    {savedTemplates.length > 0 ? (
                                        <ul className="poster-saved-template-list">
                                            {savedTemplates.map((template) => (
                                                <li key={template.id}>
                                                    <button
                                                        type="button"
                                                        className="poster-saved-template-apply"
                                                        title={`应用「${template.name}」的布局、配色与排版（保留当前打码设置）`}
                                                        onClick={() => {
                                                            setOptions((current) => ({ ...template.options, redaction: current.redaction }))
                                                            setStatus({ kind: 'ok', text: `已应用模板「${template.name}」，并保留当前打码设置。` })
                                                        }}
                                                    >
                                                        <span>{template.name}</span>
                                                        <small>{getTemplate(template.options.template).name}</small>
                                                    </button>
                                                    <button type="button" className="poster-mini-btn" aria-label={`删除模板 ${template.name}`} title="删除模板" onClick={() => setSavedTemplates((current) => current.filter((item) => item.id !== template.id))}>
                                                        <Trash2 size={11} />
                                                    </button>
                                                </li>
                                            ))}
                                        </ul>
                                    ) : <span className="poster-redaction-note">保存常用配色、排版和页面设置；重启后仍可使用。</span>}
                                </div>

                                <div className="poster-step-section poster-style-options">
                                    <div className="poster-step-section-heading">
                                        <strong>画面细节</strong>
                                        <span>改动会同步反映在右侧预览</span>
                                    </div>
                                    <PosterStylePanel options={options} onChange={patchOptions} showAvatarToggle={true} />
                                </div>

                                <details className="poster-advanced-filters poster-advanced-layout">
                                    <summary>高级分页设置 · 当前 {options.pageMaxHeight / 1000}k px</summary>
                                    <div className="poster-field">
                                        <span className="poster-field-label">单页高度上限</span>
                                        <div className="poster-kind-chips">
                                            {[8000, 12000, 16000].map((height) => (
                                                <button
                                                    key={height}
                                                    type="button"
                                                    className="poster-kind-chip"
                                                    data-on={options.pageMaxHeight === height}
                                                    aria-pressed={options.pageMaxHeight === height}
                                                    onClick={() => patchOptions({ pageMaxHeight: height })}
                                                >
                                                    {height / 1000}k px
                                                </button>
                                            ))}
                                        </div>
                                        <span className="poster-redaction-note">用于避免单张画布过高导致图片被裁。调小上限会增加页数和导出耗时。</span>
                                    </div>
                                </details>
                            </section>
                        ) : null}

                        {workflowStep === 'privacy' ? (
                            <section className="poster-step-card v09-panel" aria-label="隐私检查与导出">
                                <div className="poster-step-card-heading" data-step="privacy">
                                    <span className="poster-step-card-icon">
                                        {options.redaction.enabled ? <ShieldCheck size={17} aria-hidden="true" /> : <ShieldOff size={17} aria-hidden="true" />}
                                    </span>
                                    <div>
                                        <span className="poster-step-card-kicker">第 3 步</span>
                                        <h3>检查隐私</h3>
                                        <p>文字打码会直接写入预览和导出图；图片内容需要单独检查。</p>
                                    </div>
                                </div>

                                <div className="poster-step-section">
                                    <div className="poster-step-section-heading">
                                        <strong>文字保护</strong>
                                        <span>{options.redaction.enabled ? `${maskedCount} 处已在预览遮挡` : '请确认敏感信息是否可见'}</span>
                                    </div>
                                    <PosterRedactionPanel
                                        options={options}
                                        onChange={(patch) => setOptions((prev) => ({ ...prev, redaction: { ...prev.redaction, ...patch } }))}
                                        matches={matches}
                                        confirmRequired={!redactionConfirmSeen}
                                        onConfirmDisable={() => setRedactionConfirmSeen(true)}
                                    />
                                </div>

                                <div className="poster-step-section poster-image-privacy">
                                    <div className="poster-step-section-heading">
                                        <strong>图片保护</strong>
                                        <span>{visibleImages.length > 0 ? `${maskedImages}/${visibleImages.length} 张已手动遮挡` : '当前没有可见图片'}</span>
                                    </div>
                                    <p className="poster-redaction-note">自动打码只识别文字。二维码、头像和图片中的姓名或号码，请在「内容」步骤的条目上用方框工具手动遮挡。</p>
                                    <div className="poster-privacy-actions">
                                        <button type="button" className="poster-mini-btn" onClick={() => setWorkflowStep('content')}>
                                            <Images size={12} />编辑图片遮挡
                                        </button>
                                        <button type="button" className="poster-mini-btn" onClick={() => void onLoadVisibleImages()} disabled={loadingItems || pendingImages === 0}>
                                            {loadingItems ? <Loader2 size={12} className="spin" /> : <Camera size={12} />}
                                            {pendingImages > 0 ? `载入图片（${Math.min(pendingImages, 9)} 张）` : '图片已载入'}
                                        </button>
                                        <button type="button" className="poster-mini-btn" onClick={() => void onDetectQr()} disabled={loadedImages === 0}>
                                            <QrCode size={12} />检测二维码
                                        </button>
                                    </div>
                                    {qrNote ? <div className="poster-redaction-note" role="status">{qrNote}</div> : null}
                                </div>

                                <div className="poster-final-check" data-safe={options.redaction.enabled}>
                                    {options.redaction.enabled ? <ShieldCheck size={15} /> : <AlertTriangle size={15} />}
                                    <div>
                                        <strong>{options.redaction.enabled ? '自动打码已开启' : '自动打码已关闭'}</strong>
                                        <span>{options.redaction.enabled ? `${summary.map((item) => `${item.label} ${item.count}`).join(' · ') || '当前内容未命中已选规则'}。导出倍率 ${exportScale}×。` : '手机号、微信 ID、证件号与昵称可能以原文出现在图片中。'}</span>
                                    </div>
                                </div>

                                <div className="poster-mask-strip" data-enabled={!cost.over2s}>
                                    {cost.over2s ? <AlertTriangle size={13} /> : <ShieldCheck size={13} />}
                                    预计 {cost.pages} 页 · {cost.blocks} 块 · {cost.megapixels} Mpx · 约 {cost.estMs}ms
                                    {cost.over2s ? '（较长的导出可减少条目数）' : ''}
                                </div>

                                <div className="poster-redaction-note poster-final-note">
                                    {items.length === 0
                                        ? '还没有内容。返回第 1 步载入会话、朋友圈动态或手写引用。'
                                        : `画布宽 ${POSTER_WIDTH}px · ${pages.length} 页 · 当前预览已遮挡 ${maskedCount} 处。`}
                                </div>
                            </section>
                        ) : null}
                    </div>

                    <div className="poster-step-footer">
                        <button type="button" className="poster-step-back" onClick={() => previousStep && setWorkflowStep(previousStep.id)} disabled={!previousStep}>
                            <ArrowLeft size={14} />上一步
                        </button>
                        <span className="poster-step-footer-count">{currentStepIndex + 1} / {POSTER_WORKFLOW_STEPS.length}</span>
                        {nextStep ? (
                            <button
                                type="button"
                                className="poster-step-next"
                                disabled={workflowStep === 'content' && visibleItems.length === 0}
                                onClick={() => setWorkflowStep(nextStep.id)}
                            >
                                {workflowStep === 'content' ? '继续：选择样式' : '继续：检查隐私'}
                                <ArrowRight size={14} />
                            </button>
                        ) : (
                            <button type="button" className="poster-step-next poster-step-export" disabled={exportDisabled} onClick={() => void runExport('save')}>
                                {exporting ? <Loader2 size={14} className="spin" /> : <Download size={14} />}
                                {exporting ? '导出中…' : `导出 PNG（${exportScale}×）`}
                            </button>
                        )}
                    </div>
                </section>

                <div className="poster-preview-pane">
                    <PosterPreview
                        ref={previewRef}
                        pages={pages}
                        options={debouncedOptions}
                        ctx={renderCtx}
                        zoom={options.zoom}
                        onZoomChange={(zoom) => patchOptions({ zoom })}
                        onMasked={setMaskedCount}
                        totalHeight={previewHeight}
                        busy={exporting}
                        busyText={exportStage || '导出中，请勿切页（抓取在当前页面内进行）'}
                        onStartContent={() => setWorkflowStep('content')}
                    />
                </div>
            </div>
        </div>
    )
}

/**
 * 防抖：只有当**列出的字段**变化时才延迟生效，其它改动（换模板、切显隐）立刻生效。
 *
 * 这样"拖字号滑块 / 打字"不会每个输入事件都触发一次 1080px 整页重排，而"点一下变了
 * 什么"仍然即时可见。选择器只认这几个字段，是因为它们才是逐字符/逐像素变化的。
 */
function useDebounced<T extends object>(value: T, delay: number, keys: Array<keyof T>): T {
    const [debounced, setDebounced] = useState(value)
    const valueRef = useRef(value)
    valueRef.current = value
    const signature = keys.map((key) => JSON.stringify(value[key] ?? null)).join('|')
    const lastSignature = useRef(signature)
    /** 上一次**已经提交给预览**的值：用它判"这一轮到底有没有变化"。 */
    const flushed = useRef(value)

    useEffect(() => {
        // 没有真实变化就直接返回。少了这一步会成死循环：effect 里 setState →
        // 重渲染 → 新对象引用 → effect 再跑 → 再 setState……
        if (value === flushed.current) return
        if (lastSignature.current === signature) {
            // 非防抖字段：立刻同步（换模板、切显隐这类要即时反馈）
            flushed.current = value
            setDebounced(value)
            return
        }
        const timer = window.setTimeout(() => {
            lastSignature.current = signature
            flushed.current = valueRef.current
            setDebounced(valueRef.current)
        }, delay)
        return () => window.clearTimeout(timer)
    }, [signature, delay, value])

    return debounced
}
