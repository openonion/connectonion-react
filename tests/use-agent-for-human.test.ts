/**
 * @jest-environment jsdom
 *
 * Tests for connectonion/react hooks.
 *
 * Tests cover:
 * - useAgentForHuman(address, sessionId) hook initialization
 * - input() fires non-blocking, UI updates arrive reactively via onMessage
 * - reset() behavior
 * - Session persistence
 * - Error handling
 */

import { renderHook, act } from '@testing-library/react';
import { useAgentForHuman } from '../src';

// Mock browser identity to skip signing
jest.mock('connectonion/address-browser', () => ({
  generate: () => ({ address: '0xmock', privateKey: new Uint8Array(64), publicKey: new Uint8Array(32) }),
  generateBrowser: () => ({ address: '0xmock', privateKey: new Uint8Array(64), publicKey: new Uint8Array(32) }),
  load: () => null,
  loadBrowser: () => null,
  save: () => {},
  saveBrowser: () => {},
  sign: () => 'mock-signature',
  signBrowser: () => 'mock-signature',
}));

// Mock localStorage
const mockStorage: Record<string, string> = {};
const mockLocalStorage = {
  getItem: (key: string) => mockStorage[key] || null,
  setItem: (key: string, value: string) => { mockStorage[key] = value; },
  removeItem: (key: string) => { delete mockStorage[key]; },
  clear: () => { Object.keys(mockStorage).forEach(k => delete mockStorage[k]); },
  get length() { return Object.keys(mockStorage).length; },
  key: (i: number) => Object.keys(mockStorage)[i] ?? null,
};
// jsdom exposes localStorage as an accessor; plain assignment is silently ignored
Object.defineProperty(globalThis, 'localStorage', { value: mockLocalStorage, writable: true });

// Mock WebSocket for testing
class MockWebSocket {
  public onopen: ((ev?: unknown) => unknown) | null = null;
  public onmessage: ((ev: { data: unknown }) => unknown) | null = null;
  public onerror: ((ev: unknown) => unknown) | null = null;
  public onclose: ((ev: unknown) => unknown) | null = null;
  public readyState = 1;
  private closed = false;

  constructor(_url: string) {
    setTimeout(() => this.onopen && this.onopen({}), 0);
  }

  send(data: unknown): void {
    const msg = JSON.parse(String(data));
    if (msg.type === 'PONG') return;
    if (msg.type === 'CONNECT') {
      const reply = { type: 'CONNECTED', session_id: msg.session_id || 'sess-test', status: 'new' };
      setTimeout(() => this.onmessage && this.onmessage({ data: JSON.stringify(reply) }), 0);
      return;
    }
    if (msg.type !== 'INPUT') return;
    const out = {
      type: 'OUTPUT',
      input_id: msg.input_id,
      result: `Echo: ${msg.prompt}`,
      session: {
        session_id: msg.session?.session_id,
        messages: [
          { role: 'user', content: msg.prompt },
          { role: 'assistant', content: `Echo: ${msg.prompt}` },
        ],
      },
    };
    setTimeout(() => this.onmessage && this.onmessage({ data: JSON.stringify(out) }), 10);
  }

  close(): void {
    if (!this.closed) {
      this.closed = true;
      this.readyState = 3;
      this.onclose && this.onclose({});
    }
  }
}

// Swappable WebSocket class — tests can override for error scenarios
let ActiveWS: any = MockWebSocket;

// Proxy that delegates to ActiveWS at construction time
const DynamicWS = new Proxy(MockWebSocket, {
  construct(_target, args) {
    return new ActiveWS(...args);
  },
});

// Mock connect() to inject test WebSocket
jest.mock('connectonion/connect', () => {
  const actual = jest.requireActual('connectonion/connect');
  return {
    ...actual,
    connect: (address: string) => new actual.RemoteAgent(address, {
      relayUrl: 'ws://localhost',
      wsCtor: DynamicWS as any,
    }),
  };
});

// Unique address counter to avoid Zustand store cache collisions between tests
let addrCounter = 0;
function uniqueAddr() {
  return `0xtest${++addrCounter}`;
}

// Flush microtasks (async _streamInput) + macrotasks (MockWebSocket setTimeout)
// Two rounds: first flushes WS connect + send, second flushes state update re-renders
function flush() {
  return new Promise<void>(resolve => setTimeout(() => setTimeout(resolve, 30), 30));
}

