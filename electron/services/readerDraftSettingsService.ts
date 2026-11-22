/**
 * 阅读器自动草稿的按会话设置存储（v1.3.3）。
 *
 * ## 为什么单独一个文件
 *
 * 这是"每个会话一套"的配置：克隆、时间范围、本会话补充提示词。会话数量可能
 * 很大，塞进 electron-store 会让主配置越来越难读；而这些设置又是用户手写、
 * 需要持久化的（"不需要持续填写"），不能只活在页面 state 里。
 *
 * 文件：`{userData}/reader-draft-settings.json`
 * - 原子写：先写临时文件再 rename，崩在写一半不会读出半个 JSON；
 * - 只存设置，不存聊天正文与生成的草稿；
 * - 最多保留 500 个会话，按最后更新时间淘汰最旧的。
 */

import { join } from 'path'
import { readJsonTolerant, writeJsonAtomic } from './atomicJson'
import {
  normalizeReaderDraftNote,
  normalizeReaderDraftRange,
  normalizeReaderDraftSessionSettings,
  type ReaderDraftRange,
  type ReaderDraftSessionSettings,
} from '../../src/utils/readerDraftSettings'

const VERSION = 1
const MAX_SESSIONS = 500
const FILE_NAME = 'reader-draft-settings.json'

interface StoreShape {
  version: number
  sessions: Record<string, ReaderDraftSessionSettings>
}

export interface ReaderDraftSettingsPatch {
  accountId: string
  sessionId: string
  cloneId?: string
  range?: ReaderDraftRange | string
  note?: string
}

function keyOf(accountId: string, sessionId: string): string {
  return `${String(accountId || '').trim()}\u0000${String(sessionId || '').trim()}`
}

export class ReaderDraftSettingsService {
  private readonly explicitRoot?: string
  private resolvedFile?: string
  private cache: StoreShape | null = null

  constructor(userDataPath?: string) {
    this.explicitRoot = userDataPath
  }

  /** 延迟解析 userData：模块在 app ready 之前就被 import 了。 */
  private get file(): string {
    if (this.resolvedFile) return this.resolvedFile
    let root = this.explicitRoot
    if (!root) {
      try {
        // 纯 Node（测试）里 `require('electron')` 返回的是二进制路径，不是 API；
        // 拿不到 userData 时退回当前目录，调用方仍可显式传路径。
        root = require('electron')?.app?.getPath?.('userData')
      } catch {
        root = undefined
      }
    }
    this.resolvedFile = join(root || process.cwd(), FILE_NAME)
    return this.resolvedFile
  }

  private load(): StoreShape {
    if (this.cache) return this.cache
    const result = readJsonTolerant<StoreShape>(this.file)
    const sessions: Record<string, ReaderDraftSessionSettings> = {}
    if (result.value && result.value.version === VERSION && result.value.sessions && typeof result.value.sessions === 'object') {
      for (const [key, value] of Object.entries(result.value.sessions)) {
        const normalized = normalizeReaderDraftSessionSettings(value)
        if (normalized) sessions[key] = normalized
      }
    }
    this.cache = { version: VERSION, sessions }
    return this.cache
  }

  private persist(): void {
    const snapshot = this.load()
    // 淘汰最旧的会话，避免这个文件随使用无限增长。
    const entries = Object.entries(snapshot.sessions)
    if (entries.length > MAX_SESSIONS) {
      entries.sort((a, b) => (a[1].updatedAt || 0) - (b[1].updatedAt || 0))
      for (const [key] of entries.slice(0, entries.length - MAX_SESSIONS)) delete snapshot.sessions[key]
    }
    // 文件很小、保存频率低（输入停下 700ms 才写一次）；同步原子写保证
    // "看到已保存"时磁盘上真的已经是新值，应用立刻退出也不会丢。
    writeJsonAtomic(this.file, snapshot, { pretty: true })
  }

  get(accountId: string, sessionId: string): ReaderDraftSessionSettings | null {
    const account = String(accountId || '').trim()
    const session = String(sessionId || '').trim()
    if (!account || !session) return null
    return this.load().sessions[keyOf(account, session)] || null
  }

  /**
   * 合并保存。只传需要改的字段：用户在自动草稿面板里改了范围，不会把已经
   * 保存的补充提示词覆盖成空。
   */
  set(patch: ReaderDraftSettingsPatch): ReaderDraftSessionSettings {
    const accountId = String(patch.accountId || '').trim()
    const sessionId = String(patch.sessionId || '').trim()
    if (!accountId || !sessionId) throw new Error('缺少账号或会话')
    const store = this.load()
    const key = keyOf(accountId, sessionId)
    const current = store.sessions[key]
    const next: ReaderDraftSessionSettings = {
      accountId,
      sessionId,
      cloneId: patch.cloneId === undefined ? current?.cloneId || '' : String(patch.cloneId || '').trim(),
      range: patch.range === undefined ? current?.range || 'today' : normalizeReaderDraftRange(patch.range),
      note: patch.note === undefined ? current?.note || '' : normalizeReaderDraftNote(patch.note),
      updatedAt: Date.now(),
    }
    store.sessions[key] = next
    this.persist()
    return next
  }

  clear(accountId: string, sessionId: string): boolean {
    const account = String(accountId || '').trim()
    const session = String(sessionId || '').trim()
    if (!account || !session) return false
    const store = this.load()
    const key = keyOf(account, session)
    if (!store.sessions[key]) return false
    delete store.sessions[key]
    this.persist()
    return true
  }

  /** 删除克隆时顺手清掉指向它的会话设置，避免界面反复显示"分身不存在"。 */
  forgetClone(cloneId: string): void {
    const id = String(cloneId || '').trim()
    if (!id) return
    const store = this.load()
    let changed = false
    for (const [key, value] of Object.entries(store.sessions)) {
      if (value.cloneId !== id) continue
      store.sessions[key] = { ...value, cloneId: '', updatedAt: Date.now() }
      changed = true
    }
    if (changed) this.persist()
  }
}

export const readerDraftSettingsService = new ReaderDraftSettingsService()
