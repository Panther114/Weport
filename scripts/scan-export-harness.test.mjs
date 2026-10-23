import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { prepareScanExports } from './verify-v13-scan-exports.mjs'

const require = createRequire(import.meta.url)
const hash = value => createHash('sha256').update(value).digest('hex')
const root = path.resolve(import.meta.dirname, '..')

test('actual generated export verifier compares the app/native session union and rejects missing rows', async () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'weport-export-harness-test-'))
  try {
    await prepareScanExports(root, scratch)
    const source = fs.readFileSync(path.join(scratch, 'export-runner.cjs'), 'utf8')
    for (const omitExtra of [false, true]) {
      for (const file of ['export-result.json', 'export-failure.json']) fs.rmSync(path.join(scratch, file), { force: true })
      const baselineDir = path.join(scratch, 'baseline'), mirrorDir = path.join(scratch, 'mirror')
      fs.writeFileSync(path.join(scratch, 'export-material.json'), JSON.stringify({ baselineDir, mirrorDir, originalAccount: path.join(scratch, 'original'), myWxid: 'fixture', imageXorKey: 23, imageAesKey: 'synthetic-not-a-credential' }))
      let activeDir = baselineDir, nextCursor = 0
      const cursors = new Map()
      const configuration = new Map()
      const runtimes = []
      const row = id => ({ _db_path: path.join(activeDir, 'db_storage', 'message', 'message_0.db'), _table_name: 'Msg', local_id: id === 'history' ? '1' : '2' })
      const identity = id => hash('db_storage/message/message_0.db\0msg\0' + (id === 'history' ? '1' : '2'))
      const services = {
        isNoLoginDbKeyScanEnabled: () => false,
        ConfigService: class { set(key, value) { configuration.set(key, value) } get(key) { return configuration.get(key) || '' } },
        wcdbService: {
          setPaths() {}, setLogEnabled() {}, shutdown: async () => {},
          getSessions: async () => ({ success: true, sessions: [{ username: 'history' }] }),
          getMessageCount: async () => ({ success: true, count: 1 }),
          openMessageCursor: async id => { cursors.set(++nextCursor, id); return { success: true, cursor: nextCursor } },
          fetchMessageBatch: async cursor => ({ success: true, rows: [row(cursors.get(cursor))], hasMore: false }),
          closeMessageCursor: async cursor => { cursors.delete(cursor) },
        },
        chatService: {
          close: async () => {}, connect: async () => ({ success: true }),
          getSessions: async () => ({ success: true, sessions: [{ username: 'history' }, { username: 'app-only' }] }),
          getMessages: async () => ({ success: true, messages: [], hasMore: false }),
        },
        ExportServiceFacade: class {
          setRuntimeConfig(config) { activeDir = config.accountDir; runtimes.push(config) }
          async exportSessions(ids, directory, options) {
            fs.mkdirSync(directory, { recursive: true })
            const sessionOutputPaths = {}
            for (const id of ids) {
              const file = path.join(directory, id + '.' + options.format)
              fs.writeFileSync(file, options.format === 'json' ? JSON.stringify({ messages: omitExtra && id === 'app-only' ? [] : [{ sourceIdentityHash: identity(id), content: id }] }) : id)
              sessionOutputPaths[id] = file
            }
            return { success: true, failCount: 0, successCount: ids.length, sessionOutputPaths }
          }
        },
      }
      let finish
      const exit = new Promise(resolve => { finish = resolve })
      const electron = { app: { setPath() {}, on() {}, whenReady: () => Promise.resolve(), getPath: () => scratch, exit: finish }, BrowserWindow: { getAllWindows: () => [] } }
      vm.runInNewContext(source, { __dirname: scratch, Buffer, process: { env: {} }, console: { log() {}, warn() {}, error() {} }, require: name => name === 'electron' ? electron : name === './export-helpers.cjs' ? services : require(name) }, { filename: 'export-runner.cjs' })
      const code = await exit
      assert.equal(code, omitExtra ? 1 : 0)
      if (omitExtra) {
        const failure = JSON.parse(fs.readFileSync(path.join(scratch, 'export-failure.json')))
        assert.equal(failure.assertion, 'EXPORT_NATIVE_UNION_PHYSICAL_HISTORY_MISMATCH')
        assert.equal(failure.stage, 'baseline-json-identity-audit')
      } else {
        const result = JSON.parse(fs.readFileSync(path.join(scratch, 'export-result.json')))
        assert.equal(result.productionExportsProven, true)
        assert.equal(result.mediaOpeningProven, false)
        assert.equal(result.results[0].sessions, 2)
        assert.equal(result.results[0].nativeSessionCount, 1)
        assert.equal(result.results[0].nativeUnionMessages, 2)
        assert.equal(result.results[0].messages, 2)
      }
      assert.equal(cursors.size, 0)
      for (const field of ['dbPath', 'myWxid', 'imageAesKey', 'imageXorKey']) assert.equal(configuration.has(field), false)
      assert(runtimes.length > 0)
      assert(runtimes.every(config => config.myWxid === 'fixture' && config.imageAesKey === 'synthetic-not-a-credential' && config.imageXorKey === 23))
    }
  } finally {
    assert.equal(path.dirname(path.resolve(scratch)), path.resolve(os.tmpdir()))
    assert(path.basename(scratch).startsWith('weport-export-harness-test-'))
    fs.rmSync(scratch, { recursive: true, force: true })
  }
})
