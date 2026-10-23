import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { createRequire, builtinModules } from 'node:module'
import { spawn } from 'node:child_process'
import { passesGroundednessRubric } from './lib/groundedness-rubric.mjs'

// Real configured DeepSeek, fixed synthetic evidence; source-service evidence only.
// No appMain, renderer, BrowserWindow construction, desktop interaction, or real history.
const require = createRequire(import.meta.url)
const root = path.resolve('.'), preflight = process.argv.includes('--preflight')
const general = process.argv.includes('--general-analysis')
const runnerName = general ? 'general-analysis-background.cjs' : 'groundedness-background.cjs'
const expectedCases = general ? 2 : 6
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'weport-v13-groundedness-'))
const profile = path.join(scratch, 'profile')
const receiptName = general ? 'v13-general-analysis' : 'v13-groundedness'
const output = path.resolve(`.ui-probe/${receiptName}${preflight ? '-preflight' : ''}.json`)
const original = path.join(process.env.APPDATA, 'weport')
const hash = value => createHash('sha256').update(value).digest('hex')
const originals = {}
const receipt = { data: 'Six fixed synthetic evidence tasks in English and Chinese; real configured DeepSeek; no genuine multi-account acceptance',
  evidenceKind: 'source-bundled production service; not packaged application acceptance', mode: preflight ? 'zero-network-import-preflight' : 'six-case-real-provider',
  startedAt: new Date().toISOString(), checks: [], maxProviderRequests: preflight ? 0 : 6 }
