/**
 * 认证工具 —— ownerToken / secret 的哈希与比较。
 *
 * 服务端只存 SHA-256 哈希，不存明文 token（设计文档 §6.4）。
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

/** SHA-256 hex（64 字符） */
export function sha256Hex(input: string): string {
  return createHash('sha256').update(String(input), 'utf8').digest('hex')
}

/** link 可见性的分享密钥：16 hex 字符 */
export function generateSecret(): string {
  return randomBytes(8).toString('hex')
}

/** 从 Authorization: Bearer <token> 提取 token；无则 null */
export function getBearerToken(authHeader: unknown): string | null {
  if (typeof authHeader !== 'string') return null
  const m = /^Bearer\s+(.+)$/i.exec(authHeader.trim())
  return m ? m[1].trim() : null
}

/** 常数时间字符串比较（长度不同立即 false） */
export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(String(a), 'utf8')
  const bb = Buffer.from(String(b), 'utf8')
  if (ba.length !== bb.length || ba.length === 0) return false
  return timingSafeEqual(ba, bb)
}
