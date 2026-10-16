import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import crypto from 'crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  DEFAULT_LOG_TAIL_LINES,
  DiagnosticsService,
  buildBundleEntries,
  bytesPerSecond,
  collectDiagnostics,
  countCheckStates,
  groupOfCheckId,
  oneLine,
  parsePowerShellBool,
  parsePsOutput,
  parseRegQueryValue,
  parseTasklistPid,
  pickErrorLines,
  renderChecksMarkdown,
  resolveConfigFilePath,
  resolveLogPath,
  tailText,
  truncateLine,
  weChatExeCandidates,
  wcdbDllCandidates,
  type DiagnosticsContext,
  type DiagnosticsReport,
} from './diagnosticsService'
import { createZipBuffer, readZipBuffer } from './zipWriter'
import { CONFIG_BUNDLE_ALLOWLIST, redactionFingerprint } from './diagnosticsRedaction'

const savedKey = vi.hoisted(() => ({ value: '' }))
vi.mock('./config', () => ({ ConfigService: { getInstance: () => ({ get: () => savedKey.value }) } }))

/**
 * 诊断服务单测。
 *
 * 覆盖三件事：
 *   1. 检查记录的形状（id/label/state/detail）与"绝不出现未知错误"的文案纪律；
 *   2. 纯解析函数（进程列表、注册表、日志尾）；
 *   3. **脱敏保证**：夹具配置 → 真包 → 逐字节扫描密钥。
 */

// === 纯函数 ===

describe('live file rate', () => {
  it('reports non-negative byte growth per second and marks the first sample unknown', () => {
    expect(bytesPerSecond(200, undefined, 1000)).toBeNull()
    expect(bytesPerSecond(300, 200, 2000)).toBe(50)
    expect(bytesPerSecond(100, 200, 1000)).toBe(0)
    expect(bytesPerSecond(300, 200, 0)).toBeNull()
  })
})

describe('tailText', () => {
  it('取末尾 N 行、丢掉结尾空行、行数不足时全给', () => {
    expect(tailText('a\nb\nc\nd\n', 2)).toBe('c\nd')
    expect(tailText('a\nb\n', 10)).toBe('a\nb')
    expect(tailText('', 5)).toBe('')
    expect(tailText('only', 1)).toBe('only')
    // CRLF（Windows 日志）同样按行切
    expect(tailText('x\r\ny\r\n', 1)).toBe('y')
  })

  it('默认尾巴行数是 200', () => {
    const text = Array.from({ length: 500 }, (_, i) => `line ${i}`).join('\n')
    expect(tailText(text, DEFAULT_LOG_TAIL_LINES).split('\n')).toHaveLength(200)
  })
})

describe('truncateLine / pickErrorLines', () => {
  it('单行超长被截断并标注', () => {
    const long = 'x'.repeat(1000)
    const out = truncateLine(long)
    expect(out.length).toBeLessThan(500)
    expect(out).toContain('已截断')
  })

  it('只挑错误行、按上限截断、顺序稳定', () => {
    const tail = [
      '2025-01-01 10:00:00 启动完成',
      '2025-01-01 10:00:01 [error] 打不开库 -1006',
      '2025-01-01 10:00:02 继续运行',
      '2025-01-01 10:00:03 失败：-3002',
    ].join('\n')
    const lines = pickErrorLines([{ name: 'wcdb.log', tail }], 12)
    expect(lines.map((item) => item.file)).toEqual(['wcdb.log', 'wcdb.log'])
    expect(lines[0].line).toContain('-1006')
    expect(lines[1].line).toContain('-3002')

    const capped = pickErrorLines(
      [{ name: 'a.log', tail: Array.from({ length: 30 }, (_, i) => `error ${i}`).join('\n') }],
      5,
    )
    expect(capped).toHaveLength(5)
    expect(capped[0].line).toBe('error 0')
  })

  it('干净日志没有错误行', () => {
    expect(pickErrorLines([{ name: 'x.log', tail: '一切正常\n启动完成' }])).toEqual([])
  })
})