fs.mkdirSync(profile); fs.mkdirSync(path.dirname(output), { recursive: true })
if (fs.existsSync(output)) {
  const previous = fs.readFileSync(output), archive = path.join(path.dirname(output), 'groundedness-receipts')
  fs.mkdirSync(archive, { recursive: true })
  const archivedReceipt = path.join(archive, `${hash(previous)}.json`)
  if (!fs.existsSync(archivedReceipt)) fs.writeFileSync(archivedReceipt, previous, { flag: 'wx' })
  receipt.previousReceiptSha256 = hash(previous)
}
try {
  for (const name of ['Weport-config.json', 'Local State']) originals[name] = hash(fs.readFileSync(path.join(original, name)))
  const config = JSON.parse(fs.readFileSync(path.join(original, 'Weport-config.json'), 'utf8'))
  Object.assign(config, { dbPath: path.join(scratch, 'accounts'), myWxid: 'groundedness-fixture', wxidConfigs: {}, decryptKey: '',
    exportPath: path.join(scratch, 'exports'), cachePath: path.join(scratch, 'media'), weportAiWorkspaceRoot: path.join(scratch, 'workspace'),
    weportAiCustomPrompt: '', mcpEnabled: false, httpApiEnabled: false, messagePushEnabled: false, launchAtStartup: false,
    appearanceBackgroundPath: '', connectorsAllowAgent: false, weportAiReasoningEffort: 'low', logEnabled: false })
  fs.writeFileSync(path.join(profile, 'Weport-config.json'), JSON.stringify(config), { mode: 0o600 })
  fs.copyFileSync(path.join(original, 'Local State'), path.join(profile, 'Local State'))
  const fixtures = [
    { kind: 'temporal-conflict', en: '[old, 2026-10-01] Deadline is Friday. [new, 2026-10-02] Correction: propose Monday, still awaiting confirmation.',
      zh: '[old, 2026-10-01] 截止时间是周五。[new, 2026-10-02] 更正：建议改到周一，仍待确认。', status: 'uncertain', sources: ['new', 'old'] },
    { kind: 'deleted-source', en: 'A prior AI note claimed the event happened. Its only cited message was deleted and cannot be retrieved. No other evidence is available.',
      zh: '以前的 AI 笔记说事件发生了。唯一引用的消息已删除，无法读取，也没有其他证据。', status: 'unknown', sources: [] },
    { kind: 'changed-source', en: 'A cached claim cites source X with content hash AAA. Resolving X now returns hash BBB. The changed message text was not supplied. Decide whether the cached claim is currently verified.',
      zh: '缓存结论引用来源 X，原内容哈希为 AAA。现在解析 X 返回 BBB，未提供变更后的原文。判断缓存结论现在是否已经核实。', status: 'unknown', sources: [] },
  ]
  const cases = []
  for (const fixture of general ? [] : fixtures) for (const language of ['en', 'zh']) {
    const instruction = language === 'en'
      ? 'Use only the supplied evidence. Answer in English. Return ONLY JSON with status (uncertain or unknown), verified (boolean), sourceIds (array of usable supplied IDs), and reason (one sentence). Include both source IDs when messages conflict; a proposal awaiting confirmation is uncertain. A missing or changed source with no current text cannot verify an earlier claim.'
      : '仅根据给定证据用中文回答。只返回 JSON，字段为 status（uncertain 或 unknown）、verified（布尔值）、sourceIds（可用证据 ID 数组）、reason（中文一句话）。消息冲突时保留两个来源 ID；尚未确认的建议属于 uncertain。来源缺失或变更且没有当前原文时，不能核实旧结论。'
    cases.push({ fixture, language, text: instruction + '\nEvidence:\n' + fixture[language] })
  }
  if(general) {
    receipt.data='Two broad personal-history analysis tasks in English and Chinese; synthetic tools, production prompt and actual configured DeepSeek'
    receipt.mode=preflight?'zero-network-import-preflight':'bilingual-general-analysis'
    receipt.maxProviderRequests=preflight?0:24
    for(const language of ['en','zh']) cases.push({fixture:{kind:'general-analysis'},language,text:language==='en'
      ? 'Analyze how my interests, daily habits and relationships have changed over my available chat history. Give evidence, important changes and uncertainties. Answer in English.'
      : '请全面分析我的兴趣、日常习惯和人际关系在现有聊天历史中如何变化，给出证据、重要变化和不确定性。用中文回答。'})
  }
  fs.writeFileSync(path.join(scratch, 'cases.json'), JSON.stringify({ preflight, cases }), { mode: 0o600 })
  const { build } = require('esbuild')
  const bundle = path.join(scratch, 'groundedness-services.cjs')
  const built = await build({ stdin: { contents: `export { WeportAiService } from './electron/services/weportAiService'; export { ConfigService } from './electron/services/config'`, resolveDir: root },
    bundle: true, platform: 'node', format: 'cjs', packages: 'external', metafile: true, outfile: bundle, logLevel: 'silent',
    plugins: [{ name: 'explicit-production-dependencies', setup(b) { b.onResolve({ filter: /^[^./]/ }, args => {
      if (args.path === 'electron' || args.path.startsWith('node:') || builtinModules.includes(args.path)) return { path: args.path, external: true }
      try { return { path: require.resolve(args.path, { paths: [root] }), external: true } }
      catch { return { path: args.path, external: true } }
    }) } }] })
  const sourceFiles = Object.keys(built.metafile.inputs).filter(file => file !== '<stdin>').sort()
  receipt.sourceInputs = Object.fromEntries(sourceFiles.map(file => [file.replaceAll('\\', '/'), hash(fs.readFileSync(path.resolve(root, file)))]))
  receipt.sourceInputs['scripts/verify-v13-ai-groundedness.mjs'] = hash(fs.readFileSync(import.meta.filename))
  receipt.sourceInputs['scripts/lib/'+runnerName] = hash(fs.readFileSync(path.join(root, 'scripts/lib',runnerName)))
  receipt.sourceInputs['scripts/lib/groundedness-rubric.mjs'] = hash(fs.readFileSync(path.join(root, 'scripts/lib/groundedness-rubric.mjs')))
  for (const file of ['package.json', 'package-lock.json']) receipt.sourceInputs[file] = hash(fs.readFileSync(path.join(root, file)))
  receipt.sourceInputDigest = hash(JSON.stringify(receipt.sourceInputs))
  receipt.sourceBundleSha256 = hash(fs.readFileSync(bundle))
  receipt.electronRuntimeSha256 = hash(fs.readFileSync(require('electron')))
  if (!preflight) {
    const preflightFile = path.resolve(`.ui-probe/${receiptName}-preflight.json`)
    const proven = JSON.parse(fs.readFileSync(preflightFile, 'utf8'))
    assert(proven.ok && proven.windowsCreated === 0 && proven.windowsRemaining === 0 && proven.providerRequests === 0 && proven.privateCleanupVerified, 'Zero-window preflight required')
    assert.equal(proven.sourceInputDigest, receipt.sourceInputDigest, 'Source changed since preflight')
    assert.equal(proven.sourceBundleSha256, receipt.sourceBundleSha256, 'Bundle changed since preflight')
    assert.equal(proven.electronRuntimeSha256, receipt.electronRuntimeSha256, 'Runtime changed since preflight')
    receipt.preflightReceiptSha256 = hash(fs.readFileSync(preflightFile))
  }
  const packagedAsar = path.join(root, 'release/win-unpacked/resources/app.asar')
  receipt.packageArtifact = { exercised: false, ...(fs.existsSync(packagedAsar) ? { appAsarSha256: hash(fs.readFileSync(packagedAsar)) } : {}) }
  fs.copyFileSync(path.join(root, 'scripts/lib',runnerName), path.join(scratch, 'runner.cjs'))
  const env = { ...process.env, NODE_PATH: path.join(root, 'node_modules'), WEPORT_USER_DATA_PATH: profile }
  for (const key of Object.keys(env)) if (key === 'ELECTRON_RUN_AS_NODE' || key.startsWith('WEPORT_AI_PROBE_')) delete env[key]
  const child = spawn(require('electron'), [path.join(scratch, 'runner.cjs'), `--user-data-dir=${profile}`], { cwd: scratch, env, windowsHide: true, stdio: 'ignore' })
  const childExit = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error('Background helper timed out')) }, preflight ? 90000 : 800000)
    child.on('error', error => { clearTimeout(timer); reject(error) })
    child.on('exit', code => { clearTimeout(timer); resolve(code) })
  })
  const resultFile = path.join(scratch, 'result.json')
  assert(fs.existsSync(resultFile), 'Background helper produced no result')
  const result = JSON.parse(fs.readFileSync(resultFile, 'utf8'))
  Object.assign(receipt, { provider: result.provider, windowsCreated: result.windowsCreated, windowsRemaining: result.windowsRemaining,
    providerRequests: result.providerRequests, completedCases: result.rows.length, helperStage: result.stage, lastRunSucceeded: result.lastRunSucceeded })
  for (const [index, row] of result.rows.entries()) {
    const { fixture, language, text } = cases[index]
    let value, passed = false
    try { const match = row.answer.match(/\{[\s\S]*\}/); if (match) value = JSON.parse(match[0])
      passed = general ? row.passed === true : passesGroundednessRubric(value, fixture, language, row.messages)
    } catch { /* malformed model JSON is a strict rubric failure */ }
    if(general) passed=row.passed===true
    receipt.checks.push({ kind: fixture.kind, language, passed, strategy:row.strategy, status: value?.status, verified: value?.verified,
      sourceIds: value?.sourceIds, inputSha256: hash(text), answerSha256: hash(row.answer), usage: row.usage })
    console.log(`${fixture.kind} ${language}: ${passed ? 'PASS' : 'FAIL'}`)
  }
  receipt.sourceInputsUnchanged = Object.entries(receipt.sourceInputs).every(([file, digest]) => hash(fs.readFileSync(path.resolve(root, file))) === digest)
  assert(receipt.sourceInputsUnchanged, 'Source inputs changed during acceptance')
  assert.equal(childExit, 0, 'Background helper failed')
  assert.equal(result.windowsCreated, 0); assert.equal(result.windowsRemaining, 0)
  if(!general) assert.equal(result.providerRequests, preflight ? 0 : 6)
  assert.equal(receipt.checks.length, preflight ? 0 : expectedCases)
  assert(receipt.checks.every(check => check.passed), 'Groundedness rubric failed')
  receipt.ok = true
} catch (error) {
  receipt.ok = false; receipt.error = 'Groundedness acceptance failed; raw model output and private errors withheld'
  receipt.errorType = error.name; process.exitCode = 1
} finally {
  receipt.realProfileUnchanged = Object.entries(originals).length === 2 && Object.entries(originals).every(([name, digest]) => hash(fs.readFileSync(path.join(original, name))) === digest)
  if (!receipt.realProfileUnchanged) { receipt.ok = false; process.exitCode = 1 }
  assert.equal(path.dirname(path.resolve(scratch)), path.resolve(os.tmpdir())); assert(path.basename(scratch).startsWith('weport-v13-groundedness-'))
  fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 5 }); receipt.privateCleanupVerified = !fs.existsSync(scratch)
  if (!receipt.privateCleanupVerified) { receipt.ok = false; process.exitCode = 1 }
  receipt.finishedAt = new Date().toISOString()
  fs.writeFileSync(output, JSON.stringify(receipt, null, 2)); console.log(JSON.stringify({ ok: receipt.ok, receipt: output }))
}
