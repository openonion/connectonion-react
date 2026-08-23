/**
 * @llm-note
 *   Dependencies: imports from [src/address (type-only)] | imported by [all connect/ files, src/react/]
 *   Data flow: defines interfaces used by RemoteAgent for WebSocket message parsing → ChatItem union rendered by UI consumers → SessionState synced between client/server
 *   State/Effects: pure type definitions, no runtime logic or side effects
 *   Integration: exports Response, ChatItem, ChatItemType, AskUserField, WebSocketLike, WebSocketCtor, ResolvedEndpoint, AgentInfo, ConnectOptions, SessionState, Mode, AgentStatus, ConnectionState
 */
import type * as address from '../address';
import type { MessageSigner } from '../browser-identity';

export type { AddressData } from '../address';
export type { MessageSigner } from '../browser-identity';

export interface Response {
  text: string;
  done: boolean;
}

export type ProviderInvocationStatus = 'starting' | 'running' | 'awaiting_approval' | 'completed' | 'failed' | 'cancelled';

/** Proof that a scoped Stop applies to the exact Work Room lifecycle state seen by the browser. */
export interface ProviderInterruptAcknowledgement {
  invocationId: string;
  stateRevision: number;
}

/** Proof that a direct Work Room message was accepted for this Codex state. */
export interface ProviderInputAcknowledgement {
  invocationId: string;
  stateRevision: number;
}

/** Proof that the Host committed a provider-native profile at a newer revision. */
export interface ProviderPermissionAcknowledgement {
  invocationId: string;
  stateRevision: number;
}

export interface ProviderPermissionOption {
  id: string;
  nativeProfileId: string;
  reviewer: 'user' | 'auto' | 'provider';
  label: string;
  description: string;
  risk: 'standard' | 'elevated';
  selectable: boolean;
  disabledReason?: string;
}

/** Host-authored provider state; distinct from outer COAI mode and approvals. */
export interface ProviderPermissionState {
  provider: 'codex' | 'claude_code';
  activeOptionId: string;
  options: ProviderPermissionOption[];
  appliesTo: 'subsequent_turn';
  effectiveRevision: number;
}

/** Plain-text conversation content explicitly exchanged with a native provider. */
export interface ProviderMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
}

/** Safe semantic categories shared by the native Codex and Claude Code adapters. */
export type ProviderActivityKind = 'command' | 'file_change' | 'inspect' | 'search' | 'tool';

export interface ProviderActivity {
  id: string;
  /** Present for the old generic tool fallback only. */
  name?: string;
  args?: Record<string, unknown>;
  status: 'running' | 'done' | 'error';
  result?: string;
  /** Stable provider order; present for typed OIP activity events. */
  sequence?: number;
  kind?: ProviderActivityKind;
  title?: string;
  summary?: string;
  files?: string[];
  /** Generic correlated tools from an older Host are never verified evidence. */
  legacy?: boolean;
}

/** A Host-captured raster preview, bound to one provider lifecycle revision. */
export interface ProviderArtifact {
  id: string;
  kind: 'screenshot';
  stateRevision: number;
  thumbnailDataUrl: string;
  alt: 'Latest provider workspace view' | 'Latest provider browser view';
}

export interface ProviderInvocationItem {
  id: string;
  type: 'provider_invocation';
  parentToolCallId: string;
  provider: 'codex' | 'claude_code';
  providerDisplayName: string;
  /** Stable Work Room conversation grouping; continuations keep this value. */
  workroomId?: string;
  /** The initial invocation this native continuation resumes. */
  continuationOf?: string;
  /** Safe provider-generated task category. Preferred over legacy taskSummary. */
  taskTitle?: string;
  taskSummary?: string;
  /** Safe current state, never raw provider output. */
  currentSummary?: string;
  /** Monotonic semantic state version; protects reconnect replay from reviving stale controls. */
  stateRevision?: number;
  /** Optional real preview; absent means the UI must not fabricate a thumbnail. */
  artifact?: ProviderArtifact;
  permissionMode?: 'manual' | 'auto_approve' | 'full_access';
  providerPermission?: ProviderPermissionState;
  status: ProviderInvocationStatus;
  activities: ProviderActivity[];
  /** Direct user/Codex conversation, separate from redacted execution activity. */
  messages?: ProviderMessage[];
  sessionId?: string;
  elapsedMs?: number;
  /** Safe terminal outcome. Preferred over legacy result/error fields. */
  resultSummary?: string;
  errorSummary?: string;
  result?: string;
  error?: string;
}

