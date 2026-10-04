import { describe, expect, it, vi } from 'vitest'
import {
  KeyAcquisitionService,
  planKeyAcquisition,
  type AcquiredKey,
  type PlatformKeyDriver,
  type PlatformObservation,
} from './keyAcquisition'

/**
 * 双模式编排的单测（A2 的验收）。
 *
 * 全部用注入的假驱动：真实扫描要 3 秒和一台开着微信的机器，而这里要钉的是
 * **决策**——哪条路先走、走了哪条、另一条为什么没成、失败时是不是一定带自检结果。
 */

const HEALTHY: PlatformObservation = {
  wechatInstalled: true,
  wechatExePath: 'C:\\Program Files\\Tencent\\Weixin\\Weixin.exe',
  wechatPids: [1234],
  wechatVersion: '4.1.13.65',
  wechatLoggedIn: true,
  sameUser: true,
  memoryReadable: true,
  hookHelperAvailable: true,
}

const SCANNED_KEY: AcquiredKey = {
  id: 'session/session.db',
  kind: 'session',
  path: 'D:\\xwechat_files\\wxid_demo_0000\\db_storage\\session\\session.db',
  keyHex: 'fd0b'.padEnd(64, '0'),
  saltHex: '94adb3981ae06f12e9f899da94238716',
  mode: 'raw',
  fingerprint: 'fd0b…0000',
  source: 'scan',
}

function fakeDriver(overrides: Partial<PlatformKeyDriver> = {}): PlatformKeyDriver & {
  scanCalls: number
  hookCalls: number
} {
  const driver = {
    platform: 'win32',
    scanCalls: 0,
    hookCalls: 0,
    observe: async () => HEALTHY,
    scanKeys: async () => {
      driver.scanCalls++
      return { success: true, keys: [SCANNED_KEY] }
    },
    hookAcquire: async () => {
      driver.hookCalls++
      return { success: true, key: 'b62d'.padEnd(64, '1') }
    },
    ...overrides,
  }
  return driver as PlatformKeyDriver & { scanCalls: number; hookCalls: number }
}

describe('planKeyAcquisition — 平台 × 模式矩阵', () => {
  it('Windows + auto：先自校验、再扫描、最后 Hook', () => {
    const plan = planKeyAcquisition({
      platform: 'win32', mode: 'auto', hasStoredKey: true, storedKeyValid: false,
      wechatVersion: '4.1.13.65', wechatRunning: true,
    })
    expect(plan.steps).toEqual(['existing', 'scan', 'hook'])
    expect(plan.scanSupported).toBe(true)
    expect(plan.notes).toHaveLength(0)
  })

  it('macOS：只有 Hook，并且常驻一条能力边界说明（K8）', () => {
    const plan = planKeyAcquisition({
      platform: 'darwin', mode: 'auto', hasStoredKey: false, wechatVersion: null, wechatRunning: true,
    })
    expect(plan.steps).toEqual(['hook'])
    expect(plan.scanSupported).toBe(false)
    expect(plan.notes.join(' ')).toContain('macOS')
  })

  it('Linux：同样只有 Hook，说明提到 ptrace 与提权', () => {
    const plan = planKeyAcquisition({
      platform: 'linux', mode: 'auto', hasStoredKey: false, wechatVersion: null, wechatRunning: true,
    })
    expect(plan.steps).toEqual(['hook'])
    expect(plan.notes.join(' ')).toContain('ptrace')
  })

  it('版本低于 4.1.10：跳过扫描并说明原因（K4）', () => {
    const plan = planKeyAcquisition({
      platform: 'win32', mode: 'auto', hasStoredKey: false, wechatVersion: '4.0.3.36', wechatRunning: true,
    })
    expect(plan.steps).toEqual(['hook'])
    expect(plan.notes.join(' ')).toContain('4.1.10')
  })

  it('mode=hook 不许扫描；mode=scan 不许回落 Hook（便于测试与诊断）', () => {
    expect(planKeyAcquisition({ platform: 'win32', mode: 'hook', hasStoredKey: false, wechatVersion: '4.1.13.65', wechatRunning: true }).steps).toEqual(['hook'])
    expect(planKeyAcquisition({ platform: 'win32', mode: 'scan', hasStoredKey: false, wechatVersion: '4.1.13.65', wechatRunning: true }).steps).toEqual(['scan'])
  })

  it('微信没在运行也不跳过扫描项 —— 让自检去报红，而不是"点了没反应"（K2）', () => {
    const plan = planKeyAcquisition({
      platform: 'win32', mode: 'auto', hasStoredKey: false, wechatVersion: '4.1.13.65', wechatRunning: false,
    })
    expect(plan.steps).toContain('scan')
  })
})

