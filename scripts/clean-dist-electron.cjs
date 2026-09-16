// 构建前清空 dist-electron：vite 产物带内容 hash（如 config-XXXX.js），
// 不清理会让旧版本 chunk 无限堆积并被误打进安装包
const { rmSync, existsSync, statSync } = require('fs')
const { join } = require('path')

const dir = join(__dirname, '..', 'dist-electron')
if (existsSync(dir)) {
  rmSync(dir, { recursive: true, force: true })
  console.log('[clean] dist-electron removed')
}

/**
 * 顺手删掉上一次**运行**开发版留下的 WCDB 宿主可执行文件。
 *
 * `wcdbHostClient` 会在当前 exe 旁边创建 `WeFlow[.exe]`（NTFS 硬链接，零磁盘
 * 开销；Linux 只读安装目录下退化为复制）。跑过一次应用就会在**那个目录**里留下
 * 一个和宿主 exe 同样大小的 Electron 副本（本机 215MB），而它是会被打包的：
 *
 *   - `release/win-unpacked/` —— electron-builder 就地打包这个目录；
 *   - `node_modules/electron/dist/` —— 无网络构建时用
 *     `--config.electronDist=node_modules/electron/dist`，那一整个 dist 会被原样
 *     拷进 win-unpacked，于是 `dist/WeFlow.exe` 也被带上（`npm run dev` 用
 *     dist/electron.exe 启动，硬链接就落在它旁边）。
 *
 * 实测代价：安装包 115.5MB → **177.9MB**（干净构建 vs 跑过开发版之后的构建）。
 * 用户对安装包有 150MB 的硬上限，所以这两个位置都必须自动清掉，不能靠人记得。
 *
 * 打包本身不需要它：宿主硬链接是**安装目录**里的运行期产物，由
 * `resolveHostExe()` 自己创建（覆盖安装后 exe 变了它会重建）。
 */
const strayTargets = [
  join(__dirname, '..', 'release', 'win-unpacked'),
  // 只在离线构建的 electronDist 场景下会进包；正常 CI 用的是官方 zip，没有这个文件
  join(__dirname, '..', 'node_modules', 'electron', 'dist')
]
for (const outDir of strayTargets) {
  for (const name of ['WeFlow.exe', 'WeFlow']) {
    const stray = join(outDir, name)
    if (!existsSync(stray)) continue
    try {
      const size = statSync(stray).size
      rmSync(stray, { force: true })
      console.log(
        `[clean] removed stray host executable ${stray} (${(size / 1024 / 1024).toFixed(0)}MB) — packaging would have doubled the app payload`
      )
    } catch (error) {
      console.warn(`[clean] could not remove ${stray}: ${error && error.message ? error.message : error}`)
      console.warn('[clean] 安装包会因此变大（可能超过 150MB 上限），请手动删除后重试')
    }
  }
}
