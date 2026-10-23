/** Derived UTF-16 bigram postings. Substring verification remains authoritative.
 * Single code-unit queries deliberately fall back to scanning, preserving recall.
 * No tokenizer, database extension, model download, or cloud request is required.
 */
import { createHash } from 'crypto'
import { readFileSync } from 'fs'
import { writeFileAtomic } from './atomicJson'

const MAGIC = Buffer.from('WPLEX001')
export interface LexicalDocument { docKey: string; text: string }
function fingerprint(docs: LexicalDocument[]): Buffer {
  const hash = createHash('sha256')
  for (const doc of docs) hash.update(`${doc.docKey.length}:${doc.docKey}${doc.text.length}:${doc.text}`)
  return hash.digest()
}
function grams(text: string): Set<number> {
  const out = new Set<number>()
  for (let i = 1; i < text.length; i++) out.add((text.charCodeAt(i - 1) * 65536 + text.charCodeAt(i)) >>> 0)
  return out
}

export class LexicalIndex {
  private constructor(readonly postings: Map<number, Uint32Array>, readonly signature: Buffer) {}

  static build(docs: LexicalDocument[]): LexicalIndex {
    // Two passes avoid retaining JS number arrays for every common bigram.
    // Postings live in compact external typed buffers rather than V8's heap.
    const counts = new Map<number, number>()
    for (let i = 0; i < docs.length; i++) {
      for (const gram of grams(docs[i].text.toLowerCase())) {
        counts.set(gram, (counts.get(gram) || 0) + 1)
      }
    }
    const postings = new Map<number, Uint32Array>()
    for (const [gram, count] of counts) { postings.set(gram, new Uint32Array(count)); counts.set(gram, 0) }
    for (let i = 0; i < docs.length; i++) for (const gram of grams(docs[i].text.toLowerCase())) {
      const offset = counts.get(gram)!
      postings.get(gram)![offset] = i
      counts.set(gram, offset + 1)
    }
    return new LexicalIndex(postings, fingerprint(docs))
  }

  /** Use the rarest mandatory gram; final exact AND/substring checks remove false positives. */
  candidates(terms: string[]): Uint32Array | null {
    let shortest: Uint32Array | null = null
    for (const term of terms) for (const gram of grams(term)) {
      const list = this.postings.get(gram)
      if (!list) return new Uint32Array(0)
      if (!shortest || list.length < shortest.length) shortest = list
    }
    return shortest
  }

  save(path: string, docs: number): void {
    let count = 0
    for (const list of this.postings.values()) count += list.length
    const header = 48 + this.postings.size * 8
    const buffer = Buffer.allocUnsafe(header + count * 4 + 32)
    MAGIC.copy(buffer); buffer.writeUInt32LE(docs, 8); buffer.writeUInt32LE(this.postings.size, 12)
    this.signature.copy(buffer, 16)
    let entry = 48; let offset = header
    for (const [gram, list] of this.postings) {
      buffer.writeUInt32LE(gram, entry); buffer.writeUInt32LE(list.length, entry + 4); entry += 8
      for (const id of list) { buffer.writeUInt32LE(id, offset); offset += 4 }
    }
    createHash('sha256').update(buffer.subarray(0, offset)).digest().copy(buffer, offset)
    writeFileAtomic(path, buffer, { sync: true })
  }

  static load(path: string, docs: LexicalDocument[]): LexicalIndex | null {
    try {
      const buffer = readFileSync(path)
      if (buffer.length < 80 || !buffer.subarray(0, 8).equals(MAGIC) || buffer.readUInt32LE(8) !== docs.length) return null
      if (!createHash('sha256').update(buffer.subarray(0, -32)).digest().equals(buffer.subarray(-32))) return null
      const signature = fingerprint(docs)
      if (!signature.equals(buffer.subarray(16, 48))) return null
      const size = buffer.readUInt32LE(12)
      let offset = 48 + size * 8
      if (offset > buffer.length - 32) return null
      const postings = new Map<number, Uint32Array>()
      for (let i = 0; i < size; i++) {
        const gram = buffer.readUInt32LE(48 + i * 8); const count = buffer.readUInt32LE(52 + i * 8)
        if (offset + count * 4 > buffer.length - 32 || postings.has(gram)) return null
        const ids = new Uint32Array(count)
        for (let j = 0; j < count; j++) {
          const id = buffer.readUInt32LE(offset); offset += 4
          if (id >= docs.length || (j > 0 && id <= ids[j - 1])) return null
          ids[j] = id
        }
        postings.set(gram, ids)
      }
      return offset === buffer.length - 32 ? new LexicalIndex(postings, signature) : null
    } catch { return null }
  }
}