describe('oneLine', () => {
  it('把 Node 报错压成一句话（结论是给人读的，不是栈）', () => {
    const stack = "Cannot find module 'electron-store'\nRequire stack:\n- C:\\a\\b.js\n- C:\\c.js"
    const out = oneLine(stack)
    expect(out).not.toContain('\n')
    expect(out.startsWith("Cannot find module 'electron-store' Require stack: - C:\\a\\b.js")).toBe(true)
    expect(out.length).toBeLessThanOrEqual(221)
  })

  it('超长时截断并标注，空串返回空', () => {
    expect(oneLine('x'.repeat(500)).endsWith('…')).toBe(true)
    expect(oneLine('   ')).toBe('')
  })
})

describe('进程与注册表解析', () => {
  it('tasklist CSV：只认目标映像名，INFO 行忽略', () => {
    const csv = [
      '"映像名称","PID","会话名","会话#","内存使用"',
      'INFO: No tasks are running which match the specified criteria.',
      '"Weixin.exe","1234","Console","1","200,000 K"',
      '"Weixin.exe","5678","Console","1","210,000 K"',
      '"WeChat.exe","999","Console","1","100,000 K"',
    ].join('\r\n')
    expect(parseTasklistPid(csv, 'Weixin.exe')).toEqual([1234, 5678])
    expect(parseTasklistPid(csv, 'WeChat.exe')).toEqual([999])
    expect(parseTasklistPid(csv, 'chrome.exe')).toEqual([])
  })

  it('ps 输出：按 basename 匹配（macOS 的 /Applications/.../WeChat）', () => {
    const ps = [
      '  1 /sbin/launchd',
      '  501 /Applications/WeChat.app/Contents/MacOS/WeChat',
      '  700 /Applications/WXWork.app/Contents/MacOS/WXWork',
    ].join('\n')
    const hits = parsePsOutput(ps, ['WeChat', 'Weixin'])
    expect(hits).toEqual([{ pid: 501, command: '/Applications/WeChat.app/Contents/MacOS/WeChat' }])
    expect(parsePsOutput(ps, ['wechat'])).toHaveLength(1)
  })

  it('reg query 取值与 PowerShell 布尔', () => {
    const stdout = [
      '',
      'HKEY_LOCAL_MACHINE\\SOFTWARE\\WOW6432Node\\Microsoft\\EdgeUpdate\\Clients\\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}',
      '    pv    REG_SZ    131.0.2903.99',
      '',
    ].join('\r\n')
    expect(parseRegQueryValue(stdout, 'pv')).toBe('131.0.2903.99')
    expect(parseRegQueryValue(stdout, 'name')).toBeNull()
    expect(parsePowerShellBool('\r\nTrue\r\n')).toBe(true)
    expect(parsePowerShellBool('False')).toBe(false)
    expect(parsePowerShellBool('随便什么')).toBeNull()
  })
})

