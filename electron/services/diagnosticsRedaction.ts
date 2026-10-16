import { createHash } from 'crypto'

/**
 * 诊断包的脱敏层（v1.2 §5 / D17）。
 *
 * ## 硬约束的落地方式：白名单，不是黑名单
 *
 * 需求原文是"**绝不含**解密后的密钥、库密钥、API key、令牌"。黑名单做不到这件事：
 * 漏一个键名就等于泄露一把密钥，而键名会随版本增加（今天没有 `fooToken`，明天有）。
 * 所以这里把规则反过来：
 *
 *   1. **只有 {@link CONFIG_BUNDLE_ALLOWLIST} 里列出的键**才会被写进
 *      `config.redacted.json`；凡是不在这个列表里的键，一律**整条丢弃**，
 *      只在 `redactedKeys` 里留下键名（键名本身不是秘密，且是排障需要的信息）。
 *   2. 落地的**每一个字符串值**再过一遍 {@link redactSecretsInText}：即使某个
 *      白名单键里混进了密钥（例如用户把密钥粘进了 `dbPath`），也发不出去。
 *   3. `safe:` / `lock:` 前缀的值**任何情况下都不解密**，只报计数。
 *
 * 第 1 条是"代码级保证"，单测用**夹具密钥**扫描整个 zip（含每个条目的解压内容）
 * 来钉住它：见到密钥即测试失败（见 diagnosticsService.test.ts）。
 *
 * 指纹形态 `«redacted:sha256:first8»`：同一个秘密在同一份包里得到同一个指纹，
 * 于是"两处是不是同一个值"仍可判断，但推不回原值。
 */

/**
 * **允许进诊断包的配置键白名单**。
 *
 * 收录标准只有一条：这个值能帮助定位问题，而且**永远不可能是凭据**。
 * 因此这里不出现任何 `*Key` / `*Token` / `*Password` / `*Secret` 字段，
 * 也不出现 `wxidConfigs`（里面逐账号存着库密钥）。
 *
 * 新增键必须先回答"泄露它有没有代价"；答案含糊就不要加。
 */
export const CONFIG_BUNDLE_ALLOWLIST = [
  // 环境与路径（排障必需；值仍会过一遍密钥扫描）
  'dbPath',
  'cachePath',
  'exportPath',
  'lastOpenedDb',
  'lastSession',
  'myWxid',
  // 界面与行为（无凭据）
  'theme',
  'themeId',
  'language',
  'onboardingDone',
  'logEnabled',
  'launchAtStartup',
  'silentStartup',
  'updateChannel',
  'ignoredUpdateVersion',
  // 导出与通知参数（纯数值/枚举）
  'exportFormat',
  'exportAvatars',
  'exportVoiceAsText',
  'exportConflictStrategy',
  'exportConcurrency',
  'exportDefaultConcurrency',
  'exportDefaultPathStyle',
  'exportDefaultDisplayNamePreference',
  'notificationEnabled',
  'notificationPosition',
  'notificationDuration',
  'notificationAnimationEnabled',
  'notificationAnimationStyle',
  'notificationFilterMode',
  'linuxNotificationMode',
  // 模型与 AI 运行参数（不含任何 API key —— 那些键不在白名单里）
  'whisperModelName',
  'whisperDownloadSource',
  'autoTranscribeVoice',
  'transcribeLanguages',
  'weportAiContextWindow',
] as const

const ALLOW_SET = new Set<string>(CONFIG_BUNDLE_ALLOWLIST)

/** 是否允许把该配置键写进诊断包。 */
export function isBundleAllowedConfigKey(key: string): boolean {
  return ALLOW_SET.has(String(key || ''))
}

/** `«redacted:sha256:first8»` —— 秘密的唯一允许形态。 */
export function redactionFingerprint(secret: string): string {
  const digest = createHash('sha256').update(String(secret), 'utf8').digest('hex')
  return `«redacted:sha256:${digest.slice(0, 8)}»`
}

interface SecretRule {
  id: string
  pattern: RegExp
}

/**
 * 文本级密钥形状。顺序有意义：hex 规则排在通用 base64 之前，
 * 否则 64 位 hex 会被 base64 规则先吃掉（同长度同字符集，结果一样但指纹来源不同）。
 *
 * 每条都要求**足够长的连续体**，避免把普通路径、时间戳、UUID 误伤 ——
 * 误伤会让诊断包变得没用，漏判会让密钥泄露；两边都不可接受，所以要精确。
 */
