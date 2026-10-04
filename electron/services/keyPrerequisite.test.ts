import { describe, expect, it } from 'vitest'
import {
  MIN_SCAN_WECHAT_VERSION,
  PREREQ_ACTIONS,
  PREREQ_IDS,
  PREREQ_MESSAGES,
  buildPrerequisiteReport,
  compareVersions,
  supportsReadOnlyScan,
  type PrereqObservations,
} from './keyPrerequisite'

/**
 * 前置条件矩阵的单测（§1.5 / D4 的显式验收项）。
 *
 * 这里守的是**文案纪律**，不是排版：
 * - 每一项都要有一句可执行动作，且不许把责任推回用户（"请重试"）；
 * - 各项文案必须两两不同 —— 同一个坑用同一句话糊过去，等于没有自检；
 * - 平台能力边界（macOS/Linux 没有免登录路径）必须如实出现，不许沉默。
 */

function baseObservations(overrides: Partial<PrereqObservations> = {}): PrereqObservations {
  return {
    platform: 'win32',
    mode: 'auto',
    wechatInstalled: true,
    wechatExePath: 'C:\\Program Files\\Tencent\\Weixin\\Weixin.exe',
    wechatPids: [1234],
    wechatLoggedIn: true,
    wechatVersion: '4.1.13.65',
    sameUser: true,
    memoryReadable: true,
    dataDirConfigured: true,
    dataDir: 'D:\\xwechat_files\\wxid_demo_0000',
    dbFilesPresent: true,
    storedKeyValid: true,
    scanAttempted: true,
    scanKeyFound: true,
    hookHelperAvailable: true,
    ...overrides,
  }
}

