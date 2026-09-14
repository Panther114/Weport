// 探针环境配置：给 UI 探针的 userData 设置配置项。
//
// 存在的理由：`.ui-probe/userData` 是探针自己的隔离配置，里面已经有一份真实
// 数据缓存（会话/联系人/头像），但没有服务器地址、背景视频这类"要试某个功能
// 才需要"的值。用这个脚本改比手写 PowerShell 安全 —— Windows 路径里的反斜杠
// 在多层引号里几乎必定被吃错。
//
// 用法：
//   node scripts/ui-probe-config.mjs --set weCloneServerUrl=http://127.0.0.1:8099
//   node scripts/ui-probe-config.mjs --show weCloneServerUrl appearanceBackgroundPath
//
// 值里的字面不转义：传 --unset <key> 删除。

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const configPath = join(root, '.ui-probe', 'userData', 'Weport-config.json')

const argv = process.argv.slice(2)
const flag = (name) => {
  const i = argv.indexOf(`--${name}`)
  if (i === -1) return null
  // 收集到下一个 `--flag` 为止：否则 `--set a=b --show a` 会把 `--show` 也
  // 当成 set 的取值。
  const values = []
  for (let j = i + 1; j < argv.length; j += 1) {
    if (argv[j].startsWith('--')) break
    values.push(argv[j])
  }
  return values
}

const config = JSON.parse(readFileSync(configPath, 'utf8'))

const sets = flag('set') || []
for (const entry of sets) {
  const eq = entry.indexOf('=')
  if (eq === -1) throw new Error(`--set needs key=value, got: ${entry}`)
  const key = entry.slice(0, eq)
  let value = entry.slice(eq + 1)
  if (value === 'true') value = true
  else if (value === 'false') value = false
  else if (/^-?\d+$/.test(value)) value = Number(value)
  config[key] = value
}

for (const key of flag('unset') || []) delete config[key]

writeFileSync(configPath, JSON.stringify(config, null, 2))

const show = flag('show')
if (show) {
  for (const key of show) console.log(`${key} = ${JSON.stringify(config[key])}`)
} else {
  console.log(`updated ${configPath} (${sets.length} set, ${(flag('unset') || []).length} unset)`)
}
