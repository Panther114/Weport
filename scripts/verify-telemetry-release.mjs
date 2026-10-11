import { readFileSync } from 'node:fs'
const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const parts = version.split('.').map(Number)
if (parts[0] > 1 || (parts[0] === 1 && (parts[1] > 2 || (parts[1] === 2 && parts[2] >= 1)))) {
  let valid = false
  try {
    const url = new URL(process.env.WEPORT_TELEMETRY_URL || '')
    valid = url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash && url.pathname === '/'
  } catch { /* Report only the missing setting, never the raw URL. */ }
  if (!valid) throw new Error('Deploy infra/telemetry-worker and set Actions variable WEPORT_TELEMETRY_URL to its HTTPS origin before releasing.')
}
