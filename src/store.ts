/**
 * @purpose Zustand store factory for per-session agent state, persisted to localStorage
 * @llm-note
 *   Dependencies: imports from [zustand, zustand/middleware, src/connect/types (ChatItem, AgentStatus, SessionState)] | imported by [src/react/index.ts]
 *   Data flow: getStore(address, sessionId) → prunes old sessions → creates or retrieves cached zustand store → persisted to localStorage as co:agent:{address}:session:{sessionId}
 *   State/Effects: storeCache (module-level Map) prevents duplicate stores | each store persists messages, ui, session, timestamps to localStorage via zustand/persist | persisted state is sanitized: base64 data URLs are stripped (screenshots would blow the ~5MB localStorage quota); live images survive in memory and replays re-fetch from the server | at most MAX_PERSISTED_SESSIONS (20) sessions are kept — opening a session prunes the least-recently-updated, since the server is the source of truth
 *   Integration: exposes getStore(), Message, AgentState, AgentActions, AgentStore types
 *   Performance: storeCache is singleton Map — O(1) lookup per address:sessionId pair | partialize() limits persisted state size
 */

import { create, StoreApi, UseBoundStore } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import type { ChatItem, AgentStatus, SessionState } from './connect';
import { normalizeChatItems, normalizeSessionState } from './connect/mode-compat';

// =============================================================================
// Types
// =============================================================================

/** Message in conversation */
export interface Message {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  tool_call_id?: string;
  tool_calls?: Array<{ name: string; arguments: unknown; id: string }>;
}

/** Store state */
export interface AgentState {
  messages: Message[];
  ui: ChatItem[];
  session: SessionState | null;
  status: AgentStatus;
  error: Error | null;
  createdAt: number;
  updatedAt: number;
}

/** Store actions */
export interface AgentActions {
  setStatus: (status: AgentStatus) => void;
  setUI: (ui: ChatItem[]) => void;
  setSession: (session: SessionState | null) => void;
  setError: (error: Error | null) => void;
  updateMessages: (messages: Message[]) => void;
  reset: () => void;
}

export type AgentStore = AgentState & AgentActions;

// =============================================================================
// Store Factory
// =============================================================================

function createInitialState(): AgentState {
  const now = Date.now();
  return {
    messages: [],
    ui: [],
    session: null,
    status: 'idle',
    error: null,
    createdAt: now,
    updatedAt: now,
  };
}

const storeCache = new Map<string, UseBoundStore<StoreApi<AgentStore>>>();

const OMITTED_DATA_URL = '[image data omitted]';

// The ~5MB localStorage quota is shared across the whole origin, and sessions
// never expire on their own. Without a cap they accumulate until a write throws
// QuotaExceededError and the newest session silently fails to persist. Keep only
// the most-recently-updated sessions; the server is the source of truth, so a
// pruned session just re-fetches from the server the next time it's opened.
export const MAX_PERSISTED_SESSIONS = 20;

function shouldPersistImageUrl(value: unknown): value is string {
  // http(s) URLs persist; base64 payloads and absurdly long URLs don't.
  return typeof value === 'string' && !value.startsWith('data:') && value.length <= 8192;
}

// One screenshot is 100KB–1MB of base64; a few of them blow the ~5MB
// localStorage quota and evict the whole session. Data URLs hide in two
// shapes, each needing a different treatment:
//   - inside strings (message content, tool results) → replace with a
//     readable placeholder
//   - as entries of an `images` array → drop them (a placeholder string
//     there would render as a broken <img>)
//   - as a file attachment's `dataUrl` → drop the field (a placeholder
//     would render as a broken download)
// The walk is recursive because server payloads nest them arbitrarily
// (ui items, session.messages, trace entries) — a missed path is a quota
// blowout, so we sweep everything instead of enumerating known spots.
export function sanitizeForPersistence(value: unknown): unknown {
  if (typeof value === 'string') {
    return value.replace(/data:[^;,\s]+;base64,[A-Za-z0-9+/=]+/g, OMITTED_DATA_URL);
  }

  if (Array.isArray(value)) {
    return value
      .map(sanitizeForPersistence)
      .filter((item) => item !== OMITTED_DATA_URL);
  }

  // Walk plain objects only — Date/class instances would be destroyed by
  // an Object.entries rebuild and can't carry data URLs anyway.
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    const next: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (key === 'images' && Array.isArray(item)) {
        const images = item.filter(shouldPersistImageUrl);
        if (images.length) next[key] = images;
        continue;
      }
      if (key === 'dataUrl' && typeof item === 'string' && item.startsWith('data:')) {
        continue;
      }
      next[key] = sanitizeForPersistence(item);
    }
    return next;
  }

  return value;
}

// =============================================================================
// Quota-resilient persistence
// =============================================================================

