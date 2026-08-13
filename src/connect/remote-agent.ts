/**
 * @llm-note
 *   Dependencies: imports from [src/connect/types, src/connect/endpoint, src/connect/auth, src/connect/chat-item-mapper, src/address]
 *   Data flow: ensureConnected() opens persistent WS + INIT auth → input() sends INPUT on existing WS → handleMessage() dispatches events → resolves on OUTPUT | input() has no wall-clock deadline (ask_user runs pend on the human); the 60s-silence ping monitor detects dead connections
 *   State/Effects: owns persistent WebSocket + mutable _chatItems + _currentSession
 *   Integration: public API consumed by connect() factory and React useAgentForHuman hook
 *
 * Connect process (first input() on a fresh agent):
 *
 *   input(prompt)
 *     │ adds user chat item, status='working'
 *     ▼
 *   _ensureConnected() ── ws open ──► send CONNECT {session_id?, signed payload}
 *     │                              30s deadline starts
 *     │
 *     │   ┌─────────────── host reply ────────────────┐
 *     │   ▼                                           ▼
 *     │ CONNECTED {session_id, status}        ONBOARD_REQUIRED (trust gate)
 *     │   │ resolves the pending promise        │ 30s deadline CLEARED — a human
 *     │   │                                     │ is typing an invite code now
 *     │   │                                     ▼
 *     │   │                              UI collects code → send ONBOARD_SUBMIT (signed)
 *     │   │                                     │
 *     │   │                              ONBOARD_SUCCESS, then the host finishes
 *     │   │                              the interrupted CONNECT itself and sends
 *     │   │                              CONNECTED ──┐ (no client retry: resending
 *     │   ◄──────────────────────────────────────────┘  INPUT here would double-run)
 *     ▼
 *   send INPUT {input_id, prompt} ──► streaming events (thinking/tool_call/agent_image/
 *   ask_user/...) mapped into _chatItems ──► OUTPUT resolves input()
 *
 *   Right after CONNECTED the Host also pushes AGENT_PROFILE (the authenticated
 *   answer to "who are you" — every skill, not the public subset /info returns)
 *   and DASHBOARD_SNAPSHOT. Both land on the agent as `profile` / `dashboardHtml`.
 *
 *   Failure paths: ws error/close or 60s ping silence → _handleConnectionLoss →
 *   rejects pending connect/input; ERROR frame → _error set, input() rejected.
 *   reconnect(sessionId) is the same shape but sends CONNECT with the stored
 *   session and a 60s timer — connection establishment is the only bounded wait.
 */
import * as address from '../address';
import {
  AgentInfo, AgentStatus, ApprovalMode, ChatItem, ChatItemType, CollaborationMode, ConnectionState,
  ConnectOptions, PermissionProfile, PlanEntry, RemoteSessionStatus, ResolvedEndpoint, Response, SessionState, WebSocketCtor, WebSocketLike,
} from './types';
import {
  AgentInfoSource, getWebSocketCtor, generateUUID, normalizeRelayUrl, resolveEndpoint, toAgentInfo,
} from './endpoint';
import { ensureKeys, signPayload } from './auth';
import { mapEventToChatItem } from './chat-item-mapper';
import {
  ACPBrowserAdmissionError,
  type ACPBrowserAdmission,
} from './native-acp';
import {
  getNativeACPDriver,
  type NativeACPConnection,
  type NativeACPContentBlock,
  type NativeACPPermissionRequest,
  type NativeACPPermissionResponse,
} from './native-acp-runtime';
import {
  selectBrowserTransport,
  type BrowserTransportSelection,
} from './transport-selection';
import {
  isCanonicalPermissionProfile,
  normalizeCollaborationMode,
  normalizePermissionProfile,
  normalizeChatItems,
  normalizeFullAccessCheckpointFrame,
  normalizeSessionState,
} from './mode-compat';
import {
  ACPPermissionRequest,
  ACPSetModeResponse,
  ApprovalRejectMode,
  HostSessionModeState,
  acpResponseRequestId,
  acpCancelFrame,
  acpPermissionCancelledFrame,
  acpPermissionResponseFrame,
  acpSetSessionModeFrame,
  decodeACPModeUpdate,
  decodeACPPlanUpdate,
  decodeACPPermissionRequest,
  decodeACPSetModeResponse,
  decodeNativeACPUpdate,
  decodeLegacyPlanUpdate,
  hostSessionModeState,
  hostSupportsACPCancel,
  normalizeNativeSessionModeState,
  normalizePlanEntries,
  parsePermissionProfile,
} from './wire-events';

interface PendingApproval {
  chatItemId: string;
  answered: boolean;
  acp?: ACPPermissionRequest;
  native?: {
    request: NativeACPPermissionRequest;
    resolve: (response: NativeACPPermissionResponse) => void;
  };
}

interface PendingPermissionProfileChange {
  requestId: string;
  sessionId: string;
  profile: PermissionProfile;
  resolve: () => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface ReconnectReadyWaiter {
  resolve: () => void;
  reject: (error: Error) => void;
}

interface NativeAdmissionWaiter {
  resolve: (admission: ACPBrowserAdmission) => void;
  reject: (error: Error) => void;
}

const PERMISSION_PROFILE_CHANGE_TIMEOUT_MS = 30000;
const WEBSOCKET_OPEN = 1;

function approvalRejectMode(value: unknown): ApprovalRejectMode {
  return value === 'reject_soft' || value === 'reject_explain'
    ? value
    : 'reject_hard';
}

export class RemoteAgent {
  readonly address: string;

  _keys?: address.AddressData;
  _relayUrl: string;
  _directUrl?: string;
  _resolvedEndpoint?: ResolvedEndpoint;
  _endpointResolutionAttempted = false;
  _WS: WebSocketCtor;

  // Public reactive state
  _status: AgentStatus = 'idle';
  _connectionState: ConnectionState = 'disconnected';
  _currentSession: SessionState | null = null;
  _chatItems: ChatItem[] = [];
  _error: Error | null = null;

  // Latest dashboard.html snapshot pushed by the Host (on connect + after each run).
  _dashboardHtml: string | null = null;

  // The agent's own account of itself, pushed once right after CONNECTED.
  // This is the *authenticated* answer: /info and the relay directory are open to
  // anyone who can reach the agent, so they publish a filtered subset (project-tree
  // skills only). This frame arrives past the signature check and the trust gate,
  // so it carries the full picture — every skill, the model, the balance. Null until
  // it lands, which is also the honest state for an unauthenticated viewer.
  _profile: AgentInfo | null = null;

  // Persistent WebSocket
  private _ws: WebSocketLike | null = null;
  private _authenticated = false;
  private _supportsACPCancel = false;
  private _permissionProfileState: HostSessionModeState | null = null;
  private _interruptSent = false;

  // Promise resolution for current input() call
  private _inputResolve: ((value: Response) => void) | null = null;
  private _inputReject: ((reason?: unknown) => void) | null = null;
  private _inputTimer: ReturnType<typeof setTimeout> | null = null;

  // PING/PONG health check
  private _lastActivityTime = 0;
  private _pingTimer: ReturnType<typeof setInterval> | null = null;
  private _sessionStatusWaiters = new Map<string, {
    resolves: Array<(status: RemoteSessionStatus) => void>;
    timer: ReturnType<typeof setTimeout>;
  }>();

  // Callback + promise for ensureConnected
  private _connectResolve: ((data: Record<string, unknown>) => void) | null = null;
  private _connectReject: ((reason?: unknown) => void) | null = null;
  private _connectTimer: ReturnType<typeof setTimeout> | null = null;

  // In-flight connect attempt. The `_ws && _authenticated` fast path only covers a
  // *finished* connect, so without this a second caller during the (up to 30s)
  // CONNECT window would open a second WebSocket and overwrite _ws plus
  // _connectResolve/_connectReject/_connectTimer — orphaning the first caller's
  // promise and leaking the first socket and its ping monitor. Cleared when the
  // attempt settles so a failed connect can be retried.
  private _connecting: Promise<void> | null = null;
  private _reconnecting: Promise<Response> | null = null;
  private _reconnectReadyWaiters: ReconnectReadyWaiter[] = [];
  private _pendingApproval: PendingApproval | null = null;
  private _pendingPermissionProfileChange: PendingPermissionProfileChange | null = null;
  private _transportSelection: BrowserTransportSelection | null = null;
  private _selectingTransport: Promise<BrowserTransportSelection> | null = null;
  private _native: NativeACPConnection | null = null;
  private _nativePrompt: Promise<Response> | null = null;
  private _nativePromptReject: ((error: Error) => void) | null = null;
  private _nativeResponseText = '';
  private _nativePermissionProfileChangePending = false;
  private _nativeAdmission: ACPBrowserAdmission | undefined;
  private _nativeAdmissionWaiter: NativeAdmissionWaiter | null = null;
  private _connectionEpoch = 0;

  _onMessage: (() => void) | null = null;
  set onMessage(fn: (() => void) | null) { this._onMessage = fn; }

  constructor(agentAddress: string, options: ConnectOptions = {}) {
    this.address = agentAddress;
    this._relayUrl = normalizeRelayUrl(options.relayUrl || 'wss://oo.openonion.ai');
    this._directUrl = options.directUrl?.replace(/\/$/, '');
    this._WS = options.wsCtor || getWebSocketCtor();
    if (options.keys) this._keys = options.keys;
  }

  // --- Public getters ---

