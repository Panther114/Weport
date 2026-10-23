import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { randomUUID } from 'crypto'
import { accountNamespace } from './dataScope'

/** Claim legacy unscoped files for one account only; originals stay recoverable. */
export function migrateLegacyAi(dataRoot: string, workspaceRoot: string, accountId: string): void {
  if (!accountId.trim()) return
  mkdirSync(dataRoot, { recursive: true })
  const namespace = accountNamespace(accountId)
  const ownerFile = join(dataRoot, 'legacy-owner.json')
  try { writeFileSync(ownerFile, JSON.stringify({ version: 1, namespace }), { flag: 'wx', mode: 0o600 }) }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
  if (JSON.parse(readFileSync(ownerFile, 'utf8')).namespace !== namespace) return
  const migrate = (root: string, names: string[]) => {
    const target = join(root, 'accounts', namespace)
    const completed = join(target, '.legacy-migrated')
    if (existsSync(completed)) return
    // Never merge legacy data into an existing account namespace. It may contain
    // newer user work. A staged migration is committed with one directory rename.
    if (existsSync(target)) return
    mkdirSync(dirname(target), { recursive: true })
    const staging = `${target}.${randomUUID()}.migration`
    mkdirSync(staging)
    for (const name of names) if (existsSync(join(root, name))) cpSync(join(root, name), join(staging, name), { recursive: true, errorOnExist: true })
    writeFileSync(join(staging, '.legacy-migrated'), '1')
    renameSync(staging, target)
  }
  migrate(dataRoot, ['index.json', 'sessions', 'prefix-probe.json'])
  migrate(workspaceRoot, ['memory', 'chats'])
}
