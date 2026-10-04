import { execFile } from 'child_process'
import { promisify } from 'util'
import { existsSync } from 'fs'
import { basename, join } from 'path'
import {
  DbFileEnumerationLimitError,
  listDbFiles,
  readPage1,
  saltHexOf,
  verifyPageKey,
  keyFingerprint,
  type DbFileEntry,
  type PageKeyMode,
} from './wcdbPageKey'

const execFileAsync = promisify(execFile)

/**
 * Windows「免登录只读扫描」：从正在运行的微信进程内存里取**每库 page key**。
 *
 * ## 证据来源（改这里之前先把这三份读一遍）
 *
 * | 常量 | 证据 |
 * |---|---|
 * | {@link CIPHER_NEEDLE} / {@link CIPHER_NEEDLE_LEN} | `.wxkey-research/probe/cipher2.cjs:19,110`（本机 Weixin 4.1.13.65 实测命中，length=30 > SSO 阈值） |
 * | {@link CIPHER_XOR_MASK} | `.wxkey-research/probe/cipher2.cjs:20`（27 字节固定掩码，报告 §1.3 步骤 4） |
 * | {@link OFFSET_*} | `.wxkey-research/probe/scanonly.cjs:113-115`（`node+0x28` = config_ptr）与 `cipher2.cjs:132-135`（`config_ptr+0x88` → `data_ptr=u64@0x8`, `data_len=u64@0x10`） |
 * | 结构/掩码会随版本变 | `docs/research/wechat-db-key-no-login.md` §1.8 与 §7：「掩码与结构偏移在版本间会变」「有报告称 4.1.13.12 命中锚点但解不出密钥」 |
 *
 * 正因如此，本实现**不把偏移和掩码当作真理**，而是当成"首选策略 + 尝试表 + 掩码自恢复"：
 * 1. 先用参考偏移与参考掩码走一遍（本机 <10 s 命中）；
 * 2. 命中锚点但解不出密钥时，走 {@link recoverCipherMaskCandidates} 的 crib-drag 自恢复，
 *    用「明文必含 `x'` + hex + 结束引号」的约束反解掩码，再用 page 1 HMAC 裁决；
 * 3. 结构偏移走尝试表（`config_ptr+0x88/0x80/0x90`，`node+0x20/0x28/0x30`）。
 * 这三层任何一层命中即返回，全部失败则把**计数器**交出去（`diagnostics`），
 * 让"为什么没命中"可远程诊断，而不是只有一句"失败"。
 *
 * ## 硬约束（写这个文件的人必须先接受）
 *
 * - **只读**：`OpenProcess(PROCESS_VM_READ|PROCESS_QUERY_INFORMATION)` + `ReadProcessMemory`，
 *   不注入、不 patch、不 `WriteProcessMemory`；**非提权**运行（Medium IL 实测通过，报告 §1.3）。
 * - **不碰微信数据目录**：库只以 `'r'` 打开读第一页（见 `readPage1`）。
 * - **不落盘任何密钥**：本模块只把密钥返回给调用方；日志/诊断一律只有
 *   {@link keyFingerprint} 形态（`ab12…cd34`）。
 * - **不阻塞事件循环**：区域按 2 MB 分块读，块与块之间按时间片让出
 *   （{@link ScanOptions.yieldEveryMs}），单次连续占用目标 ≤ 50 ms。
 */

// === 证据常量（见文件头表格） ===

/** WCDB cipher 配置对象的键名。证据：`cipher2.cjs:19`。 */
export const CIPHER_NEEDLE = Buffer.from('com.Tencent.WCDB.Config.Cipher', 'latin1')
/** 参考实现里 needle 字符串的长度（std::string 的 size 字段）。证据：`cipher2.cjs:110`。 */
export const CIPHER_NEEDLE_LEN = 30
/** 27 字节固定 XOR 掩码。证据：`cipher2.cjs:20`。 */
export const CIPHER_XOR_MASK = Buffer.from('d2c7442458020000004889442450488b450048844c2448488944254048584c24', 'hex')
/**
 * 掩码的**真实长度**（周期）。取值直接来自 {@link CIPHER_XOR_MASK}.length，不写字面量。
 *
 * ⚠️ 研究报告 §1.3 把它写成"27 字节固定掩码"，但 `cipher2.cjs:20` 用的十六进制串是
 * **64 个 hex 字符 = 32 字节**，而且参考实现全程用 `MASK[i % MASK.length]` ——
 * 也就是说参考实现真正用的是 **32**。本实现一度按报告写了 27 当周期，结果
 * "快路径解码"与"逐字节解码"对不上（`.wxkey-research/probe/decode-check.cjs` 抓到的
 * 第一处差异：同一个字节 64 vs 210）。所以这里坚持从长度推导，别抄数字。
 */
export const CIPHER_XOR_PERIOD = CIPHER_XOR_MASK.length

/** 结构偏移（首选值来自参考实现；见 {@link STRUCT_OFFSET_ATTEMPTS} 的尝试表）。 */
export const OFFSET_NODE_DATA_PTR = 0x10
export const OFFSET_NODE_LEN = 0x18
export const OFFSET_NODE_CONFIG_PTR = 0x28
export const OFFSET_CONFIG_BLOB = 0x88
export const OFFSET_BLOB_DATA_PTR = 0x08
export const OFFSET_BLOB_DATA_LEN = 0x10

/**
 * 结构偏移尝试表。任一组合命中即采用 —— 版本敏感处的**最小成本**鲁棒性手段。
 * `label` 会写进诊断，便于把"哪个偏移其实是对的"回收成新证据。
 */
export const STRUCT_OFFSET_ATTEMPTS: Array<{ label: string; nodeConfigPtr: number; configBlob: number }> = [
  { label: 'ref-4.1.13.65', nodeConfigPtr: 0x28, configBlob: 0x88 },
  { label: 'config+0x80', nodeConfigPtr: 0x28, configBlob: 0x80 },
  { label: 'config+0x90', nodeConfigPtr: 0x28, configBlob: 0x90 },
  { label: 'node+0x20', nodeConfigPtr: 0x20, configBlob: 0x88 },
  { label: 'node+0x30', nodeConfigPtr: 0x30, configBlob: 0x88 },
  { label: 'node+0x20/config+0x80', nodeConfigPtr: 0x20, configBlob: 0x80 },
]

/** 可读的页保护标志。证据：`cipher2.cjs:21`。 */
export const READABLE_PROTECT_FLAGS = [0x02, 0x04, 0x08, 0x10, 0x20, 0x40, 0x80]
export const MEM_COMMIT = 0x1000
/** 跳过大于 500 MB 的区域（保护性上限）。证据：`cipher2.cjs:87`。 */
export const MAX_REGION_BYTES = 500 * 1024 * 1024
/** 分块大小与重叠。证据：`cipher2.cjs:60-61`（2 MB + 0x80 重叠）。 */
export const CHUNK_BYTES = 2 * 1024 * 1024
export const CHUNK_OVERLAP = 0x80
/** blob 长度上限。证据：`cipher2.cjs:22`（本机恒 99）。 */
export const BLOB_MAX = 1024
/** 事件循环让出时间片（ms）。超过这个时间没让出，UI 就能感觉到卡顿。 */
export const DEFAULT_YIELD_EVERY_MS = 12

const PROCESS_VM_READ = 0x0010
const PROCESS_QUERY_INFORMATION = 0x0400
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000