/**
 * Safe presentation-only correlation emitted when a native coding provider
 * asks for permission from inside an outer agent tool call.  This is not an
 * authority token: the Host still binds the answer to its one live request.
 */
export interface ProviderApprovalContext {
  provider?: 'codex' | 'claude_code';
  providerInvocationId?: string;
  parentToolCallId?: string;
  activityId?: string;
  /** Safe Core-authored copy for the decision surface; not an authority token. */
  providerApproval?: ProviderApprovalPresentation;
}

/** Verified provider approval scope, kept separate from raw legacy arguments. */
export interface ProviderApprovalPresentation {
  action: string;
  scope: string;
  reason: string;
  scopeClassification: 'workroom' | 'elevated' | 'unknown';
  allowOnce: boolean;
  allowSession: boolean;
  files?: string[];
}

export type ChatItemType = 'user' | 'agent' | 'thinking' | 'tool_call' | 'provider_invocation' | 'ask_user' | 'approval_needed' | 'onboard_required' | 'onboard_success' | 'intent' | 'eval' | 'compact' | 'tool_blocked' | 'files_received';

export interface AskUserField {
  name: string;
  label: string;
  type?: 'text' | 'password';
  placeholder?: string;
  required?: boolean;
  autocomplete?: string;
}

/** Provider-neutral usage emitted by Core for one managed LLM call. */
export interface LLMUsage {
  input_tokens?: number;
  output_tokens?: number;
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  cached_tokens?: number;
  cache_write_tokens?: number;
  cost?: number;
  cost_usd?: number;
  input_tokens_total?: number;
  input_tokens_uncached?: number;
  cache_read_input_tokens?: number;
  cache_write_input_tokens?: number;
  cache_write_5m_input_tokens?: number;
  cache_write_1h_input_tokens?: number;
  cache_metadata_status?: 'reported' | 'unavailable' | 'unsupported';
  provider?: string;
  requested_model?: string;
  provider_model?: string;
  provider_reported_cost_usd?: number;
  pricing_version?: string;
  pricing_tier?: string;
  cost_details?: Record<string, unknown>;
}

export type ChatItem =
  | { id: string; type: 'user'; content: string; images?: string[]; files?: FileAttachment[] }
  | { id: string; type: 'agent'; content: string; images?: string[] }
  | { id: string; type: 'thinking'; status: 'running' | 'done' | 'error'; model?: string; duration_ms?: number; content?: string; kind?: string; context_percent?: number; usage?: LLMUsage }
  | { id: string; type: 'tool_call'; name: string; args?: Record<string, unknown>; summary?: string; status: 'running' | 'done' | 'error'; result?: string; timing_ms?: number }
  | ProviderInvocationItem
  | { id: string; type: 'ask_user'; text: string; options: string[]; multi_select: boolean; input_type?: string; fields?: AskUserField[]; answered?: boolean; answer?: string }
  | ({ id: string; type: 'approval_needed'; tool: string; arguments: Record<string, unknown>; description?: string; batch_remaining?: Array<{ tool: string; arguments: string }>; answered?: boolean } & ProviderApprovalContext)
  | { id: string; type: 'onboard_required'; methods: string[]; paymentAmount?: number; paymentAddress?: string }
  | { id: string; type: 'onboard_success'; level: string; message: string }
  | { id: string; type: 'intent'; status: 'analyzing' | 'understood'; ack?: string; is_build?: boolean }
  | { id: string; type: 'eval'; status: 'evaluating' | 'done'; passed?: boolean; summary?: string; expected?: string; eval_path?: string }
  | { id: string; type: 'compact'; status: 'compacting' | 'done' | 'error'; context_before?: number; context_after?: number; context_percent?: number; message?: string; error?: string }
  | { id: string; type: 'tool_blocked'; tool: string; reason: string; message: string; command?: string }
  | { id: string; type: 'files_received'; files: Array<{ name: string; path: string }> };

