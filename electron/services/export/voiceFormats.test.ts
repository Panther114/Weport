import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
vi.mock('../config', () => ({ ConfigService: class {
  getCacheBasePath() { return process.env.TEMP || '.' }
  getMyWxidCleaned() { return 'wxid_fixture' }
  get() { return '' }
} }))
vi.mock('../wcdbService', () => ({ wcdbService: {
  getContact: vi.fn(async () => ({ success: true, contact: { nickName: 'Fixture' } })),
  openMessageCursor: vi.fn(async () => ({ success: true, cursor: 1 })),
  fetchMessageBatch: vi.fn(), closeMessageCursor: vi.fn(async () => ({ success: true })),
  getDisplayNames: vi.fn(async () => ({ success: true, map: {} })),
  getAvatarUrls: vi.fn(async () => ({ success: true, map: {} })),
} }))
vi.mock('../chatService', () => ({ chatService: { getVoiceTranscript: vi.fn() } }))
vi.mock('../imageDecryptService', () => ({ imageDecryptService: {} }))
vi.mock('../exportRecordService', () => ({ exportRecordService: {} }))
import { ExportContext } from './core/ExportContext'
import { TxtFormatter } from './formatters/TxtFormatter'
import { JsonFormatter } from './formatters/JsonFormatter'
import { HtmlFormatter } from './formatters/HtmlFormatter'
import { MarkdownFormatter } from './formatters/MarkdownFormatter'
import { ExcelFormatter } from './formatters/ExcelFormatter'
import { SqlFormatter } from './formatters/SqlFormatter'
import { ChatLabFormatter } from './formatters/ChatLabFormatter'
import { WeCloneFormatter } from './formatters/WeCloneFormatter'
import ExcelJS from 'exceljs'
import { chatService } from '../chatService'
import { wcdbService } from '../wcdbService'

const temporary: string[] = []
afterEach(() => { for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true }) })

function packedTranscript(text: string): Buffer {
  const encoded = Buffer.from(text, 'utf8')
  const nested = Buffer.concat([Buffer.from([0x08, 0x02, 0x12, encoded.length]), encoded])
  return Buffer.concat([Buffer.from([0x2a, nested.length]), nested])
}