  get agentAddress(): string { return this.address; }
  get status(): AgentStatus { return this._status; }
  get connectionState(): ConnectionState { return this._connectionState; }
  get currentSession(): SessionState | null { return this._currentSession; }
  get ui(): ChatItem[] { return this._chatItems; }
  get permissionProfile(): PermissionProfile {
    return this._currentSession?.mode || ':read-only';
  }
  get collaborationMode(): CollaborationMode {
    return this._currentSession?.collaboration_mode || 'default';
  }
  /** @deprecated Read collaborationMode and permissionProfile separately. */
  get mode(): ApprovalMode {
    return this.collaborationMode === 'plan' ? 'plan' : this.permissionProfile;
  }
  get plan(): ReadonlyArray<PlanEntry> {
    return this._currentSession?.plan?.map((entry) => ({ ...entry })) ?? [];
  }
  get availableModes(): ReadonlyArray<HostSessionModeState['availableModes'][number]> {
    return this.availablePermissionProfiles;
  }
  get availablePermissionProfiles(): ReadonlyArray<HostSessionModeState['availableModes'][number]> {
    return this._permissionProfileState?.availableModes.map((mode) => ({ ...mode })) ?? [];
  }
  get permissionProfileChangePending(): boolean {
    return this._pendingPermissionProfileChange !== null
      || this._nativePermissionProfileChangePending;
  }
  /** @deprecated Use permissionProfileChangePending. */
  get modeChangePending(): boolean { return this.permissionProfileChangePending; }
  get error(): Error | null { return this._error || null; }
  get dashboardHtml(): string | null { return this._dashboardHtml; }
  get profile(): AgentInfo | null { return this._profile; }

  // --- Public API ---

  /**
   * Open the authenticated WebSocket without sending input. Lets a landing/draft
   * view receive the Host's on-connect DASHBOARD_SNAPSHOT before the first input().
   * Idempotent — a no-op if already connected, and concurrent calls share the one
   * in-flight handshake rather than racing to open a second socket. On failure the
   * error is stored on the agent and flushed to subscribers before rethrowing.
   */
  async connect(): Promise<void> {
    const connectionEpoch = this._connectionEpoch;
    try {
      await this._ensureConnected();
    } catch (err) {
      if (connectionEpoch !== this._connectionEpoch) throw err;
      // Mirror input()'s failure handling: fire-and-forget callers (the React hook)
      // only observe state through onMessage, so without this an eager connect
      // fails completely silently — no error, no state change, nothing to retry on.
      this._error = err instanceof Error ? err : new Error(String(err));
      this._onMessage?.();
      throw err;
    }
  }

  async input(prompt: string, options?: { images?: string[]; files?: import('./types').FileAttachment[] }): Promise<Response> {
    if (this._nativePrompt) {
      throw new Error('Native ACP session is already processing a prompt');
    }
    const connectionEpoch = this._connectionEpoch;
    this._addChatItem({ type: 'user', content: prompt, images: options?.images, files: options?.files });

    const isInterjection = this._status === 'working' && this._inputResolve !== null;

    if (!isInterjection) {
      this._interruptSent = false;
      this._addChatItem({ type: 'thinking', id: '__optimistic__', status: 'running' });
      this._status = 'working';
    }
    this._error = null;
    this._onMessage?.();

    try {
      await this._ensureConnected();
    } catch (err) {
      if (connectionEpoch !== this._connectionEpoch) throw err;
      // Restore the status machine before rethrowing: fire-and-forget callers
      // (useAgentForHuman) only observe state via onMessage, and without this
      // a connection/signing failure leaves the UI stuck on 'working' forever.
      this._error = err instanceof Error ? err : new Error(String(err));
      this._clearPlaceholder();
      const onboarding = this._chatItems.some(
        (item) => item.type === 'onboard_required',
      );
      this._status = onboarding ? 'waiting' : 'idle';
      this._onMessage?.();
      throw err;
    }

    if (this._native) {
      return this._promptNative(prompt, options);
    }

    const inputId = generateUUID();
    const isDirect = this._isDirect();

    const msg: Record<string, unknown> = { type: 'INPUT', input_id: inputId, prompt };
    if (options?.images?.length) msg.images = options.images;
    if (options?.files?.length) msg.files = options.files.map(f => ({ name: f.name, data: f.dataUrl }));
    if (!isDirect) msg.to = this.address;

    try {
      this._sendAuthenticated(msg);
    } catch (cause) {
      const error = cause instanceof Error ? cause : new Error(String(cause));
      this._error = error;
      this._clearPlaceholder();
      this._status = 'idle';
      this._onMessage?.();
      throw error;
    }

    if (isInterjection) {
      return new Promise<Response>((resolve, reject) => {
        const prevResolve = this._inputResolve!;
        const prevReject = this._inputReject!;
        this._inputResolve = (r) => { prevResolve(r); resolve(r); };
        this._inputReject = (e) => { prevReject(e); reject(e); };
      });
    }

    // No overall deadline: interactive runs legitimately pend for as long as
    // ask_user waits on the human. Dead connections are detected by the ping
    // monitor (60s silence -> close -> _handleConnectionLoss rejects).
    return new Promise<Response>((resolve, reject) => {
      this._inputResolve = resolve;
      this._inputReject = reject;
    });
  }

  reconnect(sessionId?: string): Promise<Response> {
    const sid = sessionId || this._currentSession?.session_id;
    if (!sid) return Promise.reject(new Error('No session to reconnect'));
    if (getNativeACPDriver()) {
      if (this._hasReadyConnection()) {
        return Promise.resolve({ text: '', done: true });
      }
      this._connectionState = 'reconnecting';
      this._onMessage?.();
      return this._ensureConnected()
        .then(() => ({ text: '', done: true }))
        .catch((cause) => {
          const error = cause instanceof Error ? cause : new Error(String(cause));
          this._error = error;
          this._status = 'idle';
          this._connectionState = 'disconnected';
          this._onMessage?.();
          throw error;
        });
    }
    if (this._hasReadyConnection()) {
      return Promise.resolve({ text: '', done: true });
    }
    // connect() and reconnect() are two entry points to the same one-session
    // transport. A hydration callback can race the page's eager connect; let the
    // authenticated handshake finish instead of replacing its socket mid-flight.
    if (this._connecting) {
      return this._connecting.then(() => ({ text: '', done: true }));
    }
    if (this._reconnecting) return this._reconnecting;

    const attempt = this._doReconnect(sid);
    let tracked: Promise<Response>;
    tracked = attempt.catch((cause) => {
      const error = cause instanceof Error ? cause : new Error(String(cause));
      if (this._reconnecting === tracked) {
        this._error = error;
        this._status = 'idle';
        this._connectionState = 'disconnected';
        this._settleReconnectReady(error);
        this._onMessage?.();
      }
      throw error;
    });
    this._reconnecting = tracked;
    const clear = () => {
      if (this._reconnecting === tracked) this._reconnecting = null;
    };
    tracked.then(clear, clear);
    return tracked;
  }

  private async _doReconnect(sid: string): Promise<Response> {
    // A live authenticated socket already receives this session's pending output.
    // Only a genuinely unavailable transport reaches this replacement path.
    this._closeWs();

    if (!this._currentSession) this._currentSession = { session_id: sid };
    this._status = 'working';
    this._connectionState = 'reconnecting';
    this._onMessage?.();

    this._keys = ensureKeys(this._keys);
    await this._resolveEndpointOnce();

    const { wsUrl, isDirect } = this._resolveWsUrl();
    const ws = new this._WS(wsUrl);
    this._ws = ws;

    return new Promise<Response>((resolve, reject) => {
      this._inputResolve = resolve;
      this._inputReject = reject;
      this._inputTimer = setTimeout(() => {
        this._settleInput();
        this._status = 'idle';
        this._connectionState = 'disconnected';
        this._onMessage?.();
        reject(new Error('Reconnect timed out'));
      }, 60000);

      ws.onopen = () => {
        this._lastActivityTime = Date.now();
        this._startPingMonitor();

        // Send CONNECT with session_id + session data
        const payload: Record<string, unknown> = { timestamp: Math.floor(Date.now() / 1000) };
        payload.to = this.address;
        const signed = signPayload(this._keys, payload);
        const msg: Record<string, unknown> = { type: 'CONNECT', session_id: sid, ...signed };
        if (!isDirect) msg.to = this.address;
        if (this._currentSession) msg.session = { ...this._currentSession };
        ws.send(JSON.stringify(msg));
      };

      ws.onmessage = (evt: { data: unknown }) => this._handleMessage(evt);
      ws.onerror = () => this._handleConnectionLoss();
      ws.onclose = () => this._handleConnectionLoss();
    });
  }

  send(message: Record<string, unknown>): void {
    if (message.type === 'INTERRUPT') {
      this.interrupt();
      return;
    }
    if (message.type === 'APPROVAL_RESPONSE') {
      this.respondToApproval(
        message.approved === true,
        message.scope === 'session' ? 'session' : 'once',
        approvalRejectMode(message.mode),
        typeof message.feedback === 'string' ? message.feedback : undefined,
      );
      return;
    }
    if (message.type === 'ONBOARD_SUBMIT' && this._transportSelection?.kind === 'native-acp') {
      const payload = this._asRecord(message.payload);
      const inviteCode = typeof payload.invite_code === 'string'
        ? payload.invite_code
        : undefined;
      const payment = typeof payload.payment === 'number'
        ? payload.payment
        : undefined;
      const admission = { inviteCode, payment };
      this._error = null;
      const waiter = this._nativeAdmissionWaiter;
      if (waiter) {
        this._nativeAdmissionWaiter = null;
        waiter.resolve(admission);
      } else {
        this._nativeAdmission = admission;
        void this.connect().catch(() => {});
      }
      return;
    }
    if (this._native) {
      throw new Error(`Native ACP does not support Host message ${String(message.type)}`);
    }
    if (message.type === 'ONBOARD_SUBMIT') {
      this._sendOpen(message);
    } else {
      this._sendAuthenticated(message);
    }
    if (message.type === 'ASK_USER_RESPONSE') {
      for (let i = this._chatItems.length - 1; i >= 0; i--) {
        const item = this._chatItems[i];
        if (item.type === 'ask_user' && !item.answered) {
          item.answered = true;
          item.answer = String(message.answer || '');
          break;
        }
      }
      this._status = 'working';
      this._onMessage?.();
    } else if (
      message.type === 'APPROVAL_RESPONSE' ||
      message.type === 'PLAN_REVIEW_RESPONSE' ||
      message.type === 'FULL_ACCESS_RESPONSE' ||
      message.type === 'ONBOARD_SUBMIT'
    ) {
      this._status = 'working';
      this._onMessage?.();
    }
  }

  respondToApproval(
    approved: boolean,
    scope: 'once' | 'session',
    mode: ApprovalRejectMode = 'reject_hard',
    feedback?: string,
  ): void {
    const pending = this._pendingApproval;
    if (!pending || pending.answered) return;
    const rejectionMode = approvalRejectMode(mode);
    if (pending.native) {
      const option = this._nativePermissionOption(
        pending.native.request,
        approved,
        scope,
        rejectionMode,
      );
      pending.answered = true;
      pending.native.resolve({
        outcome: option
          ? { outcome: 'selected', optionId: option.optionId }
          : { outcome: 'cancelled' },
        ...(!approved && feedback && {
          _meta: { connectonion: { feedback } },
        }),
      });
      const item = this._chatItems.find(
        (candidate) => candidate.id === pending.chatItemId
          && candidate.type === 'approval_needed',
      );
      if (item?.type === 'approval_needed') item.answered = true;
      this._status = 'working';
      this._onMessage?.();
      return;
    }
    const response = pending.acp
      ? acpPermissionResponseFrame(
        pending.acp, approved, scope, rejectionMode, feedback,
      )
      : {
        type: 'APPROVAL_RESPONSE',
        approved,
        scope,
        ...(!approved && { mode: rejectionMode }),
        ...(!approved && feedback && { feedback }),
      };
    this._sendPendingApproval(pending, response);
  }

  interrupt(): void {
    if (this._interruptSent) return;
    const pending = this._pendingApproval;
    if (pending && !pending.answered) {
      if (pending.native) {
        pending.answered = true;
        pending.native.resolve({ outcome: { outcome: 'cancelled' } });
        const item = this._chatItems.find(
          (candidate) => candidate.id === pending.chatItemId
            && candidate.type === 'approval_needed',
        );
        if (item?.type === 'approval_needed') item.answered = true;
        this._status = 'working';
        this._interruptSent = true;
        this._onMessage?.();
        return;
      }
      const response = pending.acp
        ? acpPermissionCancelledFrame(pending.acp)
        : {
          type: 'APPROVAL_RESPONSE',
          approved: false,
          scope: 'once',
          mode: 'reject_hard',
        };
      this._sendPendingApproval(pending, response);
      this._interruptSent = true;
      return;
    }

    const sessionId = this._currentSession?.session_id;
    const nativeSessionId = this._currentSession?.acp_session_id;
    if (this._native && nativeSessionId) {
      this._interruptSent = true;
      void this._native.cancel({ sessionId: nativeSessionId }).catch((cause) => {
        this._error = cause instanceof Error ? cause : new Error(String(cause));
        this._onMessage?.();
      });
      return;
    }
    const message = this._supportsACPCancel && sessionId
      ? acpCancelFrame(sessionId)
      : { type: 'INTERRUPT' };
    this._sendAuthenticated(message);
    this._interruptSent = true;
  }

  private _sendPendingApproval(
    pending: PendingApproval,
    response: Record<string, unknown>,
  ): void {
    this._sendAuthenticated(response);
    pending.answered = true;
    const item = this._chatItems.find(
      (candidate) => candidate.id === pending.chatItemId
        && candidate.type === 'approval_needed',
    );
    if (item?.type === 'approval_needed') item.answered = true;
    this._status = 'working';
    this._onMessage?.();
  }

  /** Change durable Host permissions only after one owned acknowledgement. */
  async setPermissionProfile(profile: PermissionProfile): Promise<void> {
    try {
      if (!isCanonicalPermissionProfile(profile)) {
        throw new Error(`Unsupported permission profile: ${String(profile)}`);
      }
      if (this._pendingPermissionProfileChange) {
        throw new Error('A permission profile change is already pending');
      }
      if (this._nativePermissionProfileChangePending) {
        throw new Error('A permission profile change is already pending');
      }

      this._error = null;
      await this._ensureConnected();
      if (this._native) {
        const nativeSessionId = this._currentSession?.acp_session_id;
        if (!nativeSessionId) throw new Error('No authenticated native ACP session');
        const available = this._permissionProfileState?.availableModes ?? [];
        if (!available.some((item) => item.id === profile)) {
          throw new Error(`Permission profile is not available: ${profile}`);
        }
        if (this._currentSession?.mode === profile) return;
        this._nativePermissionProfileChangePending = true;
        this._onMessage?.();
        try {
          await this._native.setSessionMode({ sessionId: nativeSessionId, modeId: profile });
          this._applyServerMode(profile);
        } finally {
          this._nativePermissionProfileChangePending = false;
          this._onMessage?.();
        }
        return;
      }
      const sessionId = this._currentSession?.session_id;
      if (!sessionId || !this._ws || !this._authenticated) {
        throw new Error('No authenticated session');
      }
      if (!this._permissionProfileState) {
        throw new Error('Host does not support acknowledged permission profiles');
      }
      if (!this._permissionProfileState.availableModes.some((item) => item.id === profile)) {
        throw new Error(`Permission profile is not available: ${profile}`);
      }
      if (this._currentSession?.mode === profile) return;

      const requestId = generateUUID();
      const request = acpSetSessionModeFrame(requestId, sessionId, profile);
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          const pending = this._pendingPermissionProfileChange;
          if (pending?.requestId !== requestId) return;
          this._rejectPermissionProfileChange(
            pending,
            new Error('Permission profile change timed out'),
          );
        }, PERMISSION_PROFILE_CHANGE_TIMEOUT_MS);
        this._pendingPermissionProfileChange = {
          requestId,
          sessionId,
          profile,
          resolve,
          reject,
          timer,
        };
        this._onMessage?.();
        try {
          this._sendAuthenticated(request);
        } catch (cause) {
          const error = cause instanceof Error ? cause : new Error(String(cause));
          const pending = this._pendingPermissionProfileChange;
          if (pending) this._rejectPermissionProfileChange(pending, error);
        }
      });
    } catch (cause) {
      const error = cause instanceof Error ? cause : new Error(String(cause));
      if (this._error !== error) {
        this._error = error;
        this._onMessage?.();
      }
      throw error;
    }
  }

  /** @deprecated Use setPermissionProfile. */
  async setSessionMode(mode: PermissionProfile): Promise<void> {
    await this.setPermissionProfile(mode);
  }

  /** Change local collaboration intent without changing Host authority. */
  setCollaborationMode(mode: CollaborationMode): void {
    const collaboration = normalizeCollaborationMode(mode);
    if (!collaboration) {
      throw new Error(`Unsupported collaboration mode: ${String(mode)}`);
    }
    if (!this._currentSession) this._currentSession = {};
    if (this._currentSession.collaboration_mode === collaboration) return;
    this._currentSession.collaboration_mode = collaboration;
    this._onMessage?.();
  }

  /** @deprecated Use setCollaborationMode or await setPermissionProfile. */
  setMode(mode: ApprovalMode, _options?: { turns?: number }): void {
    const collaboration = normalizeCollaborationMode(mode);
    if (collaboration) {
      this.setCollaborationMode(collaboration);
      return;
    }
    const profile = normalizePermissionProfile(mode);
    if (!profile) throw new Error(`Unsupported permission profile: ${String(mode)}`);
    throw new Error(
      `Permission profile ${profile} requires await setPermissionProfile()`,
    );
  }

  private _applyServerMode(mode: PermissionProfile): boolean {
    if (this._currentSession?.mode === mode) {
      if (
        mode !== ':danger-full-access'
        && (
          this._currentSession.full_access_turns !== undefined
          || this._currentSession.full_access_turns_used !== undefined
        )
      ) {
        delete this._currentSession.full_access_turns;
        delete this._currentSession.full_access_turns_used;
        return true;
      }
      return false;
    }
    if (!this._currentSession) {
      this._currentSession = { mode };
    } else {
      this._currentSession.mode = mode;
      if (mode !== ':danger-full-access') {
        delete this._currentSession.full_access_turns;
        delete this._currentSession.full_access_turns_used;
      }
    }
    return true;
  }

  private _applyPlanUpdate(sessionId: string, entries: PlanEntry[]): boolean {
    if (sessionId !== this._currentSession?.session_id) return false;
    const current = this._currentSession.plan;
    if (
      current?.length === entries.length
      && current.every((entry, index) => {
        const next = entries[index];
        return entry.content === next.content
          && entry.priority === next.priority
          && entry.status === next.status;
      })
    ) return false;
    this._currentSession = {
      ...this._currentSession,
      plan: entries.map((entry) => ({ ...entry })),
    };
    return true;
  }

  /**
   * Accept a server snapshot without letting an absent or malformed optional
   * plan erase the last valid ACP state during a rolling Host upgrade.
   */
  private _applySessionSnapshot(value: unknown): void {
    const canonical = normalizeSessionState(value);
    if (!canonical) return;
    const raw = value as Record<string, unknown>;
    const snapshot = { ...canonical };
    const sameSession = typeof raw.session_id === 'string'
      && raw.session_id.length > 0
      && raw.session_id === this._currentSession?.session_id;
    const normalized = Object.prototype.hasOwnProperty.call(raw, 'plan')
      ? normalizePlanEntries(raw.plan)
      : null;
    if (normalized) {
      snapshot.plan = normalized;
    } else if (sameSession && this._currentSession?.plan) {
      snapshot.plan = this._currentSession.plan.map((entry) => ({ ...entry }));
    } else {
      delete snapshot.plan;
    }
    this._currentSession = snapshot;
  }

  private _resolvePermissionProfileChange(
    pending: PendingPermissionProfileChange,
    response: ACPSetModeResponse,
  ): void {
    if (this._pendingPermissionProfileChange !== pending) return;
    clearTimeout(pending.timer);
    this._pendingPermissionProfileChange = null;
    if ('error' in response) {
      const error = new Error(response.error.message);
      (error as Error & { code?: number; data?: unknown }).code = response.error.code;
      (error as Error & { code?: number; data?: unknown }).data = response.error.data;
      this._error = error;
      pending.reject(error);
      this._onMessage?.();
      return;
    }
    this._applyServerMode(pending.profile);
    this._error = null;
    pending.resolve();
    this._onMessage?.();
  }

  private _rejectPermissionProfileChange(
    pending: PendingPermissionProfileChange,
    error: Error,
  ): void {
    if (this._pendingPermissionProfileChange !== pending) return;
    clearTimeout(pending.timer);
    this._pendingPermissionProfileChange = null;
    this._error = error;
    pending.reject(error);
    this._onMessage?.();
  }

  reset(): void {
    const resetError = new Error('Connection reset');
    this._connectionEpoch += 1;
    this._rejectNativeAdmissionWaiter(resetError);
    this._nativePromptReject?.(resetError);
    this._connecting = null;
    const reject = this._inputReject;
    this._reconnecting = null;
    this._settleReconnectReady(resetError);
    this._closeNative(true);
    this._closeWs();
    this._currentSession = null;
    this._chatItems = [];
    this._status = 'idle';
    this._connectionState = 'disconnected';
    this._error = null;
    this._pendingApproval = null;
    this._transportSelection = null;
    this._selectingTransport = null;
    this._nativeAdmission = undefined;
    this._nativePermissionProfileChangePending = false;
    this._settleInput();
    reject?.(resetError);
    this._settleSessionStatusWaiters('not_found');
  }

  resetConversation(): void { this.reset(); }

  signOnboard(options: { inviteCode?: string; payment?: number }): Record<string, unknown> {
    const payload: Record<string, unknown> = { timestamp: Math.floor(Date.now() / 1000) };
    if (options.inviteCode) payload.invite_code = options.inviteCode;
    if (options.payment) payload.payment = options.payment;
    return { type: 'ONBOARD_SUBMIT', ...signPayload(this._keys, payload) };
  }

  async checkSessionStatus(sessionId: string): Promise<RemoteSessionStatus> {
    if (getNativeACPDriver()) {
      if (sessionId !== this._currentSession?.session_id) return 'not_found';
      try {
        await this._ensureConnected();
      } catch {
        return 'not_found';
      }
      if (this._native) return this._nativePrompt ? 'running' : 'connected';
    }
    // If we have a live WS, send SESSION_STATUS over it (no new connection needed)
    if (this._authenticated && this._isSocketOpen(this._ws)) {
      return new Promise((resolve) => {
        const existing = this._sessionStatusWaiters.get(sessionId);
        if (existing) {
          existing.resolves.push(resolve);
          return;
        }

        const timer = setTimeout(() => {
          const waiter = this._sessionStatusWaiters.get(sessionId);
          if (!waiter) return;
          this._sessionStatusWaiters.delete(sessionId);
          for (const resolve of waiter.resolves) resolve('not_found');
        }, 5000);
        this._sessionStatusWaiters.set(sessionId, { resolves: [resolve], timer });
        this._ws!.send(JSON.stringify({
          type: 'SESSION_STATUS',
          session: { session_id: sessionId },
        }));
      });
    }

    // No active connection — open a short-lived WS just for the check
    this._keys = ensureKeys(this._keys);
    await this._resolveEndpointOnce();
    const { wsUrl, isDirect } = this._resolveWsUrl();

    return new Promise((resolve) => {
      const ws = new this._WS(wsUrl);
      const timeout = setTimeout(() => { ws.close(); resolve('not_found'); }, 5000);
      ws.onopen = () => {
        ws.send(JSON.stringify({
          type: 'SESSION_STATUS',
          session: { session_id: sessionId },
          ...(!isDirect && { to: this.address }),
        }));
      };
      ws.onmessage = (evt: { data: unknown }) => {
        const data = JSON.parse(typeof evt.data === 'string' ? evt.data : String(evt.data));
        if (data?.type === 'SESSION_STATUS') {
          clearTimeout(timeout);
          ws.close();
          resolve(this._normalizeSessionStatus(data.status));
        }
      };
      ws.onerror = () => { clearTimeout(timeout); ws.close(); resolve('not_found'); };
    });
  }

  async checkSession(sessionId?: string): Promise<'running' | 'done' | 'not_found'> {
    const sid = sessionId || this._currentSession?.session_id;
    if (!sid) return 'not_found';
    await this._resolveEndpointOnce();
    const httpUrl = this._directUrl || this._resolvedEndpoint?.httpUrl;
    if (!httpUrl) return 'not_found';
    const res = await fetch(`${httpUrl}/sessions/${sid}`).catch(() => null);
    if (!res || !res.ok) return 'not_found';
    const data = await res.json().catch(() => null) as { status?: string } | null;
    return data?.status === 'running' ? 'running' : 'done';
  }

  toString(): string {
    const short = this.address.length > 12 ? this.address.slice(0, 12) + '...' : this.address;
    return `RemoteAgent(${short})`;
  }

  // --- Internal helpers (used by useAgentForHuman) ---

  _addChatItem(event: Partial<ChatItem> & { type: ChatItemType }): void {
    const id = (event as { id?: string }).id || generateUUID();
    const existingIdx = this._chatItems.findIndex(item => item.id === id);
    if (existingIdx !== -1) {
      this._chatItems[existingIdx] = { ...this._chatItems[existingIdx], ...event, id } as ChatItem;
      return;
    }
    this._chatItems.push({ ...event, id } as ChatItem);
  }

  _clearPlaceholder(): void {
    const idx = this._chatItems.findIndex(item => item.id === '__optimistic__');
    if (idx !== -1) this._chatItems.splice(idx, 1);
  }

  // Replace local chat items with server's canonical history, preserving any
  // optimistic items (user prompts + thinking placeholder) the client appended
  // after the last user message the server knows about. Naive
  // [...userItems, ...serverNonUserItems] reorders into [user, user, agent, agent]
  // when the client added an optimistic user before reconnecting.
  private _mergeServerChatItems(value: unknown): void {
    const serverItems = normalizeChatItems(value);
    const serverUserCount = serverItems.filter(i => i.type === 'user').length;
    let seen = 0;
    let cutoff = this._chatItems.length;
    for (let i = 0; i < this._chatItems.length; i++) {
      if (this._chatItems[i].type === 'user' && ++seen > serverUserCount) {
        cutoff = i;
        break;
      }
    }
    if (cutoff === this._chatItems.length) {
      // Local history can be SHORTER than the server's (fresh browser, evicted
      // session), so the count check above never fires and a just-sent prompt
      // would be silently dropped. Preserve the tail from the last local user
      // prompt onward unless the server already has that exact prompt last.
      const lastServerUser = [...serverItems].reverse().find(i => i.type === 'user');
      for (let i = this._chatItems.length - 1; i >= 0; i--) {
        const item = this._chatItems[i];
        if (item.type !== 'user') continue;
        if (!lastServerUser || item.content !== lastServerUser.content) cutoff = i;
        break;
      }
    }
    this._chatItems = [...serverItems, ...this._chatItems.slice(cutoff)];
  }

  // --- Private: connection lifecycle ---

  private _ensureConnected(): Promise<void> {
    if (this._hasReadyConnection()) return Promise.resolve();
    if (this._reconnecting) return this._waitForReconnectReady();
    if (this._connecting) return this._connecting;

    const attempt = this._doSelectedConnect();
    this._connecting = attempt;
    // Clear on settle either way (both branches handled, so this derived promise
    // never surfaces as an unhandled rejection — `attempt` is what callers await).
    const clear = () => { if (this._connecting === attempt) this._connecting = null; };
    attempt.then(clear, clear);
    return attempt;
  }

  private async _doSelectedConnect(): Promise<void> {
    const driver = getNativeACPDriver();
    if (!driver) {
      await this._doConnect();
      return;
    }
    const selection = await this._selectTransport();
    if (selection.kind === 'native-acp') {
      await this._doNativeConnect(selection, driver);
      return;
    }
    this._resolvedEndpoint = selection.kind === 'legacy-direct'
      ? { httpUrl: selection.httpUrl, wsUrl: selection.wsUrl }
      : undefined;
    this._endpointResolutionAttempted = true;
    await this._doConnect();
  }

  private _selectTransport(): Promise<BrowserTransportSelection> {
    if (this._transportSelection) return Promise.resolve(this._transportSelection);
    if (this._selectingTransport) return this._selectingTransport;
    const attempt = selectBrowserTransport({
      agentAddress: this.address,
      relayUrl: this._relayUrl,
      directUrl: this._directUrl,
    });
    this._selectingTransport = attempt;
    const settle = (selection: BrowserTransportSelection) => {
      if (this._selectingTransport === attempt) {
        this._transportSelection = selection;
        this._selectingTransport = null;
      }
      return selection;
    };
    const fail = (cause: unknown): never => {
      if (this._selectingTransport === attempt) this._selectingTransport = null;
      throw cause;
    };
    return attempt.then(settle, fail);
  }

  private async _doNativeConnect(
    selection: Extract<BrowserTransportSelection, { kind: 'native-acp' }>,
    driver: NonNullable<ReturnType<typeof getNativeACPDriver>>,
  ): Promise<void> {
    if (this._native) return;
    const connectionEpoch = this._connectionEpoch;
    const resumeStatus = this._status === 'working' ? 'working' : 'idle';
    this._keys = ensureKeys(this._keys);
    this._connectionState = this._currentSession?.acp_session_id
      ? 'reconnecting'
      : 'disconnected';
    this._onMessage?.();

    let admission = this._nativeAdmission;
    this._nativeAdmission = undefined;
    let connection: NativeACPConnection;
    while (true) {
      if (connectionEpoch !== this._connectionEpoch) throw new Error('Connection reset');
      try {
        connection = await driver.open({
          agentAddress: this.address,
          httpUrl: selection.httpUrl,
          transport: selection.transport,
          keys: this._keys,
          admission,
        }, {
          onSessionUpdate: (sessionId, update) => {
            this._handleNativeSessionUpdate(sessionId, update);
          },
          requestPermission: (request) => this._requestNativePermission(request),
          onClose: (error) => this._handleNativeConnectionLoss(error),
        });
        if (connectionEpoch !== this._connectionEpoch) {
          connection.close();
          throw new Error('Connection reset');
        }
        break;
      } catch (cause) {
        if (
          !(cause instanceof ACPBrowserAdmissionError)
          || cause.reason !== 'trust'
          || !selection.onboard
          || (!selection.onboard.inviteCode && selection.onboard.payment === null)
        ) throw cause;

        this._connectionState = 'disconnected';
        this._status = 'waiting';
        this._error = admission ? cause : null;
        this._showNativeOnboardGate(selection);
        this._onMessage?.();
        admission = await this._waitForNativeAdmission();
        if (connectionEpoch !== this._connectionEpoch) throw new Error('Connection reset');
        this._status = resumeStatus;
        this._error = null;
        this._onMessage?.();
      }
    }

    try {
      if (connection.protocolVersion !== 1) {
        throw new Error(`Unsupported ACP protocol version: ${connection.protocolVersion}`);
      }
      const existing = this._currentSession?.acp_session_id;
      let modes: unknown;
      if (existing) {
        if (connection.agentCapabilities.sessionCapabilities?.resume == null) {
          throw new Error('Agent does not support ACP session/resume');
        }
        const resumed = await connection.resumeSession({
          sessionId: existing,
          cwd: '/',
          mcpServers: [],
        });
        modes = resumed.modes;
      } else {
        const created = await connection.newSession({ cwd: '/', mcpServers: [] });
        if (!created.sessionId) throw new Error('Agent returned an empty ACP session ID');
        if (!this._currentSession) this._currentSession = {};
        this._currentSession.acp_session_id = created.sessionId;
        modes = created.modes;
      }
      const normalizedModes = normalizeNativeSessionModeState(modes);
      if (modes != null && !normalizedModes) {
        throw new Error('Agent returned malformed ACP permission modes');
      }
      this._permissionProfileState = normalizedModes;
      if (normalizedModes) this._applyServerMode(normalizedModes.currentModeId);
      this._native = connection;
      this._connectionState = 'connected';
      this._error = null;
      if (connection.agentInfo) {
        this._profile = {
          address: this.address,
          name: connection.agentInfo.name,
          version: connection.agentInfo.version,
          online: true,
        };
      }
      if (admission) {
        this._addChatItem({
          type: 'onboard_success',
          level: 'contact',
          message: 'Access granted',
        });
      }
      this._onMessage?.();
    } catch (cause) {
      connection.close();
      throw cause;
    }
  }

  private async _doConnect(): Promise<void> {
    // A socket left over from a failed attempt is dead weight: _authenticated is
    // false, so nothing can use it, and overwriting _ws below would leak it.
    if (this._ws && !this._hasReadyConnection()) this._closeWs();

    this._keys = ensureKeys(this._keys);
    await this._resolveEndpointOnce();

    const { wsUrl, isDirect } = this._resolveWsUrl();
    const ws = new this._WS(wsUrl);
    this._ws = ws;

    // Wait for open
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => {
        this._connectionState = 'connected';
        this._lastActivityTime = Date.now();
        this._startPingMonitor();
        resolve();
      };
      ws.onerror = (err) => reject(new Error(`WebSocket connection failed: ${String(err)}`));
    });

    // Wire up persistent message handler
    ws.onmessage = (evt: { data: unknown }) => this._handleMessage(evt);
    ws.onerror = () => this._handleConnectionLoss();
    ws.onclose = () => this._handleConnectionLoss();

    // Send CONNECT with session (conversation history)
    const payload: Record<string, unknown> = { timestamp: Math.floor(Date.now() / 1000) };
    payload.to = this.address;
    const signed = signPayload(this._keys, payload);
    const connectMsg: Record<string, unknown> = { type: 'CONNECT', ...signed };
    if (!isDirect) connectMsg.to = this.address;
    if (this._currentSession?.session_id) connectMsg.session_id = this._currentSession.session_id;
    if (this._currentSession) connectMsg.session = { ...this._currentSession };
    ws.send(JSON.stringify(connectMsg));

    // Wait for CONNECTED response
    const connected = await new Promise<Record<string, unknown>>((resolve, reject) => {
      this._connectResolve = resolve;
      this._connectReject = reject;
      this._connectTimer = setTimeout(() => {
        this._connectTimer = null;
        if (this._connectResolve) {
          this._connectResolve = null;
          this._connectReject = null;
          reject(new Error('Authentication timed out'));
        }
      }, 30000);
    });

    this._authenticated = true;

    // Update session from server (may include merged data)
    const sid = connected.session_id as string;
    if (sid) {
      if (!this._currentSession) {
        this._currentSession = { session_id: sid };
      } else {
        this._currentSession.session_id = sid;
      }
    }
    if (connected.server_newer && connected.session) {
      this._applySessionSnapshot(connected.session);
    }
    // CONNECTED capability state is authoritative. A server_newer session can
    // still contain the pre-transaction mode, so reapply the advertised value
    // after accepting the durable conversation snapshot.
    if (this._permissionProfileState) {
      this._applyServerMode(this._permissionProfileState.currentModeId);
    }
    if (connected.server_newer && connected.chat_items && Array.isArray(connected.chat_items)) {
      this._mergeServerChatItems(connected.chat_items as ChatItem[]);
      this._onMessage?.();
    }
  }

  private async _promptNative(
    prompt: string,
    options?: { images?: string[]; files?: import('./types').FileAttachment[] },
  ): Promise<Response> {
    if (!this._native) throw new Error('Native ACP connection is not ready');
    if (this._nativePrompt) {
      const error = new Error('Native ACP session is already processing a prompt');
      this._error = error;
      this._clearPlaceholder();
      this._status = 'idle';
      this._onMessage?.();
      throw error;
    }
    const sessionId = this._currentSession?.acp_session_id;
    if (!sessionId) throw new Error('Native ACP session is absent');

    let blocks: NativeACPContentBlock[];
    try {
      blocks = this._nativeContentBlocks(prompt, options);
    } catch (cause) {
      const error = cause instanceof Error ? cause : new Error(String(cause));
      this._error = error;
      this._clearPlaceholder();
      this._status = 'idle';
      this._onMessage?.();
      throw error;
    }
    const connectionEpoch = this._connectionEpoch;
    this._nativeResponseText = '';
    let rejectPrompt!: (error: Error) => void;
    const externallyRejected = new Promise<never>((_resolve, reject) => {
      rejectPrompt = reject;
    });
    this._nativePromptReject = rejectPrompt;
    const promptRequest = this._native.prompt({ sessionId, prompt: blocks });
    const attempt = Promise.race([promptRequest, externallyRejected])
      .then((result): Response => {
        if (connectionEpoch !== this._connectionEpoch) {
          throw new Error('Connection reset');
        }
        this._clearPlaceholder();
        this._failUnsettledNativePermissionTool();
        this._pendingApproval = null;
        this._status = 'idle';
        this._onMessage?.();
        return {
          text: this._nativeResponseText,
          done: result.stopReason !== 'cancelled',
        };
      })
      .catch((cause): never => {
        const error = cause instanceof Error ? cause : new Error(String(cause));
        if (connectionEpoch !== this._connectionEpoch) throw error;
        this._error = error;
        this._clearPlaceholder();
        this._failUnsettledNativePermissionTool();
        this._pendingApproval = null;
        this._status = 'idle';
        this._onMessage?.();
        throw error;
      });
    this._nativePrompt = attempt;
    const clear = () => {
      if (this._nativePrompt !== attempt) return;
      this._nativePrompt = null;
      this._nativePromptReject = null;
    };
    attempt.then(clear, clear);
    return attempt;
  }

  private _nativeContentBlocks(
    prompt: string,
    options?: { images?: string[]; files?: import('./types').FileAttachment[] },
  ): NativeACPContentBlock[] {
    const blocks: NativeACPContentBlock[] = [{ type: 'text', text: prompt }];
    const capabilities = this._native?.agentCapabilities.promptCapabilities;
    const images = options?.images ?? [];
    if (images.length && capabilities?.image !== true) {
      throw new Error('Agent does not support ACP image prompts');
    }
    for (const image of images) {
      const data = this._parseDataUrl(image);
      if (!['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(data.mimeType)) {
        throw new Error(`Unsupported ACP image MIME type: ${data.mimeType}`);
      }
      blocks.push({ type: 'image', data: data.base64, mimeType: data.mimeType });
    }

    const files = options?.files ?? [];
    if (files.length && capabilities?.embeddedContext !== true) {
      throw new Error('Agent does not support ACP embedded file prompts');
    }
    for (const file of files) {
      const data = this._parseDataUrl(file.dataUrl);
      const mimeType = file.type || data.mimeType || 'application/octet-stream';
      if (mimeType !== data.mimeType && file.type) {
        throw new Error(`File MIME type does not match its data URL: ${file.name}`);
      }
      const uri = `connectonion-upload:/${encodeURIComponent(file.name)}`;
      blocks.push({
        type: 'resource',
        resource: { uri, mimeType, blob: data.base64 },
      });
    }
    return blocks;
  }

  private _parseDataUrl(value: string): { mimeType: string; base64: string } {
    const match = /^data:([^;,]{1,127});base64,([A-Za-z0-9+/]*={0,2})$/.exec(value);
    if (!match || match[2].length % 4 !== 0) {
      throw new Error('Attachment must be a canonical base64 data URL');
    }
    return { mimeType: match[1].toLowerCase(), base64: match[2] };
  }

  private _handleNativeSessionUpdate(sessionId: string, update: unknown): void {
    if (sessionId !== this._currentSession?.acp_session_id) return;
    const record = typeof update === 'object' && update !== null
      ? update as Record<string, unknown>
      : null;
    if (record?.sessionUpdate === 'current_mode_update') {
      const mode = parsePermissionProfile(record.currentModeId);
      if (mode && this._applyServerMode(mode)) this._onMessage?.();
      return;
    }
    if (record?.sessionUpdate === 'plan') {
      const entries = normalizePlanEntries(record.entries);
      const localSessionId = this._currentSession?.session_id;
      if (entries && localSessionId && this._applyPlanUpdate(localSessionId, entries)) {
        this._onMessage?.();
      }
      return;
    }
    const event = decodeNativeACPUpdate(update);
    if (!event) return;
    if (typeof event.content === 'string' && typeof event.id === 'string') {
      const chunk = event.content;
      if (event.type === 'assistant') {
        this._nativeResponseText += chunk;
        const current = this._chatItems.find(
          (item) => item.type === 'agent' && item.id === event.id,
        );
        if (current?.type === 'agent') event.content = `${current.content}${chunk}`;
      } else if (event.type === 'thinking') {
        const current = this._chatItems.find(
          (item) => item.type === 'thinking' && item.id === event.id,
        );
        if (current?.type === 'thinking') {
          event.content = `${current.content ?? ''}${chunk}`;
        }
      }
    }
    const accepted = mapEventToChatItem(
      this._chatItems,
      event,
      (item) => this._addChatItem(item),
      undefined,
    );
    if (accepted) {
      this._clearPlaceholder();
      this._onMessage?.();
    }
  }

  private _requestNativePermission(
    request: NativeACPPermissionRequest,
  ): Promise<NativeACPPermissionResponse> {
    if (request.sessionId !== this._currentSession?.acp_session_id) {
      return Promise.resolve({ outcome: { outcome: 'cancelled' } });
    }
    if (
      !request.toolCall.toolCallId
      || !request.toolCall.title
      || request.toolCall.status !== 'pending'
      || !request.options.length
    ) return Promise.resolve({ outcome: { outcome: 'cancelled' } });
    const toolCallId = request.toolCall.toolCallId;
    const existingItem = this._chatItems.find((item) => item.id === toolCallId);
    if (
      existingItem
      && (existingItem.type !== 'tool_call' || existingItem.status !== 'running')
    ) return Promise.resolve({ outcome: { outcome: 'cancelled' } });
    const current = this._pendingApproval;
    if (current && !current.answered) {
      return Promise.resolve({ outcome: { outcome: 'cancelled' } });
    }
    return new Promise<NativeACPPermissionResponse>((resolve) => {
      const chatItemId = request.requestId;
      const arguments_ = this._asRecord(request.toolCall.rawInput);
      this._pendingApproval = {
        chatItemId,
        answered: false,
        native: { request, resolve },
      };
      this._status = 'waiting';
      if (existingItem?.type === 'tool_call') {
        existingItem.name = request.toolCall.title!;
        if (request.toolCall.rawInput !== undefined) existingItem.args = arguments_;
      } else {
        this._addChatItem({
          type: 'tool_call',
          id: toolCallId,
          name: request.toolCall.title!,
          args: arguments_,
          status: 'running',
        });
      }
      this._addChatItem({
        type: 'approval_needed',
        id: chatItemId,
        tool: request.toolCall.title!,
        arguments: arguments_,
      });
      this._onMessage?.();
    });
  }

  private _nativePermissionOption(
    request: NativeACPPermissionRequest,
    approved: boolean,
    scope: 'once' | 'session',
    rejectionMode: ApprovalRejectMode,
  ) {
    const preferredId = approved
      ? scope === 'session' ? 'allow_session' : 'allow_once'
      : rejectionMode === 'reject_hard' ? 'reject_once' : rejectionMode;
    const preferredKind = approved
      ? scope === 'session' ? 'allow_always' : 'allow_once'
      : rejectionMode === 'reject_hard' ? 'reject_once' : 'reject_once';
    return request.options.find((option) => option.optionId === preferredId)
      ?? request.options.find((option) => option.kind === preferredKind);
  }

  private _failUnsettledNativePermissionTool(): void {
    const toolCallId = this._pendingApproval?.native?.request.toolCall.toolCallId;
    if (!toolCallId) return;
    const item = this._chatItems.find(
      (candidate) => candidate.type === 'tool_call' && candidate.id === toolCallId,
    );
    // The prompt has ended, so `running` is no longer truthful. Without an
    // official terminal tool update, fail closed instead of manufacturing a
    // successful side effect or leaving restored UIs permanently active.
    if (item?.type === 'tool_call' && item.status === 'running') item.status = 'error';
  }

  private _asRecord(value: unknown): Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? value as Record<string, unknown>
      : {};
  }

  private _handleNativeConnectionLoss(error?: Error): void {
    this._native = null;
    this._connectionState = 'disconnected';
    this._permissionProfileState = null;
    const connectionError = error ?? new Error('Native ACP connection closed');
    if (this._pendingApproval?.native && !this._pendingApproval.answered) {
      this._pendingApproval.answered = true;
      this._pendingApproval.native.resolve({ outcome: { outcome: 'cancelled' } });
    }
    if (this._nativePrompt) {
      this._status = 'idle';
      this._error = connectionError;
      this._nativePromptReject?.(connectionError);
    }
    this._onMessage?.();
  }

  private _showNativeOnboardGate(
    selection: Extract<BrowserTransportSelection, { kind: 'native-acp' }>,
  ): void {
    const lastGate = [...this._chatItems].reverse().find(
      (item) => item.type === 'onboard_required' || item.type === 'onboard_success',
    );
    if (lastGate?.type === 'onboard_required') return;
    const onboard = selection.onboard!;
    this._addChatItem({
      type: 'onboard_required',
      methods: [
        ...(onboard.inviteCode ? ['invite_code'] : []),
        ...(onboard.payment !== null ? ['payment'] : []),
      ],
      ...(onboard.payment !== null
        ? { paymentAmount: onboard.payment, paymentAddress: this.address }
        : {}),
    });
  }

  private _waitForNativeAdmission(): Promise<ACPBrowserAdmission> {
    if (this._nativeAdmission) {
      const admission = this._nativeAdmission;
      this._nativeAdmission = undefined;
      return Promise.resolve(admission);
    }
    return new Promise<ACPBrowserAdmission>((resolve, reject) => {
      this._nativeAdmissionWaiter = { resolve, reject };
    });
  }

  private _rejectNativeAdmissionWaiter(error: Error): void {
    const waiter = this._nativeAdmissionWaiter;
    this._nativeAdmissionWaiter = null;
    waiter?.reject(error);
  }

  private _closeNative(closeSession: boolean): void {
    const connection = this._native;
    if (!connection) return;
    this._native = null;
    const sessionId = this._currentSession?.acp_session_id;
    if (
      closeSession
      && sessionId
      && connection.agentCapabilities.sessionCapabilities?.close != null
    ) {
      void connection.closeSession({ sessionId })
        .catch(() => {})
        .finally(() => connection.close());
    } else {
      connection.close();
    }
    this._connectionState = 'disconnected';
    this._permissionProfileState = null;
  }

  private _handleMessage(evt: { data: unknown }): void {
    const raw = typeof evt.data === 'string' ? evt.data : String(evt.data);
    const data = JSON.parse(raw);

    // Any inbound frame proves the link is alive — reset the liveness clock on EVERY
    // message, not just PING. Otherwise a busy task (streaming tool calls + screenshots)
    // can delay the periodic PING past the 60s threshold and the monitor false-positives
    // a dead connection mid-run, dropping it while data is actively flowing.
    this._lastActivityTime = Date.now();

    // PING/PONG keepalive — PING also covers idle periods with no other traffic.
    if (data?.type === 'PING') {
      this._ws?.send(JSON.stringify({ type: 'PONG' }));
      return;
    }

    // CONNECTED — resolve ensureConnected() promise
    if (data?.type === 'CONNECTED') {
      this._supportsACPCancel = hostSupportsACPCancel(data);
      this._permissionProfileState = hostSessionModeState(data);
      if (this._permissionProfileState) {
        this._applyServerMode(this._permissionProfileState.currentModeId);
      }
      if (this._connectResolve) {
        if (this._connectTimer) { clearTimeout(this._connectTimer); this._connectTimer = null; }
        const resolve = this._connectResolve;
        this._connectResolve = null;
        this._connectReject = null;
        resolve(data);
        this._onMessage?.();
        return;
      }

      // CONNECTED during reconnect — update session and UI if server has newer data
      if (data.server_newer && data.session) {
        this._applySessionSnapshot(data.session);
      }
      if (data.server_newer && data.chat_items && Array.isArray(data.chat_items)) {
        this._mergeServerChatItems(data.chat_items as ChatItem[]);
      }
      const reconnectSid = data.session_id as string;
      if (reconnectSid && this._currentSession) {
        this._currentSession.session_id = reconnectSid;
      }
      // Keep the Host's ACP SessionModeState above any stale mode carried by
      // the synchronized legacy session snapshot.
      if (this._permissionProfileState) {
        this._applyServerMode(this._permissionProfileState.currentModeId);
      }
      this._authenticated = true;
      this._connectionState = 'connected';
      this._settleReconnectReady();
      // An idle/new session has no output left to wait for. Hosts in the rollout
      // have used both "connected" and "idle" for that same state.
      if (
        (data.status as string) === 'connected'
        || (data.status as string) === 'idle'
        || (data.status as string) === 'new'
      ) {
        this._status = 'idle';
        const resolve = this._inputResolve;
        this._settleInput();
        resolve?.({ text: '', done: true });
      }
      // If status is "running", events will stream in via _handleMessage — don't resolve yet
      this._onMessage?.();
      return;
    }

    // Session sync
    if (data?.type === 'session_sync' && data.session) {
      this._applySessionSnapshot(data.session);
    }

    if (data?.type === 'SESSION_STATUS') {
      const sid = typeof data.session_id === 'string' ? data.session_id : '';
      const waiter = sid ? this._sessionStatusWaiters.get(sid) : undefined;
      if (waiter) {
        clearTimeout(waiter.timer);
        this._sessionStatusWaiters.delete(sid);
        const status = this._normalizeSessionStatus(data.status);
        for (const resolve of waiter.resolves) resolve(status);
      }
      return;
    }

    if (data?.type === 'ACP_RESPONSE') {
      const pending = this._pendingPermissionProfileChange;
      if (!pending || acpResponseRequestId(data) !== pending.requestId) return;
      const response = decodeACPSetModeResponse(data);
      if (!response || response.sessionId !== pending.sessionId) {
        this._rejectPermissionProfileChange(
          pending,
          new Error('Malformed or wrong-session ACP mode response'),
        );
        return;
      }
      this._resolvePermissionProfileChange(pending, response);
      return;
    }

    if (data?.type === 'RECONNECTED') {
      // Server confirmed reconnect — events will follow
    }

    if (data?.type === 'SESSION_MERGED' && data.server_newer) {
      // Server had newer session
    }

    const acpMode = decodeACPModeUpdate(data);
    if (acpMode) {
      if (
        acpMode.sessionId === this._currentSession?.session_id
        && this._applyServerMode(acpMode.mode)
      ) this._onMessage?.();
      return;
    }

    const acpPlan = decodeACPPlanUpdate(data);
    if (acpPlan) {
      if (this._applyPlanUpdate(acpPlan.sessionId, acpPlan.entries)) {
        this._onMessage?.();
      }
      return;
    }

    const legacyPlan = decodeLegacyPlanUpdate(data);
    if (legacyPlan) {
      if (this._applyPlanUpdate(legacyPlan.sessionId, legacyPlan.entries)) {
        this._onMessage?.();
      }
      return;
    }

    if (data?.type === 'mode_changed') {
      const profile = parsePermissionProfile(data.mode);
      if (profile && this._applyServerMode(profile)) this._onMessage?.();
      return;
    }

    const fullAccessCheckpoint = normalizeFullAccessCheckpointFrame(data);
    if (fullAccessCheckpoint) {
      this._status = 'waiting';
      if (this._currentSession) {
        this._currentSession.full_access_turns_used = fullAccessCheckpoint.turnsUsed;
      }
      this._addChatItem({
        type: 'full_access_checkpoint',
        turns_used: fullAccessCheckpoint.turnsUsed,
        max_turns: fullAccessCheckpoint.maxTurns,
      });
    }

    // Stream events → ChatItem mapping
    if (data?.type === 'llm_call' || data?.type === 'llm_result' ||
        data?.type === 'tool_call' || data?.type === 'tool_result' ||
        data?.type === 'tool_call_update' || data?.type === 'ACP_NOTIFICATION' ||
        data?.type === 'thinking' || data?.type === 'assistant' ||
        data?.type === 'agent_image' ||
        data?.type === 'intent' || data?.type === 'eval' || data?.type === 'compact' ||
        data?.type === 'tool_blocked' || data?.type === 'files_received') {
      const accepted = mapEventToChatItem(
        this._chatItems,
        data,
        (item) => this._addChatItem(item),
        this._currentSession?.session_id,
      );
      if (accepted) this._clearPlaceholder();
      if (accepted && data.session) {
        this._applySessionSnapshot(data.session);
      }
    }

    // Interactive events
    if (data?.type === 'ask_user') {
      this._status = 'waiting';
      this._addChatItem({
        type: 'ask_user',
        id: data.id != null ? String(data.id) : undefined,
        text: String(data.text || data.question || ''),
        options: Array.isArray(data.options) ? data.options as string[] : [],
        multi_select: Boolean(data.multi_select),
        ...(typeof data.input_type === 'string' && { input_type: data.input_type }),
        ...(Array.isArray(data.fields) && { fields: data.fields as import('./types').AskUserField[] }),
      });
    }

    if (data?.type === 'ACP_REQUEST') {
      const request = decodeACPPermissionRequest(data);
      if (request && request.sessionId === this._currentSession?.session_id) {
        const current = this._pendingApproval;
        const sameRequest = current?.acp?.requestId === request.requestId;
        if (sameRequest && current.answered) {
          // A reconnect may replay the request after the user's decision left
          // this process. Keep the card answered and never send it twice.
        } else if (!current || current.answered || sameRequest) {
          this._pendingApproval = {
            chatItemId: request.requestId,
            answered: false,
            acp: request,
          };
          this._status = 'waiting';
          this._addChatItem({
            type: 'approval_needed',
            id: request.requestId,
            tool: request.title,
            arguments: request.rawInput,
          });
        }
      }
    }

    if (data?.type === 'approval_needed') {
      const toolCallId = typeof data.tool_call_id === 'string'
        ? data.tool_call_id
        : undefined;
      const requestId = typeof data.id === 'string' ? data.id : undefined;
      const current = this._pendingApproval;
      const isACPPair = current?.acp && (
        current.acp?.toolCallId === toolCallId
        || current.acp?.requestId === requestId
      );
      const chatItemId = isACPPair
        ? current.chatItemId
        : requestId || generateUUID();
      if (!isACPPair) {
        this._pendingApproval = {
          chatItemId,
          answered: false,
        };
      }
      this._status = 'waiting';
      this._addChatItem({
        type: 'approval_needed',
        id: chatItemId,
        tool: data.tool as string,
        arguments: data.arguments as Record<string, unknown>,
        ...(data.description && { description: data.description as string }),
        ...(data.batch_remaining && { batch_remaining: data.batch_remaining as Array<{ tool: string; arguments: string }> }),
      });
    }

    if (data?.type === 'plan_review') {
      this._status = 'waiting';
      this._addChatItem({ type: 'plan_review', plan_content: data.plan_content as string });
    }

    // Onboard flow
    if (data?.type === 'ONBOARD_REQUIRED') {
      // The gate hands this connection to a human (invite code / payment) —
      // stop the 30s auth deadline; CONNECTED after onboard resumes the
      // pending connect promise, and the ping monitor still bounds dead sockets.
      if (this._connectTimer) { clearTimeout(this._connectTimer); this._connectTimer = null; }
      this._status = 'waiting';
      this._addChatItem({
        type: 'onboard_required',
        methods: (data.methods || []) as string[],
        paymentAmount: data.payment_amount as number | undefined,
        // Where to send it. The host publishes this and protocol.md documents
        // it; dropping it made the payment branch of an onboard gate unusable,
        // because a client could ask for money without saying where.
        //
        // @connectonion/react owns the supported browser protocol implementation.
        // Keep this normalization here; the retired standalone TypeScript SDK is
        // not a second source of truth.
        paymentAddress: data.payment_address as string | undefined,
      });
    }

    if (data?.type === 'ONBOARD_SUCCESS') {
      // No retry here: the host finishes the interrupted CONNECT itself and
      // sends CONNECTED, which resumes the original input() — it sends the
      // INPUT exactly once. A blind resend would double-run the prompt.
      this._status = 'working';
      this._addChatItem({
        type: 'onboard_success',
        level: data.level as string,
        message: data.message as string,
      });
    }

    // AGENT_PROFILE — the agent's full self-description, pushed once after CONNECTED.
    // Overwrites rather than merges: this frame is the authenticated source of truth,
    // and a key it omits (no balance on a bring-your-own-key agent) means absent, not
    // "keep whatever /info said". Falls through to the tail flush so subscribers
    // re-render. `online` is true by construction — we are talking to it.
    if (data?.type === 'AGENT_PROFILE') {
      this._profile = {
        ...toAgentInfo(data as AgentInfoSource),
        address: (typeof data.address === 'string' && data.address) || this.address,
        online: true,
      };
    }

    // DASHBOARD_SNAPSHOT — full dashboard.html, pushed on connect and after each run.
    // Store it and fall through to the tail flush so subscribers re-render.
    // A malformed frame is ignored, not treated as "no dashboard" — clearing here
    // would blank an already-rendered dashboard on one bad push.
    if (data?.type === 'DASHBOARD_SNAPSHOT' && typeof data.html === 'string') {
      this._dashboardHtml = data.html;
    }

    // OUTPUT — resolve input() promise
    if (data?.type === 'OUTPUT') {
      this._clearPlaceholder();
      this._status = 'idle';
      this._pendingApproval = null;

      if (data.session) {
        this._applySessionSnapshot(data.session);
      }

      if (data.server_newer && data.chat_items && Array.isArray(data.chat_items)) {
        this._mergeServerChatItems(data.chat_items as ChatItem[]);
      }

      const result = data.result || '';
      if (result) {
        const lastAgent = this._chatItems.filter((e): e is ChatItem & { type: 'agent' } => e.type === 'agent').pop();
        if (!lastAgent || lastAgent.content !== result) {
          this._addChatItem({ type: 'agent', content: result });
        }
      }

      // Don't close WS — keep it for next input()
      const resolve = this._inputResolve;
      this._settleInput();
      resolve?.({ text: result, done: true });
    }

    // ERROR — reject input() promise, and keep the socket.
    //
    // An ERROR frame is the host answering, not the transport failing. This used to
    // run `_closeWs()` for every one of them, which made a mistyped invite code
    // permanent: the host replies `{"type": "ERROR", "message": "Invalid invite code"}`
    // and deliberately holds the connection open for a second try —
    //
    //   # session.py, ONBOARD_SUBMIT
    //   # Pop the stashed CONNECT only on a successful onboard: a failed one
    //   # (e.g. wrong invite code) keeps it so a retry on the same socket can
    //   # still complete the interrupted CONNECT.
    //
    // — and this side closed it anyway. The retry went into a dead socket, so the
    // button sat on "Checking…" forever with no error, no timeout, and nothing
    // suggesting that reloading was the way out. Codes are hyphenated strings typed
    // by hand on phones; a first-try miss is ordinary, and it cost the whole page.
    //
    // The OUTPUT branch twenty lines above already says "Don't close WS — keep it for
    // next input()". Same handler, same reasoning, and this branch disagreed with it.
    // An ERROR can arrive with a connect in flight rather than an input: a trust
    // denial happens during CONNECT, before there is anything to answer. That
    // case used to fall through here and the connect was left to its own
    // 30-second deadline — by which point "forbidden: no matching allow
    // condition" had been dropped and the caller was told the connection timed
    // out. `default: deny` is what `strict` ships, so that was the first
    // experience of every correctly configured agent meeting a new client. #434.
    if (data?.type === 'ERROR') {
      const err = new Error(`Agent error: ${String(data.message || data.error || 'Unknown error')}`);
      const onboarding = this._status === 'waiting';
      this._error = err;
      // Not while a human is onboarding. ONBOARD_REQUIRED leaves the connect
      // pending on purpose — the host finishes the interrupted CONNECT itself
      // after a good code, so there is no client retry to resolve anything
      // else. A wrong code arrives as ERROR too, and settling here would strand
      // the retry exactly as it did before 0.3.1: "Checking…" forever, reload
      // the only way out. Codes are hyphenated strings typed on phones; a
      // first-try miss is ordinary.
      if (this._connectReject && !onboarding) this._settleConnect(err);
      if (!onboarding) this._status = 'idle';
      const reject = this._inputReject;
      this._settleInput();
      reject?.(err);
    }

    this._onMessage?.();
  }

  /**
   * Settle an in-flight CONNECT and cancel its deadline.
   *
   * Cancelling matters as much as rejecting: an orphaned 30s timer fires long after
   * its own attempt is over and nulls `_connectResolve`/`_connectReject`, which by
   * then may belong to a *newer* attempt — leaving that one unable to resolve when
   * CONNECTED arrives.
   */
  private _settleConnect(err?: Error): void {
    if (this._connectTimer) { clearTimeout(this._connectTimer); this._connectTimer = null; }
    const reject = this._connectReject;
    this._connectResolve = null;
    this._connectReject = null;
    if (err) reject?.(err);
  }

  private _handleConnectionLoss(): void {
    const connectionError = new Error('Connection closed before response');
    // Make recovery callable before subscribers render the disconnected UI.
    // Promise rejection handlers clear this on a later microtask, which is too
    // late for an immediate online/visibility event or reconnect click.
    this._reconnecting = null;
    this._settleReconnectReady(connectionError);
    this._ws = null;
    this._authenticated = false;
    this._connectionState = 'disconnected';
    this._supportsACPCancel = false;
    this._permissionProfileState = null;
    this._stopPingMonitor();
    this._settleSessionStatusWaiters('not_found');

    if (this._pendingPermissionProfileChange) {
      this._rejectPermissionProfileChange(
        this._pendingPermissionProfileChange,
        new Error('Connection closed before permission profile acknowledgement'),
      );
    }

    // Reject pending connect
    if (this._connectReject) {
      this._settleConnect(new Error('Connection lost during authentication'));
      this._onMessage?.();
      return;
    }

    // Reject pending input only if there is one
    if (this._inputReject) {
      this._status = 'idle';
      this._error = connectionError;
      const reject = this._inputReject;
      this._settleInput();
      reject(connectionError);
    }
    this._onMessage?.();
  }

  private _isSocketOpen(ws: WebSocketLike | null): boolean {
    return !!ws && (ws.readyState === undefined || ws.readyState === WEBSOCKET_OPEN);
  }

  private _hasReadyConnection(): boolean {
    return this._native !== null || (this._authenticated
      && this._isSocketOpen(this._ws));
  }

  private _sendAuthenticated(message: Record<string, unknown>): void {
    if (!this._authenticated) {
      const error = new Error('Agent connection is not ready');
      this._error = error;
      this._onMessage?.();
      throw error;
    }
    this._sendOpen(message);
  }

  private _sendOpen(message: Record<string, unknown>): void {
    if (!this._isSocketOpen(this._ws)) {
      const error = new Error('Agent connection is not ready');
      this._error = error;
      this._onMessage?.();
      throw error;
    }
    this._ws!.send(JSON.stringify(message));
  }

  private _waitForReconnectReady(): Promise<void> {
    if (this._hasReadyConnection()) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      this._reconnectReadyWaiters.push({ resolve, reject });
    });
  }

  private _settleReconnectReady(error?: Error): void {
    const waiters = this._reconnectReadyWaiters.splice(0);
    for (const waiter of waiters) {
      if (error) waiter.reject(error);
      else waiter.resolve();
    }
  }

  private _settleInput(): void {
    if (this._inputTimer) { clearTimeout(this._inputTimer); this._inputTimer = null; }
    this._inputResolve = null;
    this._inputReject = null;
  }

  private _closeWs(): void {
    this._stopPingMonitor();
    // An intentional close during the handshake must fail that handshake now. The
    // socket's onclose is detached below, so nothing else would ever settle it, and
    // _ensureConnected would keep handing the stale promise to every later caller.
    this._settleConnect(new Error('Connection closed during authentication'));
    if (this._pendingPermissionProfileChange) {
      this._rejectPermissionProfileChange(
        this._pendingPermissionProfileChange,
        new Error('Connection closed before permission profile acknowledgement'),
      );
    }
    if (this._ws) {
      // Prevent close handler from firing during intentional close
      this._ws.onerror = null;
      this._ws.onclose = null;
      this._ws.onmessage = null;
      this._ws.close();
      this._ws = null;
    }
    this._authenticated = false;
    this._supportsACPCancel = false;
    this._permissionProfileState = null;
    this._connectionState = 'disconnected';
    this._settleSessionStatusWaiters('not_found');
  }

  private _startPingMonitor(): void {
    this._stopPingMonitor();
    this._pingTimer = setInterval(() => {
      if (Date.now() - this._lastActivityTime > 60000) {
        this._stopPingMonitor();
        this._ws?.close();
      }
    }, 10000);
  }

  private _stopPingMonitor(): void {
    if (this._pingTimer) { clearInterval(this._pingTimer); this._pingTimer = null; }
  }

  private _isDirect(): boolean {
    return !!this._directUrl || !!this._resolvedEndpoint;
  }

  private _resolveWsUrl(): { wsUrl: string; isDirect: boolean } {
    if (this._directUrl) {
      const base = this._directUrl.replace(/^https?:\/\//, '');
      const protocol = this._directUrl.startsWith('https') ? 'wss' : 'ws';
      return { wsUrl: `${protocol}://${base}/ws`, isDirect: true };
    }
    if (this._resolvedEndpoint) return { wsUrl: this._resolvedEndpoint.wsUrl, isDirect: true };
    return { wsUrl: `${this._relayUrl}/ws/input`, isDirect: false };
  }

  private async _resolveEndpointOnce(): Promise<void> {
    if (this._endpointResolutionAttempted || this._directUrl) return;
    this._endpointResolutionAttempted = true;
    if (!this.address.startsWith('0x') || this.address.length !== 66) return;
    const resolved = await resolveEndpoint(this.address, this._relayUrl);
    if (resolved) this._resolvedEndpoint = resolved;
  }

  private _normalizeSessionStatus(status: unknown): RemoteSessionStatus {
    return status === 'running' || status === 'connected' ? status : 'not_found';
  }

  private _settleSessionStatusWaiters(status: RemoteSessionStatus): void {
    for (const waiter of this._sessionStatusWaiters.values()) {
      clearTimeout(waiter.timer);
      for (const resolve of waiter.resolves) resolve(status);
    }
    this._sessionStatusWaiters.clear();
  }
}