// === 纯函数部分（可单测，不依赖 koffi / 进程） ===

export interface DecodedKeyRecord {
  /** 64 位 hex 的密钥。 */
  keyHex: string
  /** 32 位 hex 的 salt；从 `x'<64hex>` 这种短记录里取不到时为 null。 */
  saltHex: string | null
}

/** 用一个掩码解码 blob 的可见文本（`latin1`，与参考实现一致）。 */
export function decodeBlobWithMask(blob: Buffer, mask: Buffer): string {
  if (!mask.length) return ''
  const out = Buffer.allocUnsafe(blob.length)
  for (let i = 0; i < blob.length; i++) out[i] = blob[i] ^ mask[i % mask.length]
  return out.toString('latin1')
}

/**
 * 从解码文本里抽出 `x'<hex…>'` 记录。
 *
 * 为什么不是简单正则一把梭：真实记录里 hex 串可能长于 96（同一个 blob 里拼了
 * 两条记录），参考实现对每个 run 试了多个起点（`cipher2.cjs:146-152`）。
 * 这里保持同样的宽容度，并用 `keyHex|saltHex` 去重。
 */
export function extractKeyRecords(text: string): DecodedKeyRecord[] {
  const out: DecodedKeyRecord[] = []
  const seen = new Set<string>()
  const re = /[xX]'([0-9a-fA-F]{64,192})'/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    const run = m[1].toLowerCase()
    const starts = new Set<number>([0])
    if (run.length > 96) {
      for (let s = 0; s + 64 <= run.length; s += 32) starts.add(s)
      starts.add(run.length - 64)
    }
    for (const s of starts) {
      if (s + 64 > run.length) continue
      const keyHex = run.slice(s, s + 64)
      const saltHex = run.length >= s + 96 ? run.slice(s + 64, s + 96) : null
      const id = `${keyHex}|${saltHex}`
      if (seen.has(id)) continue
      seen.add(id)
      out.push({ keyHex, saltHex })
    }
  }
  return out
}

/** 掩码自恢复结果。 */
export interface MaskRecoveryResult {
  /** 候选掩码（去重，按发现顺序）。真掩码若满足约束必在其中。 */
  masks: Buffer[]
  /** 被接受的 crib 锚点数（`x'` 起点假说数）。 */
  anchors: number
  /** 被完全钉死的残差类数量（27 类里有多少类只剩一个取值）。 */
  determinedClasses: number
  /** 实际检查过的掩码组合数（有上限，防止病态输入拖死进程）。 */
  explored: number
  /** 因结构不合法（解出来不像 `x'…'`）被丢弃的组合数。 */
  rejected: number
}

const HEX_BYTES: readonly number[] = '0123456789abcdefABCDEF'.split('').map((c) => c.charCodeAt(0))
/**
 * crib 只需要**小写** hex。
 *
 * 为什么收紧它：真实记录是 `x'<小写 64 hex><小写 32 hex>'`（参考实现解出来后统一
 * `toLowerCase()`），而 22 个字符（含大小写）的约束比 16 个松得多 —— 松约束会让
 * 某些残差类留下多个候选，回溯就可能先凑出一个"看着像记录、其实是别处"的假掩码
 * （单测里就是这样先命中了假掩码，而真掩码排在候选列表之外）。
 * 结构判定同样只认小写，两处口径一致。
 */
const HEX_LOWER: readonly number[] = '0123456789abcdef'.split('').map((c) => c.charCodeAt(0))
/** 记录形状（结构判定与测试共用一处口径：只认小写 hex）。 */
export const RECORD_SHAPE = /[xX]'[0-9a-f]{64,192}'/
const PRINTABLE: readonly number[] = (() => {
  const list: number[] = []
  for (let b = 0x20; b <= 0x7e; b++) list.push(b)
  return list
})()

/** 记录前缀（解码后的明文形状）。 */
export const CIPHER_RECORD_PREFIX = Buffer.from("x'", 'latin1')

/**
 * 从**已解码**的内存文本里读出 `x'` 之后的 hex 串。
 *
 * 与 {@link extractKeyRecords} 的分工：后者负责"一段文本里可能有几条记录、每条从
 * 哪个偏移开始"的宽容解析；这个只负责"这里到底是不是一条 hex 串" —— 主路由对着
 * 2 MB 解码块做 `indexOf("x'")`，需要的是 O(1) 的形状判定。
 * 返回 null 表示形状不对（长度不足 64 或没有以 `'` 收尾）。
 */
export function readHexRunAt(text: Buffer, start: number, maxLen = 192): string | null {
  if (start < 0 || start >= text.length) return null
  let end = start
  while (end < text.length && end - start < maxLen) {
    const c = text[end]
    const isHex =
      (c >= 0x30 && c <= 0x39) || (c >= 0x61 && c <= 0x66) || (c >= 0x41 && c <= 0x46)
    if (!isHex) break
    end++
  }
  const len = end - start
  if (len < 64) return null
  if (end >= text.length || text[end] !== 0x27) return null
  return text.toString('latin1', start, end)
}

/**
 * **掩码自恢复（crib-drag）** —— 掩码随版本变时的兜底。
 *
 * 原理：密钥在内存里不是明文，而是被 `blob[i] ^ mask[i % 27]` 掩起来的
 * `x'<64hex key><32hex salt>'`。掩码本身未知，但**明文的结构已知**：
 * `x`、`'`、至少 64 个 hex 字符、结束引号。于是对每个可能的 `x'` 起点：
 *
 * 1. 该起点给出两类掩码的**确定值**：`mask[i0%27] = blob[i0] ^ 'x'`、`mask[(i0+1)%27] = blob[i0+1] ^ '\''`；
 * 2. hex 区段的每个位置把 `mask[i%27]` 的取值限制在 16 个候选里；
 *    `x'…'` 共 99 个字符 ≈ 3.7 个掩码周期 ⇒ **27 个残差类每类至少被约束 3 次**，
 *    交集通常直接收敛成唯一值；
 * 3. 仍不唯一时按残差类做有界回溯（先定候选最少的类），组合上限 `maxCombos`；
 * 4. 每个候选掩码解码整块 blob 并要求仍然匹配 `x'<hex…>'` 结构 —— 只有通过
 *    结构检查的候选才会被拿去做 HMAC 裁决（HMAC 昂贵，不能用来枚举）。
 *
 * 返回的候选里**真掩码一定在**（前提是 blob 里确实有 `x'…'` 结构）；调用方
 * 逐个试，用 page 1 HMAC 决定谁是真的 —— 即"结构收敛 + 密码学裁决"。
 */
