import { afterEach, describe, expect, it } from 'vitest'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  buildNotifySendArgs,
  parseActivatableNames,
  parseBusctlList,
  parseGdbusBoolean,
  resolveLinuxNotificationMode,
  sendLinuxNotification,
} from './linuxNotify'

/**
 * 这些纯函数是 Linux 通知路由里唯一需要"猜"的部分：D-Bus 检测的输出解析、
 * 环境变量/配置的优先级、notify-send 参数拼装。真实子进程调用不在单测范围内。
 */
describe('linuxNotify: D-Bus 检测解析', () => {
  it('parseBusctlList 识别持有 org.freedesktop.Notifications 的行', () => {
    const stdout = [
      ':1.1    1716 dbus-broker-lau lyorn :1.1 user@1000.service - -',
      'org.freedesktop.Notifications 142473 mako lyorn :1.237 user@1000.service - -',
    ].join('\n')
    expect(parseBusctlList(stdout)).toBe(true)
  })

  it('parseBusctlList 不把前缀相同的其它 name 当成通知服务', () => {
    expect(parseBusctlList('org.freedesktop.Notifications.Foo 1 x')).toBe(false)
    expect(parseBusctlList(':1.2 1 foo\norg.freedesktop.systemd1 1 systemd')).toBe(false)
  })

  it('parseGdbusBoolean 读 NameHasOwner 的结果', () => {
    expect(parseGdbusBoolean('(true,)')).toBe(true)
    expect(parseGdbusBoolean('(false,)')).toBe(false)
    // 异常输出不能误判为"有守护进程"
    expect(parseGdbusBoolean('')).toBe(false)
  })

  it('parseActivatableNames 从 gdbus 数组输出里取出名字', () => {
    const stdout = "(['org.freedesktop.Notifications', 'org.freedesktop.portal.Desktop'],)"
    expect(parseActivatableNames(stdout)).toEqual([
      'org.freedesktop.Notifications',
      'org.freedesktop.portal.Desktop',
    ])
    expect(parseActivatableNames('([],)')).toEqual([])
  })
})

describe('linuxNotify: 投递方式', () => {
  it('默认 auto，环境变量优先于配置', () => {
    expect(resolveLinuxNotificationMode(undefined, undefined)).toBe('auto')
    expect(resolveLinuxNotificationMode(undefined, 'off')).toBe('off')
    expect(resolveLinuxNotificationMode('off', 'auto')).toBe('off')
    expect(resolveLinuxNotificationMode('FORCE-DBUS', 'off')).toBe('force-dbus')
  })

  it('非法值逐级回退：env 非法看配置，配置非法回 auto', () => {
    expect(resolveLinuxNotificationMode('dbus', 'off')).toBe('off')
    expect(resolveLinuxNotificationMode('', 'bogus')).toBe('auto')
    expect(resolveLinuxNotificationMode(undefined, 42)).toBe('auto')
  })
})

describe('linuxNotify: notify-send 参数', () => {
  it('标题/正文放在 -- 之后，标题以 - 开头也不会被当成选项', () => {
    const args = buildNotifySendArgs({ title: '--urgency=low', body: '正文' })
    const separator = args.indexOf('--')
    expect(separator).toBeGreaterThanOrEqual(0)
    expect(args.slice(separator)).toEqual(['--', '--urgency=low', '正文'])
  })

  it('app-name / urgency / icon / expire-time / category 按需拼装', () => {
    const args = buildNotifySendArgs({
      title: '标题',
      body: '正文',
      icon: '/tmp/icon.png',
      urgency: 'critical',
      timeoutMs: 3000,
      category: 'im.received',
    })
    expect(args).toContain('--app-name=Weport')
    expect(args).toContain('--urgency=critical')
    expect(args).toContain('--icon=/tmp/icon.png')
    expect(args).toContain('--expire-time=3000')
    expect(args).toContain('--category=im.received')
  })

  it('不传时长时交给守护进程默认值，负数不会写成非法参数', () => {
    expect(buildNotifySendArgs({ title: 't' })).not.toContain('--expire-time=NaN')
    const args = buildNotifySendArgs({ title: 't', timeoutMs: -5 })
    expect(args).toContain('--expire-time=0')
  })

  it('带点击动作时加 --print-id 与 default action', () => {
    const args = buildNotifySendArgs({ title: 't', actionLabel: '打开微信', onAction: () => { } })
    expect(args).toContain('--print-id')
    expect(args).toContain('--action=default=打开微信')
  })

  it('只有 actionLabel 或只有 onAction 时都不挂动作（必须成对）', () => {
    expect(buildNotifySendArgs({ title: 't', actionLabel: '打开微信' })).not.toContain('--print-id')
    expect(buildNotifySendArgs({ title: 't', onAction: () => { } })).not.toContain('--print-id')
  })
})

describe('linuxNotify: 点击回传（假 notify-send）', () => {
  const originalPath = process.env.PATH
  let fakeDir: string | null = null

  function installFakeNotifySend(script: string): void {
    fakeDir = mkdtempSync(join(tmpdir(), 'weport-notify-send-'))
    const binPath = join(fakeDir, 'notify-send')
    writeFileSync(binPath, script, 'utf8')
    chmodSync(binPath, 0o755)
    process.env.PATH = `${fakeDir}:${originalPath || ''}`
  }

  afterEach(() => {
    process.env.PATH = originalPath
    if (fakeDir) {
      rmSync(fakeDir, { recursive: true, force: true })
      fakeDir = null
    }
  })

  it.skipIf(process.platform === 'win32')('点击默认动作触发 onAction，投递本身立即返回 true', async () => {
    installFakeNotifySend('#!/bin/sh\nprintf "4242\\n"\nsleep 0.05\nprintf "default\\n"\n')
    let clicked = 0
    const sent = await sendLinuxNotification({
      title: '标题',
      body: '正文',
      actionLabel: '打开微信',
      timeoutMs: 2000,
      onAction: () => { clicked += 1 },
    })
    expect(sent).toBe(true)
    // 投递成功不等于被点击：回调必须等动作行
    expect(clicked).toBe(0)
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(clicked).toBe(1)
  })

  it.skipIf(process.platform === 'win32')('通知被关闭（没有动作行）不触发 onAction', async () => {
    installFakeNotifySend('#!/bin/sh\nprintf "4242\\n"\n')
    let clicked = 0
    const sent = await sendLinuxNotification({
      title: '标题',
      actionLabel: '打开微信',
      timeoutMs: 2000,
      onAction: () => { clicked += 1 },
    })
    expect(sent).toBe(true)
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(clicked).toBe(0)
  })

  it.skipIf(process.platform === 'win32')('notify-send 立刻失败（没有守护进程）时返回 false', async () => {
    installFakeNotifySend('#!/bin/sh\nexit 1\n')
    const sent = await sendLinuxNotification({
      title: '标题',
      actionLabel: '打开微信',
      timeoutMs: 2000,
      onAction: () => { },
    })
    expect(sent).toBe(false)
  })
})
