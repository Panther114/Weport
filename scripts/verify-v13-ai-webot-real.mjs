// Real DeepSeek + current-account acceptance in an isolated offscreen profile.
// Credentials stay inside the application's existing ConfigService/provider path.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createHash } from 'node:crypto'
import { _electron } from 'playwright-core'

const root = process.cwd()
const out = path.join(os.tmpdir(), 'weport-v13-ai-acceptance')
fs.mkdirSync(out, { recursive: true })
if (fs.existsSync(path.join(out, 'result.json'))) fs.copyFileSync(path.join(out, 'result.json'), path.join(out, `prior-${Date.now()}.json`))
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'weport-v13-ai-private-'))
const profile = path.join(scratch, 'profile')
fs.mkdirSync(profile)
const real = path.join(process.env.APPDATA, 'weport')
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const fileHash = p => digest(fs.readFileSync(p))
const protectedNames = ['Weport-config.json', 'Local State']
const protectedBefore = Object.fromEntries(protectedNames.map(n => [n, fileHash(path.join(real, n))]))
const result = { startedAt: new Date().toISOString(), cases: [], failures: [], credentialHandling: 'Encrypted profile copied; existing application provider decrypts internally. No key returned to harness or logs.', privateCleanupVerified: false }
const record = (name, data = {}) => { result.cases.push({ name, ...data }); fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify({ name, ...data })) }
const walk = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)])
let app, page
try {
  // Parse only the saved configuration envelope, never decrypt a credential here.
  const config = JSON.parse(fs.readFileSync(path.join(real, 'Weport-config.json'), 'utf8'))
  result.credentialsEncryptedAtRest = ['weportAiProfilesBlob', 'weportAiApiKey'].filter(k => config[k]).every(k => String(config[k]).startsWith('safe:'))
  const dirs = [config.dbPath, path.join(config.dbPath, config.myWxid)]
  if (fs.existsSync(config.dbPath)) for (const e of fs.readdirSync(config.dbPath, { withFileTypes: true })) {
    if (e.isDirectory() && (e.name === config.myWxid || e.name.startsWith(config.myWxid + '_'))) dirs.push(path.join(config.dbPath, e.name))
  }
  const sourceAccount = dirs.find(d => fs.existsSync(path.join(d, 'db_storage', 'session', 'session.db')) || fs.existsSync(path.join(d, 'db_storage', 'session.db')))
  assert(sourceAccount, 'Current saved account unavailable')
  const source = path.join(sourceAccount, 'db_storage')
  const copied = path.join(scratch, 'accounts', path.basename(sourceAccount))
  let stable = false, files = [], copiedBytes = 0
  for (let attempt = 0; attempt < 5 && !stable; attempt++) {
    files = walk(source).filter(f => /\.db(?:-wal)?$/i.test(f))
    const signature = () => JSON.stringify(walk(source).filter(f => /\.db(?:-wal)?$/i.test(f)).sort().map(f => { const s = fs.statSync(f); return [path.relative(source, f), s.size, s.mtimeMs, s.ctimeMs] }))
    const before = signature()
    copiedBytes = 0
    let matching = true
    for (const file of files) {
      const dest = path.join(copied, 'db_storage', path.relative(source, file))
      fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.copyFileSync(file, dest)
      matching &&= fileHash(file) === fileHash(dest); copiedBytes += fs.statSync(dest).size
    }
    stable = matching && signature() === before
  }
  assert(stable, 'Source changed during all snapshot attempts')
  record('stable-private-real-history', { files: files.length, bytes: copiedBytes })
  Object.assign(config, { dbPath: path.dirname(copied), myWxid: path.basename(copied), exportPath: path.join(scratch, 'exports'),
    weportAiWorkspaceRoot: path.join(scratch, 'workspace'), weportAiMaxSteps: 10, weportAiMaxToolChars: 24000,
    weportAiReasoningEffort: 'low', weportAiCustomPrompt: '', connectorsAllowAgent: false,
    messagePushEnabled: false, antiRevokeAutoApplyNewGroups: false, mcpEnabled: false, httpApiEnabled: false,
    launchAtStartup: false, appearanceBackgroundPath: '', logEnabled: false })
  fs.copyFileSync(path.join(real, 'Local State'), path.join(profile, 'Local State'))
  fs.writeFileSync(path.join(profile, 'Weport-config.json'), JSON.stringify(config))
  const launch = async () => {
    result.appAsarSha256 = fileHash(path.join(root, 'release', 'win-unpacked', 'resources', 'app.asar'))
    app = await _electron.launch({ executablePath: path.join(root, 'release', 'win-unpacked', 'Weport.exe'), args: ['--background', `--user-data-dir=${profile}`],
      env: { ...process.env, WEPORT_PROBE_OFFSCREEN: '1', WEPORT_NATIVE_GLASS: '0', WEPORT_DISCARD_DELAY_MS: '1000' }, timeout: 90000 })
    await app.evaluate(async ({ app: electronApp, BrowserWindow }) => {
      await electronApp.whenReady()
      while (!electronApp.listenerCount('activate')) await new Promise(r => setTimeout(r, 25))
      const position = BrowserWindow.prototype.setPosition, inactive = BrowserWindow.prototype.showInactive
      BrowserWindow.prototype.show = BrowserWindow.prototype.showInactive = function () { position.call(this, -4000, 0); inactive.call(this) }
      BrowserWindow.prototype.focus = function () {}; electronApp.emit('activate')
    })
    page = await app.firstWindow()
    await page.waitForFunction(() => Boolean(window.electronAPI?.weBot), null, { timeout: 60000 })
    page.setDefaultTimeout(360000)
    // No console/stdout forwarding: model text, headers and credentials stay private.
  }
  await launch()
  const provider = await page.evaluate(async () => {
    const setup = await window.electronAPI.ai.getSetup()
    const p = setup.profiles.find(p => p.providerId === 'deepseek' && p.hasApiKey) || setup.profiles.find(p => /deepseek/i.test(p.name + ' ' + p.model) && p.hasApiKey)
    if (!p) return null
    for (const consumer of ['chat', 'webot']) { const r = await window.electronAPI.ai.assignConsumer(consumer, p.id); if (!r.success) throw Error('Provider assignment failed') }
    return { providerId: p.providerId, model: p.model, hasApiKey: p.hasApiKey }
  })
  assert(provider, 'Configured DeepSeek profile unavailable')
  record('configured-deepseek-reused', provider)
  const connected = await page.evaluate(() => window.electronAPI.chat.connect())
  assert(connected.success, 'Private real-history connection failed')
  const selected = await page.evaluate(async () => {
    const listed = await window.electronAPI.chat.getSessions()
    if (!listed.success) throw Error('Sessions unavailable')
    for (const s of listed.sessions.slice(0, 40)) {
      if (s.username.startsWith('gh_')) continue
      const rows = await window.electronAPI.chat.getMessages(s.username, 0, 12, 0, 0, false)
      if (!rows.success || rows.messages.length < 12) continue
      // ChatService normalizes each native-selected page into ascending display
      // order, even when the cursor selects the latest page. Row zero is not
      // the newest message: use the maximum timestamp as the independent oracle.
      const stamp = new Date(Math.max(...rows.messages.map(m => Number(m.createTime))) * 1000)
      const p = n => String(n).padStart(2, '0')
      return { id: s.username, label: s.displayName || s.remark || s.nickname || s.username,
        latest: `${stamp.getFullYear()}-${p(stamp.getMonth() + 1)}-${p(stamp.getDate())} ${p(stamp.getHours())}:${p(stamp.getMinutes())}:${p(stamp.getSeconds())}` }
    }
    return null
  })
  assert(selected, 'No 12-message conversation available')
  record('real-history-oracle-ready', { sessionHash: digest(selected.id), windowSize: 12 })
  const prompt = lang => lang === 'en'
    ? `Reply in English. This is a bounded factual check of my real history. For conversation ID ${selected.id}, first sync_chat_history, then read_session_messages with offset=0, limit=12, newest first. Use only this one 12-message window. State how many messages were returned and quote the newest message timestamp in YYYY-MM-DD HH:MM:SS format. Then give two short English observations supported by this window, explicitly noting the limited coverage. Do not write memory, inspect images, create tasks or query other conversations. Keep the final answer under 120 words.`
    : `请用中文回答。这是对我真实聊天记录的有限事实核验：会话 ID ${selected.id}。先调用 sync_chat_history，再用 read_session_messages 读取 offset=0、limit=12、最新优先。只分析这一个窗口。说明实际返回多少条，并用 YYYY-MM-DD HH:MM:SS 给出最新消息时间。再给出两条有窗口内依据的简短观察，明确说明只覆盖这12条。不要写记忆、看图、创建任务或读取其他会话。最终结论不超过180字。`
  const assess = (messages, lang) => {
    const answers = messages.filter(m => m.role === 'assistant' && m.content?.trim())
    const answer = answers.at(-1)?.content || ''
    const calls = messages.flatMap(m => m.toolCalls || [])
    const han = (answer.match(/\p{Script=Han}/gu) || []).length
    const latin = (answer.match(/[A-Za-z]/g) || []).length
    const read = calls.filter(c => c.name === 'read_session_messages' && c.args?.sessionId === selected.id)
    const timestamps = [...answer.matchAll(/(\d{4}-\d{2}-\d{2})[ T]+(\d{2}:\d{2}(?::\d{2})?)/g)].map(m => `${m[1]} ${m[2]}`)
    const toolText = messages.filter(m => m.role === 'tool' && m.toolName === 'read_session_messages').map(m => m.content || '').join('\n')
    const toolTimestamps = [...toolText.matchAll(/\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\]/g)].map(m => m[1])
    return { nonempty: !!answer.trim(), languagePass: lang === 'en' ? latin > han * 2 : han >= 15,
      newestTimestampExact: answer.includes(selected.latest), countPresent: /(?:12|十二)\s*(?:条|messages)/i.test(answer.replace(/[*_`]/g, '')),
      timestampFormatNormalizedMatch: timestamps.includes(selected.latest),
      answerTimestampCount: timestamps.length, answerMatchesAnyReadTimestamp: timestamps.some(t => toolTimestamps.includes(t)),
      expectedTimestampInToolResult: toolTimestamps.includes(selected.latest),
      firstReadTimestampIsExpected: toolTimestamps[0] === selected.latest,
      answerMatchesMaxReadTimestamp: timestamps.includes([...toolTimestamps].sort().at(-1)),
      answerMatchesMinReadTimestamp: timestamps.includes([...toolTimestamps].sort()[0]),
      answerMatchesLastReadTimestamp: timestamps.includes(toolTimestamps.at(-1)),
      answerTimestampOffsetSeconds: timestamps[0] ? (Date.parse(timestamps[0]) - Date.parse(selected.latest)) / 1000 : null,
      requestedOldestFirst: read.map(c => c.args.oldestFirst === true),
      synced: calls.some(c => c.name === 'sync_chat_history'), readRealSession: read.length > 0,
      requestedTwelve: read.some(c => Number(c.args.limit) === 12 && Number(c.args.offset || 0) === 0),
      readOnlyExpectedConversation: calls.filter(c => c.name === 'read_session_messages').every(c => c.args?.sessionId === selected.id),
      toolNames: [...new Set(calls.map(c => c.name))], answerCharacters: answer.length,
      answerSha256: digest(answer), groundedSummaryManuallyReviewed: false }
  }
  const aiChat = await page.evaluate(async () => (await window.electronAPI.ai.createChat('V1.3 bilingual acceptance')).chat.id)
  for (const lang of (process.argv.includes('--scheduled-only') || process.argv.includes('--digest-only') ? [] : process.argv.includes('--diagnose') ? ['en'] : ['en', 'zh', 'en'])) {
    const before = await page.evaluate(async id => (await window.electronAPI.ai.getChat(id)).messages.length, aiChat)
    const response = await page.evaluate(async ({ id, text }) => {
      const timer = setTimeout(() => window.electronAPI.ai.abort(id), 300000)
      try { return await window.electronAPI.ai.send(id, text) } finally { clearTimeout(timer) }
    }, { id: aiChat, text: prompt(lang) })
    const chat = await page.evaluate(id => window.electronAPI.ai.getChat(id), aiChat)
    const assessment = assess(chat.messages.slice(before), lang)
    record(`ai-${lang}-${result.cases.filter(c => c.name.startsWith('ai-')).length + 1}`, { success: response.success, ...assessment,
      usage: chat.lastRun?.usage ? { promptTokens: chat.lastRun.usage.promptTokens, completionTokens: chat.lastRun.usage.completionTokens } : undefined })
    if (!response.success || !assessment.languagePass || !assessment.newestTimestampExact || !assessment.readRealSession || !assessment.countPresent) result.failures.push(`ai-${lang}`)
  }
  const tasks = []
  for (const lang of (process.argv.includes('--diagnose') || process.argv.includes('--scheduled-only') || process.argv.includes('--digest-only') ? [] : ['en', 'zh'])) {
    const task = await page.evaluate(async ({ text, lang, ref }) => window.electronAPI.weBot.createTask({ title: `V1.3 ${lang} real-history check`, description: text,
      schedule: { kind: 'daily', hour: 23, minute: 59 }, enabled: false, catchUp: 'skip', references: [ref] }),
      { text: prompt(lang), lang, ref: { id: selected.id, label: selected.label, kind: selected.id.endsWith('@chatroom') ? 'group' : 'private' } })
    tasks.push(task.id)
    const beforeChats = await page.evaluate(async () => (await window.electronAPI.ai.listChats()).chats.map(c => c.id))
    const run = await page.evaluate(async id => {
      const timer = setTimeout(async () => {
        const chats = (await window.electronAPI.ai.listChats()).chats.filter(c => c.invocation?.taskId === id)
        for (const chat of chats) await window.electronAPI.ai.abort(chat.id)
      }, 300000)
      try { return await window.electronAPI.weBot.runNow(id) } finally { clearTimeout(timer) }
    }, task.id)
    const data = await page.evaluate(async ({ id, before }) => {
      const runs = await window.electronAPI.weBot.listRuns(id)
      const notes = await window.electronAPI.weBot.listNotes({ taskId: id })
      const chats = (await window.electronAPI.ai.listChats()).chats.filter(c => !before.includes(c.id))
      const chat = chats.length ? await window.electronAPI.ai.getChat(chats[0].id) : null
      return { runs, notes, chat }
    }, { id: task.id, before: beforeChats })
    const assessment = assess(data.chat?.messages || [], lang)
    record(`webot-${lang}`, { dispatchReturned: run.success, runStatus: data.runs[0]?.status, noteCount: data.notes.length,
      automationLabel: data.chat?.chat?.invocation?.kind === 'automation', ...assessment })
    if (data.runs[0]?.status !== 'ok' || data.notes.length !== 1 || !assessment.languagePass || !assessment.newestTimestampExact || !assessment.readRealSession) result.failures.push(`webot-${lang}`)
  }
  if (!process.argv.includes('--diagnose') && !process.argv.includes('--digest-only')) for (const lang of ['en', 'zh']) {
    const beforeChats = await page.evaluate(async () => (await window.electronAPI.ai.listChats()).chats.map(c => c.id))
    const task = await page.evaluate(async ({ text, lang, ref }) => window.electronAPI.weBot.createTask({ title: `V1.3 ${lang} timer acceptance`, description: text,
      schedule: { kind: 'interval', everyMinutes: 60, anchorMs: Date.now() + 15000 }, enabled: true, catchUp: 'once', references: [ref] }),
      { text: prompt(lang), lang, ref: { id: selected.id, label: selected.label, kind: selected.id.endsWith('@chatroom') ? 'group' : 'private' } })
    tasks.push(task.id)
    assert(task.id && task.enabled && Number.isFinite(task.nextRunAt), 'Timer task was not enabled')
    record(`webot-timer-${lang}-armed`, { delayMs: task.nextRunAt - Date.now() })
    const timerStarted = Date.now()
    let finished = false
    while (Date.now() - timerStarted < 300000) {
      finished = await page.evaluate(async id => {
        const runs = await window.electronAPI.weBot.listRuns(id)
        return runs.length > 0 && runs.some(r => r.status !== 'running')
      }, task.id)
      if (finished) break
      await new Promise(r => setTimeout(r, 1000))
    }
    assert(finished, 'Scheduled task did not finish within five minutes')
    await page.evaluate(id => window.electronAPI.weBot.updateTask(id, { enabled: false }), task.id)
    const data = await page.evaluate(async ({ id, before }) => {
      const runs = await window.electronAPI.weBot.listRuns(id)
      const notes = await window.electronAPI.weBot.listNotes({ taskId: id })
      const chats = (await window.electronAPI.ai.listChats()).chats.filter(c => !before.includes(c.id))
      return { runs, notes, chat: chats.length ? await window.electronAPI.ai.getChat(chats[0].id) : null }
    }, { id: task.id, before: beforeChats })
    const assessment = assess(data.chat?.messages || [], lang)
    record(`webot-timer-${lang}`, { runCount: data.runs.length, runStatus: data.runs[0]?.status,
      noteCount: data.notes.length, scheduledAtPresent: Number.isFinite(data.runs[0]?.scheduledAt), ...assessment })
    if (data.runs.length !== 1 || data.runs[0]?.status !== 'ok' || data.notes.length !== 1 || !assessment.languagePass || !assessment.newestTimestampExact || !assessment.readRealSession) result.failures.push(`webot-timer-${lang}`)
  }
  if (process.argv.includes('--digest-only')) for (const lang of ['en', 'zh']) {
    const beforeChats = await page.evaluate(async () => (await window.electronAPI.ai.listChats()).chats.map(chat => chat.id))
    const task = await page.evaluate(async ({ sessionId, label, lang, startTime }) => {
      const accountId = await window.electronAPI.dataAccess.currentAccount()
      return window.electronAPI.weBot.createTask({ title: `V1.3 delta ${lang}`, enabled: false, schedule: { kind: 'daily', hour: 23, minute: 59 }, catchUp: 'skip',
        description: lang === 'en' ? 'Reply entirely in English. Summarize only the supplied new evidence. Cite the provided exact source links. Explicitly state that this is a limited snapshot and do not infer image contents.' : '请全程用中文回答。只总结提供的新增证据，引用给定来源链接，明确说明仅是有限快照，不能猜测图片内容。',
        references: [{ id: sessionId, label, kind: sessionId.endsWith('@chatroom') ? 'group' : 'private' }],
        digest: { template: 'weekly-highlights', scope: { accountId, sessionIds: [sessionId], startTime }, limits: { maxMessages: 1000, maxInputChars: 100000, maxTotalTokens: 8000, timeoutMs: 240000 } } })
    }, { sessionId: selected.id, label: selected.label, lang, startTime: Math.floor(new Date(selected.latest.replace(' ', 'T')).getTime() / 1000) })
    tasks.push(task.id)
    await page.evaluate(id => window.electronAPI.weBot.runNow(id), task.id)
    const first = await page.evaluate(async ({ id, beforeChats }) => {
      const notes = await window.electronAPI.weBot.listNotes({ taskId: id }), runs = await window.electronAPI.weBot.listRuns(id)
      const metadata = (await window.electronAPI.ai.listChats()).chats.find(chat => !beforeChats.includes(chat.id))
      const chat = metadata ? await window.electronAPI.ai.getChat(metadata.id) : null
      const ids = [...String(notes[0]?.summary || '').matchAll(/weport-evidence:([a-f0-9]{64})/g)].map(match => match[1])
      const citations = await Promise.all([...new Set(ids)].map(id => window.electronAPI.ai.resolveEvidence(id)))
      return { notes, runs, chat, citationCount: citations.length, citationsResolve: citations.every(citation => citation.success) }
    }, { id: task.id, beforeChats })
    const answer = first.notes[0]?.summary || '', han = (answer.match(/\p{Script=Han}/gu) || []).length, latin = (answer.match(/[A-Za-z]/g) || []).length
    const pass = first.runs[0]?.status === 'ok' && first.runs[0]?.outcome === 'committed' && first.notes.length === 1 && first.citationCount > 0 && first.citationsResolve
      && (lang === 'en' ? latin > han * 2 : han >= 15) && !first.chat?.messages.some(message => message.toolCalls?.length)
    record(`delta-${lang}-committed`, { success: pass, runStatus: first.runs[0]?.status, outcome: first.runs[0]?.outcome,
      noteCount: first.notes.length, citationCount: first.citationCount, citationsResolve: first.citationsResolve, languagePass: lang === 'en' ? latin > han * 2 : han >= 15,
      noAdditionalToolReads: !first.chat?.messages.some(message => message.toolCalls?.length), answerSha256: digest(answer) })
    if (!pass) result.failures.push(`delta-${lang}`)
    const beforeRepeatChats = await page.evaluate(async () => (await window.electronAPI.ai.listChats()).chats.length)
    await page.evaluate(id => window.electronAPI.weBot.runNow(id), task.id)
    const repeated = await page.evaluate(async id => ({ notes: (await window.electronAPI.weBot.listNotes({ taskId: id })).length,
      latest: (await window.electronAPI.weBot.listRuns(id))[0], chats: (await window.electronAPI.ai.listChats()).chats.length }), task.id)
    const quiet = repeated.notes === 1 && ['no-change', 'duplicate'].includes(repeated.latest?.outcome) && repeated.chats === beforeRepeatChats
    record(`delta-${lang}-quiet-repeat`, { success: quiet, notes: repeated.notes, outcome: repeated.latest?.outcome, noNewModelChat: repeated.chats === beforeRepeatChats })
    if (!quiet) result.failures.push(`delta-${lang}-repeat`)
  }
  await app.close(); app = null
  await launch()
  const persisted = await page.evaluate(async ids => {
    const notes = await window.electronAPI.weBot.listNotes({ limit: 100 })
    const tasks = await window.electronAPI.weBot.listTasks()
    return { notes: notes.filter(n => ids.includes(n.taskId)).length, tasks: tasks.filter(t => ids.includes(t.id)).length }
  }, tasks)
  assert.equal(persisted.tasks, tasks.length); assert.equal(persisted.notes, tasks.length)
  record('webot-real-notes-survive-process-restart', persisted)
  const protectedAfter = Object.fromEntries(protectedNames.map(n => [n, fileHash(path.join(real, n))]))
  result.realProfileUnchanged = JSON.stringify(protectedAfter) === JSON.stringify(protectedBefore)
  assert(result.realProfileUnchanged, 'Original profile changed during private test')
  result.ok = result.failures.length === 0
} catch (error) {
  result.ok = false
  // Errors can include paths or provider output: retain only the harness category.
  result.errorCategory = error?.name || 'Error'
  result.harnessError = String(error?.message || '').replace(/(?:sk-|Bearer\s+)[A-Za-z0-9_.-]+/g, '[REDACTED]').slice(0, 300)
  console.log(JSON.stringify({ ok: false, errorCategory: result.errorCategory, error: result.harnessError }))
  process.exitCode = 1
} finally {
  if (app) await app.close().catch(() => {})
  const resolved = path.resolve(scratch)
  assert(path.dirname(resolved) === path.resolve(os.tmpdir()) && path.basename(resolved).startsWith('weport-v13-ai-private-'))
  fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 5 })
  result.privateCleanupVerified = !fs.existsSync(resolved)
  result.finishedAt = new Date().toISOString()
  fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify(result, null, 2))
  console.log(JSON.stringify({ ok: result.ok, privateCleanupVerified: result.privateCleanupVerified, receipt: path.join(out, 'result.json') }))
  if (!result.ok) process.exitCode = 1
}