export function recoverCipherMaskCandidates(
  blob: Buffer,
  options: { period?: number; maxCombos?: number; maxMasks?: number; knownSalts?: string[] } = {}
): MaskRecoveryResult {
  const period = options.period ?? CIPHER_XOR_PERIOD
  const maxCombos = options.maxCombos ?? 4096
  const maxMasks = options.maxMasks ?? 16
  const result: MaskRecoveryResult = { masks: [], anchors: 0, determinedClasses: 0, explored: 0, rejected: 0 }
  if (blob.length < 67 || blob.length > BLOB_MAX) return result

  const seenMasks = new Set<string>()
  const pushMask = (mask: Buffer): boolean => {
    const key = mask.toString('hex')
    if (seenMasks.has(key)) return false
    seenMasks.add(key)
    result.masks.push(Buffer.from(mask))
    return result.masks.length >= maxMasks
  }

  // === 决定性路径：已知 salt ⇒ 掩码被完全确定 ===
  //
  // 记录形如 `x'<64 hex key><32 hex salt>'`：salt 的 **32 个字符恰好覆盖掩码的
  // 32 个残差类各一次**。既然库的 salt 我们本来就知道（page 1 的前 16 字节），
  // 那么 `mask[i%32] = blob[i] ^ saltChar` 就把整张掩码唯一确定下来了 ——
  // 不需要枚举、不需要猜。这是"掩码随版本变了"时真正的救回路径；
  // 没有它，纯 crib-drag 只能给出候选（见下面的兜底路径）。
  const knownSalts = (options.knownSalts ?? [])
    .map((s) => String(s || '').trim().toLowerCase())
    .filter((s) => /^[0-9a-f]{32}$/.test(s))
  if (knownSalts.length > 0) {
    // 两种真实记录的 hex 长度：96（§1.7 的标准形态）与 128（宽容变体）
    for (const runLen of [96, 128]) {
      for (let anchor = 0; anchor + 2 + runLen + 1 <= blob.length; anchor++) {
        if (result.masks.length >= maxMasks) break
        const saltStart = anchor + 2 + runLen - 32
        for (const saltHex of knownSalts) {
          const mask = Buffer.alloc(period)
          const assigned = new Array<boolean>(period).fill(false)
          let conflict = false
          for (let j = 0; j < 32; j++) {
            const idx = saltStart + j
            const r = idx % period
            const candidate = blob[idx] ^ saltHex.charCodeAt(j)
            if (assigned[r] && mask[r] !== candidate) { conflict = true; break }
            mask[r] = candidate
            assigned[r] = true
          }
          if (conflict) continue
          // 32 个字符覆盖 32 类 ⇒ 这里不该有未赋值的类；真出现（period ≠ 32）就用参考掩码补齐
          for (let r = 0; r < period; r++) if (!assigned[r]) mask[r] = CIPHER_XOR_MASK[r % CIPHER_XOR_MASK.length]
          const text = decodeBlobWithMask(blob, mask)
          if (!RECORD_SHAPE.test(text)) {
            result.rejected++
            continue
          }
          result.anchors++
          if (pushMask(mask)) break
        }
      }
    }
    if (result.masks.length > 0) return result
  }

  let bestDetermined = 0

  /**
   * 每个位置**在掩码后必须是可读 ASCII**，这与 anchor 无关：残差类 `i % period` 的候选集只由
   * blob 决定。以前这段在 anchor 循环里每个 anchor 重算一遍（`blob.length × PRINTABLE` 次
   * Set 插入），anchor 可能有上千个 —— 找不到掩码时整段就是纯浪费。
   * 现在先算一次基表，每个 anchor 只**拷贝**它（`period` 个 Set），约束仍然作用在拷贝上。
   */
  const baseAllowed: Array<Set<number>> = Array.from({ length: period }, () => new Set<number>())
  for (let i = 0; i < blob.length; i++) {
    const set = baseAllowed[i % period]
    for (const p of PRINTABLE) set.add(blob[i] ^ p)
  }

  for (let anchor = 0; anchor + 67 <= blob.length; anchor++) {
    if (result.masks.length >= maxMasks) break

    // 本 anchor 的工作表：基表的一份拷贝
    const allowed: Array<Set<number>> = baseAllowed.map((set) => new Set(set))

    const constrain = (index: number, chars: readonly number[]): boolean => {
      if (index >= blob.length) return false
      const set = allowed[index % period]
      const next = new Set<number>()
      for (const c of chars) {
        const cand = blob[index] ^ c
        if (set.has(cand)) next.add(cand)
      }
      if (next.size === 0) return false
      allowed[index % period] = next
      return true
    }

    if (!constrain(anchor, [0x78, 0x58])) continue // x / X
    if (!constrain(anchor + 1, [0x27])) continue // '
    let hexEnd = anchor + 2
    while (hexEnd < blob.length && hexEnd - anchor - 2 < 192) {
      if (!constrain(hexEnd, HEX_LOWER)) break
      hexEnd++
    }
    const hexLen = hexEnd - anchor - 2
    if (hexLen < 64) continue
    if (!constrain(hexEnd, [0x27])) continue // 结束引号
    result.anchors++

    const determined = allowed.filter((s) => s.size === 1).length
    if (determined > bestDetermined) bestDetermined = determined

    // 有界回溯：先定候选最少的残差类（未定类沿用参考掩码的字节 —— 它们只影响
    // crib 之外的字符，不影响密钥/盐的抽取）
    const order = Array.from({ length: period }, (_, i) => i).sort((a, b) => allowed[a].size - allowed[b].size)
    const mask = Buffer.from(CIPHER_XOR_MASK.slice(0, period))
    let explored = 0
    let stop = false

    const checkMask = (): boolean => {
      explored++
      result.explored++
      const text = decodeBlobWithMask(blob, mask)
      // 结构判定只认小写 hex：与真实记录格式一致，避免把"凑出来的像记录的乱码"当成候选
      if (!RECORD_SHAPE.test(text)) {
        result.rejected++
        return false
      }
      return pushMask(mask)
    }

    const walk = (depth: number): boolean => {
      if (stop) return true
      if (explored > maxCombos) return true
      if (depth >= order.length) return checkMask()
      const cls = order[depth]
      for (const value of allowed[cls]) {
        mask[cls] = value
        if (walk(depth + 1)) { stop = true; return true }
      }
      return false
    }

    walk(0)
  }

  result.determinedClasses = bestDetermined
  return result
}

/**
 * 从原始 blob 里解出记录：先试给定掩码，再（可选）试自恢复的候选掩码。
 *
 * ⚠️ **不要把"第一个能解出记录的掩码"当成答案**：候选掩码里可能混进"凑出来也像
 * 一条记录、但其实是别处字节"的假掩码（单测里就抓到过：假掩码解出的 key 与真 key
 * 完全不同）。所以这里是"把**所有**候选掩码解出的记录并起来去重",由调用方用
 * page 1 HMAC 做最终裁决 —— 结构收敛 + 密码学裁决，两步都不能省。
 */
export function decodeCipherBlob(
  blob: Buffer,
  options: { masks?: Buffer[]; recovery?: MaskRecoveryResult } = {}
): { records: DecodedKeyRecord[]; usedMaskHex: string | null; recovery?: MaskRecoveryResult } {
  const records: DecodedKeyRecord[] = []
  const seen = new Set<string>()
  let usedMaskHex: string | null = null

  const absorb = (mask: Buffer): void => {
    const text = decodeBlobWithMask(blob, mask)
    const found = extractKeyRecords(text)
    if (found.length === 0) return
    if (!usedMaskHex) usedMaskHex = Buffer.from(mask).toString('hex')
    for (const record of found) {
      const id = `${record.keyHex}|${record.saltHex ?? ''}`
      if (seen.has(id)) continue
      seen.add(id)
      records.push(record)
    }
  }

  for (const mask of options.masks ?? [CIPHER_XOR_MASK]) absorb(mask)
  if (options.recovery) {
    for (const mask of options.recovery.masks) absorb(mask)
  }
  return { records, usedMaskHex, recovery: options.recovery }
}

// === 扫描结果模型 ===

