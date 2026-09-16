import { existsSync, readdirSync, statSync } from 'fs'
import { join } from 'path'
import { createHash } from 'crypto'

/**
 * 微信「已登录账号」档案（login oracle）。
 *
 * ## 它解决什么问题
 *
 * 账号目录有两种形态：`wxid_X` 与 `wxid_X_<4位>`。自定义过微信号的账号，
 * 磁盘上目录名会带后缀；而**真正的 wxid 是不带后缀的那一半**。当两者同时存在
 * （升级/改号遗留）时，只能靠「谁有 session.db + 谁更新」猜 —— 现有代码就是
 * 这么做的。
 *
 * WeChat 自己会把已登录账号记在 `xwechat_files/all_users/login/<wxid>/` 下，
 * 目录名就是**不带后缀的 canonical wxid**，里面放 `key_info.db`。
 * 因此这个目录列表是一个权威、无需猜测的账号名单。
 *
 * ## 已在本机真实数据上验证（Windows，微信 4.x，2026-09-13）
 *
 * - `all_users/login/wxid_gsnpwh6vh2z012/` 存在，内含 `key_info.db`（明文 SQLite）。
 * - `key_info.db` 的表结构为
 *   `LoginKeyInfoTable(user_name_md5, key_md5, key_info_md5, key_info_data)`，
 *   其中 `user_name_md5 = md5(canonical wxid)`。
 * - 实测 `md5('wxid_gsnpwh6vh2z012') === '5664eda7…2172'`，与库中该列完全一致；
 *   而磁盘目录名 `wxid_gsnpwh6vh2z012_64b5` 的 md5 与之**不匹配**。
 *
 * 也就是说：**目录名即可拿到 canonical wxid**，不需要解析 SQLite（`key_info.db`
 * 里存的是 md5，无法反查出 wxid）。`keyInfoDbHasAccount()` 保留为交叉验证手段 ——
 * 万一将来微信改了目录命名，md5 匹配仍能确认。
 */

/** 从 candidate 目录名里去掉 `_<4位后缀>`，得到疑似 canonical wxid。 */
export function stripAccountSuffix(accountDirName: string): string {
  const name = String(accountDirName || '').trim()
  // 只剥离恰好 `_` + 4 位十六进制（微信改号后追加的就是这种后缀）。
  // 不能用通用的「最后一段下划线」——真实 wxid 本身可能含下划线。
  return name.replace(/_[0-9a-f]{4}$/i, '')
}

/** `md5(wxid)` 的十六进制形式（与 key_info.db 的 user_name_md5 同构）。 */
export function wxidMd5(wxid: string): string {
  return createHash('md5').update(String(wxid || ''), 'utf8').digest('hex')
}

function listSubdirectories(dir: string): string[] {
  try {
    if (!existsSync(dir)) return []
    return readdirSync(dir).filter((entry) => {
      try {
        return statSync(join(dir, entry)).isDirectory()
      } catch {
        return false
      }
    })
  } catch {
    return []
  }
}

/**
 * 读取本机已登录过的账号名单（canonical、不带后缀的 wxid）。
 *
 * 两个位置都查：`all_users/login/`（4.x 标准）与 `<root>/login/`（部分版本）。
 * 失败一律返回空数组 —— 这只是辅助信息，绝不能让它的失败影响账号发现本身。
 */
export function readLoggedInWxids(rootPath: string): string[] {
  const root = String(rootPath || '').trim()
  if (!root) return []
  const found = new Set<string>()
  for (const base of [join(root, 'all_users', 'login'), join(root, 'login')]) {
    for (const name of listSubdirectories(base)) {
      // 排除明显的非账号目录；wxid_* 与自定义微信号都可能出现，因此只做基本校验。
      if (!name || name.startsWith('.') || /^(all|backup|temp)/i.test(name)) continue
      found.add(name)
    }
  }
  return Array.from(found)
}

/**
 * 交叉验证：`key_info.db` 里是否存在属于该 canonical wxid 的登录记录。
 *
 * 读的是**明文 SQLite**，但不解析 B 树 —— 只按字节扫描 `user_name_md5`
 * 的十六进制文本。这是有意为之：解析 SQLite 需要重写一遍存储格式，而这里
 * 只需要一个「是/否」的交叉确认，扫描足够且不会因为页结构变化而崩。
 */
export function keyInfoDbHasAccount(rootPath: string, canonicalWxid: string): boolean {
  const target = wxidMd5(canonicalWxid).toLowerCase()
  for (const base of [join(rootPath, 'all_users', 'login'), join(rootPath, 'login')]) {
    for (const name of listSubdirectories(base)) {
      const dbPath = join(base, name, 'key_info.db')
      try {
        if (!existsSync(dbPath)) continue
        const { readFileSync } = require('fs') as typeof import('fs')
        const buffer = readFileSync(dbPath)
        // 命中即返回；文件很小（本机实测 60 KB）。
        if (buffer.includes(Buffer.from(target, 'ascii'))) return true
      } catch {
        /* 被微信占用或权限不足：忽略，这只是一次交叉验证 */
      }
    }
  }
  return false
}

/**
 * 把候选账号目录名归并到 canonical wxid，并标注该账号是否在本机登录过。
 *
 * 返回顺序保持传入顺序（调用方已按修改时间排好），不做重排。
 */
export function annotateAccounts(
  rootPath: string,
  accountDirNames: string[]
): Array<{ dirName: string; canonicalWxid: string; loggedIn: boolean }> {
  const loggedIn = new Set(readLoggedInWxids(rootPath))
  return accountDirNames.map((dirName) => {
    const canonicalWxid = stripAccountSuffix(dirName)
    // 目录名本身是 canonical，或去掉后缀后命中登录名单，都算已登录。
    const isLoggedIn = loggedIn.has(dirName) || loggedIn.has(canonicalWxid)
    return { dirName, canonicalWxid, loggedIn: isLoggedIn }
  })
}
