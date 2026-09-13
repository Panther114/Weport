import { describe, expect, it } from 'vitest'
import { classifyContainerAccessError, isRosettaTranslation, parseSignatureInfo, parseSipStatus } from './macDiagnosticsService'

/**
 * 这些解析函数决定了用户看到的是「关掉 SIP 试试」还是「关掉 SIP 也没用」——
 * 后者才是事实。真实机器上很难复现这些输出组合，所以在这里把它们钉死。
 */

describe('parseSipStatus', () => {
  it('识别已开启（不同 macOS 版本措辞略有差异）', () => {
    expect(parseSipStatus('System Integrity Protection status: enabled.')).toBe('enabled')
    expect(parseSipStatus('System Integrity Protection status: enabled (Custom Configuration).')).toBe('enabled')
  })

  it('识别已关闭', () => {
    expect(parseSipStatus('System Integrity Protection status: disabled.')).toBe('disabled')
  })

  it('无法识别时返回 unknown，而不是猜成 enabled', () => {
    expect(parseSipStatus('')).toBe('unknown')
    expect(parseSipStatus('csrutil: command not found')).toBe('unknown')
  })
})

describe('parseSignatureInfo', () => {
  const verboseSigned =
    'Executable=/Applications/WeChat.app/Contents/MacOS/WeChat\nIdentifier=com.tencent.xinWeChat\nAuthority=Developer ID Application: Tencent Mobile International Limited (5A4RE8SF68)\nAuthority=Developer ID Certification Authority\nflags=0x10000(runtime)\n'
  const verboseAdhoc =
    'Executable=/Applications/WeChat.app/Contents/MacOS/WeChat\nSignature=adhoc\nflags=0x2(adhoc)\n'

  it('加固签名且**没有** get-task-allow —— 这是最常见、也最容易被误判的情况', () => {
    const info = parseSignatureInfo(verboseSigned, '<key>com.apple.security.app-sandbox</key>\n<true/>')
    expect(info.signed).toBe(true)
    expect(info.authority).toContain('Tencent Mobile International')
    expect(info.getTaskAllow).toBe(false)
    expect(info.hardenedRuntime).toBe(true)
  })

  it('带 get-task-allow 时判定为可附加', () => {
    const info = parseSignatureInfo(verboseAdhoc, '<key>com.apple.security.get-task-allow</key>\n<true/>')
    expect(info.getTaskAllow).toBe(true)
  })

  it('完全未签名时 signed=false', () => {
    const info = parseSignatureInfo('code object is not signed at all', '')
    expect(info.signed).toBe(false)
    expect(info.authority).toBeNull()
  })

  it('空输入不抛错', () => {
    const info = parseSignatureInfo('', '')
    expect(info.getTaskAllow).toBe(false)
    expect(info.flags).toBeNull()
  })
})

describe('classifyContainerAccessError', () => {
  it('EPERM/EACCES 归类为「需要完全磁盘访问权限」，并给出可执行步骤', () => {
    const result = classifyContainerAccessError(Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' }))
    expect(result.state).toBe('fail')
    expect(result.detail).toContain('完全磁盘访问权限')
  })

  it('ENOENT 归类为「目录不存在」而不是权限问题', () => {
    const result = classifyContainerAccessError(Object.assign(new Error('no such file'), { code: 'ENOENT' }))
    expect(result.state).toBe('fail')
    expect(result.detail).toContain('不存在')
  })

  it('未知错误不会伪装成权限问题', () => {
    expect(classifyContainerAccessError(new Error('something else')).state).toBe('unknown')
  })
})

describe('isRosettaTranslation', () => {
  it('sysctl 返回 1 表示在 Rosetta 下运行', () => {
    expect(isRosettaTranslation('1\n')).toBe(true)
  })

  it('返回 0 或空（原生 arm64 上键不存在）都视为原生', () => {
    expect(isRosettaTranslation('0\n')).toBe(false)
    expect(isRosettaTranslation('')).toBe(false)
    expect(isRosettaTranslation(null as unknown as string)).toBe(false)
  })
})