describe('路径与分组', () => {
  it('配置文件名回落到目录内匹配', () => {
    const userDataPath = join(tmpdir(), 'weport-diag-user-data')
    const exists = (path: string) => path.endsWith('Weport-config.json')
    expect(resolveConfigFilePath(userDataPath, exists, () => [])).toBe(join(userDataPath, 'Weport-config.json'))
    const fallback = resolveConfigFilePath(userDataPath, () => false, () => ['other.txt', 'Weport-config.local.json'])
    expect(fallback).toBe(join(userDataPath, 'Weport-config.local.json'))
  })

  it('日志名拒绝目录穿越', () => {
    const dir = mkdtempSync(join(tmpdir(), 'weport-diag-log-'))
    writeFileSync(join(dir, 'wcdb.log'), 'hi', 'utf8')
    try {
      expect(resolveLogPath([dir], 'wcdb.log')).toBe(join(dir, 'wcdb.log'))
      expect(resolveLogPath([dir], '../../etc/passwd')).toBeNull()
      expect(resolveLogPath([dir], 'wcdb.log.exe')).toBeNull()
      expect(resolveLogPath([dir], '..\\wcdb.log')).toBeNull()
      expect(resolveLogPath([dir], 'missing.log')).toBeNull()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('每个检查 id 都能落到一个分组', () => {
    const ids = ['app.build', 'wechat.running', 'db.open-status', 'engine.dll', 'config.summary', 'logs.files', 'env.disk', 'perm.userdata-write', 'mystery.thing']
    expect(ids.map(groupOfCheckId)).toEqual(['app', 'wechat', 'db', 'engine', 'config', 'logs', 'env', 'perm', 'other'])
  })

  it('微信 exe 候选与 WCDB 库候选按平台生成', () => {
    const win = weChatExeCandidates('win32', { ProgramFiles: 'C:\\Program Files' })
    expect(win.some((path) => /Tencent[\\/]Weixin[\\/]Weixin\.exe$/.test(path))).toBe(true)
    expect(weChatExeCandidates('darwin')).toContain('/Applications/WeChat.app')
    const dlls = wcdbDllCandidates('C:\\app\\resources', 'win32', 'x64')
    expect(dlls).toContain(join('C:\\app\\resources', 'wcdb', 'win32', 'x64', 'wcdb_api.dll'))
    expect(wcdbDllCandidates('/app', 'darwin', 'arm64').some((path) => path.endsWith('libwcdb_api.dylib'))).toBe(true)
  })
})

// === 采集与诊断包（临时目录夹具；不碰真实微信数据） ===

// 精确 64 位 hex 的库密钥夹具（长度写错的话会退化成通用规则命中，掩盖真实漏洞）
const HEX_KEY = '9f2c1b7a'.repeat(8)

/** 夹具配置：混入多把"密钥"，用来验证它们一个都进不了包。 */
const FIXTURE_CONFIG: Record<string, unknown> = {
  theme: 'dark',
  exportConcurrency: 3,
  myWxid: 'wxid_fixture0001',
  dbPath: '',
  cachePath: HEX_KEY, // 白名单键 + 密钥形状的值 → 只应得到指纹
  decryptKey: HEX_KEY,
  httpApiToken: 'PLAINTOKEN-9f2c1b7a',
  connectorsBlob: 'blob-with-plaintext-token-abc123',
  weportAiApiKey: 'PLAINSECRET-no-shape-match',
  wxidConfigs: { wxid_fixture0001: { decryptKey: `safe:${'B'.repeat(32)}` } },
}

const FIXTURE_SECRETS = [
  HEX_KEY,
  'PLAINTOKEN-9f2c1b7a',
  'blob-with-plaintext-token-abc123',
  'PLAINSECRET-no-shape-match',
  `safe:${'B'.repeat(32)}`,
]

let root = ''
let context: DiagnosticsContext
let report: DiagnosticsReport

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'weport-diag-'))
  const userData = join(root, 'userData')
  const logs = join(userData, 'logs')
  const exportPath = join(root, 'export')
  const dataRoot = join(root, 'xwechat_files')
  const accountDir = join(dataRoot, 'wxid_fixture0001')
  const dbStorage = join(accountDir, 'db_storage')
  mkdirSync(logs, { recursive: true })
  mkdirSync(exportPath, { recursive: true })
  mkdirSync(join(dbStorage, 'session'), { recursive: true })
  mkdirSync(join(dbStorage, 'message'), { recursive: true })
  // 一页 4096 字节的假库：足够 readPage1 判定"不是坏密钥"
  writeFileSync(join(dbStorage, 'session', 'session.db'), Buffer.alloc(4096, 7))
  writeFileSync(join(dbStorage, 'message', 'message_0.db'), Buffer.alloc(4096, 9))
  writeFileSync(join(userData, 'Weport-config.json'), JSON.stringify(FIXTURE_CONFIG, null, 2), 'utf8')
  writeFileSync(
    join(logs, 'wcdb.log'),
    [
      ...Array.from({ length: 300 }, (_, i) => `[tick] ${i}`),
      '[open] -1006 宿主文件名检查失败（夹具行）',
    ].join('\n'),
    'utf8',
  )

  context = {
    appVersion: '1.2.0-test',
    resourcesPath: join(root, 'resources'),
    userDataPath: userData,
    logDirs: [logs],
    isPackaged: false,
    shellVersion: '33.0.0',
    chromeVersion: '130.0.0.0',
    nodeVersion: '20.0.0',
    exportPath,
    dbPath: dataRoot,
  }
  report = await collectDiagnostics(context, { full: false })
}, 120_000)

afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true })
})

