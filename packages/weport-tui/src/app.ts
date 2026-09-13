/**
 * The Weport TUI.
 *
 * Structure: one long-lived render loop, one `Engine` connection, and a small
 * navigation stack (`route`) where the first entry picks the view and the rest are
 * that view's arguments (a session id, a chat id, …). Everything the UI shows comes
 * from the engine's command surface, so the terminal and the GUI can never disagree
 * about what Weport can do — adding a command to the main process makes it
 * available here through the command palette without touching this file.
 *
 * Keyboard model (kept deliberately close to the GUI):
 *   ↑/↓ or j/k    move in the current list          Enter  open / run
 *   ←/→ or h/l    previous / next section           Esc    back
 *   /             filter the current list (sessions)
 *   :             command palette
 *   r             refresh         q / Ctrl-C  quit
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { Paint, askLine, colourEnabled, composeFrame, enterTerminal, padEnd, stripAnsi, truncate, wrapText, type TerminalSession } from './terminal.js'
import { WeportEngine, type EngineInfo } from './engine.js'
import { bullets, formatCount, formatRelative, formatTime, keyValue, renderTable, section, statCards, type Column } from './render.js'


interface SessionRow { id: string; name: string; type: string; lastAt: number; messageCount: number }
interface MessageRow { id: string; at: number; from: string; sender: string; type: number; text: string }
interface ViewState {
  title: string
  hint: string
  /** Lines already rendered for the content pane. */
  lines: string[]
  /** Rows selectable with ↑/↓. */
  rows: Array<{ key: string; label: string }>
  loading: boolean
  error?: string
}

const SECTIONS: Array<{ id: string; label: string; keys: string; summary: string }> = [
  { id: 'overview', label: '总览', keys: '1', summary: '账号、数据库与连接状态' },
  { id: 'sessions', label: '会话', keys: '2', summary: '浏览聊天记录（列表 → 消息）' },
  { id: 'messages', label: '消息', keys: '3', summary: '当前会话的完整消息流' },
  { id: 'moments', label: '朋友圈', keys: '4', summary: '朋友圈时间线' },
  { id: 'analytics', label: '分析', keys: '5', summary: '全局统计与联系排行' },
  { id: 'weportai', label: 'WeportAI', keys: '6', summary: '服务状态、会话与提问' },
  { id: 'connectors', label: '连接器', keys: '7', summary: 'Todoist 等第三方工具' },
  { id: 'settings', label: '设置', keys: '8', summary: '配置项读写' },
  { id: 'help', label: '帮助', keys: '9', summary: '快捷键与全部命令' },
]

export interface TuiOptions {
  /** Explicit engine binary (defaults to the packaged app next to this package). */
  exe?: string
  cwd?: string
  /** When set, render one frame per section into this directory and exit. */
  dumpDir?: string
  dumpWidth?: number
  dumpHeight?: number
  /** Also render the messages view for this session id. */
  dumpSession?: string
}

/**
 * Locate the Weport executable.
 *
 * The TUI ships on its own (npm) while the engine is the desktop app, so the search
 * has to cover both the repository layout and every place an install can land. The
 * order is "most specific first": an explicit flag, then an env override, then the
 * packaged side-by-side layout, then a development checkout, then the per-platform
 * install locations. A miss is reported rather than guessed at, because spawning the
 * wrong Electron binary produces a confusing failure deep inside the WCDB host.
 */
export function resolveEngineExe(options: TuiOptions): string | null {
  const win = process.platform === 'win32'
  const localAppData = process.env.LOCALAPPDATA || ''
  const candidates = [
    options.exe,
    process.env.WEPORT_ENGINE,
    // Packaged next to the TUI (a bundled distribution can ship both).
    join(dirname(process.execPath), '..', 'cli', win ? 'weport.exe' : 'weport'),
    // Development checkout: release/win-unpacked/Weport.exe.
    join(process.cwd(), 'release', win ? 'win-unpacked/Weport.exe' : 'mac-arm64/Weport.app/Contents/MacOS/Weport'),
    win ? join(localAppData, 'Programs', 'Weport', 'Weport.exe') : null,
    win ? join(process.env.ProgramFiles || 'C:\\Program Files', 'Weport', 'Weport.exe') : null,
    '/Applications/Weport.app/Contents/MacOS/Weport',
    '/usr/lib/weport/weport',
    '/opt/Weport/weport',
    '/usr/local/bin/weport-app',
  ].filter(Boolean) as string[]
  for (const candidate of candidates) if (existsSync(candidate)) return candidate
  return null
}

