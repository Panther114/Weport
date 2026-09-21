import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { parsePositiveIntegers, resolveNiriSocket, selectWeChatWindow } from './wechatLinux'

/**
 * 窗口选择的关键事实（在本机 Niri + 微信 4.x 上实测）：
 * Flatpak/bwrap 沙箱里的微信有独立 PID namespace，niri 报的窗口 pid 是沙箱内
 * 的 PID（XWayland 下甚至解析成 xwayland-satellite 142451），和宿主机上
 * pgrep 到的微信 PID（如 468818）对不上。所以必须优先 app_id。
 */
describe('wechatLinux: 微信窗口选择', () => {
  const hostPids = [468818]

  it('按 app_id 选中微信窗口（沙箱 pid 与宿主 pid 不一致也能命中）', () => {
    const windows = [
      { id: 297, pid: 143111, app_id: 'com.mitchellh.ghostty', title: 'nvim' },
      { id: 191, pid: 142451, app_id: 'wechat', title: '微信' },
      { id: 628, pid: 628746, app_id: 'weport', title: 'Weport' },
    ]
    expect(selectWeChatWindow(windows, hostPids)).toEqual(windows[1])
  })

  it('app_id 不认识时按宿主 pid 兜底（原生 Wayland 客户端）', () => {
    const windows = [{ id: 5, pid: 468818, app_id: 'some-new-wechat-build' }]
    expect(selectWeChatWindow(windows, hostPids)?.id).toBe(5)
  })

  it('都没有时按精确标题 微信 兜底，不匹配相似标题', () => {
    expect(selectWeChatWindow([{ id: 7, app_id: '', title: '微信' }], hostPids)?.id).toBe(7)
    expect(selectWeChatWindow([{ id: 8, app_id: '', title: '微信读书' }], hostPids)).toBeNull()
  })

  it('选不中或输入异常时返回 null', () => {
    expect(selectWeChatWindow([{ id: 1, app_id: 'firefox', title: 'Weport 文档' }], hostPids)).toBeNull()
    expect(selectWeChatWindow(null, hostPids)).toBeNull()
    expect(selectWeChatWindow('nope', hostPids)).toBeNull()
    expect(selectWeChatWindow([{ app_id: 'wechat' }], hostPids)).toBeNull() // 没有 id 的条目不可用
  })
})

describe('wechatLinux: 输出解析', () => {
  it('parsePositiveIntegers 只保留正整数', () => {
    expect(parsePositiveIntegers('191\n297  \n')).toEqual([191, 297])
    expect(parsePositiveIntegers('abc 0 -3 42')).toEqual([42])
    expect(parsePositiveIntegers('')).toEqual([])
  })
})

describe('wechatLinux: niri socket 解析', () => {
  it('优先 NIRI_SOCKET，缺失时从运行目录里找 niri.wayland-*.sock', () => {
    const dir = mkdtempSync(join(tmpdir(), 'weport-niri-'))
    try {
      const socket = join(dir, 'niri.wayland-1.123.sock')
      writeFileSync(socket, '')
      writeFileSync(join(dir, 'not-a-socket.txt'), '')
      // App 由 systemd/托盘拉起时常常没有 NIRI_SOCKET，只能靠运行目录
      expect(resolveNiriSocket({ XDG_RUNTIME_DIR: dir })).toBe(socket)
      expect(resolveNiriSocket({ NIRI_SOCKET: '/tmp/explicit.sock', XDG_RUNTIME_DIR: dir })).toBe(
        '/tmp/explicit.sock',
      )
      expect(resolveNiriSocket({ XDG_RUNTIME_DIR: '/definitely/not/here' })).toBeNull()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
