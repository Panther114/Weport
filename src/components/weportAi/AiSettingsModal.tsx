import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  CheckCircle2,
  ChevronDown,
  Eye,
  FilePenLine,
  FileText,
  FolderOpen,
  Info,
  KeyRound,
  Loader2,
  MemoryStick,
  MessageSquareText,
  Pencil,
  Plus,
  RefreshCw,
  Settings2,
  Sparkles,
  Trash2,
  XCircle,
  Zap,
} from 'lucide-react'
import type { AiAction, ProviderCatalogEntry, ProviderModelMetadata, ProviderProfileSummary, ProviderProtocol, SetupInfo } from './aiPanelTypes'
/**
 * 这份样式**必须由本组件自己引入**。
 *
 * 它原来只被 `WeportAiPanel.tsx` 引入，而两个组件都是 `React.lazy` 的独立 chunk：
 * 用户从「设置 → AI 服务」直接进来（没先进过 WeportAI 页）时，`providerProfiles.css`
 * 根本没被加载 —— `.ai-profile-layout` 的栅格、`.ai-add-*` 弹层、表单行全部失效，
 * 面板塌成一堆没排版的输入框，弹窗掉到页面最下面（实测：`position:fixed` 缺失时
 * 一个 780×906 的 dialog 落在 y=650 处，正好在视口之外）。用户报的「AI 提供商 UI 坏掉」
 * 就是这个。谁用这些类名，谁就负责把它拉进来（重复 import 由打包器去重）。
 */
import './providerProfiles.css'

export const TOOL_LABELS: Array<[string, string]> = [
  ['list_sessions', '会话列表'],
  ['get_social_overview', '社交活动概览'],
  ['get_relationship_candidates', '关系候选多维筛选'],
  ['sample_session_history', '早中近期分层抽样'],
  ['review_prior_analyses', '回顾既往分析'],
  ['get_group_members', '群成员名单'],
  ['read_session_messages', '读取会话消息'],
  ['read_day_events', '单日跨会话时间线'],
  ['read_period_events', '区间跨会话时间线'],
  ['search_messages', '全文搜索'],
  ['get_session_stats', '会话统计'],
  ['list_dates', '活跃日历'],
  ['get_contact_info', '联系人资料'],
  ['get_self_overview', '分析范围概览'],
  ['list_notes', '记忆/笔记列表'],
  ['read_note', '读取记忆/笔记'],
  ['write_note', '写入记忆/笔记'],
]


