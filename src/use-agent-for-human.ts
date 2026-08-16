/**
 * @llm-note
 *   Dependencies: imports from [react, src/react/agent-cache (acquireAgent/dropAgent), src/react/store] | imported by [src/react/index.ts]
 *   Data flow: hook gets one RemoteAgent per address:sessionId from the live-connection cache → agent.onMessage flushes ui/status/session/error into the zustand store → React re-renders from the store
 *   State/Effects: reuses the cached live RemoteAgent across session switches (agent-cache, bounded LRU) | persists session via the store | input() is fire-and-forget (errors surface via agent.error in the flush)
 *   Integration: exposes useAgentForHuman(address, options) returning {ui, status, input, setCollaborationMode, setPermissionProfile, reconnect, send, reset, ...}
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AgentInfo,
  ChatItem,
  PlanEntry,
  AgentStatus,
  ConnectionState,
  SessionState,
  ApprovalMode,
  CollaborationMode,
  OutgoingMessage,
  ApprovalRejectMode,
  HostSessionModeState,
  RemoteSessionStatus,
  PermissionProfile,
  ExecutionProfile,
} from './connect';
import { acquireAgent, dropAgent } from './agent-cache';
import { getStore, type Message } from './store';

/**
 * Return value of `useAgentForHuman`. Exposes all reactive state and every method
 * needed to drive a full chat UI — from sending a first prompt to handling
 * Full access checkpoints and approval gates.
 *
 * This hook is designed for human users interacting with agents through a UI.
 * For agent-to-agent communication, use `connect()` directly.
 *
 * All fields are stable references across re-renders unless their underlying
 * value actually changes.
 */
export interface UseAgentForHumanReturn {
  /** Current agent lifecycle state: 'idle' | 'working' | 'waiting' */
  status: AgentStatus;

  /**
   * WebSocket relay connection state: 'disconnected' | 'connected' | 'reconnecting'.
   * Updated synchronously whenever the agent's `onMessage` callback fires.
   */
  connectionState: ConnectionState;

  /**
   * Ordered list of chat items streamed from the agent. Each item is a
   * discriminated union keyed by `type` — use `isChatItemType` to narrow
   * before reading type-specific fields.
   */
  ui: ChatItem[];

  /** Latest full OIP plan snapshot for this session. Never a chat item. */
  plan: ReadonlyArray<PlanEntry>;

  /** Session UUID passed to the hook. Echoed here so consumers don't need a separate ref. */
  sessionId: string;

  /** True whenever status !== 'idle'. Useful for disabling input controls. */
  isProcessing: boolean;

  /** Last error captured and stored in the Zustand store. Cleared on the next `input()` call. */
  error: Error | null;

  /**
   * Latest `dashboard.html` snapshot the Host pushed over this connection
   * (on connect and after each run). `null` until the first snapshot arrives.
   */
  dashboardHtml: string | null;

  /**
   * The agent's full self-description — name, model, tools, every skill, balance —
   * pushed by the Host once the connection is authenticated. `null` until then, which
   * is the correct state to render for a viewer who has not passed the trust gate:
   * the public `/info` answer is deliberately narrower. Prefer this over
   * `fetchAgentInfo()` once connected.
   */
  profile: AgentInfo | null;

  /**
   * Check whether a specific session is alive on the relay server.
   * The caller decides when and how often to invoke this — no built-in interval.
   *
   * @param sessionId - Session UUID to probe
   * @returns 'running' | 'connected' | 'not_found'
   */
  checkSessionStatus: (sessionId: string) => Promise<RemoteSessionStatus>;


  /** @deprecated Read collaborationMode and permissionProfile separately. */
  mode: ApprovalMode;

  /** Current Codex collaboration mode. */
  collaborationMode: CollaborationMode;

  /** Current Host-enforced Codex permission profile. */
  permissionProfile: PermissionProfile;

  /** Product-facing Default / Safe / Full access profile from authenticated Host state. */
  executionProfile: ExecutionProfile;

  /** @deprecated Use availablePermissionProfiles. */
  availableModes: ReadonlyArray<HostSessionModeState['availableModes'][number]>;

  /** Server-authorized permission profiles. */
  availablePermissionProfiles: ReadonlyArray<HostSessionModeState['availableModes'][number]>;

  /** Host-advertised product profiles with exact wire mappings and policy metadata. */
  availableExecutionProfiles: ReadonlyArray<HostSessionModeState['availableModes'][number]>;

  /** Versioned policy advertised by the authenticated Host, or null for a legacy Host. */
  approvalPolicy: HostSessionModeState['policy'];

  /** @deprecated Use permissionProfileChangePending. */
  modeChangePending: boolean;

  /** True while an acknowledged permission-profile transaction is outstanding. */
  permissionProfileChangePending: boolean;

  /** Maximum turns before Full access pauses. null outside Full access. */
  fullAccessTurns: number | null;

  /** Turns consumed in the current Full access window. null outside Full access. */
  fullAccessTurnsUsed: number | null;

  /**
   * Fire-and-forget: sends a user prompt to the agent. Updates flow back through
   * the `onMessage` callback registered during mount, keeping `ui`, `status`,
   * `connectionState`, and `session` in sync as the agent streams its response.
   *
   * @param prompt - Natural-language instruction for the agent
   * @param options.images - Base64-encoded images to attach to the message
   * @param options.files - File attachments with name, type, size, and dataUrl
   */
  input: (prompt: string, options?: { images?: string[]; files?: import('./connect').FileAttachment[] }) => void;

  /** Retry the last turn without appending a duplicate user transcript item. */
  retry: (prompt: string, options?: { images?: string[]; files?: import('./connect').FileAttachment[] }) => void;

  /**
   * Open the WebSocket without sending input, so a landing/draft view receives the
   * Host's on-connect DASHBOARD_SNAPSHOT before the first message. Idempotent, and
   * safe to call concurrently. Stable across renders, so it can go in an effect's
   * dependency array. Failures land in `error`.
   */
  connect: () => void;

  /**
   * Send a typed message to the agent over the WebSocket.
   * Use this for all response messages: ASK_USER_RESPONSE, APPROVAL_RESPONSE,
   * PLAN_REVIEW_RESPONSE, FULL_ACCESS_RESPONSE, etc.
   */
  sendMessage: (message: OutgoingMessage) => void;

  /** Answer the one currently pending OIP tool approval. */
  respondToApproval: (
    approved: boolean,
    scope: 'once' | 'session',
    mode?: ApprovalRejectMode,
    feedback?: string,
  ) => void;

  /** Stop the current OIP turn. */
  interrupt: () => void;

  /** Stop one exact native Codex/Claude provider invocation after Host acknowledgement. */
  interruptProvider: (invocationId: string) => Promise<void>;

  /** Sign an onboard payload asynchronously. Pass the resolved result to sendMessage(). */
  signOnboard: (options: { inviteCode?: string; payment?: number }) => Promise<OutgoingMessage>;

  /**
   * @deprecated Use the two explicit setters. This compatibility method only
   * accepts `default` / `plan`; permission values throw instead of fabricating
   * Host authority.
   */
  setMode: (mode: ApprovalMode, options?: { turns?: number }) => void;

  /** Change local collaboration intent without changing Host permission authority. */
  setCollaborationMode: (mode: CollaborationMode) => void;

  /** Persist one permission profile and resolve only after Host confirmation. */
  setPermissionProfile: (profile: PermissionProfile) => Promise<void>;

  /** Change the product execution profile through the Host-acknowledged transaction. */
  setExecutionProfile: (profile: ExecutionProfile) => Promise<void>;

  /** @deprecated Use setPermissionProfile. */
  setSessionMode: (mode: PermissionProfile) => Promise<void>;

  /** Reconnect to existing session to receive pending output */
  reconnect: () => void;

  /** Clear all agent and store state, effectively starting a new conversation. */
  reset: () => void;
}

/**
 * React hook for a human user to interact with a remote AI agent.
 *
 * This is the primary hook for building chat UIs where a human drives the
 * conversation. It handles approval gates, Full access checkpoints, onboarding flows,
 * and session persistence — all concerns specific to human interaction.
 * For agent-to-agent communication, use `connect()` directly instead.
 *
 * Wraps a `RemoteAgent` instance with Zustand-backed localStorage persistence
 * so chat history and session state survive page refreshes. One store is created
 * per `(address, sessionId)` pair and cached for the lifetime of the module.
 *
 * **Lifecycle**
 * 1. On mount (or when `sessionId` changes), any persisted session is restored
 *    into the `RemoteAgent` so the server can resume from the correct context.
 * 2. `agent.onMessage` is registered in an effect to receive every streaming
 *    event from the agent — UI items, status, connection state, and session
 *    snapshots are all synced here without a polling interval.
 * 3. `input()` is fire-and-forget: it merges the session and dispatches the
 *    prompt; all reactive updates come back through `onMessage`.
 *
 * **Session ID ownership**
 * The caller is responsible for generating and managing the session UUID.
 * A stable ID (e.g. persisted in a URL parameter or parent component state)
 * lets users resume interrupted sessions across browser refreshes.
 *
 * @param address - Agent's 0x-prefixed public address on the relay network
 * @param sessionId - UUID identifying this conversation session
 * @returns Reactive state and methods for driving a chat UI
 *
 * @example
 * ```tsx
 * const { status, ui, input, isProcessing } = useAgentForHuman(agentAddress, sessionId);
 *
 * return (
 *   <button disabled={isProcessing} onClick={() => input('Hello')}>
 *     Send
 *   </button>
 * );
 * ```
 */
export function useAgentForHuman(
  address: string,
  sessionId: string,
): UseAgentForHumanReturn {
  const useStore = getStore(address, sessionId);

  // State from store
  const messages = useStore((s) => s.messages);
  const ui = useStore((s) => s.ui);
  const session = useStore((s) => s.session);
  const status = useStore((s) => s.status);
  const error = useStore((s) => s.error);

  // Actions from store
  const setStatus = useStore((s) => s.setStatus);
  const setUI = useStore((s) => s.setUI);
  const setSession = useStore((s) => s.setSession);
  const setError = useStore((s) => s.setError);
  const updateMessages = useStore((s) => s.updateMessages);
  const resetStore = useStore((s) => s.reset);

  // RemoteAgent for this (address, sessionId), reused from the live-connection cache.
  // Switching session no longer tears the WebSocket down and reconnects: the previous
  // session's connection stays alive in the background and switching back reuses it.
  // (See agent-cache.ts — bounded LRU so connections don't leak.)
  const agent = useMemo(() => acquireAgent(address, sessionId), [address, sessionId]);

  // connectionState is initialized from the agent and then kept in sync via onMessage.
  const [connectionState, setConnectionState] = useState<ConnectionState>(agent.connectionState);

  // Latest dashboard.html snapshot the Host pushed over this connection.
  const [dashboardHtml, setDashboardHtml] = useState<string | null>(agent.dashboardHtml);

  // Authenticated agent profile — arrives right after CONNECTED, so a cached agent
  // already holds it and a cold one fills it in on the next flush.
  const [profile, setProfile] = useState<AgentInfo | null>(agent.profile);

  const [availablePermissionProfiles, setAvailablePermissionProfiles] = useState(
    () => [...agent.availablePermissionProfiles],
  );
  const [permissionProfileChangePending, setPermissionProfileChangePending] = useState(
    agent.permissionProfileChangePending,
  );

  // Detach the public observation from persisted/server-owned session data while
  // keeping its reference stable until the underlying plan snapshot changes.
  const plan = useMemo(
    () => session?.plan?.map((entry) => ({ ...entry })) ?? [],
    [session?.plan],
  );

  // Register a single onMessage callback for the lifetime of this agent instance.
  // This replaces a polling interval: every streaming event from the server triggers
  // one synchronous flush of all derived state into React/Zustand.
  useEffect(() => {
    const flush = () => {
      setUI([...agent.ui]);
      setStatus(agent.status);
      setConnectionState(agent.connectionState);
      setDashboardHtml(agent.dashboardHtml);
      setProfile(agent.profile);
      setAvailablePermissionProfiles([...agent.availablePermissionProfiles]);
      setPermissionProfileChangePending(agent.permissionProfileChangePending);
      setError(agent.error);
      if (agent.currentSession) {
        setSession(agent.currentSession);
        if (agent.currentSession.messages) {
          updateMessages(agent.currentSession.messages as Message[]);
        }
      }
    };
    agent.onMessage = flush;

    // Sync immediately on (re)mount so switching back to a cached connection reflects its
    // real state at once instead of waiting for the next server event:
    //  - connectionState: a reused live connection must not flash "offline".
    //  - full flush when the agent already holds UI — it kept streaming in the background
    //    (e.g. a task that finished while we were on another session), so show the result
    //    now without needing the user to send another message. Skip the full flush on a
    //    cold agent (empty ui) so we don't clobber the store localStorage just hydrated.
    setConnectionState(agent.connectionState);
    // Same reason, and equally safe on a cold agent: none touches the store.
    // In React Strict Mode CONNECTED can land between the development unmount
    // and remount effects. Recover cached Host authority here so consumers do
    // not invent a permission fallback or hide profiles the Host advertised.
    setProfile(agent.profile);
    setAvailablePermissionProfiles([...agent.availablePermissionProfiles]);
    setPermissionProfileChangePending(agent.permissionProfileChangePending);
    if (agent.ui.length > 0 || agent.availablePermissionProfiles.length > 0) flush();

    return () => {
      // A route transition can mount the next hook before this owner unmounts.
      // Only detach the callback this effect installed; otherwise the older
      // cleanup erases the newer page's subscription and state stops updating.
      if (agent._onMessage === flush) agent.onMessage = null;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agent]);

  // On mount (or sessionId change): wait for Zustand hydration, then restore
  // session into the agent and reconnect to the server. Server returns:
  //   status="running"   → resume forwarding events
  //   status="connected" → deliver buffered OUTPUT synchronously
  //   status="new"       → no-op (harmless)
  // Reading state inside an early useEffect would see initial empty values
  // because persist hydrates asynchronously after the first render.
  useEffect(() => {
    let cancelled = false;

    const restoreAndReconnect = () => {
      if (cancelled || !sessionId) return;
      // If input() already opened a live connection while we were waiting for
      // hydration, don't yank it: reconnect() would _closeWs() and discard the
      // pending input's resolve/reject, stranding the user's prompt.
      if (agent.status === 'working' || agent.connectionState === 'connected') return;
      const state = useStore.getState();
      const hasStored = state.messages.length > 0 || !!state.session;
      if (!hasStored) return;

      if (state.session) {
        (agent as any)._currentSession = { ...state.session, session_id: sessionId };
      } else {
        (agent as any)._currentSession = { session_id: sessionId, messages: state.messages };
      }
      if (state.ui.length > 0) (agent as any)._chatItems = [...state.ui];

      agent.reconnect(sessionId).catch((err) => {
        console.warn('[useAgentForHuman] reconnect failed:', err);
      });
    };

    const persist = (useStore as unknown as { persist?: { hasHydrated: () => boolean; onFinishHydration: (fn: () => void) => () => void } }).persist;
    if (persist && !persist.hasHydrated()) {
      const unsub = persist.onFinishHydration(restoreAndReconnect);
      return () => { cancelled = true; unsub?.(); };
    }
    restoreAndReconnect();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  const input = (prompt: string, options?: { images?: string[]; files?: import('./connect').FileAttachment[] }) => {
    setError(null);

    // Preserve current agent state while ensuring the server receives the
    // canonical message history and correct session ID.
    const agentSession = (agent as any)._currentSession || {};
    (agent as any)._currentSession = {
      ...agentSession,
      ...(session || {}),       // Overlay with store session
      session_id: sessionId,    // Ensure correct session ID
      messages: session?.messages || messages,
    };

    // Restore chat items if agent is empty but store has data
    // (Zustand hydration is async — the mount-time restore effect may have
    // run before localStorage was hydrated, leaving _chatItems empty)
    if ((agent as any)._chatItems.length === 0 && ui.length > 0) {
      (agent as any)._chatItems = [...ui];
    }

    // Non-blocking — updates come via onMessage. A failed input already
    // surfaced through agent.error in the onMessage flush; the rejection
    // here is the same error, caught to avoid an unhandled rejection.
    agent.input(prompt, options).catch(() => {});
  };

  const retry = (prompt: string, options?: { images?: string[]; files?: import('./connect').FileAttachment[] }) => {
    setError(null);
    const agentSession = (agent as any)._currentSession || {};
    (agent as any)._currentSession = {
      ...agentSession,
      ...(session || {}),
      session_id: sessionId,
      messages: session?.messages || messages,
    };
    agent.input(prompt, { ...options, retry: true }).catch(() => {});
  };

  const reconnect = () => {
    // Ensure session is set on agent before reconnecting
    if (!(agent as any)._currentSession?.session_id) {
      (agent as any)._currentSession = { ...(session || {}), session_id: sessionId };
    }
    if ((agent as any)._chatItems.length === 0 && ui.length > 0) {
      (agent as any)._chatItems = [...ui];
    }
    // Reconnect failures are already mirrored into agent.error. Consume the
    // fire-and-forget promise so browser recovery events cannot leak an
    // unhandled rejection to the page.
    agent.reconnect(sessionId).catch(() => {});
  };

  // Open the WebSocket without sending input, so a landing/draft view receives the
  // Host's on-connect DASHBOARD_SNAPSHOT before the first message. Idempotent.
  // Memoized on the agent identity: callers put this in an effect's dep array, and a
  // fresh closure per render would re-run that effect on every render.
  const connect = useCallback(() => {
    // A warm connection must claim the hook's session before CONNECT. Otherwise
    // the Host allocates another ID, then strict session checks reject the
    // permission request for the conversation this hook is rendering.
    if (!(agent as any)._currentSession?.session_id) {
      (agent as any)._currentSession = { session_id: sessionId };
    }
    // Errors are surfaced on the agent (error state + onMessage flush) by connect();
    // caught here only to avoid an unhandled rejection on this fire-and-forget call.
    agent.connect().catch(() => {});
  }, [agent, sessionId]);

  const reset = () => {
    agent.reset();          // closes this session's WebSocket + clears agent state
    dropAgent(address, sessionId);  // forget the now-closed agent so a re-acquire is fresh
    resetStore();
  };

  const sendMessage = (message: OutgoingMessage) => {
    agent.send(message);
  };

  const respondToApproval = (
    approved: boolean,
    scope: 'once' | 'session',
    mode?: ApprovalRejectMode,
    feedback?: string,
  ) => agent.respondToApproval(approved, scope, mode, feedback);

  const interrupt = () => agent.interrupt();
  const interruptProvider = (invocationId: string) => agent.interruptProvider(invocationId);

  const setMode = (newMode: ApprovalMode, options?: { turns?: number }) => {
    const isCollaborationMode = newMode === 'default' || newMode === 'plan';
    agent.setMode(newMode, options);
    if (!isCollaborationMode) return;
    const updates: Partial<SessionState> = { collaboration_mode: newMode };
    setSession(session
      ? { ...session, ...updates }
      : { session_id: sessionId, ...updates }
    );
  };

  const setCollaborationMode = (newMode: CollaborationMode) => {
    agent.setCollaborationMode(newMode);
    setSession(session
      ? { ...session, collaboration_mode: newMode }
      : { session_id: sessionId, collaboration_mode: newMode }
    );
  };

  const setPermissionProfile = async (newMode: PermissionProfile) => {
    setError(null);
    await agent.setPermissionProfile(newMode);
    setError(null);
  };
  const setExecutionProfile = async (profile: ExecutionProfile) => {
    setError(null);
    await agent.setExecutionProfile(profile);
    setError(null);
  };

  const setSessionMode = setPermissionProfile;

  return {
    status,
    connectionState,
    ui,
    plan,
    sessionId,
    isProcessing: status !== 'idle',
    error,
    dashboardHtml,
    profile,
    checkSessionStatus: (sid: string) => agent.checkSessionStatus(sid),
    mode: session?.collaboration_mode === 'plan'
      ? 'plan'
      : session?.mode || ':read-only',
    collaborationMode: session?.collaboration_mode || 'default',
    permissionProfile: session?.mode || ':read-only',
    executionProfile: agent.executionProfile,
    availableModes: availablePermissionProfiles,
    availablePermissionProfiles,
    availableExecutionProfiles: availablePermissionProfiles,
    approvalPolicy: agent.approvalPolicy,
    modeChangePending: permissionProfileChangePending,
    permissionProfileChangePending,
    fullAccessTurns: session?.full_access_turns ?? null,
    fullAccessTurnsUsed: session?.full_access_turns_used ?? null,
    input,
    retry,
    connect,
    sendMessage,
    respondToApproval,
    interrupt,
    interruptProvider,
    signOnboard: (options: { inviteCode?: string; payment?: number }) => agent.signOnboard(options),
    setMode,
    setCollaborationMode,
    setPermissionProfile,
    setExecutionProfile,
    setSessionMode,
    reconnect,
    reset,
  };
}

/**
 * Type guard that narrows a `ChatItem` to the specific variant identified by `type`.
 *
 * Prefer this over a raw `item.type === 'tool_call'` comparison in render code
 * because TypeScript will fully narrow the variant's unique fields inside the branch.
 *
 * @example
 * ```ts
 * if (isChatItemType(item, 'tool_call')) {
 *   console.log(item.name, item.timing_ms); // fully typed
 * }
 * ```
 */
export function isChatItemType<T extends ChatItem['type']>(
  item: ChatItem,
  type: T
): item is Extract<ChatItem, { type: T }> {
  return item.type === type;
}

/** @deprecated Use isChatItemType instead */
export const isEventType = isChatItemType;
