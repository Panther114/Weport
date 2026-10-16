import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { ExportOrchestrator } from './ExportOrchestrator'
import { ExportLedger } from '../ledger'
import { buildDeterministicSessions, createFakeOrchestratorContext, snapshotDirectory } from './fakeOrchestratorContext'
import type { ExportOptions } from '../types'
import { exportRecordService } from '../../exportRecordService'

/**
 * §10.1 验收：**导出 60% 时中断 → 重跑只补缺口，最终产物与一次性导出字节一致。**
 *
 * 关于数据源：真实通路要 `WeFlow.exe`（-1006 宿主名检查）+ `wcdb_api.dll` + 一份真实
 * SQLCipher `session.db` + 有效密钥。这套东西在 `npx vitest run`（纯 Node、无 Electron）
 * 里拿不到，而且**不该**拿用户的库做实验。所以这里用一个小的 SQLCipher 形状的库文件
 * （见 `fakeOrchestratorContext.ts` 的说明）替换**数据来源**，
 * 被测的仍然是产品代码：ExportOrchestrator 的账本命中/校验/重导、ledger.ts 的追加与读取、
 * atomicWrite.ts 的 tmp → fsync → 同卷替换。
 *
 * 被断言的是验收口径本身：
 *  1. 中断后目录里**不存在** 0 字节或半截产物（原子写 + 临时文件清理）；
 *  2. 重跑只补缺口（账本跳过的会话数 > 0，且跳过的会话不重新导出）；
 *  3. 最终产物集合与一次性导出**逐字节一致**（相对路径 + 字节数 + sha256 全等）；
 *  4. 目录级清单（export-manifest.json）除 `taskId` 外一致 —— 这一条就是"字节级比较
 *     不可能时的规范化比较"：清单里只有 taskId 是每次运行会变的运行标识，
 *     其余字段（格式、单元数、每个单元的 sessionId/产物路径/字节数/sha256）都相同。
 */

let root = ''
let outputRoot = ''

const SESSION_COUNT = 6
const KILL_AFTER_UNITS = 4

const runOptions: ExportOptions = {
  format: 'txt',
  contentType: 'text',
  exportMedia: false,
  exportWriteLayout: 'B',
  exportConflictStrategy: 'overwrite',
  sessionLayout: 'shared',
  sessionNameWithTypePrefix: false,
  // 串行导出：验收断言的是"账本 + 原子写"的行为，不需要用并发来增加不确定性。
  // （并发路径另有 atomicWrite.test.ts 的"并发写同一个目标"用例覆盖。）
  exportConcurrency: 1,
}

/**
 * 产物文件名 = 会话显示名 + 扩展名（`buildSessionExportBaseName` 的口径）。
 * 用它而不是 `sessionId` 来断言"一个会话一份产物"，避免把断言写死在一个实现细节上。
 */
function artifactNameOf(sessionId: string): string {
  const seed = buildDeterministicSessions(SESSION_COUNT).find((session) => session.sessionId === sessionId)
  return `${seed?.displayName || sessionId}.txt`
}

/**
 * 跑一次导出：装配假上下文 + 把编排器的产物写入换成"写真实文件"的实现。
 * 每次都重新装配 spy（共用会指向旧 harness），跑完立即还原。
 */
async function runExport(
  outputDir: string,
  sessionIds: string[],
  failAfterUnits?: number,
  overrides: Partial<ExportOptions> = {},
  messagesPerSession = 12,
  editOlderMessage = false,
): Promise<{
  result: Awaited<ReturnType<ExportOrchestrator['exportSessions']>>
  exportedSessions: string[]
  telemetry: { skips: number; mismatches: Record<string, number> }
}> {
  const sessions = buildDeterministicSessions(SESSION_COUNT, messagesPerSession)
  if (editOlderMessage) sessions[0].messages[0].text = 'edited older message; count and latest time unchanged'
  const harness = createFakeOrchestratorContext({
    sessions,
    failAfterUnits,
  })
  harness.context.getExportStatsCacheEntry = () => ({ sessions: Object.fromEntries(sessions.map(session =>
    [session.sessionId, { totalCount: session.messages.length, lastTimestamp: Math.max(...session.messages.map(message => message.ts)) }])) }) as any
  const spy = vi
    .spyOn(ExportOrchestrator.prototype, 'exportSessionToTxt')
    .mockImplementation(harness.exportSessionImplementation)
  try {
    const orchestrator = new ExportOrchestrator(harness.context)
    const result = await orchestrator.exportSessions(sessionIds, outputDir, { ...runOptions, ...overrides })
    return {
      result,
      exportedSessions: harness.exportedSessions,
      telemetry: harness.telemetry,
    }
  } finally {
    spy.mockRestore()
  }
}

