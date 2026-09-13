#!/usr/bin/env node
/**
 * extract-todoist-due-docs.mjs — pull the "Due dates" prose out of the Todoist
 * OpenAPI document.
 *
 * The docs site renders the API reference client-side, so a plain fetch returns a
 * nearly empty shell; the authoritative text lives in the spec's own `description`
 * fields. This walks the whole document, collects Markdown-ish tag descriptions
 * that mention due dates, and prints them — the input for the connector's
 * date-parsing rules.
 */
const url = 'https://developer.todoist.com/openapi.json'
const spec = await (await fetch(url, { signal: AbortSignal.timeout(45000) })).json()

const hits = []
const walk = (node, path) => {
  if (!node || typeof node !== 'object') return
  if (typeof node.description === 'string' && /due date|due_string|natural language|recurring/i.test(node.description)) {
    hits.push({ path, text: node.description })
  }
  for (const [key, value] of Object.entries(node)) {
    if (key === 'description') continue
    walk(value, `${path}.${key}`)
  }
}
walk(spec, 'spec')

const seen = new Set()
for (const hit of hits) {
  const text = hit.text.replace(/\r/g, '').trim()
  if (seen.has(text)) continue
  seen.add(text)
  console.log(`\n===== ${hit.path} =====\n${text.slice(0, 3500)}`)
}
console.log(`\n(${hits.length} description hits, ${seen.size} unique)`)
