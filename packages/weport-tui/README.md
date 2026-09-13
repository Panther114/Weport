# Weport TUI (`weport`)

Weport 的终端界面。装完之后在终端里敲 `weport`，就能用 CLI 执行 Weport 的全部功能
（浏览朋友圈图片除外——终端里没法好好看图）。

```
weport                        # 打开完整 TUI
weport sessions.list limit=20 # 单条命令，输出 JSON
weport --help
```

## 架构

TUI 不是把界面代码搬进终端，而是**复用主进程的服务层**：

```
weport (包)  ──spawn──▶  Weport.exe --cli  ──▶  electron/services/*  ──▶  WCDB 宿主
   │  终端渲染                    │  JSON-RPC over Node IPC
   └── 命令面命令 ────────────────┘
```

- `Weport.exe --cli` 是同一个应用，只是不建窗口、不建托盘，把命令注册表接到 stdio 上
  （`electron/services/weportCommands.ts` + `cliCommands.ts`，`appMain.ts::runCliHost`）。
- 终端进程通过 **Node IPC channel** 通信，不用管道 JSON：Windows 上 Electron 主进程的
  stdin 会立刻 EOF（见仓库根目录 `AGENTS.md`），只有 IPC 稳定。
- 握手用一次性令牌（`--weport-token`）。任何命令都走和 GUI 相同的 service 层，
  所以终端和界面永远不会对"Weport 能做什么"产生分歧。

## 命令

命令面 `cli.commands` 是唯一真源；TUI 的帮助页直接渲染它。

| 分组 | 命令 |
| --- | --- |
| 会话 | `sessions.list` `messages.list` `contacts.info` `groups.members` |
| 内容 | `sns.timeline` `analytics.overview` `analytics.rankings` `analytics.group` |
| 连接器 | `connectors.list` `connectors.targets` `connectors.addTask` |
| AI | `ai.status` `ai.chats` `ai.ask` |
| 配置 | `config.get` `config.set` |
| 诊断 | `cli.ping` `cli.commands` |

写入类命令（`config.set` / `connectors.addTask` / `ai.ask`）在 TUI 里会先确认，
在命令行里则以 `weport <命令> …` 直接执行。

## 按键

| 键 | 作用 |
| --- | --- |
| `↑` `↓` / `j` `k` | 在当前列表里移动 |
| `Enter` | 打开 / 运行选中项 |
| `←` `→` / `h` `l` | 切换左侧分类 |
| `/` | 过滤当前列表 |
| `:` | 命令面板 |
| `Esc` | 返回上一层 |
| `Ctrl+L` | 查看引擎日志 |
| `q` / `Ctrl+C` | 退出 |

## 开发

```sh
# 1) 构建 TUI 包（TypeScript → dist）
cd packages/weport-tui && npm run build

# 2) 指向开发版应用
node packages/weport-tui/bin/weport.mjs --exe release/win-unpacked/Weport.exe

# 3) 无终端环境下的渲染验证（把每个界面渲染成文本帧）
node packages/weport-tui/bin/weport.mjs --dump %TEMP%\weport-tui-dump --width 140
node scripts/qa-tui.mjs                 # 断言帧尺寸 / 非空 / 侧栏 / 关键内容
node scripts/verify-tui-engine.mjs      # 断言握手与真实数据命令
```

`--dump` 是终端界面的"截图"：没有它就无法在 CI 或远程检查里验证布局，所以它和
命令面一起被视为产品的一部分，而不是调试残留。
