/**
 * Bubble structure — what the user actually sees.
 *
 * The clone returns ONE string per turn, but the chat surface (and WeChat itself)
 * shows separate messages: paragraph breaks are real bubbles. Every surface metric
 * in the harness used to average over whole replies, which makes two very different
 * things look identical:
 *
 *   - one 55-character wall of text
 *   - four ~14-character messages
 *
 * The person's own median message is 14 characters and his bursts average 4.31
 * messages, so that difference is the single most visible mismatch we have. It is
 * only measurable if the arm's text is split on the same boundaries the UI uses —
 * hence this module. Deliberately NOT splitting on sentence boundaries: the harness
 * must measure what the app returns, not what it could have returned.
 */

/** Split a reply into the bubbles the UI renders. */
export function splitBubbles(text) {
  return String(text || '')
    .split(/\n\s*\n|\n/)
    .map((s) => s.trim())
    .filter(Boolean)
}

/** Bubbles per reply (the clone's burst size — compare with the author's ~4.31). */
export function bubblesPerReply(texts) {
  const list = Array.isArray(texts) ? texts : []
  if (list.length === 0) return 0
  let bubbles = 0
  for (const t of list) bubbles += splitBubbles(t).length
  return bubbles / list.length
}
