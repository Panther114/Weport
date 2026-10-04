import { describe, expect, it } from 'vitest'
import { exportSessionFavoritesFromAnnotations, getExportSessionFavoriteIds } from './exportSessionFavorites'
describe('shared Reader/export session favorites (#26)', () => {
  it('reuses existing Reader favorites and excludes message bookmarks', () => {
    const shared = exportSessionFavoritesFromAnnotations({ favorites: [
      { sessionId: 'friend', localId: 0 }, { sessionId: 'room', localId: '' },
      { sessionId: 'message-only', localId: 7 }, { sessionId: 'exact-message', messageId: '55', localId: 0 },
    ] }, 'account-a')
    expect([...getExportSessionFavoriteIds(shared, 'account-a')]).toEqual(['friend', 'room'])
    expect([...getExportSessionFavoriteIds(shared, 'account-b')]).toEqual([])
  })
  it('deduplicates session stars and handles missing/empty stores', () => {
    expect(exportSessionFavoritesFromAnnotations(null, '')).toEqual({})
    expect(exportSessionFavoritesFromAnnotations({ favorites: [{ sessionId: 'friend' }, { sessionId: 'friend' }] }, 'a')).toEqual({ a: ['friend'] })
  })
})
