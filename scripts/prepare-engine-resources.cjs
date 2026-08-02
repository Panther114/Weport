/**
 * Copy packaged Electron engine into src-tauri/resources/engine for Tauri bundling.
 */
const fs = require('node:fs')
const path = require('node:path')

const root = path.resolve(__dirname, '..')
const src = path.join(root, 'release', 'engine', 'win-unpacked')
const dest = path.join(root, 'src-tauri', 'resources', 'engine')

function rimraf(dir) {
  if (!fs.existsSync(dir)) return
  fs.rmSync(dir, { recursive: true, force: true })
}

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true })
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const s = path.join(from, entry.name)
    const d = path.join(to, entry.name)
    if (entry.isDirectory()) copyDir(s, d)
    else fs.copyFileSync(s, d)
  }
}

if (!fs.existsSync(src)) {
  console.error('[prepare-engine] Missing', src)
  console.error('Run: npm run build:engine:pack')
  process.exit(1)
}

rimraf(dest)
copyDir(src, dest)
console.log('[prepare-engine] Copied engine →', dest)
