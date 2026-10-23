import { useEffect, useState } from 'react'
import { useLiveTask } from '../../hooks/useLiveTask'
import { LIVE_TASK } from '../../utils/liveTask'
import type { LocalEmbeddingConfig } from '../../../electron/services/semanticIndex'
import type { QueryParams } from './searchQuery'
import '../v13Controls.css'
import './semanticSearch.css'

const DEFAULT_CONFIG: LocalEmbeddingConfig = { enabled: false, endpoint: 'http://127.0.0.1:5083/v1/embeddings', model: '', revision: '' }
export default function SemanticSearchControls({ mode, onModeChange, scope, coverage, canBuild, onChanged }: {
  mode: NonNullable<QueryParams['retrieval']>
  onModeChange: (mode: NonNullable<QueryParams['retrieval']>) => void
  scope?: SearchScope; coverage?: SearchCoverage; canBuild: boolean; onChanged: () => void
}) {
  const [config, setConfig] = useState(DEFAULT_CONFIG)
  const [saved, setSaved] = useState(DEFAULT_CONFIG)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const task = useLiveTask(LIVE_TASK.searchIndex)
  useEffect(() => {
    let alive = true
    void window.electronAPI.search.semanticConfig().then(value => { if (alive) { setConfig(value); setSaved(value) } })
      .catch(() => { if (alive) setError('本地语义配置暂不可用') })
    return () => { alive = false }
  }, [])
  const dirty = JSON.stringify(config) !== JSON.stringify(saved)
  const semantic = coverage?.semantic
  const patch = (value: Partial<LocalEmbeddingConfig>) => setConfig(previous => ({ ...previous, ...value }))
  return <div className="sp-semantic v13-controls">
    {(saved.enabled || mode !== 'lexical') && <div className="sp-semantic-row">
      <span className="sp-semantic-label">检索方式</span>
      <div className="seg" role="group" aria-label="检索方式">
        {([['lexical', '精确匹配'], ['hybrid', '混合召回'], ['semantic', '语义召回']] as const).map(([value, label]) =>
          <button key={value} type="button" data-active={mode === value} aria-pressed={mode === value}
            disabled={value !== 'lexical' && !saved.enabled} onClick={() => onModeChange(value)}>{label}</button>)}
      </div>
      {mode !== 'lexical' ? <span className="sp-semantic-hint">本地模型 · 相似结果需要核对原文</span> : null}
    </div>}
    <details>
      <summary>可选本地语义索引{saved.enabled ? ' · 已启用' : ' · 默认关闭'}</summary>
      <p>先启动本机嵌入模型服务，再保存配置并建立当前筛选范围的语义索引。每次最多处理 10,000 条消息、20,000 个上下文窗口；超限会披露覆盖不完整。模型文件需要另行准备。</p>
      <label className="sp-semantic-enable"><input type="checkbox" checked={config.enabled} onChange={event => patch({ enabled: event.target.checked })} />允许把当前范围的文本交给本机模型</label>
      <div className="sp-semantic-presets">
        <span className="sp-semantic-label">E5 前缀预设（可选）</span>
        <div className="seg" role="group" aria-label="E5 前缀预设">
          {([
            ['query: ', 'E5 聊天语义（query/query）'],
            ['passage: ', 'E5 问答检索（query/passage）'],
          ] as const).map(([passagePrefix, label]) => {
            const active = config.queryPrefix === 'query: ' && config.passagePrefix === passagePrefix
            return <button type="button" key={passagePrefix} aria-pressed={active} data-active={active} disabled={saving}
              onClick={() => patch({ queryPrefix: 'query: ', passagePrefix })}>{label}</button>
          })}
        </div>
      </div>
      <p>仅适用于采用 E5 前缀的模型，点击后只调整前缀。保存后需重建语义索引；语义召回仍为实验功能。</p>
      <div className="sp-semantic-fields">
        <label>本机嵌入服务地址<input value={config.endpoint} placeholder="http://127.0.0.1:5083/v1/embeddings" onChange={event => patch({ endpoint: event.target.value })} /></label>
        <label>模型名称<input value={config.model} placeholder="Xenova/multilingual-e5-small" onChange={event => patch({ model: event.target.value })} /></label>
        <label>固定模型版本或文件摘要<input value={config.revision} onChange={event => patch({ revision: event.target.value })} /></label>
        <label>查询前缀（E5：query: ）<input value={config.queryPrefix || ''} onChange={event => patch({ queryPrefix: event.target.value })} /></label>
        <label>正文前缀（E5：passage: ）<input value={config.passagePrefix || ''} onChange={event => patch({ passagePrefix: event.target.value })} /></label>
      </div>
      <div className="sp-semantic-actions">
      <button className="secondary-btn" type="button" disabled={saving || task.status === 'running' || !dirty} onClick={() => {
        setSaving(true); setError('')
        void window.electronAPI.search.saveSemanticConfig(config).then(value => {
          setSaved(value); setConfig(value); if (!value.enabled) onModeChange('lexical'); onChanged()
        }).catch(() => setError('配置保存失败，请检查本机地址、模型名称和固定版本')).finally(() => setSaving(false))
      }}>保存本地配置</button>
      <button className="secondary-btn" type="button" disabled={!canBuild || !saved.enabled || dirty || saving || task.status === 'running'} onClick={() => {
        setError('')
        void window.electronAPI.search.buildSemantic({ scope }).then(onChanged)
          .catch(() => setError('语义索引启动失败，请检查本机模型服务和当前账号索引'))
      }}>建立当前范围语义索引</button>
      </div>
      <p>账号、来源、模型、固定版本或前缀改变后需要重建。更窄的日期、发送者范围只使用范围内消息生成的向量；上下文中任何一条消息超出范围时，该上下文候选不会参与检索。</p>
    </details>
    {error ? <p className="sp-semantic-warning" role="alert">{error}</p> : null}
    {semantic ? <p className={semantic.error || semantic.truncated ? 'sp-semantic-warning' : 'sp-semantic-hint'} role="status">
      {semantic.error ? '本地语义索引不可用，混合模式已回退精确匹配。请检查模型服务并重建当前来源索引。' :
        `语义索引 ${semantic.indexedDocuments.toLocaleString()} 条 · 范围内 ${semantic.eligibleWindows.toLocaleString()} 个窗口 · 最多保留 ${semantic.rerankedCandidates} 个候选${semantic.truncated ? ' · 覆盖或候选已截断' : ''}`}
    </p> : null}
  </div>
}