/** 一个库的密钥记录（**返回值里带完整 key**，只交给调用方；日志禁止使用）。 */
export interface ScannedDbKey {
  /** 相对 `db_storage` 的 id，例如 `message/message_0.db`。 */
  id: string
  kind: string
  path: string
  keyHex: string
  saltHex: string | null
  /** 命中的形态：扫描到的是每库 page key（raw）；老版本可能是口令。 */
  mode: PageKeyMode
  verified: boolean
  /** 日志/UI 唯一允许出现的形态。 */
  fingerprint: string
  /** 命中它的进程。 */
  pid: number
  /** 该组合来自哪个结构偏移尝试（诊断用）。 */
  structOffset: string
}

export interface ScanStepTiming {
  name: string
  ms: number
}

export interface ScanDiagnostics {
  pids: number[]
  pidDetails: Array<{ pid: number; regions: number; bytes: number; needleHits: number; openDenied: boolean; note?: string }>
  regions: number
  bytesScanned: number
  readFailures: number
  needleHits: number
  /** 掩码解码后读到 `x'<hex…>'` 形状的次数（主路由的原始命中数）。 */
  recordHits: number
  /** 满足 `u64==30` + 指针形状检查的候选位置数（兜底路由的原始输入）。 */
  lenMarkerCandidates: number
  /** 其中**指针真的指向 needle 字符串**的节点数 —— 这就是 std::string 节点。 */
  nodeConfirmed: number
  /** 兼容别名：= {@link nodeConfirmed}。 */
  nodeCandidates: number
  /** 主路由 0 命中、走了结构游走兜底。 */
  usedStructuralFallback: boolean
  blobs: number
  decodedRecords: number
  distinctRecords: number
  saltMatched: number
  hmacChecks: number
  verified: number
  maskRecoveryAttempts: number
  maskRecovered: number
  structAttemptsUsed: string[]
  elapsedMs: number
  slowestStep: ScanStepTiming | null
  cancelled: boolean
}

export type ScanPhase =
  | 'prerequisite'
  | 'process'
  | 'regions'
  | 'needles'
  | 'resolve'
  | 'decode'
  | 'validate'
  | 'done'

export interface ScanProgress {
  phase: ScanPhase
  /** 直接可以显示给用户的一句话。 */
  message: string
  /** 0–1；未知时为 null。 */
  ratio: number | null
  bytesScanned?: number
  regionsDone?: number
  regionsTotal?: number
  pid?: number
  needleHits?: number
  candidates?: number
  verified?: number
  elapsedMs?: number
}

/** 取消信号：传一个可变对象即可（UI 按钮把它置 true）。 */
export interface ScanCancellation {
  cancelled: boolean
}

export interface ScanOptions {
  /** 微信进程；不给则自己找。 */
  pids?: number[]
  /** 账号目录（`…/wxid_xxx`）或直接给 `db_storage`。 */
  accountDir?: string
  dbStorageDir?: string
  /** 只读校验用的库列表；不给则由 {@link listDbFiles} 枚举。 */
  dbFiles?: DbFileEntry[]
  onProgress?: (progress: ScanProgress) => void
  cancel?: ScanCancellation
  /** 事件循环让出时间片。 */
  yieldEveryMs?: number
  /** 每块读取字节数（默认 2 MB）。 */
  chunkBytes?: number
  /** 单个进程的读取上限（调试用；不给则不限制）。 */
  maxBytesPerPid?: number
  /** 是否启用掩码自恢复（默认开）。 */
  maskRecovery?: boolean
  /**
   * 是否把记录当口令再算一次 PBKDF2。
   *
   * **默认关**，理由是实测数字：口令模式每次要跑 256000 轮 PBKDF2，本机实测
   * **98.2 ms**（
ode -e "crypto.pbkdf2Sync(key,salt,256000,32,'sha512')"），
   * 一次同步调用就能顶掉整个"不许卡顿超过 50 ms"的预算。扫描要的是**每库 page key**
   * （raw 形态，macKey 只有 2 轮 KDF，实测 < 0.01 ms），所以扫描路径不需要口令模式；
   * 需要判定"这把口令能不能开这个库"的地方（alidateAccountKeyAgainstDbs、
   * 健康面板）是用户主动触发的单次动作，在那里付这 98 ms 是可以接受的。
   */
  tryPassphraseMode?: boolean
}

export interface ScanResult {
  success: boolean
  keys: ScannedDbKey[]
  diagnostics: ScanDiagnostics
  /** 失败原因（机读码）。 */
  errorCode?: 'no-wechat-process' | 'open-denied' | 'no-db-files' | 'no-key-found' | 'cancelled' | 'unsupported-platform' | 'db-enumeration-incomplete'
  error?: string
  logs: string[]
}

// === koffi 惰性加载（让本模块能在纯 Node 下被 require，纯函数部分也能被单测直接跑） ===

type KoffiLib = any

let koffiCache: KoffiLib | null = null
function loadKoffi(): KoffiLib {
  if (koffiCache) return koffiCache
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  koffiCache = require('koffi')
  return koffiCache
}

let kernel32Cache: any = null
function loadKernel32(): any {
  if (kernel32Cache) return kernel32Cache
  const koffi = loadKoffi()
  const kernel32 = koffi.load('kernel32.dll')
  kernel32Cache = {
    OpenProcess: kernel32.func('OpenProcess', 'void*', ['uint32', 'bool', 'uint32']),
    CloseHandle: kernel32.func('CloseHandle', 'bool', ['void*']),
    VirtualQueryEx: kernel32.func('VirtualQueryEx', 'size_t', ['void*', 'uintptr', 'void*', 'size_t']),
    ReadProcessMemory: kernel32.func('ReadProcessMemory', 'bool', ['void*', 'uintptr', 'void*', 'size_t', koffi.out('size_t*')]),
    GetLastError: kernel32.func('GetLastError', 'uint32', []),
    QueryFullProcessImageNameW: kernel32.func('QueryFullProcessImageNameW', 'bool', ['void*', 'uint32', 'void*', 'void*']),
  }
  return kernel32Cache
}

// === 进程发现与只读访问探测 ===

/** 查 `Weixin.exe` / `WeChat.exe` 的 PID（与 keyService 同源做法）。 */
export async function findWeChatPids(imageNames: string[] = ['Weixin.exe', 'WeChat.exe']): Promise<number[]> {
  const pids = new Set<number>()
  for (const imageName of imageNames) {
    try {
      const { stdout } = await execFileAsync('tasklist', ['/FI', `IMAGENAME eq ${imageName}`, '/FO', 'CSV', '/NH'])
      for (const line of stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)) {
        if (line.startsWith('INFO:')) continue
        const parts = line.split('","').map((p) => p.replace(/^"|"$/g, ''))
        if (parts[0]?.toLowerCase() !== imageName.toLowerCase()) continue
        const pid = Number(parts[1])
        if (Number.isFinite(pid) && pid > 0) pids.add(pid)
      }
    } catch {
      /* tasklist 不可用时返回已找到的 */
    }
  }
  return [...pids]
}

/** 进程可执行文件路径（只读）。 */
export function getProcessImagePath(pid: number): string | null {
  try {
    const k32 = loadKernel32()
    const handle = k32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid)
    if (!handle) return null
    try {
      const sizeBuf = Buffer.alloc(4)
      sizeBuf.writeUInt32LE(1024, 0)
      const pathBuf = Buffer.alloc(1024 * 2)
      if (!k32.QueryFullProcessImageNameW(handle, 0, pathBuf, sizeBuf)) return null
      const len = sizeBuf.readUInt32LE(0)
      return pathBuf.toString('ucs2', 0, len * 2)
    } finally {
      k32.CloseHandle(handle)
    }
  } catch {
    return null
  }
}

