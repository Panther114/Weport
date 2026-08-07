/**
 * Weport 主进程（Electron GUI）。
 *
 * 双模式：
 * - 默认：GUI 应用（主窗口 / 托盘 / 通知弹窗 / 更新 / 开机自启）
 * - `--wcdb-host`：WCDB 宿主进程模式（由 WeFlow.exe 硬链接启动，见
 *   services/wcdbHostClient.ts），只运行 wcdbHost 的 stdio 循环，不创建窗口。
 *
 * 兼容旧版（Rust egui v0.6.x）用户数据：首次启动时把 %APPDATA%\Weport\settings.json
 * 迁移到 electron-store（dbPath / decryptKey / account_keys → wxidConfigs 等）。
 */
import './preload-env'
import { join } from 'path'

// ---- WCDB 宿主模式：不进入 GUI ----
if (process.argv.includes('--wcdb-host')) {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  require(join(__dirname, 'wcdbHost.js'))
} else {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { startApp } = require('./appMain')
  startApp()
}
