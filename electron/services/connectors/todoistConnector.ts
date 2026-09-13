import type {
  Connector,
  ConnectorPriority,
  ConnectorResult,
  ConnectorTarget,
  ConnectorTaskInput,
  ConnectorTaskResult,
} from './types'

/**
 * Todoist connector — REST API v1 (`https://api.todoist.com/api/v1`).
 *
 * Verified against the published OpenAPI document in 2026-09; the field notes
 * below record the non-obvious parts, because two of them are easy to get wrong
 * in a way that still "works":
 *
 * - **Priority is inverted between Todoist's own surfaces.** The REST API stores
 *   `priority` as 1 = normal … 4 = urgent, while Todoist's Quick Add syntax and
 *   UI use `p1` (urgent) … `p4` (normal). This module therefore exposes
 *   `ConnectorPriority` and translates in both directions rather than passing a
 *   number through, which is how integrations end up filing urgent work as "soon".
 * - **`due_string` is parsed by the service**, in the user's own language
 *   (`due_lang`), so `"tomorrow at 17:00"` is a legitimate value — the client is
 *   not expected to resolve natural language. `due_date` (YYYY-MM-DD) and
 *   `due_datetime` (RFC3339) remain available when the caller already knows the
 *   exact instant.
 * - **Omitted `project_id` means the Inbox.** That is the API's documented
 *   behaviour, so "no target" is a valid request rather than a missing argument.
 *
 * The API token comes from the user (Todoist → Settings → Integrations →
 * Developer); Weport never performs the OAuth dance, and the token is stored
 * through ConfigService's safeStorage envelope exactly like the MCP token.
 */

const BASE = 'https://api.todoist.com/api/v1'

const DESCRIPTOR = {
  id: 'todoist',
  name: 'Todoist',
  description: '把 WeportAI 或定时代理整理出来的待办写进 Todoist。',
  authKind: 'token' as const,
  capabilities: { read: true, write: true, hasTargets: true },
  credentialUrl: 'https://app.todoist.com/app/settings/integrations/developer',
  credentialHelp: [
    '打开 Todoist 网页版 → 左下角头像 → 设置 → 集成 → 开发者。',
    '在「API 令牌」下点「复制」，它会复制一整串 40 位十六进制字符。',
    '粘贴到下面的输入框并保存，Weport 会立刻验证一次。',
  ],
  credentialPlaceholder: '粘贴 40 位 API 令牌',
}

/**
 * Todoist's own numbering (`priority` in the REST body) against the four levels
 * callers use. The API's 1 is "no priority", which is why `none` and `low` share
 * a rung: Todoist has no separate low.
 */
const PRIORITY_TO_API: Record<ConnectorPriority, number> = { none: 1, low: 2, medium: 3, high: 4, urgent: 4 }
const PRIORITY_FROM_API: Record<number, ConnectorPriority> = { 1: 'none', 2: 'low', 3: 'medium', 4: 'urgent' }

/** Labels are picked from a different endpoint than projects; one namespace needs a marker. */
const LABEL_TARGET_PREFIX = 'label:'

async function call<T>(token: string, path: string, init?: RequestInit & { query?: Record<string, string> }): Promise<ConnectorResult<T>> {
  const query = init?.query ? `?${new URLSearchParams(init.query).toString()}` : ''
  try {
    const response = await fetch(`${BASE}${path}${query}`, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        ...(init?.headers || {}),
      },
    })
    const text = await response.text().catch(() => '')
    if (!response.ok) {
      // Todoist answers errors as `{"error": "..."}`; anything else is surfaced raw
      // so a proxy or HTML error page is not reported as a vague connector failure.
      let detail = text.slice(0, 300)
      try {
        const parsed = JSON.parse(text) as { error?: string; message?: string }
        detail = parsed.error || parsed.message || detail
      } catch { /* not JSON */ }
      if (response.status === 401) detail = 'API 令牌无效或已过期'
      if (response.status === 403) detail = 'API 令牌权限不足（请确认令牌所属账号与权限）'
      return { success: false, error: detail || `HTTP ${response.status}`, status: response.status }
    }
    return { success: true, data: (text ? JSON.parse(text) : null) as T }
  } catch (error) {
    const message = String((error as Error)?.message || error)
    // Network-level failures are the common first-run case (no internet, blocked
    // DNS); naming them beats a bare "fetch failed".
    return { success: false, error: /fetch failed|ENOTFOUND|EAI_AGAIN|timeout/i.test(message) ? `无法连接 Todoist：${message}` : message }
  }
}

interface RawTask {
  id: string
  content: string
  priority?: number
  due?: { string?: string; date?: string } | null
  url?: string
}

