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

describe('WeClone 命令面', () => {
  /**
   * WeClone 的命令面必须跟得上功能的扩张（v1.0.1）。
   *
   * 这一版给克隆加了两个用户可调开关：生成时要不要脱敏、每个克隆的敏感话题策略。
   * 只在界面上开放它们，等于脚本与 TUI 永远够不到 —— 而「终端里也能干同样的事」
   * 正是这一层存在的理由。用源级断言钉住命令与参数的存在，比等运行时发现便宜。
   */
  it('weclone.generate 暴露 redact 参数（与界面同一个开关）', () => {
    const block = cliSource.slice(cliSource.indexOf("name: 'weclone.generate'"))
    const argsBlock = block.slice(0, block.indexOf('run:'))
    expect(argsBlock).toContain("name: 'redact'")
    expect(block).toContain('weCloneService.generateClone(undefined, undefined, { redact })')
  })

  it('weclone.settings 可以读也可以写每个克隆的敏感话题策略', () => {
    expect(declaredCommands(cliSource)).toContain('weclone.settings')
    const block = cliSource.slice(cliSource.indexOf("name: 'weclone.settings'"))
    expect(block).toContain("name: 'refusal'")
    expect(block).toContain('weCloneService.getSettings')
    expect(block).toContain('weCloneService.setSettings')
    // 只接受这两个值：别的字符串必须被拒绝，而不是被静默当成默认值
    expect(block).toContain("mode !== 'character' && mode !== 'off'")
  })

  it('weclone.clones 报告每个克隆的策略（脚本要能看见"它会不会答敏感问题"）', () => {
    const block = cliSource.slice(cliSource.indexOf("name: 'weclone.clones'"))
    expect(block).toContain('refusal: weCloneService.getSettings(c.id).settings?.refusal')
  })

  it('生成结果带上生成深度（段数 / token / 耗时 / 是否脱敏）', () => {
    const block = cliSource.slice(cliSource.indexOf("name: 'weclone.generate'"))
    for (const field of ['shardCount', 'shardFailures', 'tokensIn', 'tokensOut', 'elapsedMs', 'redacted']) {
      expect(block, field).toContain(field)
    }
  })})

