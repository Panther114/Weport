import { existsSync } from 'node:fs'
import { delimiter, join } from 'node:path'

/**
 * 找 ffmpeg。刻意**不打包**它：一个完整构建 40-100 MB。
 *
 * 两条路径共用这一份探测，别再各写一套：
 * - 背景视频抽帧/转码（`backgroundVideoService`）—— 只是锦上添花，找不到就用原文件；
 * - wxgf(HEVC) 图片转 JPG（`imageDecryptService`）—— 找不到就只能给缩略图。
 *
 * 顺序：`WEPORT_FFMPEG` 覆盖 → PATH → 常见安装位置（WinGet / scoop / brew / 系统包）。
 */
export function findFfmpeg(): string | null {
  const override = String(process.env.WEPORT_FFMPEG || '').trim()
  if (override && existsSync(override)) return override
  const exe = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'
  const fromPath = String(process.env.PATH || '')
    .split(delimiter)
    .filter(Boolean)
    .map((dir) => join(dir, exe))
    .find((candidate) => existsSync(candidate))
  if (fromPath) return fromPath
  const fallbacks =
    process.platform === 'win32'
      ? [
          join(process.env.LOCALAPPDATA || '', 'Programs', 'FFmpeg', 'bin', 'ffmpeg.exe'),
          join(process.env.ProgramData || '', 'chocolatey', 'bin', 'ffmpeg.exe'),
          join(process.env.USERPROFILE || '', 'scoop', 'shims', 'ffmpeg.exe'),
        ]
      : ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/usr/bin/ffmpeg']
  return fallbacks.find((candidate) => candidate && existsSync(candidate)) || null
}