describe('already-converted voice text survives real formatters (#28)', () => {
  for (const [extension, Formatter] of [['txt', TxtFormatter], ['json', JsonFormatter], ['html', HtmlFormatter]] as const) {
    it(`writes local WeChat text into ${extension} without downloading an ASR model`, async () => {
      const root = mkdtempSync(join(tmpdir(), 'weport-voice-format-'))
      temporary.push(root)
      const context = new ExportContext()
      const xml = '<msg><voicemsg voicelength="3000"/><voicetrans transtext="已转换的本地语音文字"/></msg>'
      vi.mocked(wcdbService.fetchMessageBatch).mockResolvedValue({ success: true, hasMore: false,
        rows: [{ local_id: 7, server_id: '18446744073709551610', create_time: 1700000000,
          local_type: 34, message_content: xml, sender_username: 'wxid_fixture', computed_is_send: 1 }] })
      Object.assign(context, {
        ensureConnected: async () => ({ success: true, cleanedWxid: 'wxid_fixture' }),
        getContactInfo: async (id: string) => ({ wxid: id, displayName: 'Fixture', nickname: 'Fixture', remark: '', alias: '', groupNickname: '' }),
        hydrateEmojiCaptionsForMessages: async () => {},
        resolveQuotedMessagesForExport: async () => {},
      })
      const output = join(root, `voice.${extension}`)
      const result = await new Formatter(context).export('friend', output,
        { exportVoiceAsText: true, exportMedia: false, exportAvatars: false }, undefined, undefined)
      expect(result, result.error).toMatchObject({ success: true })
      const artifact = readFileSync(output, 'utf8')
      expect(artifact).toContain('已转换的本地语音文字')
      expect(artifact).not.toContain('转文字失败')
      expect(chatService.getVoiceTranscript).not.toHaveBeenCalled()
    })

    it(`keeps same-ID packed transcripts from separate shards distinct in ${extension}`, async () => {
      const root = mkdtempSync(join(tmpdir(), 'weport-packed-voice-format-'))
      temporary.push(root)
      const context = new ExportContext()
      const shared = {
        local_id: 7,
        create_time: 1700000000,
        local_type: 34,
        message_content: '<msg><voicemsg voicelength="3000"/></msg>',
        sender_username: 'wxid_fixture',
        computed_is_send: 1,
      }
      vi.mocked(wcdbService.fetchMessageBatch).mockResolvedValue({ success: true, hasMore: false, rows: [
        { ...shared, _db_path: 'C:/fixture/message_0.db', _table_name: 'Msg_fixture', packed_info_data: packedTranscript('第一条分片转写') },
        { ...shared, _db_path: 'C:/fixture/message_1.db', _table_name: 'Msg_fixture', packed_info_data: packedTranscript('第二条分片转写') },
      ] })
      Object.assign(context, {
        ensureConnected: async () => ({ success: true, cleanedWxid: 'wxid_fixture' }),
        getContactInfo: async (id: string) => ({ wxid: id, displayName: 'Fixture', nickname: 'Fixture', remark: '', alias: '', groupNickname: '' }),
        hydrateEmojiCaptionsForMessages: async () => {},
        resolveQuotedMessagesForExport: async () => {},
      })
      const output = join(root, `packed-voice.${extension}`)
      const result = await new Formatter(context).export('friend', output,
        { exportVoiceAsText: true, exportMedia: false, exportAvatars: false }, undefined, undefined)
      expect(result, result.error).toMatchObject({ success: true })
      const artifact = readFileSync(output, 'utf8')
      expect(artifact).toContain('第一条分片转写')
      expect(artifact).toContain('第二条分片转写')
      expect(artifact.match(/第一条分片转写/g)).toHaveLength(1)
      expect(artifact.match(/第二条分片转写/g)).toHaveLength(1)
      expect(chatService.getVoiceTranscript).not.toHaveBeenCalled()
    })
  }

  const quotedVoiceFormats = [
    { format: 'txt', extension: 'txt', Formatter: TxtFormatter },
    { format: 'json', extension: 'json', Formatter: JsonFormatter },
    { format: 'arkme-json', extension: 'json', Formatter: JsonFormatter },
    { format: 'html', extension: 'html', Formatter: HtmlFormatter },
    { format: 'markdown', extension: 'md', Formatter: MarkdownFormatter },
    { format: 'excel', extension: 'xlsx', Formatter: ExcelFormatter },
    { format: 'sql', extension: 'sql', Formatter: SqlFormatter },
    { format: 'chatlab', extension: 'chatlab', Formatter: ChatLabFormatter },
    { format: 'chatlab-jsonl', extension: 'jsonl', Formatter: ChatLabFormatter },
    { format: 'weclone', extension: 'csv', Formatter: WeCloneFormatter },
  ] as const

  for (const { format, extension, Formatter } of quotedVoiceFormats) {
    it(`keeps packed voice text when quote metadata is present in ${format}`, async () => {
      const root = mkdtempSync(join(tmpdir(), `weport-quoted-voice-${format}-`))
      temporary.push(root)
      const context = new ExportContext()
      const transcript = 'Exact transcript from packed metadata'
      const sourceContent = '<msg><voicemsg voicelength="3000"/><quoted-voice-fixture/></msg>'
      vi.mocked(wcdbService.fetchMessageBatch).mockResolvedValue({ success: true, hasMore: false,
        rows: [{
          local_id: 7,
          server_id: '18446744073709551610',
          create_time: 1700000000,
          local_type: 34,
          message_content: sourceContent,
          packed_info_data: packedTranscript(transcript),
          sender_username: 'wxid_fixture',
          computed_is_send: 1,
          _db_path: 'C:/fixture/message_0.db',
          _table_name: 'Msg_fixture',
        }] })
      Object.assign(context, {
        ensureConnected: async () => ({ success: true, cleanedWxid: 'wxid_fixture' }),
        getContactInfo: async (id: string) => ({ wxid: id, displayName: 'Fixture', nickname: 'Fixture', remark: '', alias: '', groupNickname: '' }),
        hydrateEmojiCaptionsForMessages: async () => {},
        resolveQuotedMessagesForExport: async () => {},
        resolveQuotedReplyDisplayWithNames: async ({ content }: { content: string }) => content.includes('quoted-voice-fixture')
          ? { quotedSender: 'Fixture', quotedPreview: 'Quoted source text', replyText: 'Quoted reply replacement' }
          : null,
      })

      const output = join(root, `voice.${extension}`)
      const result = await new Formatter(context).export('friend', output,
        { format, exportVoiceAsText: true, exportMedia: false, exportAvatars: false }, undefined, undefined)
      expect(result, result.error).toMatchObject({ success: true })

      let artifact: string
      if (format === 'excel') {
        const workbook = new ExcelJS.Workbook()
        await workbook.xlsx.readFile(output)
        artifact = JSON.stringify(workbook.worksheets.map((sheet) => sheet.getSheetValues()))
      } else {
        artifact = readFileSync(output, 'utf8')
      }
      expect(artifact).toContain(transcript)
      expect(artifact).not.toContain('Quoted reply replacement')
      expect(chatService.getVoiceTranscript).not.toHaveBeenCalled()
    })
  }
})
