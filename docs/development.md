# 开发与测试

[返回 README](../README.md)


环境要求：Node 24 LTS（当前 Electron / Vite 依赖要求至少 Node 22.12）。Windows / macOS 均可开发与构建（构建需在对应平台上进行）。

```sh
npm install                       # 安装依赖（Windows 额外同步运行时 DLL）
npm run dev                       # 开发模式（vite + electron）
npm run typecheck                 # 渲染进程 + 主进程类型检查
npm run build                     # 按当前平台构建安装包（Mac: arm64 DMG + ZIP）
npm run build:flash               # Windows: 构建 WeportFlash 便携导出工具
npm run build:dir                 # 当前平台免安装构建（Mac 同样编译 helper、校验原生库）
npm run build:mac                 # macOS: 构建 DMG + ZIP（arm64）
powershell -ExecutionPolicy Bypass -File scripts/capture-ui.ps1   # Windows UI 冒烟测试（自动截屏 + 内容断言）
powershell -ExecutionPolicy Bypass -File scripts/capture-ui.ps1 -PublishToDocs   # 生成并发布 README 截图
```

### Apple Silicon macOS 本机构建

需要 macOS 15+、Apple Silicon 和 Xcode Command Line Tools（`xcode-select --install`）。

```sh
npm ci
npm run typecheck
npm run build
open release/mac-arm64/Weport.app
```

`npm run build` 和 `npm run build:mac` 使用同一流程：从源码编译图片密钥 helper、恢复原生 helper 的执行权限、校验 WCDB/WASM，再构建并 ad-hoc 签名。`npm run build:dir` 也执行这些准备步骤，只跳过 DMG/ZIP 生成。输出位于 `release/`，无需 Rosetta。Intel Mac 会在构建开始前报错。

打包后的签名与合成数据验收：

```sh
bash scripts/verify-mac-pack.sh release
node scripts/verify-mac-positive-native.mjs release
```

签名验收需要完整构建生成的 ZIP。合成数据验收使用独立配置，不读取个人微信记录。真实微信连接步骤和系统权限说明见[安装说明](platform-installation.md)。

`capture-ui.ps1` 使用私有配置与演示数据，离屏截取全部页面、设置分类及通知弹窗，并逐一断言非空。`node scripts/verify-v12-ui.mjs` 另行验证打包后的 XLSX/WASM、搜索定位、阅读器、海报导出及后台任务提示。检查包括：

- 横向不溢出、左侧栏标签不隐藏（1000/1080/1440 DIP 视口）；
- WeBot 任务卡片与编辑器的实测宽度/列数（防止「列表被挤成 300px、标题每行一两个字」这类回归）；
- WeportAI 三栏在窄窗口下中间一栏不低于 300px；
- **屏幕上不出现 `undefined` / `NaN` / `[object Object]`** —— 页面渲染成功、非空白，却把 `undefined` 写给用户看，是断言抓不到的一类缺陷。

该模式**全部使用脱敏演示数据**（假路径、假密钥、演示账号），不会把真实个人信息截进 README；`-PublishToDocs` 会把截图发布到 `docs/screenshots/`。调试 AI 页面时可用 `WEPORT_TRACE_AI=1` 把渲染进程实际发出的 `ai:*` 调用打到 stdout。

v0.9 的端到端 QA 使用 `WEPORT_V09_DUMP=1` 模式：以脱敏演示数据驱动真实页面渲染（朋友圈 / 分析入口 / 全局分析 / 年度报告 / 群聊分析 / 成员画像），逐页断言关键 DOM 节点与渲染进程 console 错误数，结果写入 `WEPORT_V09_DUMP_OUT` 目录（JSON + 日志），失败退出码非 0：

```sh
$env:WEPORT_V09_DUMP = '1'
$env:WEPORT_V09_DUMP_OUT = "$env:TEMP\v09-dump"
.\release\win-unpacked\Weport.exe   # 全部断言通过时退出码 0
```

### 架构速览

| 目录 | 说明 |
|------|------|
| `electron/appMain.ts` | 主进程：窗口、托盘、IPC、更新、导出、通知管线、朋友圈/分析/年度报告 IPC、QA 截图与 v0.9 转储模式 |
| `electron/services/` | 引擎（WeFlow WCDB 栈的 TypeScript 移植）：会话、WCDB、密钥、导出、推送、朋友圈（`snsService.ts`）、全局分析（`analyticsService.ts`）、群聊分析（`groupAnalyticsService.ts`）、年度报告（`annualReportService.ts` + `annualReportWorker.ts`）、媒体解密（`isaac64.ts` / `wasmService.ts`） |
| `electron/services/weportAiService.ts` | WeportAI：agent 循环、工具调用、记忆/笔记工作区、脱敏日志 |
| `electron/wcdbHost.ts` | WCDB 宿主子进程（`WeFlow[.exe] --wcdb-host` 硬链接运行，IPC 通信） |
| `electron/windows/notificationWindow.ts` | 通知弹窗（Windows 液态玻璃 / 跨平台 Chromium 桌面流回退） |
| `src/pages/SnsPage.tsx` + `src/components/sns/` | 朋友圈界面：时间线、媒体网格、预览灯箱、作者动态、导出对话框 |
| `src/pages/analytics/` | 分析界面：入口选择（全局/群聊）、全局统计、群聊分析、年度报告（ECharts 双主题：浅蓝 / 黑白） |
| `src/` | React 渲染层（主界面 + 通知窗口 + WeportAI 面板） |
| `resources/` | 各平台原生库：`wcdb` / `key` / `wedecrypt` / `welive` / `runtime`（win32 + macos） |
