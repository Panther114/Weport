const { chmodSync, existsSync } = require('node:fs')
const { join } = require('node:path')

const projectRoot = join(__dirname, '..')
const byPlatform = {
  darwin: [
    'resources/key/macos/universal/xkey_helper',
    'resources/key/macos/universal/xkey_helper_macos',
    'resources/key/macos/universal/image_scan_helper',
    'resources/key/macos/universal/libwx_key.dylib',
    'resources/welive/macos/arm64/welive',
  ],
  linux: [
    'resources/key/linux/x64/xkey_helper_linux',
  ],
}

const targets = byPlatform[process.platform] || []
for (const relativePath of targets) {
  const absolutePath = join(projectRoot, relativePath)
  if (!existsSync(absolutePath)) {
    throw new Error(`[prepare-native-modes] Missing required native helper: ${relativePath}`)
  }
  chmodSync(absolutePath, 0o755)
  console.log(`[prepare-native-modes] executable: ${relativePath}`)
}