describe('collectDiagnostics 记录形状', () => {
  it('quick and full checks accept the native decoded-hex account passphrase without exposing it', async () => {
    const paths = ['session/session.db', 'message/message_0.db'].map(relative =>
      join(context.dbPath!, 'wxid_fixture0001', 'db_storage', relative))
    const originals = paths.map(path => readFileSync(path))
    const page = Buffer.alloc(4096, 0x27)
    const salt = Buffer.alloc(16, 0x19)
    salt.copy(page)
    const key = crypto.pbkdf2Sync(Buffer.from(HEX_KEY, 'hex'), salt, 256000, 32, 'sha512')
    const macKey = crypto.pbkdf2Sync(key, Buffer.from(salt.map(byte => byte ^ 0x3a)), 2, 32, 'sha512')
    const pageNo = Buffer.alloc(4)
    pageNo.writeUInt32LE(1)
    crypto.createHmac('sha512', macKey).update(page.subarray(16, 4032)).update(pageNo).digest().copy(page, 4032)
    try {
      savedKey.value = HEX_KEY
      paths.forEach(path => writeFileSync(path, page))
      for (const full of [false, true]) {
        const result = await collectDiagnostics(context, { full })
        for (const id of ['db.open-status', 'db.key-status', 'db.page1-hmac']) {
          expect(result.checks.find(check => check.id === id)?.state).toBe('ok')
        }
        expect(JSON.stringify(result)).not.toContain(HEX_KEY)
      }
    } finally {
      savedKey.value = ''
      paths.forEach((path, index) => writeFileSync(path, originals[index]))
    }
  }, 120_000)

  it('每条检查都是 { id, label, state, detail, raw? } 且 id 唯一', () => {
    expect(report.supported).toBe(true)
    expect(report.platform).toBe(process.platform)
    expect(report.checks.length).toBeGreaterThan(15)
    const ids = new Set<string>()
    for (const item of report.checks) {
      expect(typeof item.id).toBe('string')
      expect(item.id.length).toBeGreaterThan(2)
      expect(typeof item.label).toBe('string')
      expect(item.label.length).toBeGreaterThan(0)
      expect(['ok', 'warn', 'fail', 'unknown']).toContain(item.state)
      expect(typeof item.detail).toBe('string')
      expect(item.detail.trim().length).toBeGreaterThan(8)
      // 文案纪律：不许出现"未知错误"这种把责任推回用户的黑洞结论
      expect(item.detail).not.toMatch(/未知错误|unknown error/i)
      if (item.raw !== undefined) expect(typeof item.raw).toBe('string')
      expect(ids.has(item.id)).toBe(false)
      ids.add(item.id)
    }
  })

  it('八类检查全部落地（应用/微信/库/引擎/配置/日志/环境/权限）', () => {
    const ids = report.checks.map((item) => item.id)
    for (const required of [
      'app.build',
      'wechat.installed',
      'wechat.running',
      'wechat.version',
      'wechat.data-dir',
      'wechat.accounts',
      'wechat.session-db',
      'db.open-status',
      'engine.host',
      'engine.dll',
      'engine.init',
      'config.summary',
      'config.secrets',
      'logs.files',
      'logs.errors',
      'env.disk',
      'env.memory',
      'env.webview2',
      'env.elevation',
      'env.os',
      'perm.wechat-read',
      'perm.userdata-write',
      'perm.export-write',
    ]) {
      expect(ids, `缺少检查项 ${required}`).toContain(required)
    }
    expect(Array.from(new Set(ids.map(groupOfCheckId)))).not.toContain('other')
  })

  it('夹具数据目录被识别为可用账号，且日志错误行被摘出来', () => {
    const accountCheck = report.checks.find((item) => item.id === 'wechat.session-db')!
    expect(accountCheck.state).toBe('ok')
    expect(accountCheck.detail).toContain('1/1')
    const errorCheck = report.checks.find((item) => item.id === 'logs.errors')!
    expect(errorCheck.state).toBe('warn')
    expect(errorCheck.raw).toContain('-1006')
    const perm = report.checks.find((item) => item.id === 'perm.export-write')!
    expect(perm.state).toBe('ok')
  })

  it('summary 与 counts 自洽，checks.md 含每一组', () => {
    const counts = countCheckStates(report.checks)
    expect(counts.total).toBe(report.checks.length)
    expect(counts.ok + counts.warn + counts.fail + counts.unknown).toBe(counts.total)
    expect(report.summary).toContain('Weport 1.2.0-test')

    const markdown = renderChecksMarkdown(report.checks, {
      appVersion: report.appVersion,
      platform: report.platform,
      arch: report.arch,
      collectedAt: report.collectedAt,
      full: false,
    })
    expect(markdown.startsWith('# Weport 诊断摘要 v1.2.0-test')).toBe(true)
    expect(markdown).toContain('## 微信连接')
    expect(markdown).toContain('## 权限')
    expect(markdown).toContain('不含任何密钥、令牌或聊天内容')
  })
})

