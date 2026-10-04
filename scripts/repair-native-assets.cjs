'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { METADATA, sha256, validateNativeBinary } = require('./verify-native-assets.cjs')

function repairNativeBinary(sourceBuffer, policy = METADATA) {
  if (!Buffer.isBuffer(sourceBuffer)) throw new TypeError('Source WCDB asset must be a Buffer')
  if (sourceBuffer.length !== policy.size) {
    throw new Error(`Refusing to repair unexpected wcdb_api.dll size ${sourceBuffer.length}`)
  }

  const sourceSha256 = sha256(sourceBuffer)
  if (sourceSha256 !== policy.source.sha256) {
    throw new Error(`Refusing to patch unknown wcdb_api.dll SHA-256 ${sourceSha256}; expected ${policy.source.sha256}`)
  }

  const repaired = Buffer.from(sourceBuffer)
  for (const patch of policy.adaptation.patches) {
    const sourceBytes = Buffer.from(patch.sourceHex, 'hex')
    const actual = repaired.subarray(patch.offset, patch.offset + sourceBytes.length)
    if (!actual.equals(sourceBytes)) {
      throw new Error(`Refusing to patch unexpected bytes at file offset ${patch.offset}: ${actual.toString('hex')}`)
    }
    Buffer.from(patch.expectedHex, 'hex').copy(repaired, patch.offset)
  }

  const actualSha256 = sha256(repaired)
  if (actualSha256 !== policy.adaptation.expectedSha256) {
    throw new Error(`Repair output SHA-256 ${actualSha256} does not match ${policy.adaptation.expectedSha256}`)
  }
  validateNativeBinary(repaired, policy)
  return repaired
}

function parseArgs(argv) {
  if (argv.length === 1 && (argv[0] === '--help' || argv[0] === '-h')) return { help: true }
  if (argv.length !== 4 || argv[0] !== '--input' || argv[2] !== '--output') {
    throw new Error('Usage: node scripts/repair-native-assets.cjs --input <source.dll> --output <repaired.dll>')
  }
  return { inputPath: path.resolve(argv[1]), outputPath: path.resolve(argv[3]) }
}

function main(argv = process.argv.slice(2)) {
  try {
    const options = parseArgs(argv)
    if (options.help) {
      console.log('Usage: node scripts/repair-native-assets.cjs --input <source.dll> --output <repaired.dll>')
      console.log('Offline one-time adaptation only. It accepts exactly the recorded source SHA-256; it is never run at app startup.')
      return 0
    }
    const source = fs.readFileSync(options.inputPath)
    const repaired = repairNativeBinary(source)
    if (options.inputPath !== options.outputPath && fs.existsSync(options.outputPath)) {
      throw new Error(`Refusing to overwrite existing output: ${options.outputPath}`)
    }
    fs.writeFileSync(options.outputPath, repaired, { flag: options.inputPath === options.outputPath ? 'w' : 'wx' })
    console.log(`[native-assets] wrote repaired asset ${options.outputPath} (sha256 ${sha256(repaired)})`)
    return 0
  } catch (error) {
    console.error(`[native-assets] ${error && error.message ? error.message : error}`)
    return 1
  }
}

if (require.main === module) process.exitCode = main()

module.exports = { main, parseArgs, repairNativeBinary }