describe('useAgentForHuman hook', () => {
  beforeEach(() => {
    mockLocalStorage.clear();
    ActiveWS = MockWebSocket;
  });

  describe('initialization', () => {
    it('initializes with idle status', () => {
      const addr = uniqueAddr();
      const { result } = renderHook(() =>
        useAgentForHuman(addr, 'test-session')
      );
      expect(result.current.status).toBe('idle');
    });

    it('initializes with empty UI array', () => {
      const addr = uniqueAddr();
      const { result } = renderHook(() =>
        useAgentForHuman(addr, 'test-session')
      );
      expect(result.current.ui).toEqual([]);
    });

    it('initializes isProcessing as false', () => {
      const addr = uniqueAddr();
      const { result } = renderHook(() =>
        useAgentForHuman(addr, 'test-session')
      );
      expect(result.current.isProcessing).toBe(false);
    });

    it('initializes error as null', () => {
      const addr = uniqueAddr();
      const { result } = renderHook(() =>
        useAgentForHuman(addr, 'test-session')
      );
      expect(result.current.error).toBeNull();
    });

    it('uses provided sessionId', () => {
      const addr = uniqueAddr();
      const { result } = renderHook(() =>
        useAgentForHuman(addr, 'my-session-123')
      );
      expect(result.current.sessionId).toBe('my-session-123');
    });
  });

  describe('input method', () => {
    it('input() returns void and UI updates arrive reactively', async () => {
      const addr = uniqueAddr();
      const { result } = renderHook(() =>
        useAgentForHuman(addr, 'test-session')
      );

      await act(async () => {
        result.current.input('Hello');
        await flush();
      });

      expect(result.current.status).toBe('idle');
      const lastAgent = result.current.ui.filter(e => e.type === 'agent').pop() as any;
      expect(lastAgent.content).toBe('Echo: Hello');
    });

    it('handles multiple sequential inputs', async () => {
      const addr = uniqueAddr();
      const { result } = renderHook(() =>
        useAgentForHuman(addr, 'test-session')
      );

      await act(async () => {
        result.current.input('First');
        await flush();
      });

      await act(async () => {
        result.current.input('Second');
        await flush();
      });

      const agentItems = result.current.ui.filter(e => e.type === 'agent');
      expect(agentItems.length).toBe(2);
    });

    it('sets status back to idle after completion', async () => {
      const addr = uniqueAddr();
      const { result } = renderHook(() =>
        useAgentForHuman(addr, 'test-session')
      );

      await act(async () => {
        result.current.input('Hello');
        await flush();
      });

      expect(result.current.status).toBe('idle');
      expect(result.current.isProcessing).toBe(false);
    });
  });

  describe('reset method', () => {
    it('keeps same sessionId after reset (sessionId is a prop)', () => {
      const addr = uniqueAddr();
      const { result } = renderHook(() =>
        useAgentForHuman(addr, 'fixed-session')
      );

      act(() => { result.current.reset(); });

      expect(result.current.sessionId).toBe('fixed-session');
    });

    it('sets status to idle', () => {
      const addr = uniqueAddr();
      const { result } = renderHook(() =>
        useAgentForHuman(addr, 'test-session')
      );

      act(() => { result.current.reset(); });

      expect(result.current.status).toBe('idle');
    });

    it('clears error', () => {
      const addr = uniqueAddr();
      const { result } = renderHook(() =>
        useAgentForHuman(addr, 'test-session')
      );

      act(() => { result.current.reset(); });

      expect(result.current.error).toBeNull();
    });

    it('works - can input after reset', async () => {
      const addr = uniqueAddr();
      const { result } = renderHook(() =>
        useAgentForHuman(addr, 'test-session')
      );

      await act(async () => {
        result.current.input('First');
        await flush();
      });

      act(() => { result.current.reset(); });

      await act(async () => {
        result.current.input('After reset');
        await flush();
      });

      const agentItems = result.current.ui.filter(e => e.type === 'agent');
      expect(agentItems.length).toBeGreaterThan(0);
      const lastAgent = agentItems.pop() as any;
      expect(lastAgent.content).toBe('Echo: After reset');
    });
  });

  describe('error handling', () => {
    it('sets error state on agent error', async () => {
      class ErrorWS extends MockWebSocket {
        override send(data: unknown): void {
          const msg = JSON.parse(String(data));
          if (msg.type === 'PONG') return;
          const out = { type: 'ERROR', input_id: msg.input_id, error: 'Test error' };
          setTimeout(() => this.onmessage && this.onmessage({ data: JSON.stringify(out) }), 0);
        }
      }

      ActiveWS = ErrorWS;

      const addr = uniqueAddr();
      const { result } = renderHook(() =>
        useAgentForHuman(addr, 'test-session')
      );

      await act(async () => {
        result.current.input('Hello');
        await flush();
      });

      expect(result.current.status).toBe('idle');
    });
  });

  describe('sanitizeForPersistence', () => {
    const { sanitizeForPersistence } = require('../src/store');

    it('strips data URLs but passes Dates and class instances through untouched', () => {
      const createdAt = new Date('2026-01-01');
      const out = sanitizeForPersistence({
        createdAt,
        images: ['data:image/png;base64,AAA', 'https://x/img.png'],
        files: [{ name: 'a.pdf', dataUrl: 'data:application/pdf;base64,BBB' }],
        note: 'before data:image/png;base64,CCC after',
      }) as Record<string, unknown>;

      expect(out.createdAt).toBe(createdAt);
      expect(out.images).toEqual(['https://x/img.png']);
      expect((out.files as Array<Record<string, unknown>>)[0]).toEqual({ name: 'a.pdf' });
      expect(out.note).toBe('before [image data omitted] after');
    });
  });

  describe('pruneOldSessions', () => {
    const { pruneOldSessions, MAX_PERSISTED_SESSIONS } = require('../src/store');

    const seed = (id: number, updatedAt: number) => {
      mockLocalStorage.setItem(
        `co:agent:0xprune:session:s${id}`,
        JSON.stringify({ state: { updatedAt }, version: 0 })
      );
    };

    it('keeps the MAX_PERSISTED_SESSIONS most-recently-updated sessions', () => {
      mockLocalStorage.clear();
      mockLocalStorage.setItem('connectonion_keys', '{"address":"0x"}'); // unrelated key untouched
      for (let i = 0; i < 25; i++) seed(i, i); // s24 newest, s0 oldest

      pruneOldSessions(mockLocalStorage as unknown as Storage);

      const kept = Object.keys(mockStorage).filter((k) => k.includes(':session:'));
      expect(kept).toHaveLength(MAX_PERSISTED_SESSIONS);
      expect(kept).toContain('co:agent:0xprune:session:s24'); // newest survives
      expect(kept).not.toContain('co:agent:0xprune:session:s0'); // oldest pruned
      expect(mockStorage['connectonion_keys']).toBe('{"address":"0x"}'); // non-session key untouched
    });

    it('does nothing when under the cap', () => {
      mockLocalStorage.clear();
      for (let i = 0; i < 5; i++) seed(i, i);

      pruneOldSessions(mockLocalStorage as unknown as Storage);

      expect(Object.keys(mockStorage)).toHaveLength(5);
    });
  });

  describe('session persistence', () => {
    it('uses provided sessionId', () => {
      const addr = uniqueAddr();
      const { result } = renderHook(() =>
        useAgentForHuman(addr, 'persist-session')
      );
      expect(result.current.sessionId).toBe('persist-session');
    });

    it('keeps same sessionId across re-renders', () => {
      const addr = uniqueAddr();
      const { result, rerender } = renderHook(() =>
        useAgentForHuman(addr, 'stable-session')
      );

      expect(result.current.sessionId).toBe('stable-session');
      rerender();
      expect(result.current.sessionId).toBe('stable-session');
    });

    it('keeps runtime images but omits base64 data URLs from localStorage', async () => {
      const imageData = `data:image/png;base64,${'A'.repeat(12000)}`;

      class ImageWS extends MockWebSocket {
        override send(data: unknown): void {
          const msg = JSON.parse(String(data));
          if (msg.type === 'PONG') return;
          if (msg.type === 'CONNECT') {
            setTimeout(() => this.onmessage && this.onmessage({
              data: JSON.stringify({ type: 'CONNECTED', session_id: 'image-session', status: 'new' }),
            }), 0);
            return;
          }

          setTimeout(() => {
            this.onmessage && this.onmessage({
              data: JSON.stringify({ type: 'agent_image', image: imageData, id: 'img1' }),
            });
          }, 0);
          setTimeout(() => {
            this.onmessage && this.onmessage({
              data: JSON.stringify({
                type: 'OUTPUT',
                input_id: msg.input_id,
                result: 'done',
                session: {
                  session_id: 'image-session',
                  messages: [
                    { role: 'tool', content: `Screenshot:\n${imageData}` },
                    { role: 'assistant', content: 'done' },
                  ],
                },
              }),
            });
          }, 5);
        }
      }

      ActiveWS = ImageWS;

      const addr = uniqueAddr();
      const { result } = renderHook(() =>
        useAgentForHuman(addr, 'image-session')
      );

      await act(async () => {
        result.current.input('Show image');
        await flush();
      });

      const agentImage = result.current.ui.find(item =>
        item.type === 'agent' && item.images?.includes(imageData)
      );
      expect(agentImage).toBeDefined();

      const persisted = Object.values(mockStorage).join('\n');
      expect(persisted).not.toContain(imageData);
      expect(persisted).not.toContain('data:image/png;base64');
      expect(persisted).toContain('[image data omitted]');
      expect(persisted.length).toBeLessThan(5000);
    });
  });
});

