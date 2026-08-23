# weclone-server

Weport v0.9.10 **WeClone 人格克隆** 的服务端：极简内存（稳态 <100 MB）、Fastify 4、
Node 18+、**零 native 依赖**，一键部署到 Railway。仅暴露 WeClone 聊天 API ——
不含 Weport 本地的 WCDB / httpService(5031) / mcpService(5032) 能力。

> 设计文档：`docs/v0.9.10-weclone-design.md` §3/§4/§7

## 功能

- `POST /api/weclone/upload` — 接收客户端脱敏后的 MD 知识库 + 消息分块（Bearer ownerToken）
- `POST /api/weclone/:id/chat` — 克隆对话：BM25 检索 top-K 片段 → LLM 流式代理（SSE）
- 可见性管理：`private` / `public` / `link`（16-hex secret）
- 服务端 PII 二次复核：身份证 / 手机号 / 银行卡(Luhn) / 密码 / 住址 / 精确位置
  命中计数 > `WECLONE_PII_MAX_HITS`（默认 5）→ 400 拒绝；未超阈值就地脱敏入库
- 存储：**纯 JSON 文件**（`data/meta.json`，原子写 tmp+rename，无 better-sqlite3 ——
  避免 native 编译卡构建 + 降低常驻内存）+ 文件系统 blobs（`chunks.jsonl` 流式读写 +
  `mds/*.md`）
- 未配置 LLM key 时自动进入 mock 模式：回显消息并加前缀 `[Mock WeClone] `（联调用）
- 内置静态 Web 前端（`web/` → `public/`）：公开克隆浏览 + SSE 流式聊天 + 分享链接说明

## 快速开始（本地）

```sh
cd weclone-server
npm install
npm run build
WECLONE_LLM_API_KEY=sk-xxx npm start        # 默认 http://0.0.0.0:8080
# 未配置 key 时为 mock 模式（联调 SSE 用），会打印告警
```

开发模式：`npm run dev`（ts-node）。灌入演示数据：先启动服务，再 `npm run seed`。

## Web 前端（静态站）

`web/` 是一个小型 Vite + React SPA（浏览公开克隆 / 聊天 / 分享链接说明），构建产物
直接输出到 `../public`，由 Fastify（`@fastify/static`）托管并带 SPA fallback
（非 `/api` 的 GET 一律回退 `index.html`，见 `src/server.ts`）：

```sh
cd weclone-server/web
npm install
npm run build     # 写入 ../public（清空重建，替换占位 index.html）
```

- 开发热更：`cd web && npm run dev`（`/api` 已代理到 `http://localhost:8080`）
- 未构建时 `public/index.html` 为占位页（提示构建命令 + 健康状态）
- Railway/Docker 部署无需本地预构建：Dockerfile 的 `web-build` stage
  （node:22）会在镜像构建时自动执行上述命令，并把产物 `COPY` 进运行层；
  本地 `public/` 仅作开发占位

> 注意：本目录刻意不提交 `package-lock.json`（依赖极少且全为纯 JS，安装秒级完成）。
> 如需锁定版本，本地 `npm install --package-lock-only` 后提交即可。

## Railway 一键部署（Dockerfile，推荐）

