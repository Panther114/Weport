import { describe, it, expect } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { LexicalIndex } from './lexicalIndex'

describe('derived substring inverted index', () => {
  const docs = [
    '中文项目 alphaBeta https://example.com/order/AB-2026',
    '合同编号 MIX_2026 alice@example.com',
    'ALPHABETA 中文项目 deadline tomorrow',
    '记录😀完成 éCOLE ΓΕΙΑ',
    '另一个合同 MIX_2027',
    '隔开的中间文字文不能匹配中文',
  ].map((text, i) => ({ docKey: `source#local#${i}`, text }))
  const queries = ['中文', '文项', 'ALPHABETA', '合同 MIX_2026', 'example.com/order', 'AB-2026', 'alice@', '😀完', 'école', 'γεια', '中', 'missing-token']

  it.each(queries)('matches the complete brute-force oracle for %s', query => {
    const index = LexicalIndex.build(docs)
    const terms = query.toLowerCase().split(/\s+/)
    const matches = (id: number) => terms.every(term => docs[id].text.toLowerCase().includes(term))
    const candidates = index.candidates(terms) ?? Uint32Array.from(docs.map((_, id) => id))
    expect([...candidates].filter(matches)).toEqual(docs.map((_, id) => id).filter(matches))
  })

  it('persists checksummed postings and rejects corruption or a changed/reordered corpus', () => {
    const root = mkdtempSync(join(tmpdir(), 'weport-lexical-'))
    try {
      const path = join(root, 'derived.bin')
      const index = LexicalIndex.build(docs)
      index.save(path, docs.length)
      expect([...LexicalIndex.load(path, docs)!.candidates(['中文'])!]).toEqual([...index.candidates(['中文'])!])
      expect(LexicalIndex.load(path, [...docs].reverse())).toBeNull()
      const changed = docs.map(doc => ({ ...doc }))
      changed[0].text += 'edited'
      expect(LexicalIndex.load(path, changed)).toBeNull()
      const damaged = readFileSync(path)
      damaged[damaged.length - 33] ^= 1
      writeFileSync(path, damaged)
      expect(LexicalIndex.load(path, docs)).toBeNull()
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
})
