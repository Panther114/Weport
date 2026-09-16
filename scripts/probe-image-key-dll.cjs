/**
 * Probe: what does `wx_key.dll!GetImageKey` actually return, and how does its
 * `aesKey` relate to the derivation Weport does in TypeScript?
 *
 * Issue #20 ("获取图片密钥失败") hinge: `KeyService.autoGetImageKey()` ignores the
 * `aesKey`/`xorKey` the DLL already computed per account and re-derives them from
 * a *candidate* wxid (`md5(String(code) + cleanWxid(wxid)).slice(0,16)`). If the
 * conventions disagree, the derived key can never be verified against a template.
 *
 * Read-only: `GetImageKey` only walks the kvcomm cache directory. It does not
 * touch the WeChat process, does not hook anything, and opens no window.
 *
 * wxid values are redacted - this prints structure, not identities.
 *
 * Run: node scripts/probe-image-key-dll.cjs
 */
const path = require('path')
const crypto = require('crypto')

const KOFFI = (() => {
  try { return require('koffi') } catch { return null }
})()

function mask(value) {
  const text = String(value || '')
  if (text.length <= 8) return `${'*'.repeat(text.length)}(${text.length})`
  return `${text.slice(0, 5)}…${text.slice(-2)}(${text.length})`
}

function md5hex(input) {
  return crypto.createHash('md5').update(input).digest('hex')
}

// Mirrors KeyService.cleanWxid (electron/services/keyService.ts) - truncate at the
// second underscore, i.e. `wxid_abc_64b5` -> `wxid_abc`.
function cleanWxidLike(dll) {
  const first = dll.indexOf('_')
  if (first === -1) return dll
  const second = dll.indexOf('_', first + 1)
  if (second === -1) return dll
  return dll.substring(0, second)
}

// Mirrors accountDirResolver.cleanAccountDirName - for non-`wxid_` ids it also
// strips a trailing 4-char rename suffix.
function cleanAccountDirLike(dll) {
  const trimmed = String(dll).trim()
  if (!trimmed) return trimmed
  if (trimmed.toLowerCase().startsWith('wxid_')) {
    const m = trimmed.match(/^(wxid_[^_]+)/i)
    return m ? m[1] : trimmed
  }
  const suffix = trimmed.match(/^(.+)_([a-zA-Z0-9]{4})$/)
  return suffix ? suffix[1] : trimmed
}

