import { describe, expect, it } from 'vitest'
import { extractWechatVoiceTranscript, extractWechatVoiceTranscriptFromPackedInfo } from './voiceTranscript'

describe('WeChat cached voice transcripts (#28)', () => {
  it('reads voicetrans attributes and XML entities', () => {
    expect(extractWechatVoiceTranscript('<msg><voicetrans transtext="你好 &amp; 再见&#33;"/></msg>')).toBe('你好 & 再见!')
  })
  it('reads text nodes, CDATA, and single-quoted attributes', () => {
    expect(extractWechatVoiceTranscript('<transtext><![CDATA[今天 <明天>]]></transtext>')).toBe('今天 <明天>')
    expect(extractWechatVoiceTranscript("<voicetrans transtext='hello'/>")).toBe('hello')
    expect(extractWechatVoiceTranscript('<voicetrans>已转换的文字</voicetrans>')).toBe('已转换的文字')
    expect(extractWechatVoiceTranscript('<voicetrans><![CDATA[原文 <标签> &amp;]]></voicetrans>')).toBe('原文 <标签> &amp;')
    expect(extractWechatVoiceTranscript('<transtext>&#38;lt;</transtext>')).toBe('&lt;')
  })
  it('does not mistake audio lengths, protocol flags, or ordinary messages for text', () => {
    expect(extractWechatVoiceTranscript('<voicemsg voicelength="3000"/>')).toBe('')
    expect(extractWechatVoiceTranscript('<voicetrans><status>1</status></voicetrans>')).toBe('')
    expect(extractWechatVoiceTranscript('ordinary text')).toBe('')
  })
  it('preserves invalid entities without throwing and decodes astral characters', () => {
    expect(extractWechatVoiceTranscript('<transtext>&#x110000; &#x1f600;</transtext>')).toBe('&#x110000; 😀')
  })

  it('reads only the completed native transcript field from packed metadata', () => {
    const packed = Buffer.from('084310042a2508021221e8bf99e698afe4b880e69da1e59088e68890e6b58be8af95e8bdace58699e38082', 'hex')
    expect(extractWechatVoiceTranscriptFromPackedInfo(packed)).toBe('这是一条合成测试转写。')
    expect(extractWechatVoiceTranscriptFromPackedInfo(packed.toString('hex'))).toBe('这是一条合成测试转写。')
    expect(extractWechatVoiceTranscriptFromPackedInfo(packed.toString('base64'))).toBe('这是一条合成测试转写。')
    expect(extractWechatVoiceTranscriptFromPackedInfo({ type: 'Buffer', data: [...packed] })).toBe('这是一条合成测试转写。')
  })

  it('fails closed for non-final status, malformed protobuf, and invalid UTF-8', () => {
    expect(extractWechatVoiceTranscriptFromPackedInfo(Buffer.from('2a0708001203616263', 'hex'))).toBe('')
    expect(extractWechatVoiceTranscriptFromPackedInfo(Buffer.from('2a0708031203616263', 'hex'))).toBe('')
    expect(extractWechatVoiceTranscriptFromPackedInfo(Buffer.from('2a0508021201ff', 'hex'))).toBe('')
    expect(extractWechatVoiceTranscriptFromPackedInfo(Buffer.from('2a80', 'hex'))).toBe('')
    expect(extractWechatVoiceTranscriptFromPackedInfo('plain printable string')).toBe('')
    expect(extractWechatVoiceTranscriptFromPackedInfo(Buffer.alloc(64 * 1024 + 1))).toBe('')
  })
})
