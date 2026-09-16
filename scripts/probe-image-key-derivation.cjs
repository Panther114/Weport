/**
 * Probe: which (offset, key-derivation) pair actually decrypts real WeChat 4.x
 * `*_t.dat` thumbnails to an image?
 *
 * Issue #20 needs this because both the kvcomm verification in keyService.ts
 * (`verifyDerivedAesKey`) and the memory-scan search in `_scanMemoryForAesKey`
 * decide "is this the right key?" by AES-ECB decrypting a 16-byte slice of a
 * `*_t.dat` and looking for image magic. If that slice/derivation is wrong, both
 * paths fail for *every* account - and, as issue #20 shows, the user only ever
 * sees the 60 s memory-scan timeout.
 *
 * Read-only: opens `*_t.dat` files from the local WeChat data dir.
 *
 * Run: node scripts/probe-image-key-derivation.cjs
 */
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

const V2_MAGIC = Buffer.from([0x07, 0x08, 0x56, 0x32, 0x08, 0x07])

const koffi = (() => { try { return require('koffi') } catch { return null } })()

function md5hex(s) { return crypto.createHash('md5').update(s).digest('hex') }
function md5raw(s) { return crypto.createHash('md5').update(s).digest() }

function imageMagic(buf) {
  if (!buf || buf.length < 4) return false
  return (
    (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) ||
    (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) ||
    (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46) ||
    (buf[0] === 0x77 && buf[1] === 0x78 && buf[2] === 0x67 && buf[3] === 0x66) ||
    (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46)
  )
}

function tryAes(key, ciphertext) {
  try {
    const decipher = crypto.createDecipheriv('aes-128-ecb', key, null)
    decipher.setAutoPadding(false)
    return Buffer.concat([decipher.update(ciphertext), decipher.final()])
  } catch { return null }
}

function collectTemplates(roots, limit) {
  const files = []
  const walk = (dir, depth) => {
    if (files.length >= limit || depth > 6) return
    let entries
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      if (files.length >= limit) return
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full, depth + 1)
      else if (entry.isFile() && entry.name.endsWith('_t.dat')) files.push(full)
    }
  }
  for (const root of roots) walk(root, 0)
  return files.filter((f) => {
    try { return fs.statSync(f).size < 10 * 1024 * 1024 } catch { return false }
  })
}

function main() {
  const roots = [
    'D:\\xwechat_files',
    path.join(process.env.USERPROFILE || '', 'Documents', 'xwechat_files'),
  ].filter((r) => fs.existsSync(r))

  const files = collectTemplates(roots, 400)
  const samples = []
  for (const file of files) {
    let data
    try { data = fs.readFileSync(file) } catch { continue }
    if (data.length < 0x30 || !data.subarray(0, 6).equals(V2_MAGIC)) continue
    const aesSize = data.readInt32LE(6)
    const xorSize = data.readInt32LE(10)
    samples.push({ file, data, aesSize, xorSize })
  }
  console.log(`V2 templates: ${samples.length} (of ${files.length} candidates)`)
  const first = samples[0]
  console.log('first header:', {
    aesSize: first.aesSize,
    xorSize: first.xorSize,
    total: first.data.length,
    payloadFrom0x0F: first.data.length - 0x0f,
    payloadFrom0x10: first.data.length - 0x10,
  })

  // ---- ground truth key from the DLL -------------------------------------------------
  let dllKey = null
  let dllXor = null
  let code = null
  let dllWxid = null
  if (koffi) {
    const lib = koffi.load(path.join(__dirname, '..', 'resources', 'key', 'win32', 'x64', 'wx_key.dll'))
    const GetImageKey = lib.func('bool GetImageKey(_Out_ char *resultBuffer, int bufferSize)')
    const buf = Buffer.alloc(8192)
    if (GetImageKey(buf, buf.length)) {
      const nul = buf.indexOf(0)
      const parsed = JSON.parse(buf.toString('utf8', 0, nul === -1 ? buf.length : nul))
      const entry = parsed.accounts?.[0]?.keys?.[0]
      if (entry) {
        dllKey = String(entry.aesKey)
        dllXor = entry.xorKey
        code = entry.code
        dllWxid = String(parsed.accounts[0].wxid)
      }
    }
  }

  // ---- candidate keys ----------------------------------------------------------------
  const accountDirNames = []
  for (const root of roots) {
    try {
      for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
        if (entry.isDirectory()) accountDirNames.push(entry.name)
      }
      for (const entry of fs.readdirSync(path.join(root, 'all_users', 'login'))) accountDirNames.push(entry)
    } catch { /* ignore */ }
  }

  const candidates = []
  const push = (label, key) => { if (key && key.length >= 16) candidates.push({ label, key: Buffer.from(key).subarray(0, 16) }) }
  if (code !== null) {
    for (const name of [...new Set(accountDirNames)]) {
      push(`md5hex(code+"${name}").slice(0,16)`, Buffer.from(md5hex(`${code}${name}`).slice(0, 16), 'ascii'))
      push(`md5raw(code+"${name}") with name=${name}`, md5raw(`${code}${name}`))
    }
    push(`md5hex(code+"unknown").slice(0,16)`, Buffer.from(md5hex(`${code}unknown`).slice(0, 16), 'ascii'))
    if (dllWxid) {
      push('md5hex(code+dllWxid).slice(0,16)', Buffer.from(md5hex(`${code}${dllWxid}`).slice(0, 16), 'ascii'))
      push('md5raw(code+dllWxid)', md5raw(`${code}${dllWxid}`))
    }
    push('md5hex(String(code)).slice(0,16)', Buffer.from(md5hex(String(code)).slice(0, 16), 'ascii'))
  }
  if (dllKey) {
    push('DLL aesKey (16 ascii chars)', Buffer.from(dllKey, 'ascii'))
    if (/^[0-9a-f]{16}$/i.test(dllKey)) push('DLL aesKey reinterpreted as raw hex bytes', Buffer.from(dllKey, 'hex'))
  }

  console.log(`candidate keys: ${candidates.length}`)
  for (const candidate of candidates) {
    const stats = {}
    for (const offset of [0x0f, 0x10]) {
      let ok = 0
      for (const sample of samples) {
        const cipher = sample.data.subarray(offset, offset + 16)
        const plain = tryAes(candidate.key, cipher)
        if (imageMagic(plain)) ok++
      }
      stats[`off0x${offset.toString(16)}`] = ok
    }
    const total = samples.length
    if (stats.off0xf > 0 || stats.off0x10 > 0) {
      console.log(`  HIT ${candidate.label}: off0x0f=${stats.off0xf}/${total} off0x10=${stats.off0x10}/${total}`)
    } else {
      console.log(`  miss ${candidate.label}: 0/${total} at both offsets`)
    }
  }

  // ---- is the tail really the XOR part, and does the XOR key match? -------------------
  let xorMatches = 0
  for (const sample of samples) {
    const x = sample.data[sample.data.length - 2] ^ 0xff
    const y = sample.data[sample.data.length - 1] ^ 0xd9
    if (x === y && x === (dllXor ?? x)) xorMatches++
  }
  console.log(`tail-byte XOR key == DLL xorKey for ${xorMatches}/${samples.length} templates`)
}

main()