function toTaskResult(raw: RawTask): ConnectorTaskResult {
  return {
    id: String(raw.id),
    content: String(raw.content || ''),
    url: raw.url || `https://app.todoist.com/app/task/${encodeURIComponent(String(raw.id))}`,
    dueText: raw.due?.string || raw.due?.date,
    priority: PRIORITY_FROM_API[Number(raw.priority) || 1] || 'none',
  }
}

/** `{results: […], next_cursor}` today, a bare array in older shapes — accept both. */
function asList<T>(payload: unknown): T[] {
  if (Array.isArray(payload)) return payload as T[]
  const record = payload as { results?: unknown; items?: unknown } | null
  if (Array.isArray(record?.results)) return record!.results as T[]
  if (Array.isArray(record?.items)) return record!.items as T[]
  return []
}

export const todoistConnector: Connector = {
  descriptor: DESCRIPTOR,

  async verify(token, signal) {
    // The projects endpoint doubles as the credential check; it also names the
    // account's own workspace, which is friendlier than "token accepted".
    const result = await call<unknown>(token, '/projects', { method: 'GET', query: { limit: '1' }, signal })
    if (!result.success) return { success: false, error: result.error, status: result.status }
    const projects = asList<{ name?: string }>(result.data)
    return { success: true, data: { accountName: projects[0]?.name ? `Todoist（${projects.length ? '已连接' : '空账号'}）` : 'Todoist' } }
  },

  async listTargets(token, signal) {
    const [projects, labels] = await Promise.all([
      call<unknown>(token, '/projects', { method: 'GET', query: { limit: '200' }, signal }),
      call<unknown>(token, '/labels', { method: 'GET', query: { limit: '200' }, signal }),
    ])
    if (!projects.success) return { success: false, error: projects.error, status: projects.status }
    const targets: ConnectorTarget[] = [{ id: '', name: '收件箱（Inbox）', kind: 'inbox' }]
    for (const project of asList<{ id?: string; project_id?: string; name?: string; is_archived?: boolean }>(projects.data)) {
      if (project.is_archived) continue
      const id = String(project.id || project.project_id || '')
      if (!id) continue
      targets.push({ id, name: String(project.name || id), kind: 'project' })
    }
    // A label cannot hold a task on its own, so labels are offered as targets too
    // (the connector turns a label target into `labels: [name]` with no project).
    if (labels.success) {
      for (const label of asList<{ id?: string; name?: string }>(labels.data)) {
        const name = String(label.name || '')
        if (!name) continue
        targets.push({ id: `${LABEL_TARGET_PREFIX}${name}`, name: `@${name}`, kind: 'label' })
      }
    }
    return { success: true, data: targets }
  },

  async createTask(token, input, signal) {
    const content = String(input.content || '').trim()
    if (!content) return { success: false, error: '任务内容不能为空' }
    const body: Record<string, unknown> = { content }
    if (input.description?.trim()) body.description = input.description.trim()
    if (input.dueDatetime?.trim()) body.due_datetime = input.dueDatetime.trim()
    else if (input.dueText?.trim()) body.due_string = input.dueText.trim()
    else if (input.dueDate?.trim()) body.due_date = input.dueDate.trim()
    if (input.dueLang?.trim()) body.due_lang = input.dueLang.trim()
    if (input.priority && input.priority !== 'none') body.priority = PRIORITY_TO_API[input.priority]
    if (input.parentId?.trim()) body.parent_id = input.parentId.trim()

    const labels = (input.labels || []).map((label) => String(label).trim().replace(/^@/, '')).filter(Boolean)
    const target = String(input.targetId || '').trim()
    if (target.startsWith(LABEL_TARGET_PREFIX)) labels.unshift(target.slice(LABEL_TARGET_PREFIX.length))
    // `project_id` takes a numeric id or a name; a label target routes through
    // `labels` only, and an empty target means the Inbox.
    else if (target) body.project_id = target
    if (labels.length > 0) body.labels = Array.from(new Set(labels))

    const result = await call<RawTask>(token, '/tasks', { method: 'POST', body: JSON.stringify(body), signal })
    if (!result.success) return { success: false, error: result.error, status: result.status }
    return { success: true, data: toTaskResult(result.data || ({ id: '', content } as RawTask)) }
  },

  async listTasks(token, options, signal) {
    const limit = Math.max(1, Math.min(200, Number(options?.limit) || 30))
    const result = await call<unknown>(token, '/tasks', { method: 'GET', query: { limit: String(limit) }, signal })
    if (!result.success) return { success: false, error: result.error, status: result.status }
    return { success: true, data: asList<RawTask>(result.data).map(toTaskResult) }
  },
}