interface WebStorageLike {
  length: number;
  key(index: number): string | null;
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** True for a browser "storage full" error across engines (avoids DOM lib types). */
function isQuotaExceeded(e: unknown): boolean {
  if (!e || typeof e !== 'object') return false;
  const err = e as { name?: string; code?: number };
  return (
    err.name === 'QuotaExceededError' ||
    err.name === 'NS_ERROR_DOM_QUOTA_REACHED' || // Firefox
    err.code === 22 ||
    err.code === 1014
  );
}

/** Other persisted sessions, oldest-first, for reclaiming space under quota. */
function otherSessionsOldestFirst(ls: WebStorageLike, keepName: string): string[] {
  const sessions: Array<{ key: string; updatedAt: number }> = [];
  for (let i = 0; i < ls.length; i++) {
    const key = ls.key(i);
    if (!key || key === keepName || !key.startsWith('co:agent:')) continue;
    let updatedAt = 0;
    try {
      updatedAt = JSON.parse(ls.getItem(key) || '{}')?.state?.updatedAt ?? 0;
    } catch {
      // Unparseable entry — treat as oldest so it is evicted first.
    }
    sessions.push({ key, updatedAt });
  }
  return sessions.sort((a, b) => a.updatedAt - b.updatedAt).map((s) => s.key);
}

/**
 * localStorage wrapper whose setItem never throws on a full quota. zustand
 * persist writes the whole session synchronously on every state change, and
 * those writes run inside the WebSocket message handler — an uncaught
 * QuotaExceededError there breaks live messaging entirely (sends and incoming
 * frames both die mid-handler). On quota we evict other persisted sessions
 * oldest-first and retry; if this session alone exceeds the quota we drop the
 * write and keep running in memory (the transcript just won't survive refresh).
 */
const quotaWarned = new Set<string>();

export function createResilientLocalStorage(ls: WebStorageLike): WebStorageLike {
  const trySet = (name: string, value: string): boolean => {
    try {
      ls.setItem(name, value);
      return true;
    } catch (e) {
      if (!isQuotaExceeded(e)) throw e;
      return false;
    }
  };
  return {
    get length() { return ls.length; },
    key: (index) => ls.key(index),
    getItem: (name) => ls.getItem(name),
    removeItem: (name) => ls.removeItem(name),
    setItem: (name, value) => {
      if (trySet(name, value)) return;
      for (const key of otherSessionsOldestFirst(ls, name)) {
        ls.removeItem(key);
        if (trySet(name, value)) return;
      }
      // This session alone exceeds the quota. Keep running in memory; warn once
      // per session so a busy transcript doesn't flood the console every frame.
      if (!quotaWarned.has(name)) {
        quotaWarned.add(name);
        console.warn(
          `[connectonion] session transcript exceeds localStorage quota; ` +
          `continuing in memory only (won't survive refresh): ${name}`
        );
      }
    },
  };
}

function createAgentStore(address: string, sessionId: string) {
  return create<AgentStore>()(
    persist(
      (set) => ({
        ...createInitialState(),

        setStatus: (status) => set({ status }),

        setUI: (ui) => set({ ui, updatedAt: Date.now() }),

        setSession: (session) => set({ session, updatedAt: Date.now() }),

        setError: (error) => set({ error }),

        updateMessages: (messages) => set({ messages, updatedAt: Date.now() }),

        reset: () => set(createInitialState()),
      }),
      {
        name: `co:agent:${address}:session:${sessionId}`,
        // v2 runs the approval-vocabulary migration for existing v1 stores.
        version: 2,
        migrate: (persistedState: unknown) => {
          if (!persistedState || typeof persistedState !== 'object') {
            return persistedState as AgentState;
          }
          const state = persistedState as Record<string, unknown>;
          return {
            ...state,
            ui: normalizeChatItems(state.ui),
            session: normalizeSessionState(state.session),
          } as AgentState;
        },
        storage: createJSONStorage(() => {
          const ls = (globalThis as any).localStorage as WebStorageLike | undefined;
          return ls ? createResilientLocalStorage(ls) : (undefined as any);
        }),
        skipHydration: typeof globalThis !== 'undefined' && !(globalThis as any).localStorage,
        partialize: (state) => ({
          messages: sanitizeForPersistence(state.messages) as Message[],
          ui: sanitizeForPersistence(state.ui) as ChatItem[],
          session: sanitizeForPersistence(state.session) as SessionState | null,
          createdAt: state.createdAt,
          updatedAt: state.updatedAt,
        }),
      }
    )
  );
}

// Drop all but the MAX_PERSISTED_SESSIONS most-recently-updated session keys.
// The server is the source of truth, so a pruned session just re-fetches on next open.
export function pruneOldSessions(storage: Storage): void {
  const sessions: Array<{ key: string; updatedAt: number }> = [];
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i);
    if (!key || !key.startsWith('co:agent:') || !key.includes(':session:')) continue;
    const raw = storage.getItem(key);
    if (!raw) continue;
    sessions.push({ key, updatedAt: JSON.parse(raw)?.state?.updatedAt ?? 0 });
  }

  if (sessions.length <= MAX_PERSISTED_SESSIONS) return;
  sessions.sort((a, b) => b.updatedAt - a.updatedAt);
  sessions.slice(MAX_PERSISTED_SESSIONS).forEach(({ key }) => storage.removeItem(key));
}

export function getStore(address: string, sessionId: string) {
  const key = `${address}:${sessionId}`;
  let store = storeCache.get(key);
  if (!store) {
    const storage = (globalThis as any).localStorage as Storage | undefined;
    if (storage) pruneOldSessions(storage);
    store = createAgentStore(address, sessionId);
    storeCache.set(key, store);
  }
  return store;
}
