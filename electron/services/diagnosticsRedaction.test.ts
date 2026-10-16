import { describe, expect, it } from 'vitest'
import {
  CONFIG_BUNDLE_ALLOWLIST,
  isBundleAllowedConfigKey,
  redactConfigForBundle,
  redactSecretsDeep,
  redactSecretsInText,
  redactionFingerprint,
  secretRuleIdsIn,
} from './diagnosticsRedaction'

/**
 * 脱敏层单测。
 *
 * 这一组测试存在的意义是"漏一个就失败"：任何一条断言被放宽，都等于允许某种形态的
 * 凭据进入用户可以发给别人的 zip。
 */

// 长度必须精确：64 / 96 / 128 位 hex —— 写成手敲的长串很容易差一位，
// 于是"测试通过了"却是因为通用 base64 规则兜住，而不是库密钥规则命中。
const HEX_KEY = '9f2c1b7a'.repeat(8) // 64 位
const HEX_SALT = 'ab12cd34'.repeat(4) // 32 位
const HEX_KEY_SALT = `${HEX_KEY}${HEX_SALT}` // 96 位
const HEX_KEY_SALT128 = `${HEX_KEY}${HEX_SALT}${HEX_SALT}` // 128 位

describe('CONFIG_BUNDLE_ALLOWLIST', () => {
  it('永不包含任何凭据形状的键名', () => {
    for (const key of CONFIG_BUNDLE_ALLOWLIST) {
      expect(key).not.toMatch(/key|token|secret|password|credential/i)
    }
  })

  it('逐账号密钥容器必须不在白名单里', () => {
    expect(isBundleAllowedConfigKey('wxidConfigs')).toBe(false)
    expect(isBundleAllowedConfigKey('decryptKey')).toBe(false)
    expect(isBundleAllowedConfigKey('httpApiToken')).toBe(false)
    expect(isBundleAllowedConfigKey('theme')).toBe(true)
  })
})

describe('redactionFingerprint', () => {
  it('是 sha256 前 8 位，且同样的输入得到同样的指纹', () => {
    const first = redactionFingerprint('supersecret')
    expect(first).toMatch(/^«redacted:sha256:[0-9a-f]{8}»$/)
    expect(redactionFingerprint('supersecret')).toBe(first)
    expect(redactionFingerprint('another')).not.toBe(first)
  })
})

describe('redactSecretsInText', () => {
  it('识别 64 位 hex 库密钥与 96 / 128 位 key+salt', () => {
    expect(HEX_KEY).toHaveLength(64)
    expect(HEX_KEY_SALT).toHaveLength(96)
    expect(HEX_KEY_SALT128).toHaveLength(128)
    expect(secretRuleIdsIn(HEX_KEY)).toContain('hex-key-64')
    expect(secretRuleIdsIn(HEX_KEY_SALT)).toContain('hex-key-salt-96')
    expect(secretRuleIdsIn(HEX_KEY_SALT128)).toContain('hex-key-salt-128')
    expect(redactSecretsInText(`decryptKey=${HEX_KEY}`)).toBe(`decryptKey=${redactionFingerprint(HEX_KEY)}`)
    expect(redactSecretsInText(HEX_KEY_SALT)).toBe(redactionFingerprint(HEX_KEY_SALT))
    expect(redactSecretsInText(HEX_KEY_SALT128)).toBe(redactionFingerprint(HEX_KEY_SALT128))
  })

  it('识别 safe: 密文、sk- 令牌、JWT 与 Bearer 头', () => {
    const safeBlob = 'safe:QWxjaGVteVNlY3JldEJsb2IxMjM0NTY3ODkwfr=='
    const token = 'sk-proj-ABCDEFGH0123456789abcdef'
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk'
    const text = `a=${safeBlob} b=${token} c=${jwt} d=Authorization: Bearer abcdefghijklmnopqrstu`
    const out = redactSecretsInText(text)
    expect(out).not.toContain(safeBlob)
    expect(out).not.toContain(token)
    expect(out).not.toContain(jwt)
    expect(out).not.toContain('abcdefghijklmnopqrstu')
    expect(out).toContain('«redacted:sha256:')
  })

  it('不误伤普通路径、wxid、版本号与时间戳', () => {
    const text = [
      'C:\\Users\\admin\\Documents\\xwechat_files\\wxid_abc12def_4b2a\\db_storage\\session\\session.db',
      '/Users/x/Library/Application Support/Weport/logs/wcdb.log',
      '微信 4.1.13.65 · Electron 33.2.1',
      'collectedAt=1758765432109',
    ].join('\n')
    expect(redactSecretsInText(text)).toBe(text)
  })

  it('深拷贝脱敏不改原对象', () => {
    const source = { nested: { token: `sk-${'a'.repeat(24)}` }, list: [HEX_KEY] }
    const out = redactSecretsDeep(source)
    expect(JSON.stringify(out)).not.toContain('sk-')
    expect(JSON.stringify(out)).not.toContain(HEX_KEY)
    expect(JSON.stringify(source)).toContain(HEX_KEY)
  })
})

describe('redactConfigForBundle', () => {
  const rawStore: Record<string, unknown> = {
    theme: 'dark',
    exportConcurrency: 3,
    myWxid: 'wxid_abc12def',
    dbPath: 'C:\\Users\\admin\\Documents\\xwechat_files',
    decryptKey: `safe:${'A'.repeat(40)}`,
    httpApiToken: 'PLAINTOKEN-9f2c1b7a',
    connectorsBlob: 'blob-with-plaintext-token-abc123',
    weportAiApiKey: 'PLAINSECRET-no-shape-match',
    wxidConfigs: { wxid_abc12def: { decryptKey: 'safe:B'.repeat(4) } },
  }

  it('白名单外的键整条丢弃，只留键名', () => {
    const { config, redactedKeys, storedSecretKeys } = redactConfigForBundle(rawStore)
    const allowed = new Set<string>(CONFIG_BUNDLE_ALLOWLIST)
    for (const key of Object.keys(config)) expect(allowed.has(key)).toBe(true)
    expect(Object.keys(config).sort()).toEqual(['dbPath', 'exportConcurrency', 'myWxid', 'theme'])
    expect(redactedKeys).toEqual(['connectorsBlob', 'decryptKey', 'httpApiToken', 'weportAiApiKey', 'wxidConfigs'])
    expect(storedSecretKeys).toEqual(['decryptKey'])
  })

  it('白名单键顶着密钥形状的值也只给指纹', () => {
    const { config } = redactConfigForBundle({ theme: HEX_KEY, cachePath: 'sk-' + 'z'.repeat(24) })
    expect(config.theme).toBe(redactionFingerprint(HEX_KEY))
    expect(config.cachePath).toBe(redactionFingerprint('sk-' + 'z'.repeat(24)))
  })
})
