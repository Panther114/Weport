#!/usr/bin/env node
/**
 * measure-weclone-chunks.mjs — report the chunk-size distribution of a WeClone
 * staging corpus against the server's upload limit (1200 chars/chunk).
 *
 * Written after an upload failed with `chunks[1].text exceeds 1200 chars` while the
 * splitter looked correct: the number that matters is the length of the *string* the
 * server receives, so this prints it directly instead of re-deriving it by hand.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const dir = process.argv[2] || join(process.env.APPDATA || '', 'Weport', 'weclone-staging', 'wxid_gsnpwh6vh2z012')
const MAX = 1200
const chunks = readFileSync(join(dir, 'chunks.jsonl'), 'utf8').split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line))

const out = []
for (const chunk of chunks) {
  const text = String(chunk.text || '')
  if (text.length <= MAX) { out.push(text); continue }
  let buffer = ''
  for (const line of text.split('\n')) {
    if (buffer && buffer.length + line.length + 1 > MAX) { out.push(buffer); buffer = '' }
    buffer = buffer ? `${buffer}\n${line}` : line
  }
  if (buffer) out.push(buffer)
}

const lengths = out.map((text) => text.length)
console.log(`source: ${chunks.length} chunks, longest ${Math.max(...chunks.map((chunk) => String(chunk.text || '').length))} chars`)
console.log(`split:  ${out.length} chunks, longest ${Math.max(...lengths)} chars, over limit ${lengths.filter((length) => length > MAX).length}`)
console.log(`first four lengths: ${lengths.slice(0, 4).join(', ')}`)
console.log(`longest single line: ${Math.max(...out.flatMap((text) => text.split('\n')).map((line) => line.length))}`)
