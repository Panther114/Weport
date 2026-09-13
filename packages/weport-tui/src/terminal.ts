/**
 * Terminal primitives.
 *
 * Written by hand rather than pulled from a TUI framework: the whole surface this
 * tool needs is "draw a frame, read a key, ask one question", and a dependency-free
 * implementation keeps `npx weport` instant and installable on a machine that has
 * nothing but Node. It also means the alternate-screen/restore behaviour is
 * explicit — a TUI that leaves a terminal in raw mode is worse than no TUI.
 */

export const ESC = '\u001B'
export const CSI = `${ESC}[`

/** ANSI helpers. Colour is opt-out via NO_COLOR and opt-in only on a TTY. */
export class Paint {
  constructor(private readonly enabled: boolean) {}

  private wrap(code: string, text: string): string {
    return this.enabled ? `${CSI}${code}m${text}${CSI}0m` : text
  }

  bold(text: string) { return this.wrap('1', text) }
  dim(text: string) { return this.wrap('2', text) }
  italic(text: string) { return this.wrap('3', text) }
  underline(text: string) { return this.wrap('4', text) }
  inverse(text: string) { return this.wrap('7', text) }

  rgb(r: number, g: number, b: number, text: string) {
    return this.enabled ? `${CSI}38;2;${r};${g};${b}m${text}${CSI}0m` : text
  }

  /** Weport's accent (light blue) — the TUI keeps the same identity as the app. */
  accent(text: string) { return this.rgb(96, 168, 255, text) }
  ok(text: string) { return this.rgb(120, 210, 140, text) }
  warn(text: string) { return this.rgb(240, 200, 110, text) }
  danger(text: string) { return this.rgb(240, 120, 120, text) }
  muted(text: string) { return this.enabled ? `${CSI}38;5;245m${text}${CSI}0m` : text }
}

export function colourEnabled(): boolean {
  if (process.env.NO_COLOR) return false
  if (process.env.FORCE_COLOR) return true
  return Boolean(process.stdout.isTTY)
}

/** Visible width: CJK glyphs occupy two columns, so padding needs this, not `.length`. */
export function displayWidth(text: string): number {
  let width = 0
  for (const char of text) {
    const code = char.codePointAt(0) || 0
    if (code === 0x200b || code === 0xfe0f) continue
    const wide =
      (code >= 0x1100 && code <= 0x115f) ||
      (code >= 0x2e80 && code <= 0xa4cf) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe30 && code <= 0xfe6f) ||
      (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6) ||
      (code >= 0x1f300 && code <= 0x1f9ff)
    width += wide ? 2 : 1
  }
  return width
}

export function truncate(text: string, width: number): string {
  if (width <= 0) return ''
  let out = ''
  let used = 0
  for (const char of text) {
    const charWidth = displayWidth(char)
    if (used + charWidth > width) return `${out}${used + 1 <= width ? '…' : ''}`
    out += char
    used += charWidth
  }
  return out
}

export function padEnd(text: string, width: number): string {
  const current = displayWidth(text)
  return current >= width ? truncate(text, width) : text + ' '.repeat(width - current)
}

export function padStart(text: string, width: number): string {
  const current = displayWidth(text)
  return current >= width ? truncate(text, width) : ' '.repeat(width - current) + text
}

/** Strip ANSI so a styled line can be measured/padded correctly. */
export function stripAnsi(text: string): string {
  return text.replace(new RegExp(`${ESC}\\[[0-9;]*m`, 'g'), '')
}

export function wrapText(text: string, width: number): string[] {
  if (width <= 2) return [text]
  const lines: string[] = []
  for (const paragraph of String(text).split(/\r?\n/)) {
    if (displayWidth(paragraph) <= width) {
      lines.push(paragraph)
      continue
    }
    let current = ''
    let used = 0
    for (const char of paragraph) {
      const charWidth = displayWidth(char)
      if (used + charWidth > width) {
        lines.push(current)
        current = ''
        used = 0
      }
      current += char
      used += charWidth
    }
    lines.push(current)
  }
  return lines
}

export interface TerminalSession {
  width: number
  height: number
  restore: () => void
  onKey: (handler: (key: KeyEvent) => void) => () => void
  onResize: (handler: () => void) => void
}

export interface KeyEvent {
  name: string
  ctrl: boolean
  alt: boolean
  shift: boolean
  /** Printable input when the key is a character. */
  input: string
}

