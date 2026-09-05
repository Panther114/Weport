/**
 * Extract the requested version's section from RELEASE_NOTES.md into
 * release-notes-current.md (used by .github/workflows/release.yml as
 * body_path). Passing the full RELEASE_NOTES.md to softprops/action-gh-release
 * overwrites a pre-created release body with the entire changelog — this
 * script guarantees the release body only contains this version's notes.
 *
 * Usage: node scripts/extract-release-notes.mjs <version>   (e.g. 0.9.11)
 */
import { readFileSync, writeFileSync } from 'node:fs'

const version = process.argv[2]?.trim()
if (!version) {
  console.error('usage: node scripts/extract-release-notes.mjs <version> (e.g. 0.9.11)')
  process.exit(1)
}

const raw = readFileSync('RELEASE_NOTES.md', 'utf8')
const lines = raw.split(/\r?\n/)
const heading = `# Weport v${version}`
const startIdx = lines.findIndex((line) => line.trim() === heading)
if (startIdx === -1) {
  console.error(`RELEASE_NOTES.md has no section "${heading}" — add it before releasing`)
  process.exit(1)
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
