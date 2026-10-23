// Private Electron main-process entry: readiness + safeStorage, no application/UI bootstrap.
const { app, BrowserWindow } = require('electron')
const fs = require('node:fs'), path = require('node:path')
app.setPath('userData', path.join(__dirname, 'profile'))
app.on('window-all-closed', () => {})
console.log = console.warn = console.error = () => {}
const result = { stage: 'ready', windowsCreated: 0, windowsRemaining: 0, providerRequests: 0, rows: [] }
const check = (value, message) => { if (!value) throw new Error(message) }
const save = code => {
  result.windowsRemaining = BrowserWindow.getAllWindows().length
  fs.writeFileSync(path.join(__dirname, 'result.json'), JSON.stringify(result), { mode: 0o600 })
  app.exit(code)
}
app.on('browser-window-created', () => { result.windowsCreated++; result.stage = 'unexpected-window'; save(1) })
const nativeFetch = globalThis.fetch
let liveCase = false, caseRequests = 0
// No metadata discovery, title generation, retries, or extra provider calls in acceptance.
// The normal provider adapter still owns credentials, protocol, request shape and transport.
globalThis.fetch = async (url, init = {}) => {
  check(liveCase && init.method === 'POST' && caseRequests === 0 && result.providerRequests < 6, 'Network budget exceeded')
  caseRequests++; result.providerRequests++
  return nativeFetch(url, init)
}
app.whenReady().then(async () => {
  const { preflight, cases } = JSON.parse(fs.readFileSync(path.join(__dirname, 'cases.json'), 'utf8'))
  result.stage = 'import-services'
  const { WeportAiService, ConfigService } = require('./groundedness-services.cjs')
  const config = ConfigService.getInstance()
  check(path.resolve(app.getPath('userData')) === path.join(__dirname, 'profile'), 'Private profile mismatch')
  check(config.get('myWxid') === 'groundedness-fixture', 'Private configuration unavailable')
  const service = new WeportAiService()
  result.stage = 'select-provider'
  const setup = service.getSetup()
  const profile = setup.profiles.find(row => row.providerId === 'deepseek' && row.hasApiKey)
    || setup.profiles.find(row => /deepseek/i.test(row.name + ' ' + row.model) && row.hasApiKey)
  check(profile, 'Configured DeepSeek unavailable')
  check(service.assignConsumerProfile('chat', profile.id).success, 'Provider assignment failed')
  result.provider = { provider: profile.providerId, model: profile.model }
  check(BrowserWindow.getAllWindows().length === 0 && result.windowsCreated === 0, 'Window invariant failed')
  if (preflight) { result.stage = 'preflight-complete'; save(0); return }
  check(cases.length === 6, 'Expected exactly six cases')
  for (const [index, item] of cases.entries()) {
    result.stage = 'case-' + (index + 1)
    const chat = service.createChat('Synthetic groundedness evaluation')
    caseRequests = 0; liveCase = true
    const timeout = setTimeout(() => service.abort(chat.id), 120000)
    let response
    try { response = await service.runChat(chat.id, item.text, { tools: 'none', maxSteps: 1, maxTotalTokens: 4000 }) }
    finally { clearTimeout(timeout); liveCase = false }
    result.lastRunSucceeded = response.success
    check(response.success, 'Provider run failed')
    check(caseRequests === 1, 'Expected one provider request per case')
    const data = service.getChat(chat.id)
    const answer = data.messages.filter(row => row.role === 'assistant').at(-1)?.content || ''
    result.rows.push({ answer, messages: data.messages.map(row => ({ role: row.role, toolCalls: row.toolCalls })), usage: data.lastRun?.usage })
    check(BrowserWindow.getAllWindows().length === 0 && result.windowsCreated === 0, 'Window invariant failed')
  }
  result.stage = 'six-cases-complete'; save(0)
}).catch(error => { result.errorType = error.name; save(1) })
