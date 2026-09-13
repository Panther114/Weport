/**
 * 共享服务上下文 —— 挂在 fastify 实例上（app.weclone）。
 */

import type { MetaStore } from './store/metaStore'
import type { BlobStore } from './store/blobStore'
import type { RetrievalManager } from './retrieval/bm25'

export interface WecloneLimits {
  /** 上传请求体上限（MB） */
  maxUploadMb: number
  /** 单 clone 序列化 chunks 上限（MB） */
  maxBlobMb: number
  /** 每 owner token 的 clone 数上限 */
  maxClonesPerToken: number
  /** chat 限流：次/分钟/IP */
  rateLimitChat: number
  /** upload 限流：次/小时/IP */
  rateLimitUpload: number
}

export interface WecloneContext {
  metaStore: MetaStore
  blobStore: BlobStore
  retrieval: RetrievalManager
  limits: WecloneLimits
}

declare module 'fastify' {
  interface FastifyInstance {
    weclone: WecloneContext
  }
}

export function readLimitsFromEnv(): WecloneLimits {
  return {
    maxUploadMb: intEnv('WECLONE_MAX_UPLOAD_MB', 25),
    maxBlobMb: intEnv('WECLONE_MAX_BLOB_MB', 20),
    maxClonesPerToken: intEnv('WECLONE_MAX_CLONES_PER_TOKEN', 5),
    rateLimitChat: intEnv('WECLONE_RATE_LIMIT_CHAT', 20),
    rateLimitUpload: intEnv('WECLONE_RATE_LIMIT_UPLOAD', 5),
  }
}

export function intEnv(name: string, fallback: number): number {
  const raw = Number(process.env[name])
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : fallback
}