export default function AiSettingsModal({
  setup,
  inline = false,
  onClose,
  onChanged,
  onSaved,
}: {
  setup: SetupInfo
  /** 设置页内联渲染（无遮罩、无「取消」按钮）。 */
  inline?: boolean
  onClose?: () => void
  onChanged?: (next: SetupInfo) => void
  onSaved: (next: SetupInfo) => void
}) {
  const api = window.electronAPI
  const [profiles, setProfiles] = useState(setup.profiles || [])
  const [catalog, setCatalog] = useState(setup.catalog || [])
  const [activeProfileId, setActiveProfileId] = useState(setup.activeProfileId || '')
  const [editingId, setEditingId] = useState<string | null>(setup.activeProfileId || setup.profiles?.[0]?.id || null)
  const initial = setup.profiles?.find((p) => p.id === (setup.activeProfileId || setup.profiles?.[0]?.id))
  const [draft, setDraft] = useState({
    name: initial?.name || '新 AI 服务',
    providerId: initial?.providerId || 'deepseek',
    protocol: initial?.protocol || 'openai-compatible' as ProviderProtocol,
    baseUrl: initial?.baseUrl || '',
    model: initial?.model || '',
    apiKey: '',
  })
  const [customPrompt, setCustomPrompt] = useState(setup.customPrompt)
  const [workspaceRoot, setWorkspaceRoot] = useState(setup.workspaceRoot)
  const [effort, setEffort] = useState(setup.reasoningEffort)
  const [disabledTools, setDisabledTools] = useState<Set<string>>(new Set(setup.disabledTools))
  const [actions, setActions] = useState<AiAction[]>([])
  const [saving, setSaving] = useState(false)
  const [clearingMemory, setClearingMemory] = useState(false)
  const [error, setError] = useState('')
  const [discovering, setDiscovering] = useState<string | null>(null)
  const [fetchingModels, setFetchingModels] = useState(false)
  const [fetchedModels, setFetchedModels] = useState<string[]>(initial?.discovery?.models || [])
  const [modelDiscoveryDone, setModelDiscoveryDone] = useState(Boolean(initial?.discovery?.fetchedAt))
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)
  const [addOpen, setAddOpen] = useState(false)
  const [addDraft, setAddDraft] = useState(() => {
    const entry = (setup.catalog || []).find((item) => item.id === 'deepseek') || (setup.catalog || [])[0]
    return {
      name: entry?.name || '新 AI 服务',
      providerId: entry?.id || 'deepseek',
      protocol: (entry?.protocol || 'openai-compatible') as ProviderProtocol,
      baseUrl: entry?.baseUrl || '',
      model: entry?.defaultModel || '',
      apiKey: '',
    }
  })
  const [addFetchedModels, setAddFetchedModels] = useState<string[]>([])
  const [addFetching, setAddFetching] = useState(false)
  const [addDiscoveryDone, setAddDiscoveryDone] = useState(false)
  const [addError, setAddError] = useState('')
  const [addSaving, setAddSaving] = useState(false)

  const selectedCatalog = catalog.find((entry) => entry.id === draft.providerId)
  const selectedModels = Array.from(new Set([
    ...fetchedModels,
    ...(selectedCatalog?.models || []),
    ...(editingId ? profiles.find((p) => p.id === editingId)?.discovery?.models || [] : []),
    ...(draft.model ? [draft.model] : []),
  ]))

  /**
   * 给模型下拉项补上单价后缀。
   *
   * 选模型是**唯一**该看价格的时刻 —— 选完之后价格只影响账单。主进程已经把
   * registry 里的定价解好（`setup.modelCosts`），这里只负责呈现。没有收录的
   * 模型明确写「未定价」：一片空白会让人以为是免费的。
   */
  const modelOptionLabel = (model: string): string => {
    const cost = setup?.modelCosts?.[model]
    if (!cost || (cost.input === undefined && cost.output === undefined)) return `${model} · 未定价`
    const one = (v: number | undefined) => (v === undefined ? '—' : `$${v}`)
    return `${model} · ${one(cost.input)}/${one(cost.output)} 每百万`
  }

  useEffect(() => {
    void api.ai.listActions().then((r) => setActions(r.actions || [])).catch(() => undefined)
  }, [api])

  function startEdit(profile: ProviderProfileSummary) {
    setEditingId(profile.id)
    setDraft({ name: profile.name, providerId: profile.providerId, protocol: profile.protocol, baseUrl: profile.baseUrl, model: profile.model, apiKey: '' })
    setFetchedModels(profile.discovery?.models || [])
    setModelDiscoveryDone(Boolean(profile.discovery?.fetchedAt))
    setError('')
  }

  function openAddDialog() {
    const entry = catalog.find((item) => item.id === 'deepseek') || catalog[0]
    setAddDraft({
      name: entry?.name ? `${entry.name} · 新配置` : '新 AI 服务',
      providerId: entry?.id || 'deepseek',
      protocol: (entry?.protocol || 'openai-compatible') as ProviderProtocol,
      baseUrl: entry?.baseUrl || '',
      model: entry?.defaultModel || '',
      apiKey: '',
    })
    setAddFetchedModels([])
    setAddDiscoveryDone(false)
    setAddError('')
    setAddOpen(true)
  }

  function startAdd() {
    openAddDialog()
  }

  function selectProvider(providerId: string) {
    const entry = catalog.find((item) => item.id === providerId)
    if (!entry) return
    setFetchedModels([])
    setModelDiscoveryDone(false)
    setDraft((prev) => ({
      ...prev,
      providerId,
      protocol: entry.protocolOptions?.includes(prev.protocol) ? prev.protocol : entry.protocol,
      baseUrl: entry.baseUrl || (entry.allowCustomBaseUrl ? '' : prev.baseUrl),
      model: entry.defaultModel || prev.model,
      name: prev.name === '新 AI 服务' || prev.name === selectedCatalog?.name ? entry.name : prev.name,
    }))
  }

  function selectAddProvider(providerId: string) {
    const entry = catalog.find((item) => item.id === providerId)
    if (!entry) return
    setAddFetchedModels([])
    setAddDiscoveryDone(false)
    setAddError('')
    setAddDraft((prev) => ({
      ...prev,
      providerId,
      protocol: entry.protocolOptions?.includes(prev.protocol) ? prev.protocol : entry.protocol,
      baseUrl: entry.baseUrl || (entry.allowCustomBaseUrl ? '' : prev.baseUrl),
      model: entry.defaultModel || prev.model,
      name: prev.name === '新 AI 服务' || prev.name.startsWith(catalog.find((c) => c.id === prev.providerId)?.name || '') ? (entry.name ? `${entry.name} · 新配置` : prev.name) : prev.name,
    }))
  }

  async function fetchAddModels() {
    setAddFetching(true)
    setAddError('')
    try {
      const result = await api.ai.fetchModels({
        providerId: addDraft.providerId,
        protocol: addDraft.protocol,
        baseUrl: addDraft.baseUrl.trim() || undefined,
        apiKey: addDraft.apiKey.trim() || undefined,
      })
      if (!result.success || !result.models?.length) {
        setAddFetchedModels([])
        setAddDiscoveryDone(false)
        setAddError(result.error || '未获取到可用模型')
        return
      }
      const models = Array.from(new Set(result.models.map(String).filter(Boolean)))
      setAddFetchedModels(models)
      setAddDiscoveryDone(true)
      setAddDraft((prev) => ({ ...prev, model: models.includes(prev.model) ? prev.model : models[0] || '' }))
    } catch (e) {
      setAddError(String(e))
    } finally {
      setAddFetching(false)
    }
  }

  async function saveAddProfile() {
    setAddSaving(true)
    setAddError('')
    try {
      if (!addDraft.name.trim()) {
        setAddError('请填写配置名称')
        return
      }
      const catalogEntry = catalog.find((c) => c.id === addDraft.providerId)
      const needsKey = catalogEntry ? catalogEntry.apiKeyOptional !== true : true
      if (needsKey && !addDraft.apiKey.trim()) {
        setAddError('请填写 API key（本地服务除外）')
        return
      }
      if (!addDraft.model.trim()) {
        setAddError('请选择模型（先获取模型列表）')
        return
      }
      if (!addDiscoveryDone) {
        setAddError('请先验证并获取模型列表')
        return
      }
      if (addDiscoveryDone && addFetchedModels.length > 0 && !addFetchedModels.includes(addDraft.model.trim())) {
        setAddError('请选择已获取的模型')
        return
      }
      const result = await api.ai.saveProfile({
        name: addDraft.name.trim(),
        providerId: addDraft.providerId,
        protocol: addDraft.protocol,
        baseUrl: addDraft.baseUrl.trim(),
        model: addDraft.model.trim(),
        apiKey: addDraft.apiKey.trim() || undefined,
      })
      if (!result.success) {
        setAddError(result.error || '添加提供商失败')
        return
      }
      const next = await refreshSetup()
      if (result.profile) {
        setEditingId(result.profile.id)
        setDraft({
          name: result.profile.name,
          providerId: result.profile.providerId,
          protocol: result.profile.protocol,
          baseUrl: result.profile.baseUrl,
          model: result.profile.model,
          apiKey: '',
        })
        setFetchedModels(result.profile.discovery?.models || [])
        setModelDiscoveryDone(Boolean(result.profile.discovery?.fetchedAt))
      }
      // 使新配置立即成为当前生效项
      if (result.profile?.id) {
        try { await api.ai.activateProfile(result.profile.id); await refreshSetup() } catch { /* noop */ }
      }
      setAddOpen(false)
      if (next.baseUrlError) setError(next.baseUrlError)
    } catch (e) {
      setAddError(String(e))
    } finally {
      setAddSaving(false)
    }
  }

  async function refreshSetup() {
    const next = (await api.ai.getSetup()) as unknown as SetupInfo
    setProfiles(next.profiles || [])
    setCatalog(next.catalog || catalog)
    setActiveProfileId(next.activeProfileId || '')
    if (next.baseUrlError) setError(next.baseUrlError)
    onChanged?.(next)
    return next
  }

  async function saveProfile(): Promise<boolean> {
    setSaving(true)
    setError('')
    try {
      if (!draft.model.trim()) {
        setError('请选择模型')
        return false
      }
      if (!editingId && !modelDiscoveryDone) {
        setError('请先获取模型列表，再保存新的服务配置')
        return false
      }
      if (modelDiscoveryDone && fetchedModels.length > 0 && !fetchedModels.includes(draft.model.trim())) {
        setError('请选择已获取的模型')
        return false
      }
      const result = await api.ai.saveProfile({
        id: editingId || undefined,
        name: draft.name.trim(),
        providerId: draft.providerId,
        protocol: draft.protocol,
        baseUrl: draft.baseUrl.trim(),
        model: draft.model.trim(),
        apiKey: draft.apiKey.trim() || undefined,
      })
      if (!result.success) {
        setError(result.error || '保存服务配置失败')
        return false
      }
      const next = await refreshSetup()
      if (result.profile) {
        setEditingId(result.profile.id)
      }
      if (next.baseUrlError) {
        setError(next.baseUrlError)
        return false
      }
      return true
    } catch (e) {
      setError(String(e))
      return false
    } finally {
      setSaving(false)
    }
  }

  async function fetchDraftModels() {
    if (editingId && !draft.apiKey.trim()) {
      await discover(editingId)
      return
    }
    setFetchingModels(true)
    setError('')
    try {
      const result = await api.ai.fetchModels({
        providerId: draft.providerId,
        protocol: draft.protocol,
        baseUrl: draft.baseUrl.trim() || undefined,
        apiKey: draft.apiKey.trim() || undefined,
      })
      if (!result.success || !result.models?.length) {
        setFetchedModels([])
        setModelDiscoveryDone(false)
        setError(result.error || '未获取到可用模型')
        return
      }
      const models = Array.from(new Set(result.models.map(String).filter(Boolean)))
      setFetchedModels(models)
      setModelDiscoveryDone(true)
      setDraft((prev) => ({ ...prev, model: models.includes(prev.model) ? prev.model : models[0] || '' }))
    } catch (e) {
      setError(String(e))
    } finally {
      setFetchingModels(false)
    }
  }

  async function activate(id: string) {
    setError('')
    try {
      const result = await api.ai.activateProfile(id)
      if (!result.success) {
        setError(result.error || '启用服务失败')
        return
      }
      await refreshSetup()
    } catch (e) {
      setError(String(e))
    }
  }

  async function removeProfile(id: string) {
    if (confirmDelete !== id) {
      setConfirmDelete(id)
      return
    }
    setConfirmDelete(null)
    setError('')
    try {
      const result = await api.ai.deleteProfile(id)
      if (!result.success) {
        setError(result.error || '删除服务失败')
        return
      }
      const next = await refreshSetup()
      if (editingId === id) {
        const replacement = next.profiles?.[0]
        if (replacement) startEdit(replacement)
        else {
          setEditingId(null)
          setDraft({ name: '新 AI 服务', providerId: 'deepseek', protocol: 'openai-compatible' as ProviderProtocol, baseUrl: 'https://api.deepseek.com', model: '', apiKey: '' })
          setFetchedModels([])
          setModelDiscoveryDone(false)
        }
      }
    } catch (e) {
      setError(String(e))
    }
  }

  async function discover(profileId: string) {
    setDiscovering(profileId)
    setError('')
    try {
      await api.ai.setSetup({ discoverProfileId: profileId })
      for (let attempt = 0; attempt < 24; attempt += 1) {
        await new Promise((resolve) => window.setTimeout(resolve, 450))
        const next = (await api.ai.getSetup()) as unknown as SetupInfo
        const current = next.profiles?.find((p) => p.id === profileId)
        setProfiles(next.profiles || [])
        if (current?.discovery?.fetchedAt && current.discovery.fetchedAt > Date.now() - 20000) {
          setActiveProfileId(next.activeProfileId || '')
          setFetchedModels(current.discovery.models || [])
          setModelDiscoveryDone(Boolean(current.discovery.models?.length))
          if (current.discovery.error) setError(current.discovery.error)
          break
        }
      }
    } catch (e) {
      setError(String(e))
    } finally {
      setDiscovering(null)
    }
  }

  async function saveAll() {
    setSaving(true)
    setError('')
    try {
      // 若当前无可编辑的 profile（首次使用且尚未添加），跳过 profile 保存，仅保存其他设置
      if (editingId || profiles.length > 0) {
        if (!(await saveProfile())) return
      }
      await api.ai.setSetup({
        reasoningEffort: effort,
        customPrompt,
        workspaceRoot: workspaceRoot.trim() || undefined,
        disabledTools: Array.from(disabledTools),
      })
      await api.ai.saveActions(actions)
      const next = await refreshSetup()
      onSaved(next)
    } catch (e) {
      setError(String(e))
    } finally {
      setSaving(false)
    }
  }

  async function pickWorkspace() {
    const dir = await api.dialog.openDirectory({ title: '选择 WeportAI 工作区根目录' })
    if (dir) setWorkspaceRoot(dir)
  }

  function toggleTool(name: string) {
    setDisabledTools((prev) => {
      const next = new Set(prev)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      return next
    })
  }

  function updateAction(id: string, patch: Partial<AiAction>) {
    setActions((prev) => prev.map((a) => (a.id === id ? { ...a, ...patch } : a)))
  }

  // 主体单独拎出来，因为这个面板有两种挂载方式：「设置 → AI 服务」内联（provider
  // 配置只允许在设置里改）和 WeportAI 页里的快捷弹窗。二者共用同一份状态与逻辑。
  const body = (
    <>
      {error && <div className="ai-profile-error">{error}</div>}

        <div className="ai-profile-layout">
          <section className="ai-settings-section ai-provider-block" aria-label="AI 服务列表">
            <div className="ai-settings-sec-head">
              <KeyRound size={13} /> AI 提供商
              <span className="ai-sec-hint">
                {profiles.length > 0 ? `${profiles.length} 个服务 · 密钥只存本机` : '还没有配置'}
              </span>
              <button type="button" className="secondary-btn ai-sec-action" onClick={startAdd}>
                <Plus size={13} /> 添加
              </button>
            </div>

            {profiles.length === 0 ? (
              <div className="ai-editor-empty">
                <p>还没有配置任何 AI 提供商。</p>
                <button type="button" className="primary-btn" onClick={openAddDialog}>
                  <Plus size={13} /> 添加第一个提供商
                </button>
              </div>
            ) : (
              /* 卡片网格：一张卡 = 一条可用配置（当前哪个、哪个模型、密钥有没有），
                 点卡片进编辑。原来是「窄列表 + 更窄的编辑器」两栏，字段标签被挤成
                 一条缝，用户看到的就是"乱七八糟"。 */
              <div className="ai-profile-cards">
                {profiles.map((profile) => {
                  const active = profile.id === activeProfileId
                  const editing = profile.id === editingId
                  return (
                    <article
                      key={profile.id}
                      className={`ai-profile-card${active ? ' active' : ''}${editing ? ' editing' : ''}`}
                    >
                      <button type="button" className="ai-profile-card-main" onClick={() => startEdit(profile)}>
                        <span className="ai-profile-card-head">
                          <strong>{profile.name}</strong>
                          {active ? <em className="ai-profile-badge">当前</em> : null}
                          {editing ? <em className="ai-profile-badge editing">编辑中</em> : null}
                        </span>
                        <span className="ai-profile-card-meta">
                          <span className="ai-kv">
                            <i>模型</i>
                            <b>{profile.model || '未选择'}</b>
                          </span>
                          <span className="ai-kv">
                            <i>提供商</i>
                            <b>{profile.providerId}</b>
                          </span>
                          <span className="ai-kv">
                            <i>密钥</i>
                            <b className={profile.hasApiKey ? '' : 'warn'}>{profile.hasApiKey ? profile.apiKeyHint || '已配置' : '未配置'}</b>
                          </span>
                          <span className="ai-kv">
                            <i>协议</i>
                            <b>{profile.protocol}</b>
                          </span>
                        </span>
                      </button>
                      {profile.discovery?.error ? <p className="ai-profile-discovery-error">{profile.discovery.error}</p> : null}
                      <div className="ai-profile-card-actions">
                        {active ? null : (
                          <button type="button" className="ghost-btn" onClick={() => void activate(profile.id)}>
                            启用
                          </button>
                        )}
                        <button
                          type="button"
                          className="ghost-btn"
                          onClick={() => void discover(profile.id)}
                          disabled={discovering === profile.id}
                        >
                          <RefreshCw size={12} /> {discovering === profile.id ? '读取中' : '发现模型'}
                        </button>
                        <button type="button" className="ghost-btn danger-text" onClick={() => void removeProfile(profile.id)}>
                          {confirmDelete === profile.id ? '再次确认删除' : '删除'}
                        </button>
                      </div>
                    </article>
                  )
                })}
              </div>
            )}
          </section>

          <section className="ai-settings-section ai-profile-editor" aria-label="编辑服务">
            <div className="ai-settings-sec-head">
              <Settings2 size={13} /> {editingId ? '编辑服务' : '服务详情'}
              <span className="ai-sec-hint">
                {editingId
                  ? profiles.find((p) => p.id === editingId)?.name || ''
                  : '从上面选一张卡片编辑，或点「添加」新建一个'}
              </span>
            </div>
            {!editingId ? (
              <div className="ai-editor-empty">
                <p>
                  {profiles.length === 0
                    ? '先添加一个提供商：选服务 → 填密钥 → 获取模型 → 保存。'
                    : '选一张卡片开始编辑，或者「添加」一个新的提供商。'}
                </p>
                {profiles.length > 0 ? (
                  <button type="button" className="secondary-btn" onClick={() => profiles[0] && startEdit(profiles[0])}>
                    编辑 “{profiles[0].name}”
                  </button>
                ) : null}
                <button type="button" className="secondary-btn" onClick={startAdd}>
                  <Plus size={13} /> 添加新提供商
                </button>
              </div>
            ) : (
              <>
                <div className="ai-settings-grid ai-provider-fields">
                  <div className="field"><label htmlFor="aiProfileName">配置名称</label><input id="aiProfileName" className="path-input ai-input-wide" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} /></div>
                  <div className="field"><label htmlFor="aiProvider">Provider</label><select id="aiProvider" className="path-input" value={draft.providerId} onChange={(e) => selectProvider(e.target.value)}>{catalog.map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}</select></div>
                  <div className="field"><label htmlFor="aiApiKey">API key</label><input id="aiApiKey" className="path-input ai-input-wide" type="password" value={draft.apiKey} placeholder={editingId ? `已保存 ${profiles.find((p) => p.id === editingId)?.apiKeyHint || '密钥'}；留空保持不变` : (selectedCatalog?.apiKeyOptional ? '本地服务可留空' : '输入 API key')} onChange={(e) => { setDraft({ ...draft, apiKey: e.target.value }); setModelDiscoveryDone(false) }} autoComplete="off" spellCheck={false} /></div>
                  <div className="field"><label htmlFor="aiModel">Model</label><select id="aiModel" className="path-input" value={draft.model} onChange={(e) => setDraft({ ...draft, model: e.target.value })} disabled={selectedModels.length === 0}><option value="">{selectedModels.length ? '选择模型' : '先获取模型列表'}</option>{selectedModels.map((model) => <option key={model} value={model}>{modelOptionLabel(model)}</option>)}</select></div>
                  {(selectedCatalog?.allowCustomBaseUrl || selectedCatalog?.id === 'custom') && <div className="field ai-provider-custom-url"><label htmlFor="aiBaseUrl">自定义接口地址</label><input id="aiBaseUrl" className="path-input ai-input-wide" value={draft.baseUrl} onChange={(e) => setDraft({ ...draft, baseUrl: e.target.value })} spellCheck={false} /></div>}
                  {(selectedCatalog?.allowCustomBaseUrl || selectedCatalog?.id === 'custom') && <div className="field"><label htmlFor="aiProtocol">协议</label><select id="aiProtocol" className="path-input" value={draft.protocol} onChange={(e) => setDraft({ ...draft, protocol: e.target.value as ProviderProtocol })}>{(selectedCatalog?.protocolOptions || [selectedCatalog?.protocol || draft.protocol]).map((protocol) => <option key={protocol} value={protocol}>{protocol}</option>)}</select></div>}
                  {/* 选中模型的价格明细。列表里只有 `in/out` 两个数，这里给出完整
                      分项 + 来源，用户才能判断该不该信这个数字。 */}
                  {draft.model ? (
                    <div className="ai-cost-detail">
                      {(() => {
                        const c = setup?.modelCosts?.[draft.model]
                        if (!c || (c.input === undefined && c.output === undefined)) {
                          return <span className="ai-cost-none">未收录定价（models.dev）· 请以提供商账单为准</span>
                        }
                        const rows: Array<[string, number | undefined]> = [
                          ['输入', c.input],
                          ['输出', c.output],
                          ['缓存读', c.cacheRead],
                          ['缓存写', c.cacheWrite],
                          ['推理', c.reasoning],
                        ]
                        return (
                          <>
                            {rows.map(([label, value]) => (
                              <span key={label} className="ai-cost-chip" data-missing={value === undefined}>
                                {label} {value === undefined ? '—' : `$${value}`}
                              </span>
                            ))}
                            <span className="ai-cost-unit">USD / 百万 token</span>
                            {c.source ? <span className="ai-cost-source">来源 {c.source}</span> : null}
                          </>
                        )
                      })()}
                    </div>
                  ) : null}
                </div>
                <div className="ai-profile-editor-foot">
                  <div className="ai-profile-discovery">
                    <button type="button" className="ghost-btn" onClick={() => void fetchDraftModels()} disabled={saving || fetchingModels || Boolean(discovering)}><RefreshCw size={12} /> {fetchingModels || discovering ? '正在获取模型…' : '获取模型列表'}</button>
                    <span className="ai-profile-discovery-hint">{modelDiscoveryDone ? `已获取 ${fetchedModels.length} 个模型` : '验证 API key 并读取可用模型'}</span>
                    {editingId && profiles.find((p) => p.id === editingId)?.discovery?.error && <span className="ai-profile-discovery-error">{profiles.find((p) => p.id === editingId)?.discovery?.error}</span>}
                  </div>
                  <div className="ai-profile-editor-actions">
                    <button type="button" className="ghost-btn" onClick={() => setEditingId(null)} disabled={saving}>取消</button>
                    <button type="button" className="primary-btn" disabled={saving || (!editingId && !modelDiscoveryDone)} onClick={() => void saveProfile()}>{saving ? '保存中…' : '保存 profile'}</button>
                  </div>
                </div>
              </>
            )}
          </section>
        </div>

        <div className="ai-settings-section"><div className="ai-settings-sec-head"><FolderOpen size={13} /> 工作区</div><div className="field"><label htmlFor="aiWorkspaceRoot">工作区根目录</label><div className="path-row"><input id="aiWorkspaceRoot" className="path-input" value={workspaceRoot} onChange={(e) => setWorkspaceRoot(e.target.value)} /><button className="ghost-btn" type="button" onClick={() => void pickWorkspace()}>浏览</button></div></div></div>
        <div className="ai-settings-section"><div className="ai-settings-sec-head"><FilePenLine size={13} /> 提示词</div><textarea id="aiCustomPrompt" className="ai-prompt-textarea" value={customPrompt} onChange={(e) => setCustomPrompt(e.target.value)} rows={4} spellCheck={false} /></div>
        <div className="ai-settings-section"><div className="ai-settings-sec-head"><Zap size={13} /> 快捷动作</div>{actions.map((a) => <div className="ai-action-edit" key={a.id}><input className="path-input ai-action-name" value={a.name} onChange={(e) => updateAction(a.id, { name: e.target.value })} /><textarea className="ai-prompt-textarea ai-action-prompt" value={a.prompt} onChange={(e) => updateAction(a.id, { prompt: e.target.value })} rows={2} /><button type="button" className="ghost-btn danger-text" onClick={() => setActions((prev) => prev.filter((item) => item.id !== a.id))}><Trash2 size={12} /></button></div>)}<button type="button" className="ghost-btn" onClick={() => setActions((prev) => [...prev, { id: `action-${Date.now()}`, name: '新动作', prompt: '' }])}><Plus size={12} /> 添加动作</button></div>
        <div className="ai-settings-section"><div className="ai-settings-sec-head"><Settings2 size={13} /> 工具开关</div><div className="ai-tool-toggles">{TOOL_LABELS.map(([name, label]) => <label key={name} className={`ai-tool-toggle${disabledTools.has(name) ? ' off' : ''}`}><input type="checkbox" checked={!disabledTools.has(name)} onChange={() => toggleTool(name)} /><span>{label}</span><code>{name}</code></label>)}</div></div>
        <div className="modal-actions ai-settings-footer">{!inline && <button className="secondary-btn" type="button" disabled={saving} onClick={onClose}>取消</button>}<button className="primary-btn" type="button" disabled={saving} onClick={() => void saveAll()}><KeyRound size={13} /> 保存设置</button></div>
    </>
  )

  const addDialog = (
        <div className="ai-add-overlay" onClick={() => !addSaving && setAddOpen(false)}>          <div className="ai-add-dialog" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-labelledby="ai-add-title">
            <div className="ai-add-head">
              <div className="ai-add-title">
                <div className="ai-add-icon"><Sparkles size={16} /></div>
                <div>
                  <h3 id="ai-add-title">添加 AI 提供商</h3>
                  <p>从目录挑选提供商，验证密钥后选择模型，创建即可启用</p>
                </div>
              </div>
              <button type="button" className="icon-btn-ghost" aria-label="关闭" onClick={() => !addSaving && setAddOpen(false)}><XCircle size={16} /></button>
            </div>

            {addError && <div className="ai-profile-error" style={{ marginBottom: 12 }}>{addError}</div>}

            <div className="ai-add-catalog">
              <div className="ai-add-section-label"><span>① 选择提供商</span><small>{catalog.length} 个可用</small></div>
              <div className="ai-add-grid">
                {catalog.map((entry) => {
                  const isSelected = addDraft.providerId === entry.id
                  return (
                    <button
                      key={entry.id}
                      type="button"
                      className={`ai-add-card${isSelected ? ' selected' : ''}`}
                      onClick={() => selectAddProvider(entry.id)}
                    >
                      <div className="ai-add-card-head">
                        <strong>{entry.name}</strong>
                        {isSelected && <span className="ai-add-check"><CheckCircle2 size={13} /></span>}
                      </div>
                      <span className="ai-add-card-desc">{entry.description}</span>
                      <span className="ai-add-card-meta">
                        <code>{entry.protocol}</code>
                        <span title={entry.baseUrl}>{entry.baseUrl ? entry.baseUrl.replace(/^https?:\/\//, '').slice(0, 28) || '自定义地址' : '自定义地址'}</span>
                      </span>
                    </button>
                  )
                })}
              </div>
            </div>

            <div className="ai-add-form">
              <div className="ai-add-section-label"><span>② 配置详情</span><small>带 * 为必填</small></div>
              <div className="ai-settings-grid ai-provider-fields">
                <div className="field"><label htmlFor="aiAddName">配置名称 *</label><input id="aiAddName" className="path-input ai-input-wide" value={addDraft.name} onChange={(e) => setAddDraft({ ...addDraft, name: e.target.value })} placeholder="例如：我的 DeepSeek" /></div>
                <div className="field"><label htmlFor="aiAddKey">API Key {catalog.find((c) => c.id === addDraft.providerId)?.apiKeyOptional ? '(可选)' : '*'}</label>
                  <input id="aiAddKey" className="path-input ai-input-wide" type="password" value={addDraft.apiKey} onChange={(e) => { setAddDraft({ ...addDraft, apiKey: e.target.value }); setAddDiscoveryDone(false) }} placeholder={catalog.find((c) => c.id === addDraft.providerId)?.apiKeyOptional ? '本地服务可留空' : '粘贴 API key'} autoComplete="off" spellCheck={false} />
                </div>
                {(catalog.find((c) => c.id === addDraft.providerId)?.allowCustomBaseUrl || addDraft.providerId === 'custom') && (
                  <div className="field ai-provider-custom-url"><label htmlFor="aiAddBaseUrl">自定义接口地址 {catalog.find((c) => c.id === addDraft.providerId)?.id === 'azure-openai' ? '*' : ''}</label><input id="aiAddBaseUrl" className="path-input ai-input-wide" value={addDraft.baseUrl} onChange={(e) => setAddDraft({ ...addDraft, baseUrl: e.target.value })} placeholder="https://..." spellCheck={false} /></div>
                )}
                {(catalog.find((c) => c.id === addDraft.providerId)?.allowCustomBaseUrl || addDraft.providerId === 'custom') && (
                  <div className="field"><label htmlFor="aiAddProtocol">协议</label><select id="aiAddProtocol" className="path-input" value={addDraft.protocol} onChange={(e) => setAddDraft({ ...addDraft, protocol: e.target.value as ProviderProtocol })}>{(catalog.find((c) => c.id === addDraft.providerId)?.protocolOptions || [catalog.find((c) => c.id === addDraft.providerId)?.protocol || addDraft.protocol]).map((protocol) => <option key={protocol} value={protocol}>{protocol}</option>)}</select></div>
                )}
                <div className="field"><label htmlFor="aiAddModel">模型 *</label>
                  <div className="ai-add-model-row">
                    <select id="aiAddModel" className="path-input" value={addDraft.model} onChange={(e) => setAddDraft({ ...addDraft, model: e.target.value })} disabled={addFetchedModels.length === 0 && !(catalog.find((c) => c.id === addDraft.providerId)?.models?.length)}>
                      <option value="">{addFetchedModels.length || catalog.find((c) => c.id === addDraft.providerId)?.models?.length ? '选择模型' : '先获取模型列表'}</option>
                      {Array.from(new Set([...addFetchedModels, ...(catalog.find((c) => c.id === addDraft.providerId)?.models || []), ...(addDraft.model ? [addDraft.model] : [])].filter(Boolean))).map((m) => <option key={m} value={m}>{m}</option>)}
                    </select>
                    <button type="button" className="ghost-btn ai-add-fetch" onClick={() => void fetchAddModels()} disabled={addFetching}>
                      {addFetching ? <Loader2 size={13} className="spin" /> : <RefreshCw size={13} />}
                      {addFetching ? '获取中…' : '获取模型'}
                    </button>
                  </div>
                  <span className="ai-profile-discovery-hint">{addDiscoveryDone ? `✓ 已验证 · ${addFetchedModels.length} 个模型可用` : addFetching ? '正在验证密钥并拉取模型…' : '验证 API key 后自动刷新模型列表'}</span>
                </div>
              </div>
            </div>

            <div className="ai-add-actions">
              <button type="button" className="secondary-btn" disabled={addSaving} onClick={() => setAddOpen(false)}>取消</button>
              <button type="button" className="primary-btn" disabled={addSaving || !addDiscoveryDone || !addDraft.name.trim() || !addDraft.model.trim()} onClick={() => void saveAddProfile()}>
                {addSaving ? '创建中…' : '确认添加并启用'}
              </button>
            </div>
            <p className="hint" style={{ marginTop: 8, textAlign: 'center', fontSize: 11 }}>添加后将自动设为当前提供商，可在左侧列表随时切换</p>
          </div>
        </div>
  )

  // 「添加提供商」必须走 portal 挂到 body 上。
  //
  // 设置页里这个组件是 `inline` 渲染的 —— 它落在设置页自己的滚动容器内，而
  // `.modal` / 页面容器带 `animation`（会建立 containing block）。`position: fixed`
  // 于是不再相对视口定位，浮层被钉在滚动容器的底部，看起来就是"弹窗跑到屏幕最下面"。
  // 挂到 body 之后，fixed 才真的是相对视口居中。
  const addOverlay = createPortal(addDialog, document.body)

  if (inline) {
    return (
      <div className="ai-provider-inline">
        {body}
        {addOpen && addOverlay}
      </div>
    )
  }

  return (
    <div className="modal-backdrop" onClick={() => !saving && onClose?.()}>
      <div className="modal modal-wide ai-settings ai-provider-modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-labelledby="ai-settings-title">
        <h3 id="ai-settings-title"><Sparkles size={15} /> WeportAI 设置</h3>
        <p className="hint">服务配置按 profile 管理。API key 只在本机加密保存，列表、摘要和 discovery 结果都不会返回原始密钥。</p>
        {body}
      </div>
      {addOpen && addOverlay}
    </div>
  )
}