function main() {
  if (!KOFFI) {
    console.log('SKIP: koffi is not installed in this checkout')
    process.exit(0)
  }

  const dllPath = path.join(__dirname, '..', 'resources', 'key', 'win32', 'x64', 'wx_key.dll')
  const lib = KOFFI.load(dllPath)
  const GetImageKey = lib.func('bool GetImageKey(_Out_ char *resultBuffer, int bufferSize)')
  const GetLastErrorMsg = lib.func('const char* GetLastErrorMsg()')

  const buffer = Buffer.alloc(8192)
  const ok = GetImageKey(buffer, buffer.length)
  if (!ok) {
    let err = ''
    try { err = KOFFI.decode(GetLastErrorMsg(), 'char', -1) } catch { /* ignore */ }
    console.log('GetImageKey returned false. GetLastErrorMsg =', JSON.stringify(err))
    process.exit(0)
  }

  const nul = buffer.indexOf(0)
  const json = buffer.toString('utf8', 0, nul === -1 ? buffer.length : nul)
  console.log('raw JSON length:', json.length)
  console.log('top-level keys   :', Object.keys(JSON.parse(json)).join(', '))

  const parsed = JSON.parse(json)
  const accounts = parsed.accounts || []
  console.log('accounts         :', accounts.length)

  // Local account identities, to classify (not reveal) what the DLL calls a wxid:
  // the on-disk account directory (`xwechat_files/<name>`) and the canonical wxid
  // from `all_users/login/<name>`.
  const fs = require('fs')
  const localNames = []
  for (const root of ['D:\\xwechat_files', path.join(process.env.USERPROFILE || '', 'Documents', 'xwechat_files')]) {
    try {
      for (const entry of fs.readdirSync(root)) localNames.push(entry)
      for (const entry of fs.readdirSync(path.join(root, 'all_users', 'login'))) localNames.push(entry)
    } catch { /* not this machine's layout */ }
  }

  for (const account of accounts) {
    const keys = account.keys || []
    const raw = String(account.wxid || '')
    console.log('---')
    console.log('  wxid           :', mask(account.wxid))
    console.log('  wxid shape     : len=' + raw.length
      + ' wxidPrefix=' + raw.toLowerCase().startsWith('wxid_')
      + ' underscores=' + (raw.match(/_/g) || []).length
      + ' equalsOnDiskName=' + localNames.some((n) => n === raw)
      + ' equalsCanonicalOf(' + localNames.filter((n) => n.startsWith(raw + '_')).length + ' disk names)')
    console.log('  key entry keys :', keys.length ? Object.keys(keys[0]).join(', ') : '(none)')
    console.log('  codes          :', keys.map((k) => k.code).join(', '))
    for (const key of keys) {
      const aes = String(key.aesKey || '')
      const xor = key.xorKey
      const full = cleanWxidLike(String(account.wxid))
      const dirLike = cleanAccountDirLike(String(account.wxid))
      const raw = String(account.wxid)
      const variants = {
        'dll wxid as-is': raw,
        'cleanWxid (keyService)': full,
        'cleanAccountDirName (accountDirResolver)': dirLike,
      }
      console.log(`  code=${key.code} aesKey.len=${aes.length} xorKey=${xor} (code&0xFF=${key.code & 0xFF})`)
      for (const [label, wxid] of Object.entries(variants)) {
        const derived = md5hex(`${key.code}${wxid}`)
        const match16 = aes.slice(0, 16).toLowerCase() === derived.slice(0, 16)
        const match32 = aes.toLowerCase() === derived
        console.log(`    md5(code+${label}) match: prefix16=${match16} full32=${match32}`)
      }
      // What the Weport UI would actually pass as `wxidParam` (the on-disk account
      // directory) and what `all_users/login` calls canonical.
      const tested = new Set()
      for (const name of localNames) {
        if (tested.has(name)) continue
        tested.add(name)
        const derived = md5hex(`${key.code}${name}`)
        const match16 = aes.slice(0, 16).toLowerCase() === derived.slice(0, 16)
        console.log(`    vs on-disk name ${mask(name)} -> prefix16=${match16}`)
      }
      for (const fallback of ['unknown', cleanWxidLike(String(account.wxid))]) {
        const derived = md5hex(`${key.code}${fallback}`)
        console.log(`    vs candidate ${mask(fallback)} -> prefix16=${aes.slice(0, 16).toLowerCase() === derived.slice(0, 16)}`)
      }
      console.log('    NOTE: the DLL-computed aesKey is the only one that is ground truth;')
      console.log('          every other row above is Weport re-deriving the same key from a guessed wxid.')

      // Decisive check: does the DLL's aesKey actually decrypt a real *_t.dat?
      // Read-only. Uses the same V2 magic + ciphertext slice as imageDecryptService.
      const V2_MAGIC = Buffer.from([0x07, 0x08, 0x56, 0x32, 0x08, 0x07])
      const templates = []
      const roots = ['D:\\xwechat_files', path.join(process.env.USERPROFILE || '', 'Documents', 'xwechat_files')]
      const collect = (dir, depth) => {
        if (templates.length >= 200 || depth > 6) return
        let entries
        try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
        for (const entry of entries) {
          if (templates.length >= 200) return
          const full = path.join(dir, entry.name)
          if (entry.isDirectory()) collect(full, depth + 1)
          else if (entry.isFile() && entry.name.endsWith('_t.dat')) templates.push(full)
        }
      }
      for (const root of roots) collect(root, 0)
      templates.sort((a, b) => {
        try { return fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs } catch { return 0 }
      })

      const verify = (key, ciphertext) => {
        try {
          const decipher = crypto.createDecipheriv('aes-128-ecb', Buffer.from(key, 'ascii').subarray(0, 16), null)
          decipher.setAutoPadding(false)
          const dec = Buffer.concat([decipher.update(ciphertext), decipher.final()])
          return (dec[0] === 0xFF && dec[1] === 0xD8 && dec[2] === 0xFF) ||
            (dec[0] === 0x89 && dec[1] === 0x50 && dec[2] === 0x4E && dec[3] === 0x47) ||
            (dec[0] === 0x52 && dec[1] === 0x49 && dec[2] === 0x46 && dec[3] === 0x46) ||
            (dec[0] === 0x77 && dec[1] === 0x78 && dec[2] === 0x67 && dec[3] === 0x66) ||
            (dec[0] === 0x47 && dec[1] === 0x49 && dec[2] === 0x46)
        } catch { return false }
      }

      let checked = 0
      let dllOk = 0
      let derivedOk = 0
      const tailXor = {}
      for (const file of templates) {
        let data
        try {
          if (fs.statSync(file).size > 10 * 1024 * 1024) continue
          data = fs.readFileSync(file)
        } catch { continue }
        if (data.length < 0x1F || !data.subarray(0, 6).equals(V2_MAGIC)) continue
        checked++
        const ciphertext = data.subarray(0xF, 0x1F)
        if (verify(String(key.aesKey), ciphertext)) dllOk++
        // The key Weport would store: md5(code + <on-disk account dir name>)
        const accountDirName = path.basename(path.dirname(path.dirname(path.dirname(path.dirname(path.dirname(file))))))
        const derivedFromDirName = md5hex(`${key.code}${accountDirName}`).slice(0, 16)
        if (verify(derivedFromDirName, ciphertext)) derivedOk++
        const x = data[data.length - 2] ^ 0xFF
        const y = data[data.length - 1] ^ 0xD9
        const k = x === y ? x : -1
        tailXor[k] = (tailXor[k] || 0) + 1
      }
      console.log(`  template check   : ${checked} V2 templates read`)
      console.log(`    DLL aesKey decrypts            : ${dllOk}/${checked}`)
      console.log(`    md5(code+<dir name>) decrypts  : ${derivedOk}/${checked}`)
      console.log(`    tail-byte XOR keys seen        : ${JSON.stringify(tailXor)} (DLL xorKey=${key.xorKey})`)
    }
  }
}

main()
