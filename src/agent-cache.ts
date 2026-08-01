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
import { connect } from 'connectonion/connect';

type Agent = ReturnType<typeof connect>;

// How many background connections stay live. A handful of open panels never hits this;
// it only bounds a runaway (visiting dozens of sessions) so connections don't leak.
export const MAX_LIVE_AGENTS = 6;

const liveAgents = new Map<string, Agent>();

const keyOf = (address: string, sessionId: string) => `${address}:${sessionId}`;

/** Return the live agent for this session, reusing the cached connection if present. */
export function acquireAgent(address: string, sessionId: string): Agent {
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
  liveAgents.delete(keyOf(address, sessionId));
}

/** Test/teardown helper: close and forget every cached agent. */
export function _clearAgentCache(): void {
  for (const agent of liveAgents.values()) agent.reset();
  liveAgents.clear();
}
