import { describe, expect, it } from 'vitest'
import { latestInvestigationCoverage } from './coverageState'
const page = { name: 'read_session_messages', result: 'messages\nCoverage: {"mode":"page","returned":400,"hasMore":true}' }
describe('latest investigation coverage', () => {
  it('does not reuse an earlier success after the newest read fails', () => {
    expect(latestInvestigationCoverage([{toolCalls:[page, {name:'read_session_messages',result:'read failed'}]}])?.kind).toBe('unknown')
  })
  it('does not treat truncated metadata as usable coverage', () => {
    expect(latestInvestigationCoverage([{toolCalls:[page, {name:'search_messages',result:'{"coverage":'}]}])?.kind).toBe('unknown')
  })
  it('ignores unrelated note reads and keeps the latest actual history page', () => {
    expect(latestInvestigationCoverage([{toolCalls:[page, {name:'read_note',result:'saved note'}]}])).toEqual({kind:'page',data:{mode:'page',returned:400,hasMore:true}})
  })
  it('keeps the empty state before any history inspection', () => {
    expect(latestInvestigationCoverage([{toolCalls:[{name:'list_notes',result:'[]'}]}])).toBeNull()
  })
})