async function readManifest(): Promise<Record<string, unknown>> {
  const raw = await fs.promises.readFile(path.join(outputRoot, 'export-manifest.json'), 'utf-8')
  return JSON.parse(raw) as Record<string, unknown>
}

/** 产物集合（排除账本、清单与自检报告这三个"运行元数据"）。 */
async function artifactSet(): Promise<Map<string, { bytes: number; sha256: string }>> {
  const all = await snapshotDirectory(outputRoot)
  all.delete('.weport-export-ledger.jsonl')
  all.delete('export-manifest.json')
  // v1.2 §10.2 起，每次导出还会在同一目录落下自检报告与缺失媒体清单；它们不是"消息产物"，
  // 不计入本文件断言的产物个数（不加这两行的话，断言会看到 7 个而不是 6 个）。
  all.delete('integrity-report.json')
  all.delete('missing-media.csv')
  return all
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'weport-resume-'))
  outputRoot = path.join(root, 'export-out')
  fs.mkdirSync(outputRoot, { recursive: true })
})

afterEach(() => {
  vi.restoreAllMocks()
  fs.rmSync(root, { recursive: true, force: true })
})

describe('中断 → 续跑 的验收', () => {
  it('incremental export refreshes older edits even when count and latest time match', async () => {
    const ids = buildDeterministicSessions(SESSION_COUNT).map(s => s.sessionId)
    await runExport(outputRoot, ids, undefined, { exportConflictStrategy: 'incremental' })
    vi.spyOn(exportRecordService, 'getLatestRecord').mockReturnValue({ messageCount: 12, sourceLatestMessageTimestamp: 1800000000 } as any)
    const next = await runExport(outputRoot, ids, undefined, { exportConflictStrategy: 'incremental' }, 12, true)
    expect(next.telemetry.skips).toBe(0)
    expect(next.exportedSessions).toHaveLength(SESSION_COUNT)
    expect(fs.readFileSync(path.join(outputRoot, artifactNameOf(ids[0])), 'utf8')).toContain('edited older message')
  })

  it('incremental export repairs a corrupted artifact despite unchanged message metadata', async () => {
    const ids = buildDeterministicSessions(SESSION_COUNT).map(s => s.sessionId)
    await runExport(outputRoot, ids, undefined, { exportConflictStrategy: 'incremental' })
    fs.writeFileSync(path.join(outputRoot, artifactNameOf(ids[0])), 'damaged output')
    vi.spyOn(exportRecordService, 'getLatestRecord').mockReturnValue({ messageCount: 12, sourceLatestMessageTimestamp: 1800000000 } as any)
    const next = await runExport(outputRoot, ids, undefined, { exportConflictStrategy: 'incremental' })
    expect(next.exportedSessions).toEqual([ids[0]])
    expect(fs.readFileSync(path.join(outputRoot, artifactNameOf(ids[0])), 'utf8')).not.toContain('damaged output')
  })
  it('new source messages invalidate otherwise valid completed artifacts', async () => {
    const ids = buildDeterministicSessions(SESSION_COUNT).map(s => s.sessionId)
    await runExport(outputRoot, ids)
    const next = await runExport(outputRoot, ids, undefined, {}, 13)
    expect(next.telemetry.skips).toBe(0)
    expect(next.exportedSessions).toHaveLength(SESSION_COUNT)
    expect((await readManifest()).unitCount).toBe(SESSION_COUNT)
    expect(fs.readFileSync(path.join(outputRoot, artifactNameOf(ids[0])), 'utf8').trim().split('\n')).toHaveLength(13)
  })

  it('changed export filters invalidate completed artifacts', async () => {
    const ids = buildDeterministicSessions(SESSION_COUNT).map(s => s.sessionId)
    await runExport(outputRoot, ids)
    const next = await runExport(outputRoot, ids, undefined, { exportVoiceAsText: true })
    expect(next.telemetry.skips).toBe(0)
    expect(next.exportedSessions).toHaveLength(SESSION_COUNT)
    expect((await readManifest()).unitCount).toBe(SESSION_COUNT)
  })
  it('中断后重跑只补缺口，最终产物与一次性导出逐字节一致', async () => {
    const sessionIds = buildDeterministicSessions(SESSION_COUNT).map((session) => session.sessionId)

    // ---- 参考：一次性导出（干净目录） ----------------------------------
    const referenceRoot = path.join(root, 'reference-out')
    const reference = await runExport(referenceRoot, sessionIds)
    expect(reference.result.success).toBe(true)
    expect(reference.result.successCount).toBe(SESSION_COUNT)
    expect(reference.exportedSessions).toHaveLength(SESSION_COUNT)
    const referenceArtifacts = await snapshotDirectory(referenceRoot)
    referenceArtifacts.delete('.weport-export-ledger.jsonl')
    referenceArtifacts.delete('export-manifest.json')
    // 同上：自检报告 / 缺失媒体清单属于运行元数据，不是消息产物
    referenceArtifacts.delete('integrity-report.json')
    referenceArtifacts.delete('missing-media.csv')
    expect(referenceArtifacts.size).toBe(SESSION_COUNT)

    // ---- 第一次运行：导出到 60% 被杀 -----------------------------------
    const killed = await runExport(outputRoot, sessionIds, KILL_AFTER_UNITS)
    const partialArtifacts = await artifactSet()
    // 抛错会让编排器把这一轮标记成中断：已经写完的 4 个已进账本，
    // 剩下的 2 个留在队列里没写（下一次续跑补）。
    // 注意：`pendingSessionIds` 在"异常中断"这条路径上**没有**回填（只在 stop/pause
    // 分支里填）—— 见测试结尾的说明，这是既有缺口，不是本增量引入的。
    expect(
      {
        success: killed.result.successCount,
        fail: killed.result.failCount,
        artifacts: partialArtifacts.size,
        ledger: (await new ExportLedger(outputRoot).buildIndex()).size,
      },
      '中断那一轮应当"一部分已完成、其余留给续跑"',
    ).toEqual({ success: 4, fail: 0, artifacts: 4, ledger: 4 })
    expect(killed.exportedSessions).toHaveLength(4)
    // 中断时"已经导完的"产物必须是完整的（原子写：要么整份、要么没有）
    for (const [relPath, entry] of partialArtifacts) {
      const referenceEntry = referenceArtifacts.get(relPath)
      expect(referenceEntry, `${relPath} 不该是半截产物`).toBeDefined()
      expect(entry.sha256).toBe(referenceEntry!.sha256)
      expect(entry.bytes).toBe(referenceEntry!.bytes)
    }
    // 目录里没有 0 字节文件，也没有遗留的 .tmp-<pid>
    const leftovers = fs.readdirSync(outputRoot).filter((name) => /\.tmp-\d+$/.test(name))
    expect(leftovers).toEqual([])
    for (const [, entry] of partialArtifacts) expect(entry.bytes).toBeGreaterThan(0)

    // ---- 第二次运行：续跑 ----------------------------------------------
    // 记下中断那一轮每个产物的 mtime：续跑结束后，**被账本跳过的会话必须保持原文件不变**
    // （mtime 不动 = 没有重写），被补上的 2 个会话则是新写的。
    const mtimesBeforeResume = new Map<string, number>()
    for (const relPath of partialArtifacts.keys()) {
      mtimesBeforeResume.set(relPath, fs.statSync(path.join(outputRoot, relPath)).mtimeMs)
    }
    await new Promise((resolve) => setTimeout(resolve, 20))

    const resumed = await runExport(outputRoot, sessionIds)
    expect(resumed.result.success).toBe(true)
    expect(resumed.result.successCount).toBe(SESSION_COUNT)
    expect(resumed.result.failCount).toBe(0)

    // 只补缺口：账本跳过 4 个；被跳过的那 4 份产物原封不动（mtime 没变）
    expect(resumed.telemetry.skips).toBe(4)
    expect(resumed.exportedSessions).toHaveLength(SESSION_COUNT - resumed.telemetry.skips)
    for (const [relPath, mtime] of mtimesBeforeResume) {
      expect(fs.statSync(path.join(outputRoot, relPath)).mtimeMs, `${relPath} 不该被重写`).toBe(mtime)
    }
    // 账本跳过的 + 这次新导的 = 全部会话（既没漏也没重）
    expect(resumed.telemetry.skips + resumed.exportedSessions.length).toBe(SESSION_COUNT)

    // ---- 验收：最终产物集合与一次性导出逐字节一致 ------------------------
    const finalArtifacts = await artifactSet()
    expect([...finalArtifacts.keys()].sort()).toEqual([...referenceArtifacts.keys()].sort())
    for (const [relPath, entry] of finalArtifacts) {
      const referenceEntry = referenceArtifacts.get(relPath)!
      expect(entry.bytes, `${relPath} 字节数`).toBe(referenceEntry.bytes)
      expect(entry.sha256, `${relPath} sha256`).toBe(referenceEntry.sha256)
    }

    // ---- 目录级清单：内容一致（规范化后比较） -----------------------------
    // 清单里的 `artifact` 是**绝对路径**，两次导出落在不同目录（reference-out /
    // export-out）自然不同，所以比的是"相对该导出根目录的路径"。
    // 另外 `taskId` 是每次运行都会变的运行标识，同样排除。
    // 这是本用例里唯一需要规范化的比较：产物本身在上面已经逐字节比对过了。
    const manifest = await readManifest()
    const referenceManifest = JSON.parse(
      await fs.promises.readFile(path.join(referenceRoot, 'export-manifest.json'), 'utf-8'),
    ) as { taskId: string; units: Array<Record<string, unknown>> }
    expect(manifest.taskId).not.toBe(referenceManifest.taskId)
    const normalize = (value: { units: Array<Record<string, unknown>> }, baseDir: string) => ({
      unitCount: value.units.length,
      units: value.units
        .map((unit) => ({
          sessionId: unit.sessionId,
          artifact: path.relative(baseDir, path.resolve(baseDir, String(unit.artifact))).split(path.sep).join('/'),
          bytes: unit.bytes,
          sha256: unit.sha256,
        }))
        .sort((a, b) => String(a.artifact).localeCompare(String(b.artifact))),
    })
    expect(normalize(manifest as never, outputRoot)).toEqual(normalize(referenceManifest, referenceRoot))
    expect(Number(manifest.unitCount)).toBe(SESSION_COUNT)
  }, 60000)

  it('续跑之后产物没有多出一份（不会因为账本落点不同而写出重复文件）', async () => {
    const sessionIds = buildDeterministicSessions(SESSION_COUNT).map((session) => session.sessionId)
    await runExport(outputRoot, sessionIds, KILL_AFTER_UNITS)
    const partialCount = (await artifactSet()).size

    await runExport(outputRoot, sessionIds)
    const finalArtifacts = await artifactSet()

    expect(finalArtifacts.size).toBe(SESSION_COUNT)
    expect(finalArtifacts.size).toBeGreaterThanOrEqual(partialCount)
    // 每个会话正好一个 .txt，没有 `_2` 之类的改名重复
    const names = [...finalArtifacts.keys()].map((item) => path.basename(item)).sort()
    expect(names).toEqual(sessionIds.map((sessionId) => artifactNameOf(sessionId)).sort())
  }, 60000)

  it('账本记录与磁盘不符时重导该会话（不是"账本说完成就跳过"）', async () => {
    const sessionIds = buildDeterministicSessions(SESSION_COUNT).map((session) => session.sessionId)
    await runExport(outputRoot, sessionIds)
    const before = await artifactSet()

    // 篡改第一个会话来模拟"磁盘上的产物被改坏了"
    const victim = sessionIds[0]
    const victimName = artifactNameOf(victim)
    fs.writeFileSync(path.join(outputRoot, victimName), 'corrupted-by-someone-else\n')

    const second = await runExport(outputRoot, sessionIds)
    expect(second.result.success).toBe(true)

    // 被改坏的那份必须重导回原内容（不是被跳过）
    const after = await artifactSet()
    expect(second.exportedSessions).toContain(victim)
    expect(after.get(victimName)!.sha256).toBe(before.get(victimName)!.sha256)
    // 其余会话照旧按账本跳过
    expect(second.telemetry.skips).toBe(SESSION_COUNT - 1)
  }, 60000)

  it('账本记了、但产物被删掉 → 该会话重导', async () => {
    const sessionIds = buildDeterministicSessions(SESSION_COUNT).map((session) => session.sessionId)
    await runExport(outputRoot, sessionIds)

    const victim = sessionIds[2]
    const victimName = artifactNameOf(victim)
    fs.rmSync(path.join(outputRoot, victimName))

    const second = await runExport(outputRoot, sessionIds)
    expect(second.result.success).toBe(true)
    expect(second.exportedSessions).toEqual([victim])
    expect(fs.existsSync(path.join(outputRoot, victimName))).toBe(true)
    expect(second.telemetry.mismatches.missing).toBe(1)
  }, 60000)

  it('中断留下的临时文件在下次导出开始时被清掉，不会被当成产物', async () => {
    const sessionIds = buildDeterministicSessions(SESSION_COUNT).map((session) => session.sessionId)
    // 模拟上次崩溃留下的半截临时文件
    fs.writeFileSync(path.join(outputRoot, 'wxid_user_000.txt.tmp-4242'), 'half-written')

    const result = await runExport(outputRoot, sessionIds)
    expect(result.result.success).toBe(true)
    expect(fs.existsSync(path.join(outputRoot, 'wxid_user_000.txt.tmp-4242'))).toBe(false)
    expect([...await artifactSet()]).toHaveLength(SESSION_COUNT)
  }, 60000)

  it('账本一行一个单元，且每行都带 bytes + sha256（续跑判定的依据）', async () => {
    const sessionIds = buildDeterministicSessions(SESSION_COUNT).map((session) => session.sessionId)
    await runExport(outputRoot, sessionIds)

    const raw = await fs.promises.readFile(path.join(outputRoot, '.weport-export-ledger.jsonl'), 'utf-8')
    const lines = raw.split('\n').filter(Boolean)
    expect(lines).toHaveLength(SESSION_COUNT)
    for (const line of lines) {
      const entry = JSON.parse(line)
      expect(entry.v).toBe(1)
      expect(entry.artifact).toMatch(/^txt#[a-f0-9]{20}#\d+$/)
      expect(entry.sourceFingerprint).toHaveLength(64)
      expect(entry.messageCount).toBe(12)
      expect(entry.bytes).toBeGreaterThan(0)
      expect(entry.sha256).toHaveLength(64)
      expect(entry.outputPath).toBeTruthy()
      expect(entry.chunkStart).toBe(0)
      expect(entry.chunkEnd).toBe(0)
    }
    // 键值与磁盘产物对得上
    for (const line of lines) {
      const entry = JSON.parse(line)
      const buffer = await fs.promises.readFile(entry.outputPath)
      expect(buffer.byteLength).toBe(entry.bytes)
    }
    // 账本可被独立读回（续跑逻辑之外也能用）
    const ledger = new ExportLedger(outputRoot)
    const index = await ledger.buildIndex()
    expect(index.size).toBe(SESSION_COUNT)
  }, 60000)
})
