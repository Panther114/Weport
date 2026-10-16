const fs = require('node:fs')
const path = require('node:path')
const root = path.resolve(__dirname, '../electron/assets/wasm')
for (const name of ['wasm_video_decode.js', 'wasm_video_decode.wasm']) {
  const file = path.join(root, name)
  if (!fs.existsSync(file) || fs.statSync(file).size < 1000) throw new Error(`Required decoder asset missing: ${name}`)
}
const magic = fs.readFileSync(path.join(root, 'wasm_video_decode.wasm')).subarray(0, 4)
if (!magic.equals(Buffer.from([0, 97, 115, 109]))) throw new Error('Invalid WASM decoder header')
console.log('[wasm] decoder JS and WASM present; packaged runtime is checked by verify-v12-ui')
