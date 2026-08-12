/**
 * @llm-note
 *   Dependencies: imports from [src/address (type-only)] | imported by [all connect/ files, src/react/]
 *   Data flow: defines interfaces used by RemoteAgent for WebSocket message parsing → ChatItem union rendered by UI consumers → SessionState synced between client/server
 *   State/Effects: pure type definitions, no runtime logic or side effects
 *   Integration: exports Response, ChatItem (14-variant union), ChatItemType, AskUserField (structured ask_user forms, e.g. login credentials), WebSocketLike, WebSocketCtor, ResolvedEndpoint, AgentInfo, ConnectOptions, SessionState, ApprovalMode, AgentStatus, ConnectionState
 */
import type * as address from '../address';

export type { AddressData } from '../address';

export interface Response {
  text: string;
  done: boolean;
}

export type ChatItemType = 'user' | 'agent' | 'thinking' | 'tool_call' | 'ask_user' | 'approval_needed' | 'onboard_required' | 'onboard_success' | 'intent' | 'eval' | 'compact' | 'tool_blocked' | 'full_access_checkpoint' | 'plan_review' | 'files_received';

export interface AskUserField {
  name: string;
  label: string;
  type?: 'text' | 'password';
  placeholder?: string;
  required?: boolean;
  autocomplete?: string;
}

export type ChatItem =
  | { id: string; type: 'user'; content: string; images?: string[]; files?: FileAttachment[] }
  | { id: string; type: 'agent'; content: string; images?: string[] }
  | { id: string; type: 'thinking'; status: 'running' | 'done' | 'error'; model?: string; duration_ms?: number; content?: string; kind?: string; context_percent?: number; usage?: { input_tokens?: number; output_tokens?: number; prompt_tokens?: number; completion_tokens?: number; total_tokens?: number; cost?: number } }
  | { id: string; type: 'tool_call'; name: string; args?: Record<string, unknown>; status: 'running' | 'done' | 'error'; result?: string; timing_ms?: number }
  | { id: string; type: 'ask_user'; text: string; options: string[]; multi_select: boolean; input_type?: string; fields?: AskUserField[]; answered?: boolean; answer?: string }
  | { id: string; type: 'approval_needed'; tool: string; arguments: Record<string, unknown>; description?: string; batch_remaining?: Array<{ tool: string; arguments: string }>; answered?: boolean }
  | { id: string; type: 'onboard_required'; methods: string[]; paymentAmount?: number; paymentAddress?: string }
  | { id: string; type: 'onboard_success'; level: string; message: string }
  | { id: string; type: 'intent'; status: 'analyzing' | 'understood'; ack?: string; is_build?: boolean }
  | { id: string; type: 'eval'; status: 'evaluating' | 'done'; passed?: boolean; summary?: string; expected?: string; eval_path?: string }
  | { id: string; type: 'compact'; status: 'compacting' | 'done' | 'error'; context_before?: number; context_after?: number; context_percent?: number; message?: string; error?: string }
  | { id: string; type: 'tool_blocked'; tool: string; reason: string; message: string; command?: string }
  | { id: string; type: 'full_access_checkpoint'; turns_used: number; max_turns: number }
  | { id: string; type: 'plan_review'; plan_content: string }
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
  /** Signing keys for authenticated requests */
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

/** Stable ACP plan priority. Kept separate from ConnectOnion's approval mode. */
export type PlanEntryPriority = 'high' | 'medium' | 'low';

/** Stable ACP plan lifecycle state. */
export type PlanEntryStatus = 'pending' | 'in_progress' | 'completed';

/** One item in the current session's full ACP plan snapshot. */
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
  /** Latest full ACP plan snapshot. An empty array explicitly clears the plan. */
  plan?: ReadonlyArray<PlanEntry>;
  /** Host-enforced permission profile. Kept in `mode` for wire compatibility. */
  mode?: PermissionProfile;
  /** Local product workflow; never treated as Host authority. */
  collaboration_mode?: CollaborationMode;
  /** Full access: max turns before pausing at a checkpoint. */
  full_access_turns?: number;
  /** Full access: turns used in the current checkpoint window. */
  full_access_turns_used?: number;
}

/** Exact built-in Codex permission profile identifiers. */
export type PermissionProfile =
  | ':read-only'
  | ':workspace'
  | ':danger-full-access';

/** Codex collaboration modes are independent of permission profiles. */
export type CollaborationMode = 'default' | 'plan';

/** @deprecated Use PermissionProfile. */
export type ServerApprovalMode = PermissionProfile;

/** @deprecated Use CollaborationMode and PermissionProfile separately. */
export type ApprovalMode = CollaborationMode | PermissionProfile;

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