describe('KeyAcquisitionService — 走哪条路、为什么', () => {
  it('已有密钥校验通过 → mode=existing，不扫描、不 Hook（K6）', async () => {
    const driver = fakeDriver()
    const validate = vi.fn(async () => ({ valid: true, checked: 22, matched: 22 }))
    const service = new KeyAcquisitionService({
      driver,
      accountDir: 'D:\\xwechat_files\\wxid_demo_0000',
      storedKey: { hexKey: 'b62d'.padEnd(64, '1'), source: 'config' },
      validateStoredKey: validate,
      hasDbFiles: async () => true,
    })
    const result = await service.acquire('auto')
    expect(result.success).toBe(true)
    expect(result.mode).toBe('existing')
    expect(driver.scanCalls).toBe(0)
    expect(driver.hookCalls).toBe(0)
    expect(validate).toHaveBeenCalledTimes(1)
    expect(result.prerequisites?.length).toBeGreaterThan(0)
  })

  it('扫描命中 → mode=scan，persistKeys 被调用（每库密钥要落库）', async () => {
    const driver = fakeDriver()
    const persist = vi.fn(async () => { /* noop */ })
    const service = new KeyAcquisitionService({
      driver,
      accountDir: 'D:\\xwechat_files\\wxid_demo_0000',
      hasDbFiles: async () => true,
      persistKeys: persist,
    })
    const result = await service.acquire('auto')
    expect(result.success).toBe(true)
    expect(result.mode).toBe('scan')
    expect(result.keys).toHaveLength(1)
    expect(result.key).toBeUndefined() // 扫描拿的是 per-DB page key，不是账号口令
    expect(persist).toHaveBeenCalledTimes(1)
    expect(driver.hookCalls).toBe(0)
    expect(result.prerequisiteSummary).toContain('全部条件已满足')
  })

  it('扫描未命中 → 自动回落 Hook，并把"扫描为什么没成"写进 reasons', async () => {
    const driver = fakeDriver({
      scanKeys: async () => ({ success: false, keys: [], error: '扫描完成但没有找到能解开这些数据库的密钥。' }),
    })
    const service = new KeyAcquisitionService({
      driver,
      accountDir: 'D:\\xwechat_files\\wxid_demo_0000',
      hasDbFiles: async () => true,
    })
    const result = await service.acquire('auto')
    expect(result.success).toBe(true)
    expect(result.mode).toBe('hook')
    expect(result.key).toBe('b62d'.padEnd(64, '1'))
    expect(result.reasons?.scan).toContain('没有找到能解开这些数据库的密钥')
    expect(driver.hookCalls).toBe(1)
  })

  it('两条路都失败 → success=false，但一定带自检结果与下一步动作（消不掉"点了没反应"）', async () => {
    const driver = fakeDriver({
      observe: async () => ({ ...HEALTHY, wechatPids: [] }),
      scanKeys: async () => ({ success: false, keys: [], error: '微信没有在运行。' }),
      hookAcquire: async () => ({ success: false, error: '微信没在运行。' }),
    })
    const service = new KeyAcquisitionService({
      driver,
      accountDir: 'D:\\xwechat_files\\wxid_demo_0000',
      hasDbFiles: async () => true,
    })
    const result = await service.acquire('auto')
    expect(result.success).toBe(false)
    expect(result.prerequisites?.some((i) => i.id === 'wechat-running' && i.status === 'fail')).toBe(true)
    expect(result.prerequisites?.some((i) => !!i.action)).toBe(true)
    expect(result.error).toContain('打开微信')
    expect(result.error).toContain('手动输入密钥')
    expect(result.error).not.toContain('重试')
    expect(result.reasons?.hook).toBeTruthy()
  })

  it('macOS 驱动（没有 scanKeys）→ 只走 Hook，并且自检里说明本平台无免登录路径', async () => {
    const hook = vi.fn(async () => ({ success: true, key: 'aa'.repeat(32) }))
    const driver: PlatformKeyDriver = {
      platform: 'darwin',
      observe: async () => ({ wechatInstalled: true, wechatPids: [999], hookHelperAvailable: true }),
      hookAcquire: hook,
    }
    const service = new KeyAcquisitionService({
      driver,
      accountDir: '/Users/demo/Documents/xwechat_files/wxid_demo_0000',
      hasDbFiles: async () => true,
    })
    const result = await service.acquire('auto')
    expect(result.success).toBe(true)
    expect(result.mode).toBe('hook')
    expect(hook).toHaveBeenCalledTimes(1)
    const platformItem = result.prerequisites?.find((i) => i.id === 'platform-scan-support')
    expect(platformItem?.message).toContain('macOS')
    expect(platformItem?.action).toContain('启动瞬间')
  })

  it('没有数据目录时：扫描被跳过并说明，Hook 仍可尝试', async () => {
    const driver = fakeDriver()
    const service = new KeyAcquisitionService({ driver, accountDir: null })
    const result = await service.acquire('auto')
    expect(result.success).toBe(true)
    expect(result.mode).toBe('hook')
    expect(result.reasons?.scan).toContain('数据目录')
    expect(driver.scanCalls).toBe(0)
  })

  it('mode=scan 时不回落 Hook（只报扫描结果）', async () => {
    const driver = fakeDriver({ scanKeys: async () => ({ success: false, keys: [], error: '没命中' }) })
    const service = new KeyAcquisitionService({
      driver,
      accountDir: 'D:\\xwechat_files\\wxid_demo_0000',
      hasDbFiles: async () => true,
    })
    const result = await service.acquire('scan')
    expect(result.success).toBe(false)
    expect(result.mode).toBeUndefined()
    expect(driver.hookCalls).toBe(0)
  })

  it('扫描抛异常也不会把编排打断：转成 reasons 后继续走 Hook', async () => {
    const driver = fakeDriver({
      scanKeys: async () => { throw new Error('koffi load failed') },
    })
    const service = new KeyAcquisitionService({
      driver,
      accountDir: 'D:\\xwechat_files\\wxid_demo_0000',
      hasDbFiles: async () => true,
    })
    const result = await service.acquire('auto')
    expect(result.success).toBe(true)
    expect(result.mode).toBe('hook')
    expect(result.reasons?.scan).toContain('koffi load failed')
    expect(result.logs?.some((l) => l.includes('免登录扫描异常'))).toBe(true)
  })

  it('诊断里带上耗时与扫描计数器（便于远程判断"为什么没命中"）', async () => {
    const driver = fakeDriver({
      scanKeys: async () => ({
        success: true,
        keys: [SCANNED_KEY],
        diagnostics: { needleHits: 8, recordHits: 15, verified: 12 },
      }),
    })
    const service = new KeyAcquisitionService({
      driver,
      accountDir: 'D:\\xwechat_files\\wxid_demo_0000',
      hasDbFiles: async () => true,
      now: () => 1000,
    })
    const result = await service.acquire('auto')
    expect(result.diagnostics?.platform).toBe('win32')
    expect(result.diagnostics?.scanSupported).toBe(true)
    expect(result.diagnostics?.elapsedMs).toBe(0)
    expect(result.diagnostics?.scan).toEqual({ needleHits: 8, recordHits: 15, verified: 12 })
  })
})
