/**
 * Weport CLI command surface — the single dispatcher behind every non-UI entry point.
 *
 * The TUI (`weport` in a terminal) is a separate process that talks to a headless
 * Weport over JSON-RPC, so the interesting work lives here rather than in the
 * renderer. Keeping one dispatcher means the terminal and the GUI cannot drift:
 * both go through the same services, and a command's validation happens once.
 *
 * Commands are read-only unless explicitly marked, and the few that mutate Weport
 * state are listed under `mutating` so the TUI can confirm them before running.
 */

export interface CommandContext {
  /** How the caller reached us: the GUI (`ipc`), the terminal (`cli`), or an agent. */
  origin: 'ipc' | 'cli' | 'agent'
}

export interface CommandResult {
  success: boolean
  data?: unknown
  error?: string
  /** Rendered by the TUI when it wants a line rather than JSON. */
  text?: string
}

export interface CommandSpec {
  name: string
  summary: string
  /** Mutates Weport state or a third-party account; the TUI confirms these. */
  mutating: boolean
  /** JSON-schema-ish hint for the TUI's argument prompt. */
  args?: Array<{ name: string; type: 'string' | 'number' | 'boolean'; required?: boolean; description?: string }>
  run: (args: Record<string, unknown>, ctx: CommandContext) => Promise<CommandResult> | CommandResult
}

type Registry = Map<string, CommandSpec>

let registry: Registry | null = null

/**
 * Built lazily: the registry closes over services that only exist after
 * `startApp` has wired them up, and importing them eagerly at module scope would
 * create a cycle back into `appMain`.
 */
export function getCommandRegistry(): Registry {
  if (registry) return registry
  registry = new Map()
  return registry
}

export function registerCommands(entries: CommandSpec[]): void {
  const map = getCommandRegistry()
  for (const entry of entries) map.set(entry.name, entry)
}

/** Command list for the TUI's help pane and for `weport commands --json`. */
export function listCommands(): Array<Omit<CommandSpec, 'run'>> {
  return Array.from(getCommandRegistry().values())
    .map(({ run: _run, ...rest }) => rest)
    .sort((a, b) => a.name.localeCompare(b.name))
}

export async function runCommand(name: string, args: Record<string, unknown>, ctx: CommandContext): Promise<CommandResult> {
  const spec = getCommandRegistry().get(String(name || '').trim())
  if (!spec) return { success: false, error: `未知命令：${name}` }
  try {
    return await spec.run(args || {}, ctx)
  } catch (error) {
    return { success: false, error: String((error as Error)?.message || error) }
  }
}
