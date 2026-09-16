/**
 * Extract the requested version's section from RELEASE_NOTES.md into
 * release-notes-current.md.
 *
 * Two consumers, one file:
 *   1. .github/workflows/release.yml uses it as `body_path` for
 *      softprops/action-gh-release. Passing the full RELEASE_NOTES.md would
 *      overwrite a pre-created release body with the entire changelog — this
 *      script guarantees the release body only contains this version's notes.
 *   2. electron-builder embeds it into latest.yml (`build.releaseInfo.
 *      releaseNotesFile`), which is how the **in-app updater** gets the full
 *      markdown changelog for the version it just detected: users see the
 *      complete release notes, not just "a new version is available".
 *      Without this file in the feed, `updateInfo.releaseNotes` is empty and
 *      the update card renders nothing.
 *
 * Usage:
 *   node scripts/extract-release-notes.mjs [version] [--allow-missing]
 *
 * - version defaults to package.json's version (so npm scripts can call it
 *   with no arguments and stay cross-platform — `$npm_package_version` only
 *   expands in POSIX shells).
 * - --allow-missing downgrades "no section for this version" from a hard
 *   failure to a warning. CI keeps the strict form (a release tag without
 *   notes must fail the build); local `npm run build` uses the tolerant form
 *   so a work-in-progress version number cannot block packaging.
 */
import { readFileSync, writeFileSync } from 'node:fs'

const args = process.argv.slice(2)
const allowMissing = args.includes('--allow-missing')
let version = args.find((a) => !a.startsWith('--'))?.trim()
if (!version) {
  try {
    version = String(JSON.parse(readFileSync('package.json', 'utf8')).version || '').trim()
  } catch {
    version = ''
  }
}
if (!version) {
  console.error('usage: node scripts/extract-release-notes.mjs [version] [--allow-missing]')
  process.exit(1)
}

const raw = readFileSync('RELEASE_NOTES.md', 'utf8')
const lines = raw.split(/\r?\n/)
const heading = `# Weport v${version}`
const startIdx = lines.findIndex((line) => line.trim() === heading)
if (startIdx === -1) {
  const message = `RELEASE_NOTES.md has no section "${heading}" — add it before releasing`
  if (!allowMissing) {
    console.error(message)
    process.exit(1)
  }
  // 容错模式：写一个**明确说明**的占位，而不是留下上一次构建的陈旧内容 ——
  // 陈旧的上一个版本说明出现在更新卡片里，比没有说明更糟。
  console.warn(`[release-notes] ${message}（--allow-missing：写占位继续）`)
  writeFileSync(
    'release-notes-current.md',
    `# Weport v${version}\n\n（本版本尚未填写更新说明。）\n`,
    'utf8'
  )
  process.exit(0)
}

let endIdx = lines.length
for (let i = startIdx + 1; i < lines.length; i++) {
  if (lines[i].startsWith('# Weport ')) {
    endIdx = i
    break
  }
}

// Note: the heading must match a full line ("# Weport v0.9.1" never matches
// "# Weport v0.9.11" because findIndex compares the whole trimmed line).
const section = lines.slice(startIdx, endIdx).join('\n').trimEnd() + '\n'
if (!section.trim()) {
  console.error(`Section "${heading}" is empty — add release notes before releasing`)
  process.exit(1)
}

writeFileSync('release-notes-current.md', section, 'utf8')
console.log(`Wrote release-notes-current.md (${section.split('\n').length} lines, ${heading})`)
