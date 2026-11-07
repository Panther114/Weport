import { describe, expect, it } from 'vitest'
import { exactServerId, quoteTarget } from './quoteReferences'

describe('exact structured quote relationships', () => {
  it('retains uint64 precision and recognizes signed native representations', () => {
    expect(exactServerId('18446744073709551615')).toBe('18446744073709551615')
    expect(exactServerId('-1')).toBe('18446744073709551615')
    expect(exactServerId('18446744073709551616')).toBeNull()
    expect(exactServerId('0')).toBeNull()
  })
  it('reads only refermsg fields and preserves the referenced timestamp', () => {
    expect(quoteTarget('<msg><svrid>3</svrid><refermsg><svrid>9007199254740993</svrid><createtime>1700000000</createtime><content>quoted</content></refermsg></msg>')).toEqual({ serverId: '9007199254740993', timestamp: 1700000000 })
    expect(quoteTarget('Someone mentioned 9007199254740993 in text')).toBeNull()
    expect(quoteTarget('<refermsg><svrid>0</svrid></refermsg>')).toBeNull()
    expect(quoteTarget('&lt;refermsg&gt;&lt;svrid&gt;42&lt;/svrid&gt;&lt;/refermsg&gt;')).toEqual({ serverId: '42' })
  })
})
