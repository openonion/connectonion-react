/**
 * @purpose Keep RemoteAgent WebSocket connections alive across session switches.
 *
 * Without this, useAgentForHuman created a fresh RemoteAgent (and a fresh WebSocket)
 * for every (address, sessionId) and dropped it on switch — so every session switch
 * tore the connection down and reconnected, flashing "disconnected"/"reconnecting"
 * and stranding a running session's live stream.
 *
 * This module caches the live RemoteAgent per (address, sessionId). Switching away
 * leaves the connection open in the background (it keeps receiving events and PONGing
 * the server's keepalive PING); switching back reuses the same instance, so there is
 * no reconnect. Bounded LRU (Map insertion order = recency): the most-recently-used
 * MAX_LIVE_AGENTS stay connected, older ones are closed. The active session is always
 * the most-recently-used, so it is never the one evicted.
 */
import { connect } from './connect';

type Agent = ReturnType<typeof connect>;
type LiveAgentMap = Pick<
  Map<string, Agent>,
  'size' | 'get' | 'set' | 'delete' | 'keys' | 'values' | 'clear'
>;

interface AgentRegistry {
  version: 3;
  liveAgents: LiveAgentMap;
}

// How many background connections stay live. A handful of open panels never hits this;
// it only bounds a runaway (visiting dozens of sessions) so connections don't leak.
export const MAX_LIVE_AGENTS = 6;

const REGISTRY_VERSION = 3;
const REGISTRY_KEY = '__connectonionReactLiveAgentRegistryV3__';
const moduleLiveAgents = new Map<string, Agent>();

function isAgentRegistry(value: unknown): value is AgentRegistry {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<AgentRegistry>;
  const agents = candidate.liveAgents as Partial<LiveAgentMap> | undefined;
  return candidate.version === REGISTRY_VERSION
    && typeof agents?.get === 'function'
    && typeof agents.set === 'function'
    && typeof agents.delete === 'function'
    && typeof agents.keys === 'function'
    && typeof agents.values === 'function'
    && typeof agents.clear === 'function'
    && typeof agents.size === 'number';
}

/**
 * Share connections between browser bundles evaluated in the same page. Next.js can
 * evaluate this module once per Turbopack route. The page Document is the stable
 * browser-owned object those chunks demonstrably share; `window` and `globalThis`
 * can be module-runtime wrappers. Server renders remain request/module local.
 */
function getLiveAgents(): LiveAgentMap {
  if (typeof document === 'undefined') return moduleLiveAgents;

  // Version 1 rejected foreign-realm Maps. Version 2 still anchored ownership to
  // `window`, which Turbopack can wrap per route even though the DOM is shared.
  // A new key on Document avoids both poisoned, non-configurable predecessors.
  const page = document as unknown as Record<string, unknown>;
  const existing = Object.getOwnPropertyDescriptor(page, REGISTRY_KEY);
  if (existing) {
    return isAgentRegistry(existing.value) ? existing.value.liveAgents : moduleLiveAgents;
  }
  if (!Object.isExtensible(page)) return moduleLiveAgents;

  const registry: AgentRegistry = {
    version: REGISTRY_VERSION,
    liveAgents: new Map<string, Agent>(),
  };

  Object.defineProperty(page, REGISTRY_KEY, {
    value: registry,
    enumerable: false,
    configurable: false,
    writable: false,
  });

  return registry.liveAgents;
}

const keyOf = (address: string, sessionId: string) => `${address}:${sessionId}`;

/** Return the live agent for this session, reusing the cached connection if present. */
export function acquireAgent(address: string, sessionId: string): Agent {
  const liveAgents = getLiveAgents();
  const key = keyOf(address, sessionId);

  const existing = liveAgents.get(key);
  if (existing) {
    liveAgents.delete(key);      // re-insert so this key becomes most-recently-used
    liveAgents.set(key, existing);
    return existing;
  }

  const agent = connect(address);
  liveAgents.set(key, agent);

  // Evict least-recently-used (oldest insertion) beyond the cap, closing its WebSocket.
  while (liveAgents.size > MAX_LIVE_AGENTS) {
    const lruKey = liveAgents.keys().next().value as string;
    const lru = liveAgents.get(lruKey);
    liveAgents.delete(lruKey);
    lru?.reset();                // reset() closes the WS; safe on a never-connected agent
  }

  return agent;
}

/** Forget a session's cached agent (after an explicit reset), so the next acquire is fresh. */
export function dropAgent(address: string, sessionId: string): void {
  getLiveAgents().delete(keyOf(address, sessionId));
}

/** Test/teardown helper: close and forget every cached agent. */
export function _clearAgentCache(): void {
  const liveAgents = getLiveAgents();
  for (const agent of liveAgents.values()) agent.reset();
  liveAgents.clear();
}
