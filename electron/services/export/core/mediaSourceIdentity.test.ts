import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../config', () => ({ ConfigService: class {
  getCacheBasePath() { return process.env.TEMP || '.' }
  get() { return '' }
} }))
vi.mock('../../wcdbService', () => ({ wcdbService: {
  getMessageById: vi.fn(), getContact: vi.fn(async () => ({ success: false })), getMediaStream: vi.fn(), openMessageCursor: vi.fn(), fetchMessageBatch: vi.fn(), closeMessageCursor: vi.fn(),
  getDisplayNames: vi.fn(async () => ({ success: true, map: {} })),
  getAvatarUrls: vi.fn(async () => ({ success: true, map: {} })),
} }))
vi.mock('../../chatService', () => ({ chatService: { setRuntimeConfig: vi.fn(), getMessageByIdentity: vi.fn(), getVoiceData: vi.fn() } }))
vi.mock('../../imageDecryptService', () => ({ imageDecryptService: { setRuntimeConfig: vi.fn(), resolveCachedImage: vi.fn(), decryptImage: vi.fn() } }))
vi.mock('../../exportRecordService', () => ({ exportRecordService: {} }))

import { ExportContext } from './ExportContext'
import { wcdbService } from '../../wcdbService'
import { chatService } from '../../chatService'

describe('media export physical source identities', () => {
  beforeEach(() => vi.clearAllMocks())

  it('forwards runtime image credentials and account paths to the reader service', () => {
    const context = new ExportContext()
    const runtime = { dbPath: '/private/account-parent', myWxid: 'runtime-account', decryptKey: 'fixture-db-key', imageXorKey: 23, imageAesKey: 'fixture-image-key' }
    context.setRuntimeConfig(runtime)
    expect(chatService.setRuntimeConfig).toHaveBeenLastCalledWith(expect.objectContaining(runtime))
  })

  it.each(['unscoped', 'partly-scoped', 'unsafe-number'])('discards an inexact fast stream and uses canonical rows (%s)', async variant => {
    const context = new ExportContext()
    const stream = { sessionId: 'room', localId: 7, serverId: '123', createTime: 1700000000,
      localType: 3, mediaType: 'image' as const, imageMd5: 'a'.repeat(32), imageDatName: 'a'.repeat(32) }
    const scoped = { ...stream, _db_path: '/db_storage/message_0.db', _table_name: 'Msg_room' }
    const items = variant === 'unsafe-number' ? [{ ...scoped, localId: Number('9007199254740993') }]
      : variant === 'partly-scoped' ? [scoped, stream] : [stream]
    vi.mocked(wcdbService.getMediaStream).mockResolvedValue({ success: true, hasMore: false, items } as any)
    const canonical = [0, 1].map(shard => ({ local_id: '9007199254740993', server_id: '123',
      create_time: 1700000000, local_type: 3, sender_username: 'sender',
      message_content: `<msg><img md5="${'a'.repeat(32)}"/></msg>`,
      _db_path: `/db_storage/message_${shard}.db`, _table_name: 'Msg_room' }))
    vi.mocked(wcdbService.openMessageCursor).mockResolvedValue({ success: true, cursor: 1 })
    vi.mocked(wcdbService.fetchMessageBatch).mockResolvedValue({ success: true, hasMore: false, rows: canonical })
    vi.mocked(wcdbService.closeMessageCursor).mockResolvedValue({ success: true })
    vi.spyOn(context as any, 'backfillMediaFieldsFromMessageDetail').mockResolvedValue(undefined)

    const collected = await context.collectMessages('room', 'me', null, undefined, 'media-fast', new Set([3]))

    expect(collected.error).toBeUndefined()
    expect(wcdbService.openMessageCursor).toHaveBeenCalledOnce()
    expect(collected.rows).toHaveLength(2)
    expect(collected.rows.map(row => row.localIdRaw)).toEqual(['9007199254740993', '9007199254740993'])
    const identities = collected.rows.map(row => context.getSourceMessageIdentityHash(row))
    expect(identities.every(Boolean)).toBe(true)
    expect(new Set(identities).size).toBe(2)
    expect(wcdbService.closeMessageCursor).toHaveBeenCalledWith(1)
  })
})


import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { imageDecryptService } from '../../imageDecryptService'
import { JsonFormatter } from '../formatters/JsonFormatter'
const mediaRoots: string[] = []
afterEach(async () => { for (const root of mediaRoots.splice(0)) await rm(root, { recursive: true, force: true }) })