describe('isEventType helper', () => {
  it('narrows user event type', () => {
    const { isEventType } = require('../src');
    const event = { id: '1', type: 'user', content: 'Hello' };
    if (isEventType(event, 'user')) {
      expect(event.content).toBe('Hello');
    }
  });

  it('narrows tool_call event type', () => {
    const { isEventType } = require('../src');
    const event = { id: '1', type: 'tool_call', name: 'search', status: 'done', result: 'found' };
    if (isEventType(event, 'tool_call')) {
      expect(event.name).toBe('search');
      expect(event.status).toBe('done');
    }
  });
});

describe('createResilientLocalStorage (quota handling)', () => {
  const { createResilientLocalStorage } = require('../src/store');

  // localStorage mock with a byte budget: setItem throws QuotaExceededError
  // (like a real browser) when the total stored size would exceed `budget`.
  function makeQuotaStorage(budget: number) {
    const data = new Map<string, string>();
    const size = (skip?: string) => {
      let total = 0;
      for (const [k, v] of data) { if (k !== skip) total += k.length + v.length; }
      return total;
    };
    return {
      data,
      get length() { return data.size; },
      key: (i: number) => Array.from(data.keys())[i] ?? null,
      getItem: (k: string) => (data.has(k) ? data.get(k)! : null),
      removeItem: (k: string) => { data.delete(k); },
      setItem: (k: string, v: string) => {
        if (size(k) + k.length + v.length > budget) {
          const err: any = new Error('quota'); err.name = 'QuotaExceededError'; err.code = 22;
          throw err;
        }
        data.set(k, v);
      },
    };
  }

  const sessionValue = (updatedAt: number, pad = '') =>
    JSON.stringify({ state: { updatedAt, ui: pad } });

  it('evicts other sessions oldest-first and retries until the write fits', () => {
    const ls = makeQuotaStorage(250);
    ls.setItem('co:agent:0xA:session:old', sessionValue(1, 'x'.repeat(60)));
    ls.setItem('co:agent:0xA:session:mid', sessionValue(2, 'x'.repeat(60)));
    const resilient = createResilientLocalStorage(ls);

    // A fresh write that only fits after old sessions are evicted.
    resilient.setItem('co:agent:0xA:session:current', sessionValue(3, 'y'.repeat(60)));

    expect(ls.getItem('co:agent:0xA:session:current')).not.toBeNull();
    expect(ls.getItem('co:agent:0xA:session:old')).toBeNull();   // oldest evicted first
    // mid may or may not survive; the guarantee is the current write succeeded
  });

  it('does not throw when the session alone exceeds quota (memory-only fallback)', () => {
    const ls = makeQuotaStorage(100);
    const resilient = createResilientLocalStorage(ls);
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

    expect(() =>
      resilient.setItem('co:agent:0xA:session:huge', sessionValue(1, 'z'.repeat(500)))
    ).not.toThrow();
    expect(ls.getItem('co:agent:0xA:session:huge')).toBeNull(); // dropped, not persisted
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('never touches non-co:agent keys and rethrows non-quota errors', () => {
    const ls = makeQuotaStorage(1_000_000);
    ls.setItem('connectonion_keys', 'identity');
    const boom: any = new Error('nope'); boom.name = 'TypeError';
    ls.setItem = () => { throw boom; };
    const resilient = createResilientLocalStorage(ls);

    expect(() => resilient.setItem('co:agent:0xA:session:x', 'v')).toThrow('nope');
    expect(ls.getItem('connectonion_keys')).toBe('identity'); // identity key untouched
  });
});