/** 是否可以只读打开该进程（自检第 6 项 / K10）。 */
export function canReadProcessMemory(pid: number): boolean {
  try {
    const k32 = loadKernel32()
    const handle = k32.OpenProcess(PROCESS_VM_READ | PROCESS_QUERY_INFORMATION, false, pid)
    if (!handle) return false
    k32.CloseHandle(handle)
    return true
  } catch {
    return false
  }
}

/**
 * 读 Windows 可执行文件的版本号（纯读取文件字节，不启动子进程）。
 *
 * 为什么不用 PowerShell：自检要在点「获取密钥」的瞬间出结果，起一个 PowerShell
 * 约 300–700 ms，而这件事只需要 `version.dll` 两个调用。
 *
 * 先取 `FileVersion` 字符串（人手看到的版本就是它，例如 `4.1.13.65`），
 * 取不到再退化成 `VS_FIXEDFILEINFO` 里的数字版本。
 */
export function readFileVersionString(exePath: string): string | null {
  try {
    if (!existsSync(exePath)) return null
    const koffi = loadKoffi()
    const version = koffi.load('version.dll')
    const sizeFn: any = version.func('GetFileVersionInfoSizeW', 'uint32', ['void*', koffi.out('uint32*')])
    const ignored = [0]
    const size = Number(sizeFn(Buffer.from(`${exePath}\0`, 'ucs2'), ignored))
    if (!size || size <= 0 || size > 1 << 20) return null
    const infoFn: any = version.func('GetFileVersionInfoW', 'bool', ['void*', 'uint32', 'uint32', 'void*'])
    const buf = Buffer.alloc(size)
    if (!infoFn(Buffer.from(`${exePath}\0`, 'ucs2'), 0, size, buf)) return null

    const marker = Buffer.from('FileVersion\0', 'ucs2')
    const at = buf.indexOf(marker)
    if (at >= 0) {
      let start = at + marker.length
      while (start + 1 < buf.length && buf.readUInt16LE(start) === 0) start += 2
      let end = start
      while (end + 1 < buf.length && buf.readUInt16LE(end) !== 0) end += 2
      const text = buf.toString('ucs2', start, end).trim()
      if (/^\d+(\.\d+){1,3}$/.test(text)) return text
    }
    if (buf.readUInt32LE(0) === 0xfeef04bd) {
      const ms = buf.readUInt32LE(8)
      const ls = buf.readUInt32LE(12)
      return `${ms >>> 16}.${ms & 0xffff}.${ls >>> 16}.${ls & 0xffff}`
    }
    return null
  } catch {
    return null
  }
}

// === 扫描主体 ===

function nowMs(): number {
  return Number(process.hrtime.bigint() / 1000000n)
}

class StepTimer {
  private steps = new Map<string, number>()
  add(name: string, ms: number): void {
    this.steps.set(name, (this.steps.get(name) ?? 0) + ms)
  }
  slowest(): ScanStepTiming | null {
    let best: ScanStepTiming | null = null
    for (const [name, ms] of this.steps) {
      if (!best || ms > best.ms) best = { name, ms: Math.round(ms) }
    }
    return best
  }
}

/** 从账号目录（或任意上层目录）定位 `db_storage`。只读、不创建。 */
export function resolveDbStorageDir(accountDir: string): string | null {
  if (!accountDir) return null
  const candidates = [accountDir, join(accountDir, 'db_storage')]
  for (const candidate of candidates) {
    try {
      if (basename(candidate).toLowerCase() === 'db_storage' && existsSync(candidate)) return candidate
      const direct = join(candidate, 'db_storage')
      if (existsSync(direct)) return direct
    } catch { /* noop */ }
  }
  return null
}

/**
 * 只读扫描主入口（Windows / 微信 4.1.10+）。
 *
 * 返回的 `keys` 里每个库一把密钥、且**每把都过了 page 1 HMAC** —— 未验证的候选
 * 不会出现在结果里。"验证过的才算拿到密钥"是本特性唯一的成功判据。
 */