const SECRET_RULES: SecretRule[] = [
  // 库密钥：64 位 hex（32 字节）；key+salt：96 / 128 位 hex
  { id: 'hex-key-salt-128', pattern: /\b[0-9a-fA-F]{128}\b/g },
  { id: 'hex-key-salt-96', pattern: /\b[0-9a-fA-F]{96}\b/g },
  { id: 'hex-key-64', pattern: /\b[0-9a-fA-F]{64}\b/g },
  // safeStorage / 锁定模式的密文：前缀 + base64
  { id: 'safe-blob', pattern: /(?:safe|lock):[A-Za-z0-9+/=]{16,}/g },
  // 常见服务商令牌
  { id: 'sk-token', pattern: /\bsk-[A-Za-z0-9_-]{16,}/g },
  { id: 'github-token', pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}/g },
  { id: 'slack-token', pattern: /\bxox[abposr]-[A-Za-z0-9-]{10,}/g },
  { id: 'aws-key', pattern: /\bAKIA[0-9A-Z]{16}\b/g },
  // JWT：三段点分 base64url
  { id: 'jwt', pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/g },
  // HTTP 头形态
  { id: 'bearer', pattern: /\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*/gi },
  // 通用：≥40 字符的连续 base64（覆盖各种自定义 token；路径里不会出现这种串）
  { id: 'base64-blob', pattern: /\b[A-Za-z0-9+/]{40,}={0,2}/g },
]

/** 命中的秘密规则 id（供单测与排障；不含命中内容）。 */
export function secretRuleIdsIn(text: string): string[] {
  const hits: string[] = []
  for (const rule of SECRET_RULES) {
    rule.pattern.lastIndex = 0
    if (rule.pattern.test(String(text ?? ''))) hits.push(rule.id)
  }
  return hits
}

/**
 * 把文本里所有密钥形状替换成 `«redacted:sha256:first8»`。
 *
 * 逐字符扫描 + 单遍替换：每条规则各自 `replace`，但每条都在**同一份已替换过的
 * 文本**上继续，因此不会出现"替换出来的 sha256 十六进制又被下一条规则命中"。
 * （`«redacted:sha256:ab12cd34»` 里没有 64 位连续 hex，也不会被 base64 规则吃，
 * 因为 `«»` 与 `:` 都不在 base64 字母表内。）
 */
export function redactSecretsInText(text: string): string {
  let out = String(text ?? '')
  for (const rule of SECRET_RULES) {
    rule.pattern.lastIndex = 0
    out = out.replace(rule.pattern, (match) => redactionFingerprint(match))
  }
  return out
}

/** 深度脱敏任意 JSON 值（对象键名不动，只处理字符串叶子）。 */
export function redactSecretsDeep<T>(value: T): T {
  if (typeof value === 'string') return redactSecretsInText(value) as unknown as T
  if (Array.isArray(value)) return value.map((item) => redactSecretsDeep(item)) as unknown as T
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = redactSecretsDeep(item)
    }
    return out as unknown as T
  }
  return value
}

export interface RedactedConfigResult {
  /** 只含白名单键，且值已过密钥扫描。 */
  config: Record<string, unknown>
  /**
   * 被**丢弃**的键名（黑名单之外的一切）。按字母序稳定排序 ——
   * 用户与维护者看到的是同一份清单，可以逐条讨论"要不要放行"。
   */
  redactedKeys: string[]
  /** 被丢弃的键里，取值是 `safe:` / `lock:` 密文的个数。 */
  storedSecretKeys: string[]
}

/**
 * 由**磁盘原始配置对象**（不是 `ConfigService.get()` 的解密结果）生成脱敏配置。
 *
 * 入参契约：`rawStore` 必须是 `electron-store` 的原始内容 —— 里面 `safe:` 前缀的
 * 值仍是密文。传解密后的对象进来就等于把秘密交给了本函数来处理，那是设计错误；
 * 调用方（diagnosticsService）从不调用 `get()`。
 */
export function redactConfigForBundle(rawStore: Record<string, unknown>): RedactedConfigResult {
  const config: Record<string, unknown> = {}
  const redactedKeys: string[] = []
  const storedSecretKeys: string[] = []

  for (const key of Object.keys(rawStore || {}).sort()) {
    if (!isBundleAllowedConfigKey(key)) {
      redactedKeys.push(key)
      const value = rawStore[key]
      if (typeof value === 'string' && /^(safe|lock):/.test(value)) storedSecretKeys.push(key)
      continue
    }
    const value = rawStore[key]
    // 白名单键也不放过值级扫描：用户可能把密钥粘进了 dbPath / exportPath。
    if (typeof value === 'string' && /^(safe|lock):/.test(value)) {
      // 白名单里不该出现密文；真出现了也只给指纹，不解密。
      config[key] = redactionFingerprint(value)
      storedSecretKeys.push(key)
      continue
    }
    config[key] = redactSecretsDeep(value)
  }

  return { config, redactedKeys, storedSecretKeys }
}
