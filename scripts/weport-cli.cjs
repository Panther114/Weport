#!/usr/bin/env node
/**
 * Weport CLI launcher: runs the headless Electron extraction engine.
 * Electron is required for native WCDB / key helpers.
 */
const { spawn } = require('node:child_process')
const path = require('node:path')
const fs = require('node:fs')

const projectRoot = path.resolve(__dirname, '..')
const mainJs = path.join(projectRoot, 'dist-electron', 'main.js')

function resolveElectronBinary() {
  try {
    return require('electron')
  } catch {
    return null
  }
}

if (!fs.existsSync(mainJs)) {
  console.error('[weport] dist-electron/main.js not found. Run: npm run build:engine')
  process.exit(1)
}

const electronBin = resolveElectronBinary()
if (!electronBin || typeof electronBin !== 'string') {
  console.error('[weport] electron package not found. Run: npm install')
  process.exit(1)
}

const args = [mainJs, ...process.argv.slice(2)]
const child = spawn(electronBin, args, {
  stdio: 'inherit',
  cwd: projectRoot,
  env: {
    ...process.env,
    ELECTRON_NO_ATTACH_CONSOLE: '1',
    WEPORT_USER_DATA_PATH:
      process.env.WEPORT_USER_DATA_PATH ||
      process.env.WEFLOW_USER_DATA_PATH ||
      ''
  },
  windowsHide: true
})

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal)
    return
  }
  process.exit(code ?? 1)
})