[![Deploy on Railway](https://railway.app/button.svg)](https://railway.app/template/github/Weport/weport)

> 按钮为占位模板链接；发布正式 Railway Template 后把链接换成
> `https://railway.app/template/<template-code>` 即可。部署时按提示设置
> `WECLONE_*` 环境变量（必填只有 `WECLONE_LLM_API_KEY`，其余均有默认值）。

### 简单流程（三步）

1. **Deploy to Railway（一键）** → 点上方按钮创建服务，构建由本目录
   `railway.json`（builder = DOCKERFILE）+ `Dockerfile` 完成，Healthcheck 走
   `/health`。从模板创建服务时，在 Settings → Networking 里把公网域名设为
   **`weport.up.railway.app`**（Railway 生成服务时会分配 `<name>.up.railway.app`
   子域，手动改成 weport 即可），得到服务地址 `https://weport.up.railway.app`。
   建议挂一个 Volume 到 `/data`（或设 `WECLONE_DATA_DIR` 指向卷路径），重启不丢数据。
2. **Weport App 人格克隆 → 私有服务器**：填入服务器 URL
   （`https://weport.up.railway.app`）→ 填入 OpenCode Go API Key
   （模型固定 `muse-spark-1.2-contributor`）→ 点「保存并测试」。
3. **新建分身 → 一键生成**：Agent 完成后进入「管理分身」，选择可见性
   （私密 / 公开 / 链接）；选「链接」即获得分享链接，浏览器打开即可与分身对话。

### 部署细节

- 服务新建后 Railway 自动注入 `PORT`，容器内 `EXPOSE 8080` 仅为文档默认值，
  `HEALTHCHECK` 与应用均按 `$PORT` 监听。
- `railway.json` 已声明：`builder: DOCKERFILE`、`healthcheckPath: /health`
  （超时 100s）、`restartPolicyType: ON_FAILURE`（最多重试 3 次）、单副本。
  不需要再放 `railway.toml`（两者同时存在只会造成重复配置）。
- 若临时禁用 Dockerfile builder，Railway 会读取本目录 `nixpacks.toml`
  （Node 18 + `npm install` + `npm run build` + `node dist/server.js`），行为一致。

### 环境变量

| 变量 | 默认 | 说明 |
|------|------|------|
| `PORT` | `8080` | Railway 自动注入 |
| `WECLONE_DATA_DIR` | `./data` | 元数据 + blobs 持久化目录（Railway 上指向 Volume） |
| `WECLONE_LLM_BASE_URL` | `https://opencode.ai/zen/go/v1` | OpenAI 兼容上游（OpenCode Go 订阅网关，自建网关才覆盖） |
| `WECLONE_LLM_API_KEY` | — | 服务端 LLM key（客户端永不传 key；空 = mock 模式） |
| `WECLONE_LLM_MODEL` | `muse-spark-1.2-contributor` | |
| `WECLONE_LLM_MAX_TOKENS` | `1024` | 单次回复上限 |
| `WECLONE_MAX_UPLOAD_MB` | `25` | 上传请求体上限 |
| `WECLONE_MAX_BLOB_MB` | `20` | 单 clone 序列化 chunks 上限 |
| `WECLONE_MAX_CLONES_PER_TOKEN` | `5` | 每 owner token 配额 |
| `WECLONE_RATE_LIMIT_CHAT` | `20` | chat 次/分钟/IP |
| `WECLONE_RATE_LIMIT_UPLOAD` | `5` | upload 次/小时/IP |
| `WECLONE_PII_MAX_HITS` | `5` | 服务端严重 PII 命中阈值（超过 400 拒绝） |
| `CORS_ALLOW_ORIGINS` | `*` | 生产可收敛为逗号分隔白名单 |

## API 摘要

| Method | Path | 鉴权 | 说明 |
|--------|------|------|------|
| GET | `/health` | 无 | `{ok, mem, version, uptime, store, llm}` |
| POST | `/api/weclone/upload` | Bearer | `{meta, mds, chunks, visibility}` → `{id, secret?, visibility}` |
| GET | `/api/weclone/list` | Bearer | 自己的克隆 |
| GET | `/api/weclone/public?q=&limit=&offset=` | 无 | 公开克隆（≤50） |
| GET | `/api/weclone/:id` | Bearer 或 `?secret=` | 元数据 + mds |
| DELETE | `/api/weclone/:id` | Bearer owner | 删除即焚毁（blob 目录 rm + meta 删行） |
| PATCH | `/api/weclone/:id/visibility` | Bearer owner | `{visibility}` → `{shareUrl?}` |
| POST | `/api/weclone/:id/chat` | public 匿名 / link secret / private owner | SSE 或 `?stream=false` |

Chat SSE 协议：

```
event: delta
data: {"delta":"你好"}

event: done
data: [DONE]
```

ownerToken 由 **Weport 客户端**生成并保存（electron-store + safeStorage）；服务端只存
SHA-256 哈希。上传 body 为 JSON（≤27MB）；客户端可自行 gzip（需带 `Content-Encoding`，
当前默认直传 JSON）。

## 内存预算

```
Node 18 + Fastify            ~30–40 MB
meta.json 内存缓存            ~1–2 MB（仅元数据 + mds 正文）
BM25 LRU（≤5 clone 索引）     ~2–10 MB（单索引 ≤20k docs / 1M chars 正文护栏）
单请求流式扫描                ~2–4 MB
稳态 RSS                     ≈40–60 MB（NODE_OPTIONS=--max-old-space-size=256 兜底）
```

## 与 electron 侧的同步约定

以下文件是 electron 侧对应模块的**服务端副本**，修改必须双向同步：

- `src/prompts.ts` ←→ `electron/services/weClonePrompts.ts`（`WECLONE_CHAT_SYSTEM_PROMPT` 逐字一致）
- `src/utils/pii.ts` ←→ `electron/services/weClonePiiFilter.ts`（规则表逐条一致）

## 与 weport 主构建的隔离

本目录完全独立于 Electron 构建：根 `package.json` 的 `build.files` 白名单不包含
`weclone-server/`，两个 tsconfig 也均不引用它；依赖安装在本目录内完成，
不会进入 electron-builder 产物。
