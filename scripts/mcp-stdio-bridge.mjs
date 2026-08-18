#!/usr/bin/env node
/**
 * Weport MCP stdio 桥接（v0.9.7）
 *
 * 供仅支持 stdio 的 AI 宿主（Claude Desktop 等）接入 Weport 的本地
 * MCP 服务（Streamable HTTP）。桥接进程是独立 Node 进程：
 *
 *   stdio (AI 宿主) ←→ 本进程（SDK Server/Client） ←→ http://127.0.0.1:5032/mcp
 *
 * 用法：
 *   node mcp-stdio-bridge.cjs --port 5032 [--token <token>] [--url <mcp-url>]
 *
 * 开发环境直接运行 scripts/mcp-stdio-bridge.mjs；打包后运行
 * resources/mcp/mcp-stdio-bridge.cjs（esbuild 单文件产物，含 SDK 依赖，
 * 任意 Node ≥ 18 可运行，无需 NODE_PATH）。
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { z } from 'zod'

function parseArgs(argv) {
  const out = { port: 5032, token: '', url: '' }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--port' && argv[i + 1]) out.port = Number(argv[i + 1])
    else if (arg === '--token' && argv[i + 1]) out.token = String(argv[i + 1])
    else if (arg === '--url' && argv[i + 1]) out.url = String(argv[i + 1])
    else if (arg.startsWith('--port=')) out.port = Number(arg.split('=')[1])
    else if (arg.startsWith('--token=')) out.token = String(arg.split('=')[1])
    else if (arg.startsWith('--url=')) out.url = String(arg.split('=')[1])
  }
  return out
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const mcpUrl = args.url || `http://127.0.0.1:${args.port}/mcp`

  const headers = {}
  if (args.token) headers.Authorization = `Bearer ${args.token}`

  const client = new Client({ name: 'weport-mcp-bridge', version: '0.9.7' }, { capabilities: {} })
  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL(mcpUrl), { requestInit: { headers } }),
    )
  } catch (e) {
    console.error(`[weport-mcp-bridge] 无法连接 Weport MCP 服务 (${mcpUrl})：${e?.message || e}`)
    process.exit(1)
  }

  const server = new Server(
    { name: 'weport-mcp-bridge', version: '0.9.7' },
    { capabilities: { tools: {} } },
  )

  // Protocol.request 必须携带 resultSchema（无默认值，缺省会在响应校验时
  // 崩溃）。桥接转发任意方法的响应，用宽松 schema 原样透传。
  const passthroughSchema = z.any()

  server.fallbackRequestHandler = async (request) => {
    try {
      return await client.request(request, passthroughSchema)
    } catch (e) {
      console.error(`[weport-mcp-bridge] 转发失败 (${request.method})：${e?.message || e}`)
      throw e
    }
  }
  server.fallbackNotificationHandler = async (notification) => {
    await client.notification(notification)
  }
  server.onclose = async () => {
    try { await client.close() } catch { /* noop */ }
  }

  await server.connect(new StdioServerTransport())
  console.error(`[weport-mcp-bridge] 已连接 ${mcpUrl}，等待 AI 宿主…`)
}

main().catch((e) => {
  console.error(`[weport-mcp-bridge] 启动失败：${e?.stack || e}`)
  process.exit(1)
})
