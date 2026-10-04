/** Private screenshot-mode acceptance: real packaged WASM + SNS image pipeline,
 * intercepted fixture transport. No CDN request or personal media is involved. */
import https from 'node:https'
import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { nativeImage } from 'electron'
import { WasmService } from './wasmService'
import { snsService } from './snsService'

export async function verifyPackagedMomentsImage(userData: string) {
  const root = mkdtempSync(join(userData, 'packaged-media-fixture-'))
  const originalRequest = https.request
  try {
    const png = nativeImage.createFromBitmap(Buffer.from([23, 128, 245, 255]), { width: 1, height: 1 }).toPNG()
    const key = '314159265358979'
    const aligned = Math.ceil(png.length / 8) * 8
    const stream = Buffer.from(await WasmService.getInstance().getRawKeystream(key, aligned)).reverse()
    const cipher = Buffer.from(png.map((byte, i) => byte ^ stream[i]))
    // Prime a shorter request in the same aligned block to reproduce the cache bug.
    await WasmService.getInstance().getKeystream(key, aligned - 7)
    let intercepted = 0
    https.request = ((options: any, callback: any) => {
      if (options.hostname !== 'weport-fixture.invalid') return (originalRequest as any)(options, callback)
      intercepted++
      const request = new EventEmitter() as any
      request.setTimeout = () => request
      request.destroy = () => {}
      request.end = () => queueMicrotask(() => {
        const response = Readable.from([cipher]) as any
        response.statusCode = 200
        response.headers = { 'x-enc': '1', 'content-type': 'application/octet-stream' }
        callback(response)
      })
      return request
    }) as typeof https.request
    const fixture = Object.create(Object.getPrototypeOf(snsService))
    const cachePath = join(root, 'fixture.png')
    Object.assign(fixture, { getCacheFilePath: () => cachePath, normalizeCacheUrl: (url: string) => url,
      migrateLegacyCacheFile: () => {}, rememberFailedResource: () => {} })
    const result = await fixture.fetchAndDecryptImage('https://weport-fixture.invalid/image', key)
    if (!result.success || !result.data?.equals(png) || !readFileSync(cachePath).equals(png)) throw new Error('Packaged SNS image decryption failed')
    const size = nativeImage.createFromBuffer(result.data).getSize()
    if (size.width !== 1 || size.height !== 1 || intercepted !== 1) throw new Error('Decrypted fixture is not a valid PNG')
    return { bytes: png.length, sha256: createHash('sha256').update(png).digest('hex'), contentType: result.contentType, ...size, intercepted }
  } finally {
    https.request = originalRequest
    rmSync(root, { recursive: true, force: true })
  }
}
