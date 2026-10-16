import { useEffect, useState } from 'react'
import { Bug, ClipboardCopy, ExternalLink, ImagePlus, Trash2 } from 'lucide-react'
import './BugReportPanel.scss'

interface ReportImage {
  id: string
  name: string
  sizeBytes: number
  previewDataUrl: string
}

interface Draft {
  title: string
  body: string
}

const DRAFT_KEY = 'weport:bug-report-draft:v1'
const MAX_IMAGES = 5

function readDraft(): Draft {
  try {
    const parsed = JSON.parse(localStorage.getItem(DRAFT_KEY) || 'null') as Partial<Draft> | null
    return {
      title: typeof parsed?.title === 'string' ? parsed.title.slice(0, 120) : '',
      body: typeof parsed?.body === 'string' ? parsed.body.slice(0, 3000) : '',
    }
  } catch {
    return { title: '', body: '' }
  }
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export default function BugReportPanel() {
  const [draft, setDraft] = useState<Draft>(readDraft)
  const [includeEnvironment, setIncludeEnvironment] = useState(false)
  const [images, setImages] = useState<ReportImage[]>([])
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState('')
  const [error, setError] = useState('')
  const [copiedImageId, setCopiedImageId] = useState('')

  useEffect(() => {
    try {
      localStorage.setItem(DRAFT_KEY, JSON.stringify(draft))
    } catch {
      // A blocked or full localStorage must not prevent the issue editor from working.
    }
  }, [draft])

  useEffect(() => () => {
    // Image tokens point only to files selected in the native picker. Release them when
    // this temporary attachment list leaves the Settings view.
    void window.electronAPI.bugReport?.clearImages()
  }, [])

  async function chooseImages(): Promise<void> {
    const reportApi = window.electronAPI.bugReport
    if (!reportApi) {
      setError('当前运行版本没有提供截图选择接口。')
      return
    }
    setBusy(true)
    setError('')
    setStatus('')
    try {
      const result = await reportApi.chooseImages()
      const nextImages = result.images || []
      if (nextImages.length > 0) setImages((current) => [...current, ...nextImages].slice(0, MAX_IMAGES))
      if (result.errors?.length) setError(result.errors.join('；'))
      else if (!result.canceled && nextImages.length > 0) setStatus(`已添加 ${nextImages.length} 张图片。`)
      else if (!result.canceled && nextImages.length === 0 && result.error) setError(result.error)
    } catch (cause) {
      setError(`选择图片失败：${String((cause as Error)?.message || cause)}`)
    } finally {
      setBusy(false)
    }
  }

  async function removeImage(image: ReportImage): Promise<void> {
    try {
      await window.electronAPI.bugReport?.removeImage(image.id)
    } finally {
      setImages((current) => current.filter((item) => item.id !== image.id))
      setCopiedImageId((current) => current === image.id ? '' : current)
    }
  }

  async function copyImage(image: ReportImage): Promise<void> {
    const reportApi = window.electronAPI.bugReport
    if (!reportApi) {
      setError('当前运行版本没有提供图片剪贴板接口。')
      return
    }
    setError('')
    setStatus('')
    try {
      const result = await reportApi.copyImage(image.id)
      if (!result.success) {
        setError(result.error || '复制图片失败。')
        return
      }
      setCopiedImageId(image.id)
      setStatus(`已复制“${image.name}”。打开 GitHub 编辑器后粘贴图片即可上传。`)
    } catch (cause) {
      setError(`复制图片失败：${String((cause as Error)?.message || cause)}`)
    }
  }

  async function openIssue(): Promise<void> {
    const title = draft.title.trim()
    const body = draft.body.trim()
    if (!title || !body) {
      setError('请先填写标题和问题详情。')
      return
    }
    const reportApi = window.electronAPI.bugReport
    if (!reportApi) {
      setError('当前运行版本没有提供 GitHub 问题编辑器接口。')
      return
    }
    setBusy(true)
    setError('')
    setStatus('')
    try {
      const result = await reportApi.openIssue({ title, body, includeEnvironment })
      if (!result.success) {
        setError(result.error || '无法打开 GitHub 新建问题页面。')
        return
      }
      setStatus(result.bodyNeedsPaste
        ? '正文较长，已打开带标题的 GitHub 编辑器。请点击“复制正文”，粘贴完整说明，再逐张上传图片并提交。'
        : '已打开 GitHub 官方新建问题编辑器。请检查内容、逐张粘贴要上传的图片，再自行提交。')
    } catch (cause) {
      setError(`打开 GitHub 失败：${String((cause as Error)?.message || cause)}`)
    } finally {
      setBusy(false)
    }
  }

  async function clearDraft(): Promise<void> {
    setDraft({ title: '', body: '' })
    setIncludeEnvironment(false)
    setError('')
    setStatus('草稿已清空。')
    await window.electronAPI.bugReport?.clearImages()
    setImages([])
    setCopiedImageId('')
  }

  async function copyDraftBody(): Promise<void> {
    setError('')
    try {
      const result = await window.electronAPI.bugReport.copyDraftText({ body: draft.body, includeEnvironment })
      if (!result.success) { setError(result.error || '无法复制正文。'); return }
      setCopiedImageId('')
      setStatus('已复制完整正文。请粘贴到 GitHub 编辑器，再逐张复制并粘贴图片。')
    } catch {
      setError('无法复制正文，请稍后重试。')
    }
  }

  return (
    <section className="panel bug-report-panel" aria-labelledby="bug-report-title">
      <div className="panel-head">
        <h2 id="bug-report-title"><Bug size={15} />问题反馈</h2>
        <span>本机草稿 · GitHub 手动提交</span>
      </div>

      <div className="bug-report-content">
        <p className="bug-report-intro">
          标题和正文先保存在本机。打开 GitHub 后请自行检查并提交；Weport 不会代你发送报告。
        </p>

        <label className="bug-report-field" htmlFor="bug-report-title-input">
          <span>标题</span>
          <input
            id="bug-report-title-input"
            type="text"
            maxLength={120}
            value={draft.title}
            placeholder="简要描述遇到的问题"
            onChange={(event) => setDraft((current) => ({ ...current, title: event.target.value }))}
          />
        </label>

        <label className="bug-report-field" htmlFor="bug-report-body-input">
          <span>问题详情</span>
          <textarea
            id="bug-report-body-input"
            rows={6}
            maxLength={3000}
            value={draft.body}
            placeholder={'请描述发生了什么、你执行了哪些步骤，以及预期结果。\n\n不要粘贴密钥、聊天记录或个人资料。'}
            onChange={(event) => setDraft((current) => ({ ...current, body: event.target.value }))}
          />
          <small>{draft.body.length} / 3000</small>
        </label>

        <div className="bug-report-attachments">
          <div className="bug-report-attachments-head">
            <div>
              <strong>截图附件</strong>
              <span>最多 5 张，每张不超过 10 MB。只包含你手动选择的图片。</span>
            </div>
            <button type="button" className="ghost-btn compact" onClick={() => void chooseImages()} disabled={busy || images.length >= MAX_IMAGES}>
              <ImagePlus size={14} />选择图片
            </button>
          </div>

          {images.length > 0 ? (
            <ul className="bug-report-image-list">
              {images.map((image) => (
                <li className="bug-report-image" key={image.id}>
                  <img src={image.previewDataUrl} alt={`你选择的截图：${image.name}`} />
                  <span className="bug-report-image-name" title={image.name}>{image.name}</span>
                  <small>{formatFileSize(image.sizeBytes)}</small>
                  <button type="button" className="ghost-btn compact" onClick={() => void copyImage(image)} disabled={busy}>
                    <ClipboardCopy size={13} />{copiedImageId === image.id ? '已复制' : '复制图片'}
                  </button>
                  <button type="button" className="bug-report-remove" aria-label={`移除图片 ${image.name}`} title="移除图片" onClick={() => void removeImage(image)}>
                    <Trash2 size={14} />
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="bug-report-empty">尚未选择图片。不会自动捕获屏幕或添加应用数据。</p>
          )}
          <p className="bug-report-upload-note">
            图片尚未上传。打开 GitHub 编辑器后，点击每张图片旁的“复制图片”，再粘贴到正文；GitHub 会在你提交前完成上传。
          </p>
        </div>

        <label className="bug-report-environment">
          <input type="checkbox" checked={includeEnvironment} onChange={(event) => setIncludeEnvironment(event.target.checked)} />
          <span>附加版本和系统平台信息（不含用户名、路径、日志或截图）</span>
        </label>

        {error ? <p className="bug-report-message" data-kind="error" role="alert">{error}</p> : null}
        {status ? <p className="bug-report-message" role="status">{status}</p> : null}

        <div className="bug-report-actions">
          <button type="button" className="ghost-btn compact" onClick={() => void copyDraftBody()} disabled={busy || !draft.body.trim()}>
            <ClipboardCopy size={13} />复制正文
          </button>
          <button type="button" className="ghost-btn compact" onClick={() => void clearDraft()} disabled={busy}>
            <Trash2 size={13} />清空草稿
          </button>
          <button type="button" className="primary-btn" onClick={() => void openIssue()} disabled={busy || !draft.title.trim() || !draft.body.trim()}>
            <ExternalLink size={14} />{busy ? '正在打开…' : '打开 GitHub 新建问题'}
          </button>
        </div>
      </div>
    </section>
  )
}
