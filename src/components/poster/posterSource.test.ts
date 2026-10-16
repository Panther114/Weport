import { afterEach, describe, expect, it, vi } from 'vitest'
import { loadItemImage, normalizeMessage, posterItemsFromReaderMessages } from './posterSource'
import type { ReaderMessage } from '../reader/readerTypes'

const message = (patch: Partial<ReaderMessage>): ReaderMessage => ({
  key: 'k1', sessionId: 'wxid_a', localId: 1, ts: 1790388300000, isSend: false,
  senderName: 'Alice', senderUsername: 'wxid_alice', kind: 'text', text: 'hello', chatRecordCount: 0,
  revoked: false, ...patch,
})

function stubImageBridge(getImageDataByIdentity: (identity: unknown, options?: unknown) => Promise<unknown>): void {
  ;(globalThis as unknown as { window?: unknown }).window = { electronAPI: { chat: { getImageDataByIdentity } } }
}

afterEach(() => {
  delete (globalThis as unknown as { window?: unknown }).window
  vi.restoreAllMocks()
})

describe('posterItemsFromReaderMessages', () => {
  it('preserves message order, sender, quote and timestamp when passed selected reader messages', () => {
    const items = posterItemsFromReaderMessages([
      message({ key: 'a', localId: 42, kind: 'quote', text: 'reply', quote: { sender: 'Bob', text: 'quoted' } }),
      message({ key: 'b', localId: 43, isSend: true, senderName: 'Me', kind: 'image', text: '' }),
    ])
    expect(items).toHaveLength(2)
    expect(items[0]).toMatchObject({ key: 'a', kind: 'quote', quote: { sender: 'Bob', text: 'quoted' }, ts: 1790388300000 })
    expect(items[1]).toMatchObject({ key: 'b', isSend: true, senderName: '我', kind: 'image', imageUnavailable: true })
  })

  it('keeps a locally cached sticker inline instead of requesting the image database', () => {
    const [item] = posterItemsFromReaderMessages([message({ kind: 'sticker', stickerLocalPath: 'C:\\cache\\sticker.gif' })])
    expect(item.kind).toBe('image')
    expect(item.imageUnavailable).toBe(false)
    expect(item.imageSrc).toContain('weport-media://local/')
  })

  it('loads a reader poster image by exact shard identity, including server IDs', async () => {
    const getImageDataByIdentity = vi.fn(async () => ({ success: true, data: 'iVBORw0KGgo' }))
    stubImageBridge(getImageDataByIdentity)
    const [item] = posterItemsFromReaderMessages([
      message({ key: 'exact', localId: 0, serverId: '9007199254740993', kind: 'image', ts: 1_790_388_300_000, db: 'C:/wx/message_2.db', table: 'Msg_A' }),
    ])

    const result = await loadItemImage(item)
    expect(getImageDataByIdentity).toHaveBeenCalledWith({
      sessionId: 'wxid_a',
      localId: '9007199254740993',
      ts: 1_790_388_300_000,
      db: 'C:/wx/message_2.db',
      table: 'Msg_A',
      idKind: 'server',
    }, { excludeThumbnail: true })
    expect(result).toMatchObject({ success: true, src: 'data:image/png;base64,iVBORw0KGgo' })
  })

  it('preserves large exact local IDs as text for poster image lookup', async () => {
    const getImageDataByIdentity = vi.fn(async () => ({ success: true, data: 'iVBORw0KGgo' }))
    stubImageBridge(getImageDataByIdentity)
    const item = normalizeMessage({
      localId: '9007199254740993',
      idKind: 'local',
      messageId: '9007199254740993',
      localType: 3,
      imageMd5: 'abc',
      createTime: 1_790_388_300,
      _db_path: 'C:/wx/message_2.db',
      _table_name: 'Msg_A',
    }, 0, 'wxid_a')!

    const result = await loadItemImage(item)

    expect(getImageDataByIdentity).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'wxid_a',
      localId: '9007199254740993',
      idKind: 'local',
    }), { excludeThumbnail: true })
    expect(item.localId).toBeUndefined()
    expect(result.success).toBe(true)
  })
})
