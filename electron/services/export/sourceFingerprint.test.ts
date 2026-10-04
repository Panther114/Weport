import { afterEach, expect, it } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sourceFingerprint } from './sourceFingerprint'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

it('invalidates media recovery when an attachment is downloaded without a DB change', async () => {
  const root = await mkdtemp(join(tmpdir(), 'weport-watermark-'))
  roots.push(root)
  await mkdir(join(root, 'db_storage'))
  await writeFile(join(root, 'db_storage', 'message.db'), 'fixture database')
  const database = await sourceFingerprint(root)
  const media = await sourceFingerprint(root, true)
  await mkdir(join(root, 'msg', 'attach'), { recursive: true })
  await writeFile(join(root, 'msg', 'attach', 'fixture.dat'), 'fixture attachment')
  expect(await sourceFingerprint(root)).toBe(database)
  expect(await sourceFingerprint(root, true)).not.toBe(media)
})

it('does not allow recovery with an unknown source', async () => {
  expect(await sourceFingerprint('')).toBeNull()
})

it('ignores shared-memory bookkeeping but tracks database and WAL changes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'weport-watermark-'))
  roots.push(root)
  const directory = join(root, 'db_storage')
  await mkdir(directory)
  const database = join(directory, 'message.db')
  const sharedMemory = `${database}-shm`
  await writeFile(database, 'database')
  const initial = await sourceFingerprint(root)
  await writeFile(sharedMemory, 'reader bookkeeping')
  expect(await sourceFingerprint(root)).toBe(initial)
  await writeFile(sharedMemory, 'different reader bookkeeping')
  expect(await sourceFingerprint(root)).toBe(initial)
  await rm(sharedMemory)
  expect(await sourceFingerprint(root)).toBe(initial)
  await writeFile(`${database}-wal`, 'new messages')
  const withWal = await sourceFingerprint(root)
  expect(withWal).not.toBe(initial)
  await writeFile(`${database}-wal`, 'more new messages')
  expect(await sourceFingerprint(root)).not.toBe(withWal)
  const beforeDatabaseChange = await sourceFingerprint(root)
  await writeFile(database, 'changed database contents')
  expect(await sourceFingerprint(root)).not.toBe(beforeDatabaseChange)
})