export type WebSocketLike = {
  onopen: ((ev?: unknown) => unknown) | null;
  onmessage: ((ev: { data: unknown }) => unknown) | null;
  onerror: ((ev: unknown) => unknown) | null;
  onclose: ((ev: unknown) => unknown) | null;
  /** Browser and `ws` sockets expose this; optional keeps custom test transports compatible. */
  readonly readyState?: number;
  send(data: unknown): void;
  close(): void;
};

export type WebSocketCtor = new (url: string) => WebSocketLike;

export interface ResolvedEndpoint {
  httpUrl: string;
  wsUrl: string;
}

export interface SkillInfo {
  name: string;
  description: string;
  location?: string;
}

export interface AgentAcceptedInputs {
  text?: boolean;
  images?: boolean;
  files?: { max_file_size_mb: number; max_files_per_request: number };
}

export interface AgentInfo {
  address: string;
  name?: string;
  tools?: string[];
  skills?: SkillInfo[];
  trust?: string;
  version?: string;
  model?: string;
  /** Agent's OpenOnion account balance in USD. Present only for co/* managed-key
   *  agents that published it (clients can't fetch it themselves — it's gated by
   *  the agent's private key). A startup snapshot, not a live figure. */
  balance_usd?: number;
  accepted_inputs?: AgentAcceptedInputs;
  /** What a stranger has to do before this agent will talk to them. Present when
   *  the agent gates access; absent when anyone may connect.
   *
   *  A client that cannot see this only discovers the gate by being refused —
   *  after the reader has typed a message, which is then lost. Carried so a
   *  landing page can say so before they type. */
  onboard?: AgentOnboard;
  online: boolean;
}

/** How a stranger becomes a contact. `invite_code: true` means a code is accepted;
 *  `payment` is the price in USD, or null when payment is not an option. */
export interface AgentOnboard {
  invite_code?: boolean;
  payment?: number | null;
}

export interface ConnectOptions {
  /** Async-capable identity provider for authenticated requests. */
  signer?: MessageSigner;
  /** @deprecated Prefer signer; raw keys remain supported for compatibility. */
  keys?: address.AddressData;
  /** Relay URL for WebSocket connection (default: wss://oo.openonion.ai) */
  relayUrl?: string;
  /**
   * Direct agent URL for deployed agents (bypasses relay).
   * Use this for agents deployed via `co deploy`.
   * Example: 'https://my-agent.agents.openonion.ai'
   *
   * When set:
   * - Connects directly to {directUrl}/ws
   * - Does not use relay routing
   * - Agent address is optional (used only for signing)
   */
  directUrl?: string;
  /** Custom WebSocket constructor */
  wsCtor?: WebSocketCtor;
}

/** Stable OIP plan priority. Kept separate from ConnectOnion's approval mode. */
export type PlanEntryPriority = 'high' | 'medium' | 'low';

/** Stable OIP plan lifecycle state. */
export type PlanEntryStatus = 'pending' | 'in_progress' | 'completed';

/** One item in the current session's full OIP plan snapshot. */
export interface PlanEntry {
  readonly content: string;
  readonly priority: PlanEntryPriority;
  readonly status: PlanEntryStatus;
}

export interface SessionState {
  session_id?: string;
  messages?: Array<{ role: string; content: string }>;
  trace?: unknown[];
  turn?: number;
  /** Latest full OIP plan snapshot. An empty array explicitly clears the plan. */
  plan?: ReadonlyArray<PlanEntry>;
  /** Host-enforced public mode. Unknown stored values normalize to Auto. */
  mode?: Mode;
  /** Remaining completed user-driven turns for bounded Full access. */
  turns_left?: number;
}

/** The complete ConnectOnion 1.7 public mode vocabulary. */
export type Mode = 'read-only' | 'auto' | 'full-access';

export type AgentStatus = 'idle' | 'working' | 'waiting';

export type ConnectionState = 'disconnected' | 'connected' | 'reconnecting';

export type RemoteSessionStatus = 'running' | 'connected' | 'not_found';

export interface FileAttachment {
  name: string;
  type: string;
  size: number;
  dataUrl: string;
}

export type OutgoingMessage = Record<string, unknown>;