describe('诊断包（脱敏保证）', () => {
  it('夹具配置生成的包里搜不到任何密钥', () => {
    const entries = buildBundleEntries(context, report, {})
    const zip = createZipBuffer(entries, { date: new Date(1_700_000_000_000) })

    // 1) 整个包（含中央目录、文件名）逐字节扫描
    const rawText = zip.toString('latin1')
    for (const secret of FIXTURE_SECRETS) {
      expect(rawText.includes(secret), `zip 原文里出现了密钥：${secret.slice(0, 12)}…`).toBe(false)
    }

    // 2) 每个条目解压后再扫一遍
    const read = readZipBuffer(zip)
    expect(read.map((entry) => entry.name).sort()).toEqual([
      'README.txt',
      'checks.md',
      'config.redacted.json',
      'diagnostics.json',
      'logs/wcdb.log',
    ])
    for (const entry of read) {
      const text = entry.data.toString('utf8')
      for (const secret of FIXTURE_SECRETS) {
        expect(text.includes(secret), `${entry.name} 里出现了密钥`).toBe(false)
      }
    }

    // 3) 白名单键保留、白名单外的键只留名字、密钥形状的值变成指纹
    const configEntry = read.find((entry) => entry.name === 'config.redacted.json')!
    const parsed = JSON.parse(configEntry.data.toString('utf8')) as {
      config: Record<string, unknown>
      redactedKeys: string[]
    }
    const allowed = new Set<string>(CONFIG_BUNDLE_ALLOWLIST)
    for (const key of Object.keys(parsed.config)) expect(allowed.has(key)).toBe(true)
    expect(parsed.config.theme).toBe('dark')
    expect(parsed.config.exportConcurrency).toBe(3)
    expect(parsed.config.myWxid).toBe('wxid_fixture0001')
    expect(parsed.config.cachePath).toBe(redactionFingerprint(HEX_KEY))
    expect(parsed.redactedKeys).toContain('decryptKey')
    expect(parsed.redactedKeys).toContain('httpApiToken')
    expect(parsed.redactedKeys).toContain('connectorsBlob')
    expect(parsed.redactedKeys).toContain('weportAiApiKey')
    expect(parsed.redactedKeys).toContain('wxidConfigs')
    for (const key of Object.keys(parsed.config)) expect(parsed.redactedKeys).not.toContain(key)

    // 4) 日志尾巴进包（且已脱敏）
    const logEntry = read.find((entry) => entry.name === 'logs/wcdb.log')!
    expect(logEntry.data.toString('utf8')).toContain('-1006')
  })

  it('DiagnosticsService.exportBundle 落盘一个可读的包', async () => {
    const service = new DiagnosticsService()
    service.setContext(context)
    await service.collect({ full: false })
    const target = join(root, 'bundle', 'out')
    const result = await service.exportBundle({ path: target })
    expect(result.success).toBe(true)
    expect(result.path).toBe(`${target}.zip`)
    expect(result.sizeBytes).toBeGreaterThan(500)
    expect(existsSync(result.path!)).toBe(true)

    const zip = readFileSync(result.path!)
    const read = readZipBuffer(zip)
    expect(read.map((entry) => entry.name)).toContain('diagnostics.json')
    const text = zip.toString('latin1')
    for (const secret of FIXTURE_SECRETS) expect(text.includes(secret)).toBe(false)

    // readLog / listLogs 走同一个上下文
    expect(service.listLogs().files.map((file) => file.name)).toContain('wcdb.log')
    const tail = service.readLog({ name: 'wcdb.log', tailLines: 2 })
    expect(tail.content.split('\n')).toHaveLength(2)
    expect(service.readLog({ name: '../evil.log' }).content).toContain('读不到日志')
  }, 120_000)

  it('includeConfig=false 时不写 config.redacted.json，includeLogs=false 时不写日志', () => {
    const names = buildBundleEntries(context, report, { includeConfig: false, includeLogs: false })
      .map((entry) => entry.name)
    expect(names).not.toContain('config.redacted.json')
    expect(names.some((name) => name.startsWith('logs/'))).toBe(false)
    expect(names).toContain('checks.md')
  })
})
