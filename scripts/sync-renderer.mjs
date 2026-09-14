// 渲染进程 + 主进程快速迭代：vite build + 同步进 release/win-unpacked/resources/app。
//
// 为什么要单独写：`npm run build:dir` 每次都要重跑 electron-builder（数分钟），
// 但 95% 的改动只动 JS/TS 产物。scripts/make-dev-app-dir.ps1 已经把 asar 展开成
// 目录，所以之后每次改动只需要「重新打包 + 覆盖 dist/dist-electron」即可。
//
// 【必须跑完整的 vite build】。`dist-electron/main.js` 是 vite
// (vite-plugin-electron) 打出来的**单文件**主进程 bundle，不是 `tsc` 的输出；
// 只跑 `tsc -p tsconfig.node.json` 会把代码写到 `dist-electron/services/*.js`
// 这些**运行时根本不加载**的文件里，然后你会在 CLI 里看到「未知命令：xxx」，
// 而源码明明是对的。（踩过一次：新加的 ai.costs 命令怎么也找不到。）

import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const appDir = join(root, 'release', 'win-unpacked', 'resources', 'app')

const argv = process.argv.slice(2)
const skipBuild = argv.includes('--skip-build')

const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx'

if (!existsSync(appDir)) {
  console.error(`Dev app dir missing: ${appDir}`)
  console.error('Run: pwsh -NoProfile -File scripts/make-dev-app-dir.ps1 -Setup')
  process.exit(1)
}

if (!skipBuild) {
  console.log('vite build (renderer + electron main + workers) ...')
  // Windows 下 .cmd 不能直接 spawn（EINVAL），必须走 shell；这不是"多绕一层"，
  // 是 Node 在 Windows 上执行批处理包装器唯一受支持的方式。
  execFileSync(npx, ['vite', 'build'], { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' })
}

for (const [from, to] of [
  ['dist', join(appDir, 'dist')],
  ['dist-electron', join(appDir, 'dist-electron')]
]) {
  const src = join(root, from)
  if (!existsSync(src)) continue
  rmSync(to, { recursive: true, force: true })
  cpSync(src, to, { recursive: true })
  console.log(`synced ${from} -> ${to}`)
}

console.log('renderer refreshed (no electron-builder run)')
