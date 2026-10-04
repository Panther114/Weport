import { describe, expect, it, vi } from 'vitest'
import {
  KeyAcquisitionService,
  planKeyAcquisition,
  type AcquiredKey,
  type PlatformKeyDriver,
  type PlatformObservation,
} from './keyAcquisition'
import { isNoLoginDbKeyScanEnabled } from './v12StablePolicy'

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
  it('V1.2 Windows + auto：先校验已有密钥，免登录扫描暂缓，失败后走 Hook', () => {
    const plan = planKeyAcquisition({
      platform: 'win32', mode: 'auto', hasStoredKey: true, storedKeyValid: false,
      wechatVersion: '4.1.13.65', wechatRunning: true,
    })
    expect(plan.steps).toEqual(['existing', 'hook'])
    expect(plan.scanSupported).toBe(false)
    expect(plan.notes).toEqual([])
    expect(isNoLoginDbKeyScanEnabled('win32')).toBe(false)
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

  it('Windows 扫描暂缓与微信版本无关，仍走 Hook', () => {
    const plan = planKeyAcquisition({
      platform: 'win32', mode: 'auto', hasStoredKey: false, wechatVersion: '4.0.3.36', wechatRunning: true,
    })
    expect(plan.steps).toEqual(['hook'])
    expect(plan.scanSupported).toBe(false)
    expect(plan.notes).toEqual([])
  })

  it('mode=hook 不扫描；禁用的 mode=scan 不加入任何自动路径', () => {
    expect(planKeyAcquisition({ platform: 'win32', mode: 'hook', hasStoredKey: false, wechatVersion: '4.1.13.65', wechatRunning: true }).steps).toEqual(['hook'])
    expect(planKeyAcquisition({ platform: 'win32', mode: 'scan', hasStoredKey: false, wechatVersion: '4.1.13.65', wechatRunning: true }).steps).toEqual([])
  })

  it('Windows 稳定版不扫描；微信未运行时由 Hook 前置自检报红', () => {
    const plan = planKeyAcquisition({
      platform: 'win32', mode: 'auto', hasStoredKey: false, wechatVersion: '4.1.13.65', wechatRunning: false,
    })
    expect(plan.steps).not.toContain('scan')
    expect(plan.steps).toContain('hook')
  })
})

describe('KeyAcquisitionService — V1.2 稳定版路径', () => {
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

  it('禁用的 scan 请求仍接受通过校验的已有密钥', async () => {
    const driver = fakeDriver()
    const service = new KeyAcquisitionService({
      driver,
      accountDir: 'D:\\xwechat_files\\wxid_demo_0000',
      storedKey: { hexKey: 'b62d'.padEnd(64, '1'), source: 'config' },
      validateStoredKey: async () => ({ valid: true, checked: 22, matched: 22 }),
    })

    const result = await service.acquire('scan')

    expect(result.success).toBe(true)
    expect(result.mode).toBe('existing')
    expect(driver.scanCalls).toBe(0)
    expect(driver.hookCalls).toBe(0)
  })

  it('Windows V1.2 不调用逐库扫描，自动获取仍走 Hook', async () => {
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
    expect(result.mode).toBe('hook')
    expect(result.keys).toEqual([])
    expect(result.key).toBe('b62d'.padEnd(64, '1'))
    expect(persist).not.toHaveBeenCalled()
    expect(driver.scanCalls).toBe(0)
    expect(driver.hookCalls).toBe(1)
    expect(result.reasons?.scan).toBeUndefined()
    expect(result.diagnostics?.scanSupported).toBe(false)
  })

  it('禁用扫描时不调用扫描驱动，也不阻断登录捕获', async () => {
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
    expect(result.reasons?.scan).toBeUndefined()
    expect(driver.scanCalls).toBe(0)
    expect(driver.hookCalls).toBe(1)
  })

  it('已有密钥与 Hook 都失败 → 带自检结果和手动输入动作', async () => {
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
    expect(result.error).toContain('有效的 64 位账号级密钥')
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

  it('没有数据目录时：不调用扫描，Hook 仍可尝试', async () => {
    const driver = fakeDriver()
    const service = new KeyAcquisitionService({ driver, accountDir: null })
    const result = await service.acquire('auto')
    expect(result.success).toBe(true)
    expect(result.mode).toBe('hook')
    expect(result.reasons?.scan).toBeUndefined()
    expect(driver.scanCalls).toBe(0)
  })

  it('显式 scan 模式在 V1.2 拒绝执行，不调用扫描或 Hook', async () => {
    const driver = fakeDriver({ scanKeys: async () => ({ success: false, keys: [], error: '没命中' }) })
    const service = new KeyAcquisitionService({
      driver,
      accountDir: 'D:\\xwechat_files\\wxid_demo_0000',
      hasDbFiles: async () => true,
    })
    const result = await service.acquire('scan')
    expect(result.success).toBe(false)
    expect(result.mode).toBeUndefined()
    expect(result.error).toContain('V1.3')
    expect(driver.scanCalls).toBe(0)
    expect(driver.hookCalls).toBe(0)
  })

  it('扫描驱动异常不会在 V1.2 调用；Hook 仍能成功', async () => {
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
    expect(result.reasons?.scan).toBeUndefined()
    expect(driver.scanCalls).toBe(0)
    expect(result.logs?.some((l) => l.includes('koffi load failed'))).toBe(false)
  })

  it('诊断明确报告稳定版未启用扫描，不暴露扫描计数器', async () => {
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
    expect(result.diagnostics?.scanSupported).toBe(false)
    expect(result.diagnostics?.elapsedMs).toBe(0)
    expect(result.diagnostics?.scan).toBeUndefined()
    expect(driver.scanCalls).toBe(0)
  })
})
