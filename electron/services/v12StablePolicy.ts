/**
 * Stable-release gates for the V1.2 Windows no-login per-database key path.
 *
 * The scanner and mirror implementation stay in the tree for V1.3. This static
 * switch is deliberately not configurable through env vars or user settings.
 */
export const WINDOWS_NO_LOGIN_DB_KEY_SCAN_ENABLED = false

export const WINDOWS_NO_LOGIN_DB_KEY_SCAN_DEFERRED_MESSAGE =
  'Windows 免登录逐库扫描暂缓至 V1.3，V1.2 稳定版请使用已有密钥、手动输入或登录捕获。'

export const WINDOWS_NO_LOGIN_DB_KEY_SCAN_DEFERRED_ACTION =
  '请使用有效的账号级密钥，或完全退出并重新打开微信，让 Weport 在启动瞬间捕获密钥。'

export function isNoLoginDbKeyScanEnabled(platform: string): boolean {
  return platform === 'win32' && WINDOWS_NO_LOGIN_DB_KEY_SCAN_ENABLED
}
