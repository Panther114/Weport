interface Step { toolCalls?: Array<{ name: string; result?: string }> }
export interface Coverage { kind: 'page' | 'sample' | 'images' | 'aggregate' | 'search' | 'unknown'; data: Record<string, any> }

/** Never substitute an earlier success for the most recent failed or incomplete read. */
export function latestInvestigationCoverage(messages: Step[]): Coverage | null {
  const calls = messages.flatMap(message => message.toolCalls || []).filter(call => /^(read_session_messages|read_day_events|read_period_events|read_chat_images|search_messages|sample_session_history|get_session_stats|list_dates)$/.test(call.name))
  const call = calls[calls.length - 1]
  if (!call) return null
  const result = call.result || ''
  const marker = result.lastIndexOf('\nCoverage: ')
  try {
    if (marker >= 0) {
      const data = JSON.parse(result.slice(marker + '\nCoverage: '.length))
      if (data && typeof data === 'object' && !Array.isArray(data)) return { kind: ['sample', 'images', 'aggregate'].includes(data.mode) ? data.mode : 'page', data }
    } else {
      const firstLine = JSON.parse(result.split('\n')[0])
      if (firstLine?.coverage && typeof firstLine.coverage === 'object' && !Array.isArray(firstLine.coverage)) return { kind: 'search', data: { ...firstLine.coverage, truncated: firstLine.truncated } }
    }
  } catch { /* The latest unavailable coverage remains unknown. */ }
  return { kind: 'unknown', data: {} }
}
