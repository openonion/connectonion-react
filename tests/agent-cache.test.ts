/**
 * Tests for the live-connection cache that keeps RemoteAgents alive across session
 * switches (so switching back reuses the connection instead of reconnecting).
 *
 * connect() builds a RemoteAgent but does NOT open a WebSocket until input()/reconnect(),
 * so these tests exercise the cache/LRU purely in memory — no real network.
 */
import { acquireAgent, dropAgent, _clearAgentCache, MAX_LIVE_AGENTS } from '../src/agent-cache';

const ADDR = '0x' + 'a'.repeat(64);

afterEach(() => _clearAgentCache());

describe('agent-cache', () => {
  test('same (address, session) reuses the same agent — no reconnect', () => {
    const a = acquireAgent(ADDR, 's1');
    const b = acquireAgent(ADDR, 's1');
    expect(b).toBe(a);
  });

  test('different sessions get distinct agents', () => {
    expect(acquireAgent(ADDR, 's1')).not.toBe(acquireAgent(ADDR, 's2'));
  });

  test('switching away and back reuses the live agent (the core fix)', () => {
    const first = acquireAgent(ADDR, 's1');
    acquireAgent(ADDR, 's2');            // switch away — s1 stays cached/alive
    const back = acquireAgent(ADDR, 's1'); // switch back
    expect(back).toBe(first);            // same instance → no teardown/reconnect
  });

  test('LRU evicts the least-recently-used beyond the cap', () => {
    const lru = acquireAgent(ADDR, 's0');
    for (let i = 1; i < MAX_LIVE_AGENTS; i++) acquireAgent(ADDR, `s${i}`);
    acquireAgent(ADDR, 'overflow');      // exceeds cap → evict s0 (oldest)
    expect(acquireAgent(ADDR, 's0')).not.toBe(lru); // s0 was closed → fresh instance
  });

  test('re-touching a session protects it from eviction', () => {
    const keep = acquireAgent(ADDR, 's0');
    for (let i = 1; i < MAX_LIVE_AGENTS; i++) acquireAgent(ADDR, `s${i}`);
    acquireAgent(ADDR, 's0');            // re-touch → most-recently-used
    acquireAgent(ADDR, 'overflow');      // evicts s1 (now oldest), not s0
    expect(acquireAgent(ADDR, 's0')).toBe(keep);
  });

  test('dropAgent forgets a session so the next acquire is fresh', () => {
    const a = acquireAgent(ADDR, 's1');
    dropAgent(ADDR, 's1');
    expect(acquireAgent(ADDR, 's1')).not.toBe(a);
  });

  test('keeps isolated server module caches separate', () => {
    type CacheModule = typeof import('../src/agent-cache');
    let firstModule!: CacheModule;
    let secondModule!: CacheModule;

    jest.isolateModules(() => {
      firstModule = require('../src/agent-cache') as CacheModule;
    });
    jest.isolateModules(() => {
      secondModule = require('../src/agent-cache') as CacheModule;
    });

    expect(firstModule.acquireAgent(ADDR, 'server-session')).not.toBe(
      secondModule.acquireAgent(ADDR, 'server-session'),
    );
    firstModule._clearAgentCache();
    secondModule._clearAgentCache();
  });
});
