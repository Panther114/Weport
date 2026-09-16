import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { annotateAccounts, keyInfoDbHasAccount, readLoggedInWxids, stripAccountSuffix, wxidMd5 } from './weChatLoginOracle'

const dirs: string[] = []
function tempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'weport-login-'))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch { /* noop */ }
  }
})

describe('stripAccountSuffix', () => {
  it('剥离微信改号后追加的 _xxxx 后缀', () => {
    expect(stripAccountSuffix('wxid_gsnpwh6vh2z012_64b5')).toBe('wxid_gsnpwh6vh2z012')
  })

  it('不带后缀时原样返回', () => {
    expect(stripAccountSuffix('wxid_gsnpwh6vh2z012')).toBe('wxid_gsnpwh6vh2z012')
  })

  it('**不**误伤真实 wxid 里的下划线（不是最后一段就一定该剥）', () => {
    // 只有「_ + 恰好 4 位十六进制」才是微信的后缀
    expect(stripAccountSuffix('wxid_abc_def')).toBe('wxid_abc_def')
    expect(stripAccountSuffix('my_wechat_id')).toBe('my_wechat_id')
    expect(stripAccountSuffix('wxid_abc_12g4')).toBe('wxid_abc_12g4') // g 不是十六进制
    expect(stripAccountSuffix('wxid_abc_12345')).toBe('wxid_abc_12345') // 5 位
  })
})

describe('wxidMd5 — 与真实 key_info.db 对齐', () => {
  it('本机实测值：md5(wxid_gsnpwh6vh2z012) 与 key_info.db 的 user_name_md5 一致', () => {
    // 这组值取自本机真实数据（Windows 微信 4.x）。它不是造出来的期望值，
    // 而是从 key_info.db 里实际读到的 user_name_md5。
    expect(wxidMd5('wxid_gsnpwh6vh2z012')).toBe('5664eda7efc0c2726796446ec2662172')
  })

  it('带后缀的目录名得到的 md5 与之不同 —— 说明后缀必须剥掉才能匹配', () => {
    expect(wxidMd5('wxid_gsnpwh6vh2z012_64b5')).not.toBe('5664eda7efc0c2726796446ec2662172')
  })
})

describe('readLoggedInWxids', () => {
  it('读取 all_users/login 下的目录名', () => {
    const root = tempRoot()
    mkdirSync(join(root, 'all_users', 'login', 'wxid_aaa'), { recursive: true })
    mkdirSync(join(root, 'all_users', 'login', 'wxid_bbb_x1y2'), { recursive: true })
    expect(readLoggedInWxids(root).sort()).toEqual(['wxid_aaa', 'wxid_bbb_x1y2'])
  })

  it('同时兼容 <root>/login 变体', () => {
    const root = tempRoot()
    mkdirSync(join(root, 'login', 'wxid_ccc'), { recursive: true })
    expect(readLoggedInWxids(root)).toEqual(['wxid_ccc'])
  })

  it('合并两处并去重', () => {
    const root = tempRoot()
    mkdirSync(join(root, 'all_users', 'login', 'wxid_same'), { recursive: true })
    mkdirSync(join(root, 'login', 'wxid_same'), { recursive: true })
    expect(readLoggedInWxids(root)).toEqual(['wxid_same'])
  })

  it('目录不存在时返回空数组而不是抛错', () => {
    expect(readLoggedInWxids(join(tempRoot(), 'nope'))).toEqual([])
    expect(readLoggedInWxids('')).toEqual([])
  })

  it('跳过明显的非账号目录', () => {
    const root = tempRoot()
    mkdirSync(join(root, 'all_users', 'login', 'backup_tmp'), { recursive: true })
    mkdirSync(join(root, 'all_users', 'login', 'wxid_real'), { recursive: true })
    expect(readLoggedInWxids(root)).toEqual(['wxid_real'])
  })
})

describe('keyInfoDbHasAccount — 交叉验证', () => {
  it('文件里出现该 wxid 的 md5 时返回 true', () => {
    const root = tempRoot()
    const dir = join(root, 'all_users', 'login', 'wxid_real')
    mkdirSync(dir, { recursive: true })
    // 模拟明文 SQLite：内容里嵌着 user_name_md5 的十六进制文本
    writeFileSync(join(dir, 'key_info.db'), Buffer.concat([
      Buffer.from('SQLite format 3\0', 'binary'),
      Buffer.from(`LoginKeyInfoTable${wxidMd5('wxid_real')}deadbeef`, 'ascii'),
    ]))
    expect(keyInfoDbHasAccount(root, 'wxid_real')).toBe(true)
  })

  it('md5 不匹配时返回 false（不会因为目录存在就判定）', () => {
    const root = tempRoot()
    const dir = join(root, 'all_users', 'login', 'wxid_real')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'key_info.db'), Buffer.from('SQLite format 3\0nothing here', 'ascii'))
    expect(keyInfoDbHasAccount(root, 'wxid_real')).toBe(false)
  })

  it('文件缺失时返回 false 而不是抛错', () => {
    expect(keyInfoDbHasAccount(tempRoot(), 'wxid_missing')).toBe(false)
  })
})

describe('annotateAccounts', () => {
  it('把目录名归并到 canonical wxid 并标注登录状态', () => {
    const root = tempRoot()
    mkdirSync(join(root, 'all_users', 'login', 'wxid_gsnpwh6vh2z012'), { recursive: true })
    mkdirSync(join(root, 'wxid_gsnpwh6vh2z012_64b5'), { recursive: true })
    // 后缀不是 4 位十六进制 → 不会被当成微信后缀，按"另一个账号"处理
    mkdirSync(join(root, 'wxid_stale_zzzz'), { recursive: true })

    const result = annotateAccounts(root, ['wxid_gsnpwh6vh2z012_64b5', 'wxid_stale_zzzz'])
    expect(result).toEqual([
      { dirName: 'wxid_gsnpwh6vh2z012_64b5', canonicalWxid: 'wxid_gsnpwh6vh2z012', loggedIn: true },
      { dirName: 'wxid_stale_zzzz', canonicalWxid: 'wxid_stale_zzzz', loggedIn: false },
    ])
  })

  it('已知的固有歧义：wxid 本身以 _ + 4 位十六进制结尾时会被误剥后缀', () => {
    // 微信的后缀规则(`_` + 4 hex)与真实 id 的字符集有重叠，纯字符串无法区分。
    // 这不会造成误判账号 —— 用户 ID 里出现这种结尾的概率极低，且剥错时
    // canonicalWxid 只是少 5 个字符，loggedIn 仍是 false 而不是错误地命中。
    expect(stripAccountSuffix('wxid_stale_aaaa')).toBe('wxid_stale')
    const root = tempRoot()
    const result = annotateAccounts(root, ['wxid_stale_aaaa'])
    expect(result[0].loggedIn).toBe(false)
  })

  it('保持传入顺序（调用方已按修改时间排好，不能被打乱）', () => {
    const root = tempRoot()
    const result = annotateAccounts(root, ['b_dir', 'a_dir', 'c_dir'])
    expect(result.map((r) => r.dirName)).toEqual(['b_dir', 'a_dir', 'c_dir'])
  })

  it('登录名单读不到时全部标为未登录，而不是抛错', () => {
    const result = annotateAccounts(join(tempRoot(), 'missing'), ['wxid_x'])
    expect(result).toEqual([{ dirName: 'wxid_x', canonicalWxid: 'wxid_x', loggedIn: false }])
  })
})
