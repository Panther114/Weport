import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'

export async function verifyFixtureModules(page, scratch, manifest, result, output = '.ui-probe/mac-native-positive') {
  result.exports = []
  for (const format of ['txt','json','html','excel','markdown','chatlab','chatlab-jsonl','arkme-json','weclone','sql']) {
    const out = join(scratch, 'exports', format)
    const options = { format, sessionIds: [manifest.contact], exportMedia: false, exportAvatars: false, exportConflictStrategy: 'incremental' }
    const first = await page.evaluate(({ out, options }) => window.electronAPI.export.exportSessions(out, options), { out, options })
    const record = { format, first }; result.exports.push(record)
    assert.equal(first.success, true); assert.equal(first.failCount, 0); assert.equal(first.successCount, 1)
    const artifact = first.sessionOutputPaths[manifest.contact]
    record.independent = JSON.parse(execFileSync('python3', ['scripts/verify-mac-export-artifact.py', format, artifact], { encoding: 'utf8' }))
    const digest = () => createHash('sha256').update(readFileSync(artifact)).digest('hex')
    const before = digest()
    record.repeat = await page.evaluate(({ out, options }) => window.electronAPI.export.exportSessions(out, options), { out, options })
    assert.equal(record.repeat.success, true); assert.equal(digest(), before)
    record.repeatArtifactUnchanged = true
    // A ledger match must never skip a damaged export. Parse the repaired bytes
    // independently; XLSX timestamps may differ, so byte equality is not required.
    writeFileSync(artifact, 'Deliberately damaged synthetic export')
    record.repair = await page.evaluate(({ out, options }) => window.electronAPI.export.exportSessions(out, options), { out, options })
    assert.equal(record.repair.success, true)
    assert.equal(record.repair.failCount, 0)
    record.repairedArtifact = JSON.parse(execFileSync('python3', ['scripts/verify-mac-export-artifact.py', format, artifact], { encoding: 'utf8' }))
  }
  result.readerSearch = await page.evaluate(async contact => {
    const api = window.electronAPI
    const counts = await api.chat.getSessionMessageCounts([contact])
    const dates = await api.chat.getMessageDates(contact)
    const directSearch = await api.chat.searchMessages('incoming', contact, 10, 0)
    const directSearchVariants = []
    for (const [keyword, session, begin, end] of [
      ['Synthetic', contact, undefined, undefined], ['outgoing', contact, undefined, undefined],
      ['incoming', undefined, undefined, undefined], ['incoming', contact, 1791599900, 1791600100],
      ['incoming', contact, 0, 2147483647], ['Synthetic incoming message', contact, undefined, undefined],
    ]) directSearchVariants.push({ keyword, session, begin, end, result: await api.chat.searchMessages(keyword, session, 10, 0, begin, end) })
    const build = await api.search.buildIndex({ force: true, wxid: 'qa_account' })
    const deadline = Date.now() + 120000
    let status
    do { status = await api.search.indexStatus(); if (!status.building) break; await new Promise(r => setTimeout(r, 100)) } while (Date.now() < deadline)
    const search = await api.search.query({ text: 'incoming', limit: 10 })
    const hit = search.hits?.[0]
    const identity = hit ? await api.chat.getMessageByIdentity({ sessionId: hit.sessionId, localId: hit.localId, ts: hit.ts, db: hit.db, table: hit.table, idKind: hit.idKind }) : null
    return { counts, dates, directSearch, directSearchVariants, build, status, search, identity }
  }, manifest.contact)
  const r = result.readerSearch
  assert.equal(r.counts.counts[manifest.contact], 2)
  assert.equal(r.dates.success, true); assert(r.dates.dates.length > 0)
  assert.equal(r.search.hits.length, 1)
  assert.equal(r.identity.message.parsedContent, manifest.messages[0][3])
  result.indexedSearchAccepted = true
  result.nativeFtsAcceptance = { verified: false, reason: 'Synthetic fixture has no message_fts.db; direct FTS search is not a positive acceptance gate' }
  // Reload normally so the renderer reads the real private profile persisted above.
  await page.reload()
  await page.locator('.rail-item').first().waitFor({ timeout: 30000 })
  // Hidden/offscreen Chromium windows can stop requestAnimationFrame polling.
  // Readiness is a DOM state assertion, so keep the same deadline with a timer.
  await page.waitForFunction(() => document.querySelector('.rail-item[data-tab="reader"]')?.disabled === false,
    null, { timeout: 30000, polling: 100 })
  await page.locator('.rail-item[data-tab="reader"]').click()
  await page.locator('.reader-session').first().click()
  await page.locator('.reader-row').first().waitFor({ timeout: 30000 })
  await page.locator('.reader-search-input').fill('incoming')
  await page.waitForFunction(() => {
    const note = document.querySelector('.reader-hits-note')?.textContent || ''
    return note && !note.includes('正在搜索')
  }, null, { timeout: 30000, polling: 100 })
  result.readerSearchUI = { hits: await page.locator('.reader-hit-row').count(),
    note: await page.locator('.reader-hits-note').textContent(),
    excerpt: await page.locator('.reader-hit-excerpt').allTextContents() }
  await page.screenshot({ path: join(output, 'reader-search.png') })
  assert.equal(result.readerSearchUI.hits, 1, 'Reader must retain a loaded matching message when optional FTS search returns empty')
  assert.equal(result.readerSearchUI.excerpt[0], manifest.messages[0][3])
  result.persistedIndex = await page.evaluate(() => window.electronAPI.search.query({ text: 'outgoing', limit: 10 }))
  assert.equal(result.persistedIndex.hits.length, 1, 'Search index must remain usable after renderer reload')
  result.paging = await page.evaluate(async contact => {
    const api = window.electronAPI
    return { first: await api.chat.getMessages(contact, 0, 1), second: await api.chat.getMessages(contact, 1, 1),
      absent: await api.chat.getMessages(contact, 10, 1) }
  }, manifest.contact)
  assert.equal(result.paging.first.messages.length, 1)
  assert.equal(result.paging.second.messages.length, 1)
  assert.notEqual(result.paging.first.messages[0].localId, result.paging.second.messages[0].localId)
  assert.equal(result.paging.absent.messages.length, 0)
  result.fixtureModulesAccepted = true
}
