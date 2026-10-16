// Compatibility entry point retained for the existing macOS verification workflows.
import assert from 'node:assert/strict'
assert.equal(process.platform, 'darwin')
await import('./verify-encrypted-fixture.mjs')