async function mediaFixture(tier: string, policy: 'best-available' | 'original-only' = 'best-available') {
  const root = await mkdtemp(join(tmpdir(), 'weport-media-policy-')); mediaRoots.push(root)
  const source = join(root, 'image' + ({ original: '_hd', display: '', thumbnail: '_thumb' } as Record<string, string>)[tier] + '.png')
  if (['original', 'display', 'thumbnail'].includes(tier)) await writeFile(source, Buffer.from('fixture image bytes'))
  vi.mocked(imageDecryptService.resolveCachedImage).mockImplementation(async () => ['original', 'display', 'thumbnail'].includes(tier) ? { success: true, localPath: source } : { success: false } as any)
  vi.mocked(imageDecryptService.decryptImage).mockResolvedValue({ success: false, failureKind: tier === 'decryption-failed' ? 'decrypt_failed' : 'not_found' } as any)
  const context = new ExportContext()
  const row: any = { localType: 3, localId: Number('9007199254740993'), localIdRaw: '9007199254740993', imageMd5: 'a'.repeat(32), createTime: 1700000000,
    _db_path: 'db_storage/message_0.db', _table_name: 'Msg_room', senderUsername: 'sender', content: '<msg><img/></msg>' }
  const options = { archiveMode: true, mediaPolicy: policy, exportImages: true }
  return { root, source, context, row, options }
}

async function formatArchive(x: Awaited<ReturnType<typeof mediaFixture>>, options: Record<string, unknown> = {}, rows = [x.row]) {
  const context: any = x.context
  const overrides: Record<string, any> = {
    ensureConnected: async () => ({ success: true, cleanedWxid: 'me' }), getConfiguredMyWxid: () => 'me',
    getContactInfo: async (id: string) => ({ displayName: id }),
    collectMessages: async () => ({ rows, memberSet: new Map(), lastTime: x.row.createTime }),
    createWeliveRawOutputPlaceholder: async () => {}, hydrateEmojiCaptionsForMessages: async () => {}, resolveQuotedMessagesForExport: async () => {},
    preloadContacts: async () => {}, preloadContactInfos: async () => new Map(), preloadWeliveRawEmojiMedia: async () => {},
    preloadMediaLookupCaches: async () => {}, resolveWeliveRawMediaItem: async () => null, resolveQuotedReplyDisplayWithNames: async () => null,
  }
  for (const [key, value] of Object.entries(overrides)) vi.spyOn(context, key).mockImplementation(value)
  const file = join(x.root, 'archive.json')
  const result = await new JsonFormatter(context).export('room', file, { ...x.options, format: 'json', exportMedia: true, exportEmojis: false, exportAvatars: false, ...options }, undefined, undefined)
  expect(result).toEqual({ success: true })
  return JSON.parse(await readFile(file, 'utf8'))
}

