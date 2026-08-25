# WeClone 服务端部署指南（Railway）

> 目标：把 **WeClone 克隆分享服务**（`weclone-server/`）部署到 Railway，
> 得到 `https://weport.up.railway.app`，让桌面端可以把人格克隆上传上去、
> 生成公开浏览页与分享链接。
>
> ⚠️ 这个服务 **不是** Weport 桌面应用本身 —— Railway 上只跑
> `weclone-server`（Fastify API + 静态站，<100MB 内存）。Weport 桌面端照常
> 跑在你自己的电脑上。

---

## 0. 部署入口（重要，别踩坑）

Railway 构建以 **GitHub 仓库根目录** 为上下文。本仓库根目录已经放好：

- `Dockerfile` — 只构建 `weclone-server`（三阶段：server 编译 → web SPA 构建 → 运行层）
- `railway.json` — 强制 `builder: DOCKERFILE`、健康检查 `/health`

**不需要任何手动配置构建方式。** 如果你的 Railway 服务之前部署失败过
（所有路由返回 Weport HTML 或 404），那是旧配置的缓存 —— 直接删掉旧服务
重新部署一次即可。

## 1. 创建服务（Dashboard 流程）

1. 登录 [railway.com](https://railway.com) → **New Project** →
   **Deploy from GitHub repo** → 选择 `Panther114/Weport`（如未授权先
   Configure GitHub App 授权仓库）。
2. 如果弹出选择对话框，选分支 `main`；Railway 检测到根 `railway.json`
   会自动用 **Dockerfile** 构建（构建日志里能看到三个 stage：
   `build` / `web-build` / 运行层，全程约 2–4 分钟）。
3. 首次部署可能因缺环境变量进入 mock 模式 —— 不影响构建和健康检查，
   第 2 步补上 key 后会自动生效。

## 2. 设置 LLM Key（唯一必填变量）

服务端需要一个 OpenAI 兼容的 LLM key 来驱动克隆对话（客户端**不会**上传
自己的 key）。默认对接 OpenCode Go 订阅网关：

1. 打开服务 → **Variables** → 添加：

   | 变量 | 值 |
   |------|------|
   | `WECLONE_LLM_API_KEY` | 你的 OpenCode Go API Key（`sk-` 开头） |

2. 可选覆盖（一般不用动）：

   | 变量 | 默认 | 说明 |
   |------|------|------|
   | `WECLONE_LLM_MODEL` | `muse-spark-1.2-contributor` | 首选模型 |
   | `WECLONE_LLM_FALLBACK_MODELS` | `glm-5,minimax-m2.5,deepseek-v4-flash` | 首选模型网关 500/404 时依次降级 |
   | `WECLONE_LLM_BASE_URL` | `https://opencode.ai/zen/go/v1` | 自建网关才改 |

   > **模型降级链是自动的**：首选模型如果像 2026-08 的
   > `muse-spark-1.2-contributor` 一样整段返回 `Internal server error`(500)，
   > 服务会按顺序换备选模型重试并记住可用的那个，无需人工干预。

3. 改完变量 Railway 会自动重新部署。

> 不配 key 服务也能跑：进入 mock 模式（回复带 `[Mock WeClone]` 前缀），
> 用于验证部署链路。

## 3. 绑定域名 `weport.up.railway.app`（必须）

Weport 客户端把服务地址**硬编码**为 `https://weport.up.railway.app`，
域名必须一字不差：

1. 打开服务 → **Settings → Networking** → **Generate Domain**（或 Public
   Networking 里修改已有域名）。
2. 把子域改成 **`weport`**，得到 `weport.up.railway.app` 并保存。
   - 如果提示子域被占用：说明你（或同账号其他项目）的旧服务占着它，
     先去旧服务的 Settings 删除该域名，再回来生成。
3. Railway 免费档会定期休眠；休眠后首次请求会有几十秒冷启动，属正常现象。

## 4. 挂载持久卷（推荐）

不挂卷的话，重新部署后已上传的克隆会丢：

1. 服务右键 → **Attach Volume**（或 New → Volume → Attach 到本服务）。
2. 挂载点填 **`/data`**（镜像里已设 `WECLONE_DATA_DIR=/data`，无需再加变量）。

## 5. 验证部署

浏览器打开：

```
https://weport.up.railway.app/health
```

期望返回（关键字段）：

```json
{
  "ok": true,
  "version": "0.9.10",
  "llm": "configured",          // "mock" = 第 2 步的 key 没配上
  "llmModels": ["muse-spark-1.2-contributor", "glm-5", "..."]
}
```

再打开首页 `https://weport.up.railway.app/` 应该看到「WeClone · 人格克隆」
静态站（不是 Weport 主应用的界面）。

## 6. 回到 Weport 桌面端：上传克隆 + 分享

前提：已在「新建分身」里用同一枚 OpenCode Go API Key 生成了本地克隆。

1. Weport → 人格克隆 → **新建分身** → 「生成服务配置」区点 **保存并测试**，
   状态应显示 ● 在线（顶部工具栏的 `weport.up.railway.app · 在线` 小灯也会变绿）。
2. 进 **管理分身**，在还没上传过的克隆卡片上点 **上传到服务器**
   （ownerToken 首次上传时自动生成并加密保存，无需手填）。
3. 卡片上切换可见性：
   - `PUBLIC` — 出现在网站公开列表，任何人可聊；
   - `LINK` — 生成 `https://weport.up.railway.app/share/<id>?secret=<16hex>`
     分享链接，仅持有链接者可聊；
   - `PRIVATE` — 只有你自己（客户端 ownerToken）能聊。
4. 浏览器打开分享链接即可与克隆对话（SSE 流式回复）。

## 故障排查

| 症状 | 原因 / 处理 |
|------|-------------|
| 所有路径 404（包括 `/health`） | 域名没有绑到这个服务（第 3 步），或服务被删除/休眠后域名悬空 |
| `/api/weclone/*` 返回 HTML（`<!doctype…`） | 构建用了 nixpacks + 根 package.json（Electron 应用）——确认部署用的是最新 main 分支（根 `railway.json` 存在），删掉旧服务重deploy |
| `/health` 里 `"llm":"mock"` | `WECLONE_LLM_API_KEY` 未设置或没触发重新部署 |
| 聊天返回 `LLM upstream unavailable` / 502 | 网关 key 失效或所有候选模型都不可用 —— 查看 Railway Deploy Logs 里 `[llm/proxy] model … failed` 行确认每个模型的 HTTP 状态 |
| 上传报 `missing bearer token` | 客户端版本过旧 —— 更新到带 ownerToken 自动生成的版本 |
| 上传报 `severe PII detected …` | 服务端 PII 复核命中超过阈值（默认 5）；这是隐私保护，正常现象 |
| 冷启动慢 | Railway 免费档休眠后的首次请求，等 30–60 秒 |

## 本地跑一份（可选）

```sh
cd weclone-server
npm install
npm run build
set WECLONE_LLM_API_KEY=sk-xxx      # PowerShell: $env:WECLONE_LLM_API_KEY='sk-xxx'
npm start                            # http://0.0.0.0:8080
node scripts/verify-e2e.mjs          # 端到端回归（含模型降级链模拟）
```
