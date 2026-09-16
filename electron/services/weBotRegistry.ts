import type { WeBotService } from './weBotService'

/**
 * WeBot 服务的单例注册表。
 *
 * 为什么需要它：`httpService` / `mcpService` 要把 WeBot 的数据对外暴露，
 * 但它们由 `appMain` 在启动时构造，而 WeBot 服务本身依赖 `appMain` 里的
 * agent 派发函数。让它们互相 import 会形成环。
 *
 * 这里只放一个引用，类型用 `import type`（编译后不留运行时依赖），
 * 因此依赖方向始终是单向的：appMain → registry ← httpService/mcpService。
 *
 * 对外暴露的一律是**只读**查询：与 Weport 既有的 13 个 MCP 工具口径一致，
 * 不提供创建任务或触发运行的能力。
 */
let instance: WeBotService | null = null

export function setWeBotService(service: WeBotService | null): void {
  instance = service
}

export function getWeBotService(): WeBotService | null {
  return instance
}