export async function runTui(options: TuiOptions = {}): Promise<number> {
  const exe = resolveEngineExe(options)
  if (!exe) {
    process.stderr.write(
      '找不到 Weport 引擎。请安装 Weport 桌面版，或用 --exe 指定 Weport 可执行文件路径：\n' +
        '  weport --exe "D:\\path\\to\\Weport.exe"\n',
    )
    return 2
  }

  const paint = new Paint(colourEnabled())
  // `--dump` renders frames to files instead of a terminal, so the QA harness can
  // inspect the TUI's layout on a machine with no interactive console attached.
  const dumpDir = options.dumpDir || ''
  const session = dumpDir ? null : enterTerminal()
  const engine = new WeportEngine(exe, options.cwd)

  const logs: string[] = []
  engine.onLog = (line) => {
    logs.push(line)
    if (logs.length > 400) logs.shift()
    if (session && showLogs) draw()
  }
  engine.onExit = () => {
    logs.push('引擎已退出')
    if (session) draw()
  }

  let info: EngineInfo | null = null
  let fatal: string | null = null
  let route: string[] = ['overview']
  let cursor = 0
  let filter = ''
  let showLogs = false
  let busy = '正在连接 Weport 引擎…'
  let view: ViewState = { title: '总览', hint: '', lines: [], rows: [], loading: true }
  let sessions: SessionRow[] = []
  let messages: MessageRow[] = []
  let statusLine = ''
  let exiting = false

  const sectionId = () => route[0] || 'overview'

  /** Non-null terminal session: the `--dump` path returns before anything asks for it. */
  const tty = (): TerminalSession => {
    if (!session) throw new Error('没有终端会话：--dump 模式不应渲染交互界面')
    return session
  }

  /**
   * Render one complete frame. Split out from `draw()` so the QA harness can render
   * a real frame at a fixed size with no terminal attached (`--dump`), which is the
   * only way to look at the TUI's layout from outside a terminal.
   */
  function renderFrame(width: number, height: number): string {
    const sidebarWidth = Math.min(24, Math.max(16, Math.floor(width * 0.22)))
    const contentWidth = width - sidebarWidth - 3
    const bodyHeight = height - 4

    const header = ` ${paint.bold(paint.accent('Weport'))} ${paint.muted('v' + (info?.version || '…'))} ${
      info ? paint.ok('● 已连接') : fatal ? paint.danger('● 未连接') : paint.warn('● 连接中')
    }`
    const logoLine = `${padEnd(header, width - 1)}`

    const left = SECTIONS.map((entry) => {
      const active = entry.id === sectionId()
      // Pad to the sidebar width first, then add the marker: measuring the marker
      // glyph itself made the active row one column wider than the rest.
      const text = padEnd(`  ${entry.keys} ${entry.label}`, sidebarWidth - 1)
      return active ? paint.inverse(`▍${stripAnsi(text)}`) : padEnd(` ${text}`, sidebarWidth)
    })
    if (info?.dbPath) {
      left.push('')
      left.push(padEnd(paint.muted('数据目录'), sidebarWidth))
      for (const line of wrapText(info.dbPath, sidebarWidth - 1)) left.push(padEnd(paint.muted(line), sidebarWidth))
    }

    const content = renderContent(contentWidth)
    const body: string[] = []
    for (let index = 0; index < bodyHeight; index += 1) {
      const leftLine = left[index] || ''
      const rightLine = content[index] || ''
      body.push(`${padEnd(leftLine, sidebarWidth)} ${rightLine}`)
    }

    return composeFrame([logoLine, ...body, renderFooter(width)], width, height)
  }

  function draw(): void {
    process.stdout.write(renderFrame(tty().width, tty().height))
  }

  function renderContent(width: number): string[] {
    if (fatal) {
      return [
        '',
        paint.danger('无法连接 Weport 引擎'),
        '',
        ...wrapText(fatal, width - 4).map((line) => `  ${line}`),
        '',
        paint.muted(`引擎路径：${exe}`),
        paint.muted('请确认已安装 Weport 桌面版，或使用 --exe 指定可执行文件。'),
      ]
    }
    if (busy && view.loading) {
      return ['', `  ${paint.accent('◐')} ${busy}`]
    }
    const head = [`${paint.bold(view.title)} ${paint.muted(view.hint)}`, '']
    const lines = view.error ? ['', `  ${paint.danger('!')} ${view.error}`, ''] : view.lines
    return [...head, ...lines]
  }

  function renderFooter(width: number): string {
    if (statusLine) return `${paint.accent('»')} ${truncate(statusLine, width - 3)}`
    const hints = showLogs
      ? 'Ctrl+L 返回界面 · q 退出'
      : `${filter ? `/ 过滤: ${filter} · ` : ''}↑↓ 选择 · Enter 打开 · : 命令 · Ctrl+L 日志 · q 退出`
    return paint.muted(truncate(hints, width - 1))
  }

  // ---------------------------------------------------------------------------
  // Data loading
  // ---------------------------------------------------------------------------

  async function call<T>(command: string, args: Record<string, unknown> = {}): Promise<T> {
    const result = await engine.call(command, args)
    if (!result.success) throw new Error(result.error || `${command} 执行失败`)
    return result.data as T
  }

  /**
   * Load one section's data into a fresh `ViewState`.
   *
   * Pure with respect to the screen: it returns the state instead of mutating the
   * live one, so the same code serves the interactive loop and the `--dump` harness
   * (whose whole point is to render sections nobody has navigated to).
   */
  async function loadView(target: string, width: number): Promise<ViewState> {
    const next: ViewState = { title: '', hint: '', lines: [], rows: [], loading: true }
    try {
      switch (target) {
        case 'overview': {
          const [ping, stats] = await Promise.all([
            call<{ version: string; dbPath: string; myWxid: string; hasKey: boolean }>('cli.ping'),
            call<Record<string, unknown>>('analytics.overview').catch(() => null),
          ])
          const statistic = (stats || {}) as Record<string, unknown>
          next.title = '总览'
          next.hint = '账号、数据库与运行状态'
          next.rows = []
          const cards = [
            { label: '会话总数', value: formatCount(Number(statistic.totalSessions || 0)) },
            { label: '消息总数', value: formatCount(Number(statistic.totalMessages || 0)) },
            { label: '联系人', value: formatCount(Number(statistic.totalContacts || 0)) },
            { label: '活跃天数', value: formatCount(Number(statistic.activeDays || 0)) },
          ]
          next.lines = [
            ...statCards(cards, width, paint),
            '',
            section('环境', paint),
            ...keyValue(
              [
                ['版本', ping.version],
                ['账号', ping.myWxid || paint.warn('未配置')],
                ['数据库', ping.dbPath || paint.warn('未配置')],
                ['解密密钥', ping.hasKey ? paint.ok('已保存') : paint.warn('未保存')],
              ],
              paint,
            ),
          ]
          if (!ping.dbPath) {
            next.lines.push('', ...bullets(['尚未连接微信数据目录：请先在桌面版「连接微信」里完成配置。'], width, paint))
          }
          break
        }
        case 'sessions': {
          sessions = await call<SessionRow[]>('sessions.list', { limit: 300 })
          const keyword = filter.toLowerCase()
          const rows = keyword
            ? sessions.filter((row) => `${row.name} ${row.id}`.toLowerCase().includes(keyword))
            : sessions
          next.title = '会话'
          next.hint = `共 ${sessions.length} 个${keyword ? ` · 过滤「${filter}」命中 ${rows.length} 个` : ''}`
          next.rows = rows.map((row) => ({ key: row.id, label: row.name }))
          const columns: Column<SessionRow>[] = [
            { title: '会话', max: 40, value: (row) => row.name, styled: (row, p) => p.bold(row.name) },
            { title: '类型', width: 6, value: (row) => ({ group: '群聊', private: '私聊', official: '公众号' }[row.type] || row.type) },
            { title: '消息', width: 8, align: 'right', value: (row) => formatCount(row.messageCount) },
            { title: '最后活跃', width: 12, align: 'right', value: (row) => formatRelative(row.lastAt) },
          ]
          next.lines = renderTable(rows, columns, width, paint)
          break
        }
        case 'messages': {
          const sessionId = route[1]
          if (!sessionId) {
            next.title = '消息'
            next.hint = '请先选择一个会话'
            next.rows = []
            next.lines = ['', paint.muted('在「会话」里按 Enter 打开一个聊天。')]
            break
          }
          const name = sessions.find((row) => row.id === sessionId)?.name || sessionId
          messages = await call<MessageRow[]>('messages.list', { session: sessionId, limit: 200 })
          next.title = `消息 · ${name}`
          next.hint = `最近 ${messages.length} 条`
          next.rows = messages.map((row, index) => ({ key: row.id || String(index), label: `${row.sender} ${row.text.slice(0, 20)}` }))
          next.lines = messages
            .slice()
            .reverse()
            .map((row) => {
              const who = row.from === 'me' ? paint.accent('我') : paint.bold(row.sender || '对方')
              const time = paint.muted(formatTime(row.at))
              const text = row.text.replace(/\s*\n\s*/g, ' ⏎ ')
              const head = `${time} ${who}`
              const body = wrapText(text, Math.max(20, width - 16))
              if (body.length === 1) return `${head}  ${body[0]}`
              return [head, ...body.map((line) => `                ${line}`)].join('\n')
            })
            .flatMap((entry) => entry.split('\n'))
          break
        }
        case 'moments': {
          const posts = await call<Array<Record<string, unknown>>>('sns.timeline', { limit: 40 })
          next.title = '朋友圈'
          next.hint = `最近 ${posts.length} 条`
          next.rows = posts.map((post, index) => ({ key: String(post.id || index), label: String(post.authorName || post.author || '') }))
          next.lines = posts.length === 0
            ? ['', paint.muted('没有读到朋友圈内容（可能尚未启用或没有数据）。')]
            : posts.flatMap((post) => {
                const author = String(post.authorName || post.author || '未知')
                const when = formatTime(Number(post.createTime || post.timestamp || 0))
                const body = String(post.content || '').replace(/\s*\n\s*/g, ' ')
                const head = `${paint.bold(author)} ${paint.muted(when)}`
                const likes = Array.isArray(post.likes) ? (post.likes as unknown[]).length : 0
                const comments = Array.isArray(post.comments) ? (post.comments as unknown[]).length : 0
                const meta = likes + comments > 0 ? paint.muted(`  ♥ ${likes}  💬 ${comments}`) : ''
                return [head, ...wrapText(body, width - 4).map((line) => `  ${line}`), `  ${meta}`, '']
              })
          break
        }
        case 'analytics': {
          const [stats, rankings] = await Promise.all([
            call<Record<string, unknown>>('analytics.overview'),
            call<Array<Record<string, unknown>>>('analytics.rankings', { limit: 20 }),
          ])
          next.title = '分析'
          next.hint = '全局统计与联系人排行'
          next.rows = rankings.map((row) => ({ key: String(row.username || row.name || ''), label: String(row.name || '') }))
          const cards = [
            { label: '消息总数', value: formatCount(Number(stats.totalMessages || 0)) },
            { label: '会话总数', value: formatCount(Number(stats.totalSessions || 0)) },
            { label: '活跃天数', value: formatCount(Number(stats.activeDays || 0)) },
          ]
          next.lines = [
            ...statCards(cards, width, paint),
            '',
            section('消息最多的联系人', paint),
            ...renderTable(
              rankings,
              [
                { title: '#', width: 4, value: (row) => String(rankings.indexOf(row) + 1) },
                { title: '联系人', max: 30, value: (row) => String(row.name || row.username || '') },
                { title: '消息', width: 10, align: 'right', value: (row) => formatCount(Number(row.messageCount || row.count || 0)) },
              ],
              width,
              paint,
            ),
          ]
          break
        }
        case 'weportai': {
          const status = await call<{ active: { name: string; model: string } | null; profiles: unknown[]; assignments: Array<{ consumer: string; profileName: string; model: string; followsDefault?: boolean }> }>('ai.status')
          const chats = await call<Array<{ id: string; title: string; createdAt?: number; updatedAt?: number }>>('ai.chats')
          next.title = 'WeportAI'
          next.hint = '服务状态与会话'
          next.rows = chats.map((chat) => ({ key: chat.id, label: chat.title }))
          next.lines = [
            section('当前服务', paint),
            ...keyValue(
              [
                ['服务', status.active ? status.active.name : paint.warn('未配置')],
                ['模型', status.active ? status.active.model : '—'],
              ],
              paint,
            ),
            '',
            section('功能面分配', paint),
            ...status.assignments.map((entry) =>
              `${padEnd(entry.consumer, 10)} ${entry.profileName || paint.muted('跟随默认')} ${paint.muted(entry.model || '')}`,
            ),
            '',
            section('最近会话', paint),
            ...renderTable(
              chats,
              [
                { title: '标题', max: 36, value: (chat) => chat.title },
                { title: '创建', width: 12, align: 'right', value: (chat) => formatRelative(chat.createdAt ? chat.createdAt / 1000 : 0) },
                { title: '更新', width: 12, align: 'right', value: (chat) => formatRelative(chat.updatedAt ? chat.updatedAt / 1000 : 0) },
              ],
              width,
              paint,
            ),
            '',
            paint.muted('按 a 对当前会话提问；Enter 打开会话并显示最后一条回答。'),
          ]
          break
        }
        case 'connectors': {
          const list = await call<Array<{ id: string; descriptor: { name: string; description: string; capabilities: { read: boolean; write: boolean } }; connected: boolean; credentialHint?: string; lastCheck?: { ok: boolean; error?: string } }>>('connectors.list')
          next.title = '连接器'
          next.hint = '第三方工具'
          next.rows = list.map((entry) => ({ key: entry.id, label: entry.descriptor.name }))
          next.lines = list.flatMap((entry) => {
            const state = entry.connected
              ? entry.lastCheck?.ok === false
                ? paint.danger('令牌失效')
                : paint.ok(`已连接 ${entry.credentialHint || ''}`)
              : paint.warn('未连接')
            return [
              `${paint.bold(entry.descriptor.name)}  ${state}`,
              ...wrapText(entry.descriptor.description, width - 4).map((line) => `  ${paint.muted(line)}`),
              `  ${paint.muted(`读 ${entry.descriptor.capabilities.read ? '✓' : '✗'} · 写 ${entry.descriptor.capabilities.write ? '✓' : '✗'}`)}`,
              '',
            ]
          })
          next.lines.push(paint.muted('按 t 查看可写入目标；按 n 新建待办；在桌面版设置里可粘贴/更换令牌。'))
          break
        }
        case 'settings': {
          const values = await call<Record<string, unknown>>('config.get', {})
          next.title = '设置'
          next.hint = '配置读写'
          next.rows = Object.keys(values).map((key) => ({ key, label: key }))
          next.lines = [
            ...keyValue(Object.entries(values).map(([key, value]) => [key, String(value ?? '')] as [string, string]), paint),
            '',
            paint.muted('按 Enter 编辑选中项；也可以直接 `weport config.set <key> <value>`。'),
          ]
          break
        }
        case 'help': {
          const commands = await call<Array<{ name: string; summary: string; mutating: boolean }>>('cli.commands')
          next.title = '帮助'
          next.hint = `${commands.length} 个命令`
          next.rows = commands.map((command) => ({ key: command.name, label: command.name }))
          next.lines = [
            section('按键', paint),
            ...keyValue(
              [
                ['↑ ↓ / j k', '在当前列表里移动'],
                ['Enter', '打开 / 运行选中项'],
                ['← → / h l', '切换左侧分类'],
                ['/', '过滤（会话列表）'],
                [':', '命令面板'],
                ['Esc', '返回上一层'],
                ['Ctrl+L', '查看引擎日志'],
                ['q / Ctrl+C', '退出'],
              ],
              paint,
            ),
            '',
            section(`全部命令（${commands.length}）`, paint),
            ...renderTable(
              commands,
              [
                { title: '命令', max: 30, value: (command) => command.name, styled: (command, p) => p.bold(command.name) },
                { title: '写', width: 3, value: (command) => (command.mutating ? '✎' : '') },
                { title: '说明', max: 60, value: (command) => command.summary },
              ],
              width,
              paint,
            ),
          ]
          break
        }
        default:
          next.lines = [paint.muted('未知分类')]
      }
    } catch (error) {
      next.error = String((error as Error)?.message || error)
      next.lines = []
      next.rows = []
    } finally {
      next.loading = false
    }
    return next
  }

  // ---------------------------------------------------------------------------
  // Interaction
  // ---------------------------------------------------------------------------

  async function refresh(reload = true): Promise<void> {
    const terminal = tty()
    const width = terminal.width - Math.min(24, Math.max(16, Math.floor(terminal.width * 0.22))) - 3
    if (reload) {
      // Show a loading state immediately: the first load can take a few seconds while
      // the engine connects to the WeChat database, and a silent terminal looks hung.
      view = { title: view.title, hint: '', lines: [], rows: [], loading: true }
      draw()
      view = await loadView(sectionId(), width)
      cursor = 0
    }
    draw()
  }

  function moveCursor(delta: number): void {
    if (view.rows.length === 0) return
    cursor = (cursor + delta + view.rows.length) % view.rows.length
    draw()
  }

  function switchSection(delta: number): void {
    const index = SECTIONS.findIndex((entry) => entry.id === sectionId())
    const next = SECTIONS[(index + delta + SECTIONS.length) % SECTIONS.length]
    route = [next.id]
    filter = ''
    void refresh()
  }

  async function openSelection(): Promise<void> {
    const row = view.rows[cursor]
    if (!row) return
    if (sectionId() === 'sessions') {
      route = ['messages', row.key]
      await refresh()
      return
    }
    if (sectionId() === 'settings') {
      const value = await askLine(tty(), `${row.key} =`, paint)
      if (!value) { draw(); return }
      statusLine = `正在写入 ${row.key}…`
      draw()
      const result = await engine.call('config.set', { key: row.key, value })
      statusLine = result.success ? `已写入 ${row.key}` : `失败：${result.error}`
      await refresh()
      return
    }
    if (sectionId() === 'weportai') {
      statusLine = '正在打开会话…'
      draw()
      // `ai.chats` rows carry the chat id; showing the transcript in-terminal is a
      // read of the same persisted conversation the GUI renders.
      try {
        const chat = await call<{ messages?: Array<{ role: string; content: string }> }>('ai.getChat', {})
        void chat
        statusLine = '按 a 提问（会话内容请在桌面版查看）'
      } catch {
        statusLine = '按 a 提问'
      }
      draw()
      return
    }
    if (sectionId() === 'help') {
      statusLine = `命令：${row.key}`
      draw()
      return
    }
  }

  async function runCommandPalette(): Promise<void> {
    const commands = await call<Array<{ name: string; summary: string; mutating: boolean; args?: Array<{ name: string; required?: boolean }> }>>('cli.commands')
    const input = await askLine(tty(), '命令（Tab 补全省略）:', paint)
    if (!input.trim()) { draw(); return }
    const [name, ...rest] = input.trim().split(/\s+/)
    const spec = commands.find((command) => command.name === name)
    if (!spec) {
      statusLine = `未知命令：${name}`
      draw()
      return
    }
    const args: Record<string, unknown> = {}
    let index = 0
    for (const argument of spec.args || []) {
      const positional = rest[index]
      if (positional !== undefined) {
        args[argument.name] = positional
        index += 1
        continue
      }
      if (!argument.required) continue
      const answer = await askLine(tty(), `${argument.name}:`, paint)
      if (answer) args[argument.name] = answer
    }
    statusLine = `执行 ${spec.name}…`
    draw()
    const result = await engine.call(spec.name, args)
    statusLine = result.success ? `${spec.name} ✓` : `${spec.name} ✗ ${result.error}`
    if (result.success && result.text) statusLine = result.text.split('\n')[0]
    await refresh()
  }

  // ---------------------------------------------------------------------------
  // Boot
  // ---------------------------------------------------------------------------

  if (!session) {
    // Dump mode: no terminal, no input loop. One frame per section, written to disk.
    const dir = mkdirSync(dumpDir, { recursive: true })
    void dir
    try {
      info = await engine.start(90000)
    } catch (error) {
      fatal = String((error as Error)?.message || error)
      const width = options.dumpWidth || 120
      const height = options.dumpHeight || 34
      writeFileSync(join(dumpDir, 'fatal.txt'), stripAnsi(renderFrame(width, height)), 'utf8')
      engine.stop()
      return 1
    }
    const width = options.dumpWidth || 120
    const height = options.dumpHeight || 34
    const contentWidth = width - Math.min(24, Math.max(16, Math.floor(width * 0.22))) - 3
    const written: string[] = []
    const targets: Array<{ id: string; route: string[] }> = SECTIONS.map((entry) => ({ id: entry.id, route: [entry.id] }))
    // The messages view needs a session id, so the dump takes one explicitly —
    // otherwise the harness would never render the busiest screen in the app.
    if (options.dumpSession) targets.push({ id: 'messages-session', route: ['messages', options.dumpSession] })
    for (const target of targets) {
      route = target.route
      view = await loadView(target.route[0], contentWidth)
      writeFileSync(join(dumpDir, `${target.id}.txt`), stripAnsi(renderFrame(width, height)), 'utf8')
      written.push(`${target.id} ${view.error ? `ERROR ${view.error}` : `${view.lines.length} lines`}`)
    }
    writeFileSync(join(dumpDir, 'index.txt'), `${written.join('\n')}\n`, 'utf8')
    for (const line of written) console.log(`[tui-dump] ${line}`)
    engine.stop()
    await new Promise((resolve) => setTimeout(resolve, 400))
    return written.some((line) => line.includes('ERROR')) ? 1 : 0
  }

  draw()
  try {
    info = await engine.start()
  } catch (error) {
    fatal = String((error as Error)?.message || error)
    busy = ''
    draw()
    tty().onKey((key) => {
      if (key.name === 'q' || (key.ctrl && key.name === 'c') || key.name === 'escape') {
        engine.stop()
        session?.restore()
        process.exit(fatal ? 1 : 0)
      }
    })
    return 1
  }

  await refresh()

  // Last-resort cleanup: when stdin is not a real terminal there is no Ctrl-C key to
  // read, so the signal handler is the only way to leave the engine in a clean state.
  process.on('SIGINT', () => {
    engine.stop()
    try { tty().restore() } catch { /* no tty in dump mode */ }
    process.exit(0)
  })

  tty().onResize(() => draw())
  tty().onKey((key) => {
    void (async () => {
      if (key.ctrl && key.name === 'c') {
        if (exiting) return
        exiting = true
        engine.stop()
        tty().restore()
        process.exit(0)
      }
      if (key.ctrl && key.name === 'l') {
        showLogs = !showLogs
        view.lines = showLogs
          ? logs.slice(-(tty().height - 6)).map((line) => paint.muted(truncate(line, tty().width - 6)))
          : []
        if (!showLogs) await refresh()
        else draw()
        return
      }
      if (showLogs) return
      if (key.name === 'q' && !key.input) {
        exiting = true
        engine.stop()
        tty().restore()
        process.exit(0)
      }
      if (key.name === 'up' || key.input === 'k') moveCursor(-1)
      else if (key.name === 'down' || key.input === 'j') moveCursor(1)
      else if (key.name === 'left' || key.input === 'h') switchSection(-1)
      else if (key.name === 'right' || key.input === 'l') switchSection(1)
      else if (key.name === 'escape') {
        if (route.length > 1) {
          route = [route[0]]
          await refresh()
        }
      } else if (key.name === 'enter') await openSelection()
      else if (key.input === '/') {
        filter = await askLine(tty(), '过滤:', paint)
        await refresh()
      } else if (key.input === ':') await runCommandPalette()
      else if (key.input === 'r') await refresh()
      else if (key.input && /^[1-9]$/.test(key.input)) {
        const target = SECTIONS[Number(key.input) - 1]
        if (target) {
          route = [target.id]
          filter = ''
          await refresh()
        }
      }
    })()
  })

  // Keep the session alive; exit paths call process.exit directly.
  return new Promise<number>(() => undefined)
}