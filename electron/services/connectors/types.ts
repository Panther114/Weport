/**
 * Connector layer — Weport's outward-facing integrations.
 *
 * Design note: a connector is a *transport* (how to talk to a third party) plus a
 * *capability list* (what it can do). Nothing in this layer knows about Weport's
 * UI: the services above it (`connectorsService`) own credentials, and the agent
 * reaches a connector only through an explicit tool, so a new connector cannot
 * silently acquire write access to a user's account.
 */

/** How a connector authenticates. Token connectors paste a key; OAuth is parked. */
export type ConnectorAuthKind = 'token' | 'oauth'

/** What a connector's remote service allows. Drives which UI/tool affordances show. */
export interface ConnectorCapabilities {
  read: boolean
  write: boolean
  /** Remote objects can be chosen from inside Weport (a project/label picker). */
  hasTargets: boolean
}

export interface ConnectorDescriptor {
  id: string
  name: string
  /** One line, shown in the connect panel under the name. */
  description: string
  authKind: ConnectorAuthKind
  capabilities: ConnectorCapabilities
  /** Where the user creates the credential (opened in the default browser). */
  credentialUrl: string
  /** Short, concrete steps; rendered as an ordered list in the UI. */
  credentialHelp: string[]
  /** Shown next to the token field so the expected shape is obvious. */
  credentialPlaceholder: string
}

/** Where the user wants a task to land, in the connector's own vocabulary. */
export interface ConnectorTarget {
  id: string
  name: string
  kind: 'project' | 'label' | 'inbox'
}

/**
 * Priority as the *user* sees it, not as any single API spells it.
 *
 * Every task service numbers priority differently (Todoist's REST API says
 * 4 = urgent while its Quick Add syntax says `p1` = urgent), so connectors
 * translate and callers only ever deal with these four names.
 */
export type ConnectorPriority = 'none' | 'low' | 'medium' | 'high' | 'urgent'

export interface ConnectorTaskInput {
  content: string
  description?: string
  /** ISO date (YYYY-MM-DD). */
  dueDate?: string
  /** Full RFC3339 instant, when the caller already knows the exact time. */
  dueDatetime?: string
  /** Natural-language due text; the service parses it (`tomorrow at 5pm`). */
  dueText?: string
  dueLang?: string
  priority?: ConnectorPriority
  labels?: string[]
  targetId?: string
  /** Parent task id, when the connector supports sub-tasks. */
  parentId?: string
}

export interface ConnectorTaskResult {
  id: string
  content: string
  /** Deep link the user can open in the third-party app. */
  url?: string
  dueText?: string
  priority?: ConnectorPriority
  targetName?: string
}

export interface ConnectorConnectionState {
  id: string
  connected: boolean
  /** Never the credential itself — a masked hint such as `····9f2c`. */
  credentialHint?: string
  connectedAt?: number
  /** Result of the last verification call, so the panel can show live health. */
  lastCheck?: { at: number; ok: boolean; error?: string; accountName?: string }
}

/** Result envelope shared by every connector call. */
export interface ConnectorResult<T> {
  success: boolean
  data?: T
  error?: string
  /** HTTP status when the failure came from the remote service. */
  status?: number
}

export interface Connector {
  descriptor: ConnectorDescriptor
  /** Verify the credential and, when possible, name the account behind it. */
  verify(token: string, signal?: AbortSignal): Promise<ConnectorResult<{ accountName?: string }>>
  /** Projects / labels the user can file a task into. */
  listTargets(token: string, signal?: AbortSignal): Promise<ConnectorResult<ConnectorTarget[]>>
  createTask(token: string, input: ConnectorTaskInput, signal?: AbortSignal): Promise<ConnectorResult<ConnectorTaskResult>>
  /** Optional read side; absent when the connector is write-only. */
  listTasks?(token: string, options: { limit?: number }, signal?: AbortSignal): Promise<ConnectorResult<ConnectorTaskResult[]>>
}