describe('archive media policy actual export pipeline with controlled local resolvers', () => {
  it('enriches media through exact physical source lookup without narrowing raw local IDs', async () => {
    const x = await mediaFixture('original')
    vi.mocked(chatService.getMessageByIdentity).mockResolvedValue({ success: true, message: { imageMd5: 'b'.repeat(32), content: '' } } as any)
    await (x.context as any).backfillMediaFieldsFromMessageDetail('room', [x.row], new Set([3]), undefined, { force: true })
    expect(chatService.getMessageByIdentity).toHaveBeenCalledWith({ sessionId: 'room', localId: '9007199254740993', ts: x.row.createTime,
      db: x.row._db_path, table: x.row._table_name, idKind: 'local' })
    expect(wcdbService.getMessageById).not.toHaveBeenCalled()
    expect(x.row.imageMd5).toBe('b'.repeat(32))
  })
  it('passes exact voice provenance to the service and exposes unsupported mappings', async () => {
    const x = await mediaFixture('original'); x.row.localType = 34
    vi.mocked(chatService.getVoiceData).mockResolvedValue({ success: false, failureKind: 'unsupported' })
    expect(await x.context.exportMediaForMessage(x.row, 'room', x.root, 'media', { ...x.options, exportVoices: true })).toBeNull()
    expect(chatService.getVoiceData).toHaveBeenCalledWith('room', '9007199254740993', x.row.createTime, undefined, 'sender', { db: x.row._db_path, table: x.row._table_name })
    expect(x.row._archiveMediaOutcome).toEqual({ kind: 'voice', status: 'unsupported' })
  })
  it.each(['original', 'display', 'thumbnail'])('copies %s bytes with exact ID and explicit quality', async tier => {
    const x = await mediaFixture(tier)
    const media = await x.context.exportMediaForMessage(x.row, 'room', x.root, 'media', x.options)
    expect(x.row._archiveMediaOutcome.status).toBe(tier)
    expect(media?.relativePath).toContain('9007199254740993_')
    expect(await readFile(join(x.root, media!.relativePath))).toEqual(await readFile(x.source))
  })
  it.each(['display', 'thumbnail'])('does not copy %s as an original', async tier => {
    const x = await mediaFixture(tier, 'original-only')
    expect(await x.context.exportMediaForMessage(x.row, 'room', x.root, 'media', x.options)).toBeNull()
    expect(x.row._archiveMediaOutcome).toEqual({ kind: 'image', status: 'original-unavailable' })
  })
  it('copies proven originals under original-only policy', async () => {
    const x = await mediaFixture('original', 'original-only')
    expect(await x.context.exportMediaForMessage(x.row, 'room', x.root, 'media', x.options)).not.toBeNull()
    expect(x.row._archiveMediaOutcome.status).toBe('original')
  })
  it.each(['missing-locally', 'decryption-failed'])('keeps %s distinct and clears an earlier outcome on a retry', async status => {
    const x = await mediaFixture(status)
    x.row._archiveMediaFailure = 'original-unavailable'; x.row._archiveImageTier = 'original'
    expect(await x.context.exportMediaForMessage(x.row, 'room', x.root, 'media', x.options)).toBeNull()
    expect(x.row._archiveMediaOutcome).toEqual({ kind: 'image', status })
  })
  it('rejects unproven adopted image paths in original-only mode', async () => {
    const x = await mediaFixture('display', 'original-only')
    vi.spyOn(x.context as any, 'resolveWeliveMediaPath').mockReturnValue(x.source)
    expect(await x.context.exportMediaForMessage(x.row, 'room', x.root, 'media', x.options)).toBeNull()
    expect(x.row._archiveMediaOutcome.status).toBe('original-unavailable')
  })

  it.each(['original', 'display', 'thumbnail', 'missing-locally', 'decryption-failed'])('real JSON formatter serializes %s with its exact identity', async status => {
    const x = await mediaFixture(status), doc = await formatArchive(x)
    expect(doc.messages[0].mediaOutcome.status).toBe(status)
    expect(doc.messages[0].sourceIdentity.localId).toBe('9007199254740993')
    expect(doc.messages[0].sourceIdentityHash).toBe(x.context.getSourceMessageIdentityHash(x.row))
  })
  it('real JSON formatter ignores stale media outcomes when media is not requested', async () => {
    const x = await mediaFixture('original')
    x.row._archiveMediaOutcome = { kind: 'image', status: 'original', relativePath: 'stale.png' }
    const doc = await formatArchive(x, { exportMedia: false, exportImages: false })
    expect(doc.messages[0].mediaOutcome).toEqual({ kind: 'image', status: 'not-requested' })
  })
  it('real JSON formatter preserves raw exact source identity and unsupported emoji outcomes', async () => {
    const x = await mediaFixture('original')
    x.row.localType = 47; x.row.content = '<msg><emoji/></msg>'
    const doc = await formatArchive(x)
    expect(doc.messages[0].sourceIdentity.localId).toBe('9007199254740993')
    expect(doc.messages[0].sourceIdentityHash).toBe(x.context.getSourceMessageIdentityHash(x.row))
    expect(doc.messages[0].rawContent).toBe(x.row.content)
    expect(doc.messages[0].mediaOutcome).toEqual({ kind: 'emoji', status: 'unsupported' })
  })
})


describe('ordinary export policy and repeated archive outcomes', () => {
  it('enforces original-only on imported paths outside archive mode', async () => {
    const x = await mediaFixture('display', 'original-only')
    vi.spyOn(x.context as any, 'resolveWeliveMediaPath').mockReturnValue(x.source)
    expect(await x.context.exportMediaForMessage(x.row, 'room', x.root, 'media', { ...x.options, archiveMode: false })).toBeNull()
    expect(x.row._archiveMediaFailure).toBe('original-unavailable')
  })
  it('rejects raw imported image fallback when original-only is requested', async () => {
    const x = await mediaFixture('original', 'original-only')
    vi.spyOn(x.context as any, 'isWeliveRawExportMode').mockReturnValue(true)
    vi.spyOn(x.context as any, 'resolveWeliveMediaPath').mockReturnValue('https://example.invalid/unverified.png')
    expect(await x.context.resolveWeliveRawMediaItem(x.row, x.root, 'media', x.options as any)).toBeNull()
  })
  it.each(['original', 'missing-locally', 'decryption-failed'])('keeps cached %s outcomes on every repeated physical row', async status => {
    const x = await mediaFixture(status)
    const rows = [x.row, { ...x.row, _archiveMediaOutcome: { kind: 'image', status: 'stale' } }]
    const doc = await formatArchive(x, { exportConcurrency: 1 }, rows)
    expect(doc.messages.map((row: any) => row.mediaOutcome.status)).toEqual([status, status])
  })
  it('clears an old successful tier when a later ordinary export fails', async () => {
    const x = await mediaFixture('original')
    await x.context.exportMediaForMessage(x.row, 'room', x.root, 'media', x.options)
    expect(x.row._archiveMediaOutcome.status).toBe('original')
    vi.spyOn(x.context as any, 'exportMediaForMessageUnbounded').mockResolvedValue(null)
    expect(await x.context.exportMediaForMessage(x.row, 'room', x.root, 'media', { ...x.options, archiveMode: false })).toBeNull()
    expect(x.row._archiveMediaOutcome).toBeUndefined()
    expect(x.row._archiveImageTier).toBeUndefined()
  })
})