export async function scanWindowsWeChatDbKeys(options: ScanOptions = {}): Promise<ScanResult> {
  const started = nowMs()
  const timer = new StepTimer()
  const logs: string[] = []
  const yieldEveryMs = options.yieldEveryMs ?? DEFAULT_YIELD_EVERY_MS
  const chunkBytes = options.chunkBytes ?? CHUNK_BYTES
  const tryPassphrase = options.tryPassphraseMode === true
  const maskRecoveryEnabled = options.maskRecovery !== false

  const diagnostics: ScanDiagnostics = {
    pids: [],
    pidDetails: [],
    regions: 0,
    bytesScanned: 0,
    readFailures: 0,
    needleHits: 0,
    recordHits: 0,
    lenMarkerCandidates: 0,
    nodeConfirmed: 0,
    nodeCandidates: 0,
    usedStructuralFallback: false,
    blobs: 0,
    decodedRecords: 0,
    distinctRecords: 0,
    saltMatched: 0,
    hmacChecks: 0,
    verified: 0,
    maskRecoveryAttempts: 0,
    maskRecovered: 0,
    structAttemptsUsed: [],
    elapsedMs: 0,
    slowestStep: null,
    cancelled: false,
  }

  let lastYield = nowMs()
  const maybeYield = async (force = false): Promise<void> => {
    const now = nowMs()
    if (force || now - lastYield >= yieldEveryMs) {
      lastYield = now
      // setImmediate 只让出一次宏任务：既不饿死渲染侧的 IPC，也不引入定时器抖动
      await new Promise((resolve) => setImmediate(resolve))
    }
  }
  const isCancelled = (): boolean => options.cancel?.cancelled === true
  const report = (progress: ScanProgress): void => {
    try { options.onProgress?.(progress) } catch { /* 进度回调绝不能影响扫描 */ }
  }
  const finish = (partial: Partial<ScanResult> & { keys: ScannedDbKey[] }): ScanResult => {
    diagnostics.elapsedMs = Math.round(nowMs() - started)
    diagnostics.slowestStep = timer.slowest()
    diagnostics.verified = partial.keys.filter((k) => k.verified).length
    return {
      success: partial.success ?? false,
      keys: partial.keys,
      diagnostics,
      errorCode: partial.errorCode,
      error: partial.error,
      logs,
    }
  }

  if (process.platform !== 'win32') {
    return finish({
      keys: [],
      errorCode: 'unsupported-platform',
      error: '免登录只读扫描只在 Windows 上实现；macOS/Linux 请使用登录捕获（Hook）路径。',
    })
  }

  // 0) 库文件：只读枚举 + 只读读首页
  const dbStorageDir = options.dbStorageDir ?? (options.accountDir ? resolveDbStorageDir(options.accountDir) : null)
  let dbFiles: DbFileEntry[]
  try {
    dbFiles = options.dbFiles ?? (dbStorageDir ? listDbFiles(dbStorageDir) : [])
  } catch (error) {
    return finish({
      keys: [],
      errorCode: 'db-enumeration-incomplete',
      error: error instanceof DbFileEnumerationLimitError
        ? error.message
        : `无法完整枚举数据库文件：${String((error as Error)?.message || error)}`,
    })
  }
  if (dbFiles.length === 0) {
    return finish({
      keys: [],
      errorCode: 'no-db-files',
      error: dbStorageDir
        ? '数据目录里没有找到微信 4.x 的数据库文件（db_storage/*.db）。'
        : '没能定位微信数据目录（db_storage）。',
    })
  }

  report({ phase: 'prerequisite', message: `正在读取 ${dbFiles.length} 个数据库的首页（只读）…`, ratio: null })
  const tReadStart = nowMs()
  const dbBySalt = new Map<string, { entry: DbFileEntry; page1: Buffer; saltHex: string }>()
  const readableDbs: Array<{ entry: DbFileEntry; page1: Buffer; saltHex: string }> = []
  let loadedCount = 0
  for (const entry of dbFiles) {
    const loaded = readPage1(entry.path)
    if (!loaded.ok || !loaded.page1) continue
    const saltHex = saltHexOf(loaded.page1)
    const record = { entry, page1: loaded.page1, saltHex }
    readableDbs.push(record)
    if (!dbBySalt.has(saltHex)) dbBySalt.set(saltHex, record)
    loadedCount++
    if (loadedCount % 8 === 0) await maybeYield()
  }
  timer.add('read-page1', nowMs() - tReadStart)
  if (readableDbs.length === 0) {
    return finish({
      keys: [],
      errorCode: 'no-db-files',
      error: '数据库文件存在但都无法读取首页（可能被占用或权限不足）。',
    })
  }

  // 1) 进程
  report({ phase: 'process', message: '正在查找微信进程…', ratio: null })
  const pids = options.pids && options.pids.length > 0 ? options.pids : await findWeChatPids()
  diagnostics.pids = pids
  if (pids.length === 0) {
    return finish({
      keys: [],
      errorCode: 'no-wechat-process',
      error: '微信没有在运行。免登录扫描需要读取正在运行的微信进程内存。',
    })
  }

  const k32 = loadKernel32()
  const verifiedByPath = new Map<string, ScannedDbKey>()
  const structUsed = new Set<string>()
  const seenRecordIds = new Set<string>()
  let openDeniedAll = true

  for (const pid of pids) {
    if (isCancelled()) {
      diagnostics.cancelled = true
      break
    }
    const handle = k32.OpenProcess(PROCESS_VM_READ | PROCESS_QUERY_INFORMATION, false, pid)
    if (!handle) {
      diagnostics.pidDetails.push({ pid, regions: 0, bytes: 0, needleHits: 0, openDenied: true, note: `GetLastError=${k32.GetLastError()}` })
      logs.push(`[pid ${pid}] OpenProcess 被拒绝（自检第 6 项）`)
      continue
    }
    openDeniedAll = false
    const detail = { pid, regions: 0, bytes: 0, needleHits: 0, openDenied: false }
    diagnostics.pidDetails.push(detail)

    try {
      // 2) 枚举可读区域
      const tRegionStart = nowMs()
      const mbi = Buffer.alloc(48)
      const regions: Array<[number, number]> = []
      let addr = 0
      while (addr < 0x7fffffffffff) {
        if (k32.VirtualQueryEx(handle, addr, mbi, 48) === 0) break
        const base = Number(mbi.readBigUInt64LE(0))
        const size = Number(mbi.readBigUInt64LE(24))
        const state = mbi.readUInt32LE(32)
        const protect = mbi.readUInt32LE(36)
        if (state === MEM_COMMIT && READABLE_PROTECT_FLAGS.includes(protect) && size > 0 && size < MAX_REGION_BYTES) {
          regions.push([base, size])
        }
        const next = base + size
        if (next <= addr) break
        addr = next
        await maybeYield()
      }
      timer.add('VirtualQueryEx', nowMs() - tRegionStart)
      detail.regions = regions.length
      diagnostics.regions += regions.length
      const totalBytes = regions.reduce((sum, [, size]) => sum + size, 0)
      report({
        phase: 'regions',
        message: `正在扫描微信进程内存（PID ${pid}，${regions.length} 个区域，${(totalBytes / 1024 / 1024).toFixed(0)} MB）…`,
        ratio: null,
        regionsTotal: regions.length,
        pid,
      })

      // 3) 单遍内存：掩码解码内容扫描（主路由）+ 结构游走（兜底路由）
      //
      // 为什么主路由不是"结构游走"：参考实现（`cipher2.cjs`）走的是
      // needle → std::string 节点 → `config_ptr+0x88` → blob 的指针链。本机复测发现
      // 这条路**会飘**：同一个进程里 needle 字符串一直在（本次 8 份），但指向它的
      // `(ptr,30)` 节点会随 WCDB 配置对象的创建/销毁而消失（同一天两次运行
      // `nodeCandidates` 从 12 变 0），而且 `+0x88` 这种偏移天生版本敏感。
      //
      // 主路由改用**格式自身的证据**（报告 §1.3 步骤 4/5）：每个库的 cipher blob 都用
      // 同一份 27 字节掩码混淆，所以把内存按掩码 XOR 之后，所有库的
      // `x'<64hex key><32hex salt>'` 记录都会**以明文形状出现**。它
      //   - 不依赖任何偏移，也没有指针链要爬（版本变化时最先坏的就是偏移）；
      //   - 一遍内存就能拿到**所有**库的记录（每库一份 blob）；
      //   - 本机实测复现了研究报告里的指纹（message_0=8443…d059 / session=fd0b…746a /
      //     contact=e15a…2803），并多取到 12 个库（报告当时只验了 4 个）。
      //
      // 兜底路由保留结构游走 + 掩码自恢复：当掩码随版本变了、主路由 0 命中时，
      // 它靠"结构收敛 + HMAC 裁决"把掩码反解出来。
      const tScanStart = nowMs()
      const needleHitsLocal: number[] = [] // 仅诊断：证明该版本确实带了这份配置类
      const buf = Buffer.alloc(chunkBytes + CHUNK_OVERLAP)
      const scratch = Buffer.allocUnsafe(chunkBytes + CHUNK_OVERLAP)
      const out = [0]
      let bytes = 0
      let regionsDone = 0
      const maskLen = CIPHER_XOR_MASK.length
      const recordsFromContent: DecodedKeyRecord[] = []

      for (const [base, size] of regions) {
        if (isCancelled()) break
        if (verifiedByPath.size >= readableDbs.length) break
        for (let off = 0; off < size; off += chunkBytes) {
          const want = Math.min(chunkBytes + CHUNK_OVERLAP, size - off)
          if (want <= 0) break
          if (options.maxBytesPerPid && bytes > options.maxBytesPerPid) break
          if (!k32.ReadProcessMemory(handle, base + off, buf, want, out)) {
            diagnostics.readFailures++
            continue
          }
          const got = Number(out[0] || 0)
          if (got <= 0) continue
          bytes += got
          diagnostics.bytesScanned += got
          const view = buf.subarray(0, got)

          let n = -1
          while ((n = view.indexOf(CIPHER_NEEDLE, n + 1)) >= 0) needleHitsLocal.push(base + off + n)

          // 掩码解码：相位必须按**绝对地址**对齐（blob 落在哪个相位取决于它在内存里的位置）。
          //
          // 性能注意：写成 `scratch[k] = view[k] ^ MASK[(k + phase) % maskLen]` 时，每个
          // 字节都要做一次整数除法（maskLen 在运行时才知道，V8 无法把它变成乘法），
          // 实测把本机 1.6 GB 扫成了 40 s。改成"maskLen 字节为一组、组内用常量下标"
          // 之后无除法，同机降到 ~10 s。这段循环是整条路径的热点，改它之前请用
          // `.wxkey-research/probe/keyscan-live.cjs` 复测墙钟时间。
          const phase = (base + off) % maskLen
          const m0 = CIPHER_XOR_MASK
          let k = 0
          if (phase === 0) {
            for (; k + maskLen <= got; k += maskLen) {
              for (let t = 0; t < maskLen; t++) scratch[k + t] = view[k + t] ^ m0[t]
            }
          } else {
            // 相位非 0 时，先把"旋转后的掩码"摊平，之后同样是常量下标
            const rot = Buffer.allocUnsafe(maskLen)
            for (let t = 0; t < maskLen; t++) rot[t] = m0[(t + phase) % maskLen]
            for (; k + maskLen <= got; k += maskLen) {
              for (let t = 0; t < maskLen; t++) scratch[k + t] = view[k + t] ^ rot[t]
            }
            for (let t = 0; k + t < got; t++) scratch[k + t] = view[k + t] ^ rot[t]
          }
          for (; k < got; k++) scratch[k] = view[k] ^ m0[(k + phase) % maskLen]
          const decoded = scratch.subarray(0, got)
          let i = -1
          while ((i = decoded.indexOf(CIPHER_RECORD_PREFIX, i + 1)) >= 0) {
            const run = readHexRunAt(decoded, i + CIPHER_RECORD_PREFIX.length)
            if (!run) continue
            diagnostics.recordHits++
            for (const record of extractKeyRecords(`${CIPHER_RECORD_PREFIX.toString('latin1')}${run}'`)) {
              recordsFromContent.push(record)
            }
          }
          await maybeYield()
        }
        regionsDone++
        if (regionsDone % 32 === 0) {
          report({
            phase: 'needles',
            message: `正在扫描微信进程内存（PID ${pid}）… ${regionsDone}/${regions.length} 个区域，已读到 ${recordsFromContent.length} 条记录`,
            ratio: regions.length ? regionsDone / regions.length : null,
            regionsDone,
            regionsTotal: regions.length,
            pid,
            bytesScanned: bytes,
            needleHits: needleHitsLocal.length,
          })
        }
      }
      timer.add('memory-scan', nowMs() - tScanStart)
      detail.bytes = bytes
      detail.needleHits = needleHitsLocal.length
      diagnostics.needleHits += needleHitsLocal.length
      const recordsAfterPrimary = recordsFromContent.length

      // 4) 兜底路由：结构游走（仅在主路由一条记录都没读到时才做）
      const tResolveStart = nowMs()
      const blobs: Array<{ blob: Buffer; struct: string }> = []
      const seenBlobHex = new Set<string>()
      const recoveryCache = new Map<string, MaskRecoveryResult>()
      const MAX_BLOBS = 256
      const readMem = (startAddr: number, len: number): Buffer | null => {
        if (len <= 0 || startAddr <= 0 || startAddr > 0x7fffffffff) return null
        const b = Buffer.alloc(len)
        const o = [0]
        if (!k32.ReadProcessMemory(handle, startAddr, b, len, o)) return null
        return Number(o[0]) === len ? b : null
      }
      /** 解码一块 blob：参考掩码优先，失败再走掩码自恢复。空数组 = "不像 cipher blob"。 */
      const decodeBlobCached = (blob: Buffer): { records: DecodedKeyRecord[]; maskHex: string | null } => {
        const blobHex = blob.toString('hex')
        let decoded = decodeCipherBlob(blob, { masks: [CIPHER_XOR_MASK] })
        if (decoded.records.length === 0 && maskRecoveryEnabled) {
          diagnostics.maskRecoveryAttempts++
          let recovery = recoveryCache.get(blobHex)
          if (!recovery) {
            // 把本账号**已知的库 salt** 交给自恢复：salt 的 32 个字符覆盖掩码的
            // 32 个残差类各一次，等于把整张掩码唯一确定下来（决定性路径）。
            recovery = recoverCipherMaskCandidates(blob, { knownSalts: [...dbBySalt.keys()] })
            recoveryCache.set(blobHex, recovery)
          }
          if (recovery.masks.length > 0) diagnostics.maskRecovered++
          decoded = decodeCipherBlob(
            blob,
            recovery.masks.length > 0 ? { masks: recovery.masks, recovery } : { masks: [CIPHER_XOR_MASK], recovery }
          )
        }
        return { records: decoded.records, maskHex: decoded.usedMaskHex }
      }
      const pushBlob = (blob: Buffer, struct: string): void => {
        if (blobs.length >= MAX_BLOBS) return
        const hex = blob.toString('hex')
        if (seenBlobHex.has(hex)) return
        seenBlobHex.add(hex)
        diagnostics.blobs++
        blobs.push({ blob, struct })
      }
      /**
       * 在 config 对象附近按 `(ptr, len)` 指针猎取 blob（偏移无关路径）。
       *
       * 这一步全是同步的内存读：0x400 窗口 / 0x100 块 / 8 字节步进，最坏情况几千次
       * `readMem` + 解码。原来的实现整段同步跑完，引擎的事件循环在这段时间里完全不能响应
       * （界面表现为"扫描卡住"，托盘和其他 IPC 一起不动）。现在每读完两个窗口让出一次。
       */
      const huntBlobsNear = async (configPtr: number, baseLabel: string): Promise<void> => {
        const windowBytes = 0x400
        const chunk = 0x100
        let windows = 0
        for (let win = 0; win < windowBytes; win += chunk) {
          if (isCancelled() || blobs.length >= MAX_BLOBS) return
          if (windows > 0 && windows % 2 === 0) await maybeYield()
          windows += 1
          const dump = readMem(configPtr + win, chunk)
          if (!dump) continue
          for (let o = 0; o + 16 <= dump.length; o += 8) {
            const dataPtr = Number(dump.readBigUInt64LE(o))
            const dataLen = Number(dump.readBigUInt64LE(o + 8))
            if (!(dataLen > 40 && dataLen <= BLOB_MAX)) continue
            if (!(dataPtr > 0x10000 && dataPtr < 0x7fffffffff) || dataPtr % 8 !== 0) continue
            const blob = readMem(dataPtr, dataLen)
            if (!blob) continue
            if (decodeBlobCached(blob).records.length === 0) continue
            pushBlob(blob, `${baseLabel}/hunt+0x${(win + o).toString(16)}`)
            if (blobs.length >= MAX_BLOBS) return
          }
        }
      }

      if (recordsAfterPrimary === 0 && needleHitsLocal.length > 0) {
        const pair = Buffer.alloc(16)
        for (const needleAddr of needleHitsLocal) {
          if (isCancelled() || blobs.length >= MAX_BLOBS) break
          pair.writeBigUInt64LE(BigInt(needleAddr), 0)
          pair.writeBigUInt64LE(BigInt(CIPHER_NEEDLE_LEN), 8)
          for (const [base, size] of regions) {
            if (isCancelled() || blobs.length >= MAX_BLOBS) break
            for (let off = 0; off < size; off += chunkBytes) {
              const want = Math.min(chunkBytes + CHUNK_OVERLAP, size - off)
              if (want <= 0) break
              if (!k32.ReadProcessMemory(handle, base + off, buf, want, out)) continue
              const got = Number(out[0] || 0)
              if (got <= 0) continue
              const view = buf.subarray(0, got)
              let j = -1
              while ((j = view.indexOf(pair, j + 1)) >= 0) {
                const nodeBase = base + off + j - 0x10
                const head = readMem(nodeBase, 0x40)
                if (!head) continue
                if (Number(head.readBigUInt64LE(OFFSET_NODE_DATA_PTR)) !== needleAddr) continue
                if (Number(head.readBigUInt64LE(OFFSET_NODE_LEN)) !== CIPHER_NEEDLE_LEN) continue
                diagnostics.nodeCandidates++
                let huntTarget = 0
                for (const attempt of STRUCT_OFFSET_ATTEMPTS) {
                  const configPtr = head.readBigUInt64LE(attempt.nodeConfigPtr)
                  if (!configPtr) continue
                  if (!huntTarget) huntTarget = Number(configPtr)
                  const obj = readMem(Number(configPtr) + attempt.configBlob, 0x28)
                  if (!obj) continue
                  const blobPtr = obj.readBigUInt64LE(OFFSET_BLOB_DATA_PTR)
                  const blobLen = obj.readBigUInt64LE(OFFSET_BLOB_DATA_LEN)
                  if (!blobPtr || !blobLen) continue
                  const len = Number(blobLen)
                  if (!(len > 0 && len <= BLOB_MAX)) continue
                  const blob = readMem(Number(blobPtr), len)
                  if (!blob) continue
                  if (decodeBlobCached(blob).records.length === 0) continue
                  pushBlob(blob, attempt.label)
                }
                // 现在是 async（内部会让出事件循环），所以这里要 await：否则它变成一个
                // 悬空 promise，扫描会"先往下走、后面才补猎取"，顺序和错误都丢了。
                if (huntTarget) await huntBlobsNear(huntTarget, 'near-node')
              }
              await maybeYield()
            }
          }
        }
        diagnostics.usedStructuralFallback = true
      }
      timer.add('struct-walk', nowMs() - tResolveStart)

      // 5) 只读校验（page 1 HMAC）：**只有过了这一关的密钥才会出现在结果里**
      const tDecodeStart = nowMs()
      let candidates = 0
      let saltMatched = 0
      const verifyRecord = (record: DecodedKeyRecord, label: string): void => {
        const recordId = `${record.keyHex}|${record.saltHex ?? ''}`
        if (seenRecordIds.has(recordId)) return
        seenRecordIds.add(recordId)
        diagnostics.distinctRecords++
        candidates++
        const keyBuf = Buffer.from(record.keyHex, 'hex')
        // 优先用 salt 精确配对；salt 缺失/对不上时，raw 模式的 HMAC 很便宜
        // （macKey 只做 2 轮 KDF），可以对着全部库再试一遍。
        const direct = record.saltHex ? dbBySalt.get(record.saltHex) : undefined
        if (direct) { saltMatched++; diagnostics.saltMatched++ }
        const pool = direct ? [direct] : readableDbs
        for (const target of pool) {
          if (verifiedByPath.has(target.entry.path)) continue
          diagnostics.hmacChecks++
          const verdict = verifyPageKey(target.page1, keyBuf, ['raw'])
          let mode: PageKeyMode | null = verdict.mode
          if (!mode && direct && target === direct && tryPassphrase && record.saltHex === target.saltHex) {
            // 口令模式每次 ~100 ms 的 PBKDF2，只对 salt 精确命中的记录做
            diagnostics.hmacChecks++
            const passVerdict = verifyPageKey(target.page1, keyBuf, ['passphrase'])
            if (!passVerdict.mode) continue
            mode = passVerdict.mode
          }
          if (!mode) continue
          verifiedByPath.set(target.entry.path, {
            id: target.entry.id,
            kind: target.entry.kind,
            path: target.entry.path,
            keyHex: record.keyHex,
            saltHex: record.saltHex,
            mode,
            verified: true,
            fingerprint: keyFingerprint(record.keyHex),
            pid,
            structOffset: label,
          })
        }
      }

      for (const record of recordsFromContent) {
        if (isCancelled()) break
        if (verifiedByPath.size >= readableDbs.length) break
        diagnostics.decodedRecords++
        structUsed.add('mask-xor')
        verifyRecord(record, 'mask-xor')
        await maybeYield()
      }
      if (recordsAfterPrimary === 0) {
        for (const { blob, struct } of blobs) {
          if (isCancelled()) break
          if (verifiedByPath.size >= readableDbs.length) break
          const decoded = decodeBlobCached(blob)
          if (decoded.records.length === 0) continue
          diagnostics.decodedRecords += decoded.records.length
          structUsed.add(decoded.maskHex && decoded.maskHex !== CIPHER_XOR_MASK.toString('hex') ? `${struct}/mask-recovered` : struct)
          for (const record of decoded.records) {
            verifyRecord(record, struct)
            await maybeYield()
          }
        }
      }
      timer.add('decode+verify', nowMs() - tDecodeStart)
      logs.push(
        `[pid ${pid}] regions=${regions.length} bytes=${(bytes / 1024 / 1024).toFixed(0)}MB needleHits=${needleHitsLocal.length} ` +
        `recordHits=${diagnostics.recordHits} contentRecords=${recordsAfterPrimary} nodes=${diagnostics.nodeCandidates} blobs=${blobs.length}`
      )
      report({
        phase: 'validate',
        message: `PID ${pid}：读到 ${candidates} 条候选，已验证 ${verifiedByPath.size}/${readableDbs.length} 个库…`,
        ratio: readableDbs.length ? verifiedByPath.size / readableDbs.length : null,
        pid,
        needleHits: needleHitsLocal.length,
        candidates,
        verified: verifiedByPath.size,
      })
      report({
        phase: 'validate',
        message: `PID ${pid}：读到 ${candidates} 条候选，已验证 ${verifiedByPath.size}/${readableDbs.length} 个库…`,
        ratio: readableDbs.length ? verifiedByPath.size / readableDbs.length : null,
        pid,
        needleHits: needleHitsLocal.length,
        candidates,
        verified: verifiedByPath.size,
      })
    } finally {
      try { k32.CloseHandle(handle) } catch { /* noop */ }
    }

    if (verifiedByPath.size >= readableDbs.length) break // 全中，不必再扫别的进程
  }

  diagnostics.structAttemptsUsed = [...structUsed]
  const keys = [...verifiedByPath.values()]

  report({
    phase: 'done',
    message: keys.length > 0
      ? `已取到 ${keys.length} 个库的密钥并校验通过，用时 ${((nowMs() - started) / 1000).toFixed(1)} s。`
      : '扫描完成，但没有找到与这些数据库匹配的密钥。',
    ratio: 1,
    verified: keys.length,
    needleHits: diagnostics.needleHits,
    candidates: diagnostics.distinctRecords,
    elapsedMs: Math.round(nowMs() - started),
  })

  if (keys.length > 0) return finish({ keys, success: true })
  if (isCancelled()) return finish({ keys, errorCode: 'cancelled', error: '扫描已取消。' })
  if (openDeniedAll) {
    return finish({
      keys,
      errorCode: 'open-denied',
      error: '无法读取微信进程内存（OpenProcess 被拒绝），通常是安全软件/杀毒软件的进程防护拦截。',
    })
  }
  return finish({
    keys,
    errorCode: 'no-key-found',
    error: `扫描完成（读 ${(diagnostics.bytesScanned / 1024 / 1024).toFixed(0)} MB，锚点 ${diagnostics.needleHits} 个，候选 ${diagnostics.distinctRecords} 条），但没有找到能解开这些数据库的密钥。`,
  })
}
