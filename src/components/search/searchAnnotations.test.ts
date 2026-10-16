import { describe, expect, it } from 'vitest'
import { sessionsForSearchScope, sessionsForTags, tagRows, tagsBySession } from './searchAnnotations'

const store = {
  tags: { wxid_a: ['客户', '重点'], wxid_b: ['客户'], wxid_c: ['内部'] },
  tagIndex: { 客户: ['wxid_a', 'wxid_b'], 重点: ['wxid_a'], 内部: ['wxid_c'] },
}

describe('annotation tag mappings', () => {
  it('uses the documented session-to-tags map for rows and counts', () => {
    expect(tagsBySession(store).get('wxid_a')).toEqual(['客户', '重点'])
    expect(tagRows(store)).toEqual([{ name: '客户', count: 2 }, { name: '内部', count: 1 }, { name: '重点', count: 1 }])
  })

  it('resolves selected tags to sessions and intersects explicit session scope', () => {
    expect(sessionsForTags(store, ['客户', '内部'])).toEqual(['wxid_a', 'wxid_b', 'wxid_c'])
    expect(sessionsForSearchScope(['wxid_a', 'wxid_c'], ['wxid_a', 'wxid_b'])).toEqual(['wxid_a'])
  })

  it('preserves an empty tag match as empty instead of broadening scope', () => {
    expect(sessionsForTags(store, ['missing'])).toEqual([])
    expect(sessionsForSearchScope([], [])).toEqual([])
  })

  it('reconstructs rows when only the inverse index exists', () => {
    expect(tagsBySession({ tagIndex: { 客户: ['wxid_a'] } }).get('wxid_a')).toEqual(['客户'])
  })
})