describe('前置条件文案矩阵', () => {
  it('每个 id 都有文案与动作，且文案两两不同（不许一句话糊多个坑）', () => {
    const messages = PREREQ_IDS.map((id) => PREREQ_MESSAGES[id])
    expect(messages.every((m) => typeof m === 'string' && m.trim().length > 0)).toBe(true)
    expect(new Set(messages).size).toBe(messages.length)
    const actions = PREREQ_IDS.map((id) => PREREQ_ACTIONS[id])
    expect(actions.every((a) => typeof a === 'string' && a.trim().length > 0)).toBe(true)
  })

  it('动作里不许出现"请重试"这种把责任推回用户的话', () => {
    for (const id of PREREQ_IDS) {
      expect(PREREQ_ACTIONS[id]).not.toContain('重试')
      expect(PREREQ_ACTIONS[id].length).toBeGreaterThan(8)
    }
  })

  it('全部满足时 allSatisfied=true、没有 blocking，并给出一行总述', () => {
    const report = buildPrerequisiteReport(baseObservations())
    expect(report.allSatisfied).toBe(true)
    expect(report.blocking).toHaveLength(0)
    expect(report.summary).toContain('全部条件已满足')
  })

  it('微信没在运行 → 第 2 项 fail 且带动作（K2：不静默失败）', () => {
    const report = buildPrerequisiteReport(baseObservations({ wechatPids: [], memoryReadable: null, sameUser: null }))
    const item = report.items.find((i) => i.id === 'wechat-running')
    expect(item?.status).toBe('fail')
    expect(item?.action).toContain('打开微信')
    expect(report.allSatisfied).toBe(false)
    expect(report.summary).toContain('微信没有在运行')
  })

  it('微信没登录 → 第 3 项 fail，动作是"去微信里登录"（K3）', () => {
    const report = buildPrerequisiteReport(baseObservations({ wechatLoggedIn: false }))
    const item = report.items.find((i) => i.id === 'wechat-logged-in')
    expect(item?.status).toBe('fail')
    expect(item?.action).toContain('扫码或自动登录')
  })

  it('版本低于 4.1.10 → warn（不是 fail）：仍可走 Hook（K4）', () => {
    const report = buildPrerequisiteReport(baseObservations({ wechatVersion: '4.0.3.36', scanAttempted: false, scanKeyFound: false }))
    const item = report.items.find((i) => i.id === 'wechat-version')
    expect(item?.status).toBe('warn')
    expect(item?.action).toContain('退出微信')
    expect(report.allSatisfied).toBe(true) // warn 不阻塞
  })

  it('读不到版本号 → warn 且给出"按 ③ 步走"的动作', () => {
    const report = buildPrerequisiteReport(baseObservations({ wechatVersion: null, scanAttempted: false, scanKeyFound: false }))
    const item = report.items.find((i) => i.id === 'wechat-version')
    expect(item?.status).toBe('warn')
    expect(item?.message).toContain('读不到')
  })

  it('macOS / Linux → 平台项如实说明没有免登录路径（K8）', () => {
    const mac = buildPrerequisiteReport(baseObservations({ platform: 'darwin', mode: 'hook', wechatVersion: null }))
    const platformItem = mac.items.find((i) => i.id === 'platform-scan-support')
    expect(platformItem?.status).toBe('warn')
    expect(platformItem?.message).toContain('macOS')
    expect(platformItem?.action).toContain('启动瞬间')
    // 不强塞 Windows 专属的自检项
    expect(mac.items.find((i) => i.id === 'scan-key-found')?.status).toBe('skip')

    const linux = buildPrerequisiteReport(baseObservations({ platform: 'linux', mode: 'hook', wechatVersion: null }))
    expect(linux.items.find((i) => i.id === 'platform-scan-support')?.message).toContain('Linux')
    expect(linux.items.find((i) => i.id === 'platform-scan-support')?.message).toContain('ptrace')
  })

  it('内存读不了（模拟杀软拦截）→ 第 6 项 fail + 白名单指引（K10）', () => {
    const report = buildPrerequisiteReport(baseObservations({ memoryReadable: false }))
    const item = report.items.find((i) => i.id === 'memory-readable')
    expect(item?.status).toBe('fail')
    expect(item?.action).toContain('白名单')
  })

  it('跨用户 → 第 5 项 fail，且文案与第 6 项不同', () => {
    const report = buildPrerequisiteReport(baseObservations({ memoryReadable: false, sameUser: false }))
    const sameUser = report.items.find((i) => i.id === 'same-user')
    const memory = report.items.find((i) => i.id === 'memory-readable')
    expect(sameUser?.status).toBe('fail')
    expect(sameUser?.message).not.toBe(memory?.message)
    expect(sameUser?.action).toContain('同一个 Windows 账号')
  })

  it('扫描跑完但没命中 → warn，并说明"该版本结构可能变了"', () => {
    const report = buildPrerequisiteReport(baseObservations({ scanAttempted: true, scanKeyFound: false }))
    const item = report.items.find((i) => i.id === 'scan-key-found')
    expect(item?.status).toBe('warn')
    expect(item?.message).toContain('结构')
  })

  it('已存密钥校验失败 → fail 且给出"重新获取会覆盖"的动作（K7）', () => {
    const report = buildPrerequisiteReport(baseObservations({ storedKeyValid: false }))
    const item = report.items.find((i) => i.id === 'stored-key-valid')
    expect(item?.status).toBe('fail')
    expect(item?.action).toContain('覆盖')
  })

  it('Hook 组件缺失 → fail，动作是重装或手动粘贴', () => {
    const report = buildPrerequisiteReport(baseObservations({ hookHelperAvailable: false }))
    const item = report.items.find((i) => i.id === 'hook-helper-available')
    expect(item?.status).toBe('fail')
    expect(item?.action).toContain('手动粘贴')
  })

  it('数据目录未选 / 没有库文件 → 两项都 fail 且文案不同', () => {
    const report = buildPrerequisiteReport(baseObservations({ dataDirConfigured: false, dbFilesPresent: false }))
    const dirItem = report.items.find((i) => i.id === 'data-dir-selected')
    const dbItem = report.items.find((i) => i.id === 'db-files-present')
    expect(dirItem?.status).toBe('fail')
    expect(dbItem?.status).toBe('skip')
    expect(dirItem?.message).not.toBe(dbItem?.message)
  })

  it('两条自动路都失败时会补一条「手动粘贴」的兜底指引（13 项全部可达）', () => {
    const report = buildPrerequisiteReport(baseObservations({ keyObtained: false }))
    const item = report.items.find((i) => i.id === 'manual-key-available')
    expect(item?.status).toBe('warn')
    expect(item?.action).toContain('64 位密钥')
    expect(new Set(report.items.map((i) => i.id)).size).toBe(report.items.length)
  })

  it('每一项的 detail 里可以带诊断信息，但结论 message 不含路径以外的密钥内容', () => {
    const report = buildPrerequisiteReport(baseObservations())
    for (const item of report.items) {
      expect(item.message).not.toMatch(/[0-9a-f]{64}/i)
    }
  })
})

describe('版本判定', () => {
  it('compareVersions 处理不同段数', () => {
    expect(compareVersions('4.1.10', '4.1.10.31')).toBeLessThan(0)
    expect(compareVersions('4.1.13.65', '4.1.10')).toBeGreaterThan(0)
    expect(compareVersions('4.1.10', '4.1.10')).toBe(0)
    expect(compareVersions('5.0', '4.9.9.9')).toBeGreaterThan(0)
  })

  it('supportsReadOnlyScan 的边界就是 4.1.10', () => {
    expect(supportsReadOnlyScan('4.1.9.99')).toBe(false)
    expect(supportsReadOnlyScan(MIN_SCAN_WECHAT_VERSION)).toBe(true)
    expect(supportsReadOnlyScan('4.1.13.65')).toBe(true)
    expect(supportsReadOnlyScan(null)).toBe(false)
    expect(supportsReadOnlyScan('')).toBe(false)
  })
})
