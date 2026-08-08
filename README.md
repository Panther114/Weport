<p align="center">
  <img src="assets/icons/icon.png" width="120" alt="Weport" />
</p>

<h1 align="center">Weport</h1>

<p align="center">
  <b>轻量、本地化的微信聊天记录导出工具（Windows）</b><br />
  一键导出全部私聊与群聊，支持 10 种格式，含新消息弹窗提醒与防撤回
</p>

<p align="center">
  <img src="https://img.shields.io/badge/license-MIT-green" alt="MIT License" />
  <img src="https://img.shields.io/badge/platform-Windows-blue" alt="Windows" />
  <img src="https://img.shields.io/badge/WeChat-4.x-brightgreen" alt="WeChat 4.x" />
</p>

---

## ✨ 这是什么？

Weport 是一款 Windows 桌面应用，直接读取本机**微信 4.x** 的聊天数据，把全部联系人、群聊记录导出为文件，方便你备份、检索、迁移或做分析。

- 🔒 **完全本地运行** — 数据不出本机，不上传任何内容
- 📦 **一键导出** — 全部私聊 + 群聊，不用逐个选择
- 🎨 **10 种格式** — TXT / JSON / HTML / XLSX / Markdown / ChatLab / SQL / CSV 等
- 🔔 **消息提醒** — 独立置顶弹窗，新消息与撤回即时通知（可按会话过滤）
- 🛡️ **防撤回** — 会话级 WCDB 触发器，撤回的消息在微信本地仍然可见
- 🚀 **托盘常驻** — 开机自启、静默启动、关闭最小化到托盘

## 📸 截图

**导出数据** —— 格式、目录结构、媒体与高级选项一目了然：

![导出数据页](docs/screenshots/export.png)

**通知弹窗** —— 液态玻璃风格，置顶显示、不抢焦点：

![通知弹窗](docs/screenshots/popup.png)

## 🚀 快速开始

1. 从 [Releases](https://github.com/Panther114/Weport/releases) 下载最新安装包并安装
2. 打开 Weport，在「连接微信」页选择数据目录（自动检测 `xwechat_files` 文件夹）
3. 按页面提示**获取解密密钥**（见下方说明）
4. 切到「导出数据」页，选择格式与输出文件夹，点击**导出全部聊天记录**

### 🔑 获取解密密钥（重要）

密钥在**微信登录的瞬间**被捕获，无法从已登录的会话中直接读取：

1. 打开微信电脑版，在「设置 → 通用」里**关闭「自动登录」**，然后退出当前登录
2. 点击 Weport 中的**「提取密钥」**，等待出现「已准备就绪」提示
3. 用手机**扫码登录微信** —— 登录成功的瞬间密钥会自动捕获并填入
4. 也可以手动粘贴已有的 64 位十六进制密钥

## 📦 导出格式

| 格式 | 说明 |
|------|------|
| TXT / JSON | 纯文本与完整消息详情，通用格式 |
| HTML | 网页格式，浏览器直接打开浏览 |
| XLSX | 电子表格，适合统计分析 |
| Markdown | 支持文本、图片与链接，适合 AI 场景 |
| ChatLab / JSONL / Arkme JSON | 标准聊天格式，可导入其他软件 |
| WeClone CSV | WeClone 兼容字段 |
| PostgreSQL SQL | 数据库脚本，便于导入数据库 |

支持按会话分目录 / 按类型分目录两种组织方式，媒体文件（图片、视频、语音、表情包、文件）可选导出。

## 🛠️ 开发

环境要求：Node 20+，Windows。

```sh
npm install                       # 安装依赖 + 同步运行时 DLL
npm run dev                       # 开发模式（vite + electron）
npm run typecheck                 # 渲染进程 + 主进程类型检查
npm run build                     # 构建 NSIS 安装包（release/ 目录）
npm run build:dir                 # 免安装构建（迭代更快）
powershell -ExecutionPolicy Bypass -File scripts/capture-ui.ps1   # UI 冒烟测试
```

### 架构速览

| 目录 | 说明 |
|------|------|
| `electron/appMain.ts` | 主进程：窗口、托盘、IPC、更新、导出、通知管线 |
| `electron/services/` | 引擎（WeFlow WCDB 栈的 TypeScript 移植）：会话、WCDB、密钥、导出、推送 |
| `electron/wcdbHost.ts` | WCDB 宿主子进程（以 `WeFlow.exe --wcdb-host` 运行，IPC 通信） |
| `electron/windows/notificationWindow.ts` | 液态玻璃通知弹窗 |
| `src/` | React 渲染层（主界面 + 通知窗口） |
| `resources/` | 原生 DLL：`wcdb` / `key` / `wedecrypt` / `runtime` |

## 🧭 行为约定

- 关闭窗口默认**最小化到托盘**，从托盘菜单「退出」才会完全退出
- 开机自启支持**静默启动**（`--background`，不显示主窗口）
- 通知弹窗为独立置顶窗口，不抢占焦点；点击弹窗可唤出主窗口
- 数据目录与密钥保存在本机，重启后自动恢复

## 🔐 隐私

所有处理都在本机完成。应用只读取你指定的微信数据目录，并在提取密钥时挂接微信进程捕获登录密钥；不会向任何服务器上传聊天内容。

## ⚠️ 免责声明

本工具仅供**个人学习与本地数据归档**使用。使用前请遵守微信《软件许可及服务协议》及所在国家/地区的法律法规，且仅允许处理**本人账号**的本地数据。因不当使用（包括但不限于侵犯他人隐私、违反微信服务条款、用于商业用途等）造成的一切后果由使用者自行承担，作者不对任何滥用行为负责。

## 📄 License

[MIT](./LICENSE) — 自由使用、修改与分发。
