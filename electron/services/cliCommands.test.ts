import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * Source-level guards for the CLI command surface.
 *
 * The commands themselves are thin delegations to services that need a live app
 * (database, config, network), so their behaviour is verified against the real
 * install by `scripts/verify-tui-engine.mjs`. What is worth pinning here are the
 * properties a running app cannot tell you and a refactor can quietly break:
 *
 *  - every command name is unique and namespaced (the TUI renders the manifest
 *    directly, and a duplicate silently shadows a command);
 *  - mutating commands are marked, because the TUI confirms those before running;
 *  - no command returns a credential, which is the rule that keeps a token out of a
 *    terminal transcript.
 */

// This file sits in `electron/services/`, so the repository root is two levels up.
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const cliSource = readFileSync(join(root, 'electron/services/cliCommands.ts'), 'utf8')
const registrySource = readFileSync(join(root, 'electron/services/weportCommands.ts'), 'utf8')

/** Command entries as written in the source: `name:` followed by a quoted id. */
function declaredCommands(source: string): string[] {
  return Array.from(source.matchAll(/^\s{6}name: '([a-z][\w.]*)',$/gm)).map((match) => match[1])
}

const names = declaredCommands(cliSource)

describe('CLI command surface', () => {
  it('declares its commands', () => {
    expect(names.length).toBeGreaterThanOrEqual(20)
  })

  it('keeps command names unique', () => {
    const duplicates = names.filter((name, index) => names.indexOf(name) !== index)
    expect(duplicates).toEqual([])
  })

  it('namespaces every name so the manifest stays readable', () => {
    const unnamespaced = names.filter((name) => !name.includes('.'))
    expect(unnamespaced).toEqual([])
  })

  it('marks the commands that write as mutating', () => {
    // A command that changes Weport state or a third-party account must say so: the TUI
    // uses this flag to confirm, and an unmarked write would run on a stray Enter.
    for (const command of ['config.set', 'connectors.addTask', 'connectors.connect', 'ai.setup', 'weclone.chat']) {
      const block = cliSource.slice(cliSource.indexOf(`name: '${command}'`))
      const spec = block.slice(0, block.indexOf('run:'))
      expect(spec, `${command} should be marked mutating`).toContain('mutating: true')
    }
  })

  it('never hands a credential back to the caller', () => {
    // `connectors.connect` receives a token; echoing it onto a terminal or into an agent
    // transcript is the one mistake in this file that cannot be undone.
    const connectBlock = cliSource.slice(cliSource.indexOf("name: 'connectors.connect'"))
    const body = connectBlock.slice(0, connectBlock.indexOf("name: 'connectors.list'"))
    expect(body).not.toContain('token:')
    expect(body).toContain('credentialHint')
  })

  it('registers via the shared dispatcher rather than its own registry', () => {
    expect(cliSource).toContain('registerCommands')
    // The CLI host must reach commands through the registry; a second dispatch path is how
    // the terminal and the GUI drift apart.
    expect(registrySource).toContain('export async function runCommand')
    expect(registrySource).toContain('getCommandRegistry')
  })
})

describe('TUI engine discovery', () => {
  const tuiSource = readFileSync(join(root, 'packages/weport-tui/src/app.ts'), 'utf8')

  it('reports a missing engine instead of guessing one', () => {
    // Spawning the wrong Electron binary fails inside the WCDB host, where the error reads
    // like a database fault; a clear "use --exe" beats a plausible wrong answer.
    expect(tuiSource).toContain('找不到 Weport 引擎')
    expect(tuiSource).toContain('--exe')
  })

  it('covers every platform install location', () => {
    expect(tuiSource).toContain("'Programs'")
    expect(tuiSource).toContain('Weport.app/Contents/MacOS/Weport')
    expect(tuiSource).toContain("'/opt/Weport/weport'")
  })
})

describe('WeClone voice corpus builder', () => {
  const builderPath = join(root, 'scripts/build-weclone-voice.mjs')

  it('exists and reads the real message store', () => {
    expect(existsSync(builderPath)).toBe(true)
    const source = readFileSync(builderPath, 'utf8')
    // The corpus must come from the engine's message stream, not from a previous clone's
    // chunks — that reuse is exactly the defect this builder was written to remove.
    expect(source).toContain('messages.list')
    expect(source).toContain('sessions.jsonl')
  })

  it('keeps only the user own utterances', () => {
    const source = readFileSync(builderPath, 'utf8')
    expect(source).toContain("message.from === 'me'")
    // Media/XML/system lines must be filtered before they reach a voice sheet.
    expect(source).toContain('isUsable')
  })
})
