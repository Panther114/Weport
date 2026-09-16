#!/usr/bin/env node
// npm bin shim: resolve the compiled entry relative to this file so a global install,
// `npx weport`, and a workspace link all behave the same. Kept as ESM so there is no
// CJS/ESM interop step between the shim and the compiled sources.
//
// `pathToFileURL` is required rather than a plain path: on Windows an absolute path
// such as `D:\…\dist\main.js` is rejected by the ESM loader ("protocol 'd:'").
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
await import(pathToFileURL(join(here, '..', 'dist', 'main.js')).href)