/** Put the terminal into the alternate screen with raw input and hide the cursor. */
export function enterTerminal(): TerminalSession {
  const out = process.stdout
  const input = process.stdin
  out.write(`${CSI}?1049h${CSI}?25l${CSI}2J${CSI}H`)
  if (input.isTTY) input.setRawMode(true)
  input.resume()
  input.setEncoding('utf8')

  const restore = () => {
    try { if (input.isTTY) input.setRawMode(false) } catch { /* ignore */ }
    out.write(`${CSI}?25h${CSI}?1049l`)
  }

  const session: TerminalSession = {
    width: out.columns || 100,
    height: out.rows || 32,
    restore: () => undefined,
    onKey: () => () => undefined,
    onResize: () => undefined,
  }

  const keyHandlers: Array<(key: KeyEvent) => void> = []
  const resizeHandlers: Array<() => void> = []

  input.on('data', (chunk: string) => {
    for (const key of decodeKeys(chunk)) for (const handler of [...keyHandlers]) handler(key)
  })
  out.on('resize', () => {
    session.width = out.columns || session.width
    session.height = out.rows || session.height
    for (const handler of resizeHandlers) handler()
  })

  session.onKey = (handler) => {
    keyHandlers.push(handler)
    return () => {
      const index = keyHandlers.indexOf(handler)
      if (index >= 0) keyHandlers.splice(index, 1)
    }
  }
  session.onResize = (handler) => { resizeHandlers.push(handler) }
  session.restore = () => {
    restore()
    input.pause()
  }
  return session
}

/** Decode one read chunk into key events (escape sequences included). */
function decodeKeys(chunk: string): KeyEvent[] {
  const keys: KeyEvent[] = []
  let index = 0
  while (index < chunk.length) {
    const char = chunk[index]
    if (char === ESC) {
      // Arrow keys / navigation arrive as CSI sequences; an isolated ESC is "back".
      const rest = chunk.slice(index, index + 6)
      if (rest.startsWith(`${CSI}A`)) { keys.push({ name: 'up', ctrl: false, alt: false, shift: false, input: '' }); index += 3; continue }
      if (rest.startsWith(`${CSI}B`)) { keys.push({ name: 'down', ctrl: false, alt: false, shift: false, input: '' }); index += 3; continue }
      if (rest.startsWith(`${CSI}C`)) { keys.push({ name: 'right', ctrl: false, alt: false, shift: false, input: '' }); index += 3; continue }
      if (rest.startsWith(`${CSI}D`)) { keys.push({ name: 'left', ctrl: false, alt: false, shift: false, input: '' }); index += 3; continue }
      if (rest.startsWith(`${CSI}5~`)) { keys.push({ name: 'pageup', ctrl: false, alt: false, shift: false, input: '' }); index += 4; continue }
      if (rest.startsWith(`${CSI}6~`)) { keys.push({ name: 'pagedown', ctrl: false, alt: false, shift: false, input: '' }); index += 4; continue }
      if (rest.startsWith(`${CSI}H`)) { keys.push({ name: 'home', ctrl: false, alt: false, shift: false, input: '' }); index += 3; continue }
      if (rest.startsWith(`${CSI}F`)) { keys.push({ name: 'end', ctrl: false, alt: false, shift: false, input: '' }); index += 3; continue }
      keys.push({ name: 'escape', ctrl: false, alt: false, shift: false, input: '' })
      index += 1
      continue
    }
    const code = char.codePointAt(0) || 0
    if (code === 13) { keys.push({ name: 'enter', ctrl: false, alt: false, shift: false, input: '' }); index += 1; continue }
    if (code === 10) { keys.push({ name: 'enter', ctrl: false, alt: false, shift: false, input: '' }); index += 1; continue }
    if (code === 127 || code === 8) { keys.push({ name: 'backspace', ctrl: false, alt: false, shift: false, input: '' }); index += 1; continue }
    if (code === 9) { keys.push({ name: 'tab', ctrl: false, alt: false, shift: false, input: '' }); index += 1; continue }
    if (code === 3) { keys.push({ name: 'c', ctrl: true, alt: false, shift: false, input: 'c' }); index += 1; continue }
    if (code < 32) {
      const letter = String.fromCharCode(code + 96)
      keys.push({ name: letter, ctrl: true, alt: false, shift: false, input: letter })
      index += char.length
      continue
    }
    keys.push({ name: char, ctrl: false, alt: false, shift: false, input: char })
    index += char.length
  }
  return keys
}

/** Compose one full frame, padded to the exact terminal size. */
export function composeFrame(lines: string[], width: number, height: number): string {
  const visible = lines.slice(0, height).map((line) => {
    const padding = width - displayWidth(stripAnsi(line))
    return padding > 0 ? `${line}${' '.repeat(padding)}` : truncate(line, width)
  })
  while (visible.length < height) visible.push(' '.repeat(width))
  // Home + clear-to-end-of-screen per line avoids a full clear flash on every frame.
  return `${CSI}H${visible.map((line) => `${line}${CSI}K`).join('\r\n')}`
}

/** Single-line question prompt (used for command arguments and confirmations). */
export function askLine(session: TerminalSession, question: string, paint: Paint): Promise<string> {
  return new Promise((resolve) => {
    let value = ''
    const render = () => {
      const line = `${paint.accent('?')} ${question} ${paint.bold(value)}${CSI}K`
      process.stdout.write(`${CSI}${session.height};0H${line}`)
    }
    render()
    const off = session.onKey((key) => {
      if (key.name === 'enter') { off(); resolve(value); return }
      if (key.name === 'escape') { off(); resolve(''); return }
      if (key.name === 'backspace') value = value.slice(0, -1)
      else if (key.input && !key.ctrl) value += key.input
      render()
    })
  })
}
