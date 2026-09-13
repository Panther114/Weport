import { afterEach, describe, expect, it, vi } from 'vitest'
import { todoistConnector } from './todoistConnector'

/**
 * These tests pin the parts of the Todoist connector that are easy to get subtly
 * wrong and expensive to notice: the inverted priority scale, the label-vs-project
 * target routing, and the fact that an omitted target must reach the API as "no
 * `project_id`" (the Inbox) rather than as an empty string.
 *
 * They run against a stubbed `fetch`, so they assert the exact wire body — which is
 * also the artefact the user's account sees.
 */

const calls: Array<{ url: string; init: RequestInit; body?: Record<string, unknown> }> = []

function stubFetch(responses: Array<{ status?: number; body?: unknown; text?: string }>) {
  let index = 0
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    const next = responses[Math.min(index, responses.length - 1)]
    index += 1
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined
    calls.push({ url: String(url), init, body })
    const text = next.text ?? JSON.stringify(next.body ?? {})
    return {
      ok: (next.status ?? 200) < 400,
      status: next.status ?? 200,
      text: async () => text,
    } as unknown as Response
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
  calls.length = 0
})

describe('todoist connector', () => {
  it('verifies a token against /projects and reports the account', async () => {
    stubFetch([{ body: { results: [{ id: '6X7r', name: 'Inbox' }] } }])
    const result = await todoistConnector.verify('token-1234')
    expect(result.success).toBe(true)
    expect(result.data?.accountName).toBeTruthy()
    expect(calls[0].url).toContain('/projects')
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe('Bearer token-1234')
  })

  it('reports an invalid token with the provider wording', async () => {
    stubFetch([{ status: 401, text: '{"error":"Invalid token"}' }])
    const result = await todoistConnector.verify('bad')
    expect(result.success).toBe(false)
    expect(result.status).toBe(401)
    expect(result.error).toMatch(/令牌/)
  })

  it('maps the four user-facing priority levels onto Todoist numbering', async () => {
    stubFetch([{ body: { id: '1', content: 'x' } }])
    await todoistConnector.createTask('t', { content: 'x', priority: 'urgent' })
    expect(calls[0].body?.priority).toBe(4)
    expect(calls[0].body?.content).toBe('x')
  })

  it('never sends an empty project_id for the Inbox', async () => {
    stubFetch([{ body: { id: '1', content: 'x' } }])
    await todoistConnector.createTask('t', { content: 'x', targetId: '' })
    expect('project_id' in (calls[0].body || {})).toBe(false)
  })

  it('routes a label target into labels instead of project_id', async () => {
    stubFetch([{ body: { id: '1', content: 'x' } }])
    await todoistConnector.createTask('t', { content: 'x', targetId: 'label:urgent', labels: ['@home'] })
    expect(calls[0].body?.labels).toEqual(['urgent', 'home'])
    expect('project_id' in (calls[0].body || {})).toBe(false)
  })

  it('passes natural-language due text through as due_string', async () => {
    stubFetch([{ body: { id: '1', content: 'x' } }])
    await todoistConnector.createTask('t', { content: 'x', dueText: 'tomorrow at 17:00', dueLang: 'zh' })
    expect(calls[0].body?.due_string).toBe('tomorrow at 17:00')
    expect(calls[0].body?.due_lang).toBe('zh')
    expect('due_date' in (calls[0].body || {})).toBe(false)
  })

  it('answers a network failure with an actionable message', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new Error('fetch failed')
    })
    const result = await todoistConnector.createTask('t', { content: 'x' })
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/无法连接 Todoist/)
  })
})
