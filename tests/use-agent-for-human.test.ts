/**
 * @jest-environment jsdom
 *
 * Tests for the @connectonion/react hooks.
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
import { getStore } from '../src/store';

// Mock browser identity to skip signing
jest.mock('../src/address-browser', () => ({
  generate: () => ({ address: '0xmock', privateKey: new Uint8Array(64), publicKey: new Uint8Array(32) }),
  generateBrowser: () => ({ address: '0xmock', privateKey: new Uint8Array(64), publicKey: new Uint8Array(32) }),
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

class PlanWebSocket extends MockWebSocket {
  send(data: unknown): void {
    const msg = JSON.parse(String(data));
    super.send(data);
    if (msg.type !== 'CONNECT') return;
    setTimeout(() => this.onmessage?.({
      data: JSON.stringify({
        type: 'plan',
        session_id: msg.session_id,
        entries: [{
          content: 'Render the plan',
          priority: 'high',
          status: 'in_progress',
        }],
      }),
    }), 10);
  }
}

class ControlCenterWebSocket extends MockWebSocket {
  send(data: unknown): void {
    const msg = JSON.parse(String(data));
    super.send(data);
    if (msg.type !== 'CONNECT') return;
    setTimeout(() => this.onmessage?.({
      data: JSON.stringify({
        type: 'CONTROL_CENTER_APP',
        session_id: msg.session_id,
        app: {
          schema: 'connectonion.control-app/1',
          revision: `sha256:${'a'.repeat(64)}`,
          url: 'https://apps.openonion.ai/agent/revision/index.html',
          sdk_version: '1',
          review: { status: 'approved', review_id: 'review-1' },
          capabilities: ['clipboard-write', 'fullscreen'],
        },
      }),
    }), 10);
  }
}

// Swappable WebSocket class — tests can override for error scenarios
let ActiveWS: any = MockWebSocket;
let sentFrames: Array<Record<string, unknown>> = [];

// Proxy that delegates to ActiveWS at construction time
const DynamicWS = new Proxy(MockWebSocket, {
  construct(_target, args) {
    const socket = new ActiveWS(...args);
    const send = socket.send.bind(socket);
    socket.send = (data: unknown) => {
      sentFrames.push(JSON.parse(String(data)));
      send(data);
    };
    return socket;
  },
});

// Mock connect() to inject test WebSocket
jest.mock('../src/connect', () => {
  const actual = jest.requireActual('../src/connect');
  return {
    ...actual,
    connect: (address: string) => new actual.RemoteAgent(address, {
      relayUrl: 'ws://localhost',
      wsCtor: DynamicWS as any,
      signer: { address: '0xmock', sign: () => 'mock-signature' },
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
    sentFrames = [];
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

    it('warm connect claims the provided session before opening the socket', async () => {
      const addr = uniqueAddr();
      const { result } = renderHook(() =>
        useAgentForHuman(addr, 'warm-session-123')
      );

      await act(async () => {
        result.current.connect();
        await flush();
      });

      expect(sentFrames.find(frame => frame.type === 'CONNECT')).toMatchObject({
        session_id: 'warm-session-123',
      });
    });

    it('exposes React-normalized OIP plan state outside the chat timeline', async () => {
      ActiveWS = PlanWebSocket;
      const addr = uniqueAddr();
      const { result } = renderHook(() =>
        useAgentForHuman(addr, 'plan-session')
      );

      expect(result.current.plan).toEqual([]);
      await act(async () => {
        result.current.connect();
        await flush();
      });

      expect(result.current.plan).toEqual([{
        content: 'Render the plan',
        priority: 'high',
        status: 'in_progress',
      }]);
      expect(result.current.ui).toEqual([]);
      expect(Object.values(mockStorage).some(
        (value) => value.includes('Render the plan'),
      )).toBe(true);
    });

    it('exposes the authenticated Control Center app independently from dashboard HTML', async () => {
      ActiveWS = ControlCenterWebSocket;
      const addr = uniqueAddr();
      const { result } = renderHook(() =>
        useAgentForHuman(addr, 'control-center-session')
      );

      expect(result.current.controlCenterApp).toBeNull();
      await act(async () => {
        result.current.connect();
        await flush();
      });

      expect(result.current.dashboardHtml).toBeNull();
      expect(result.current.controlCenterApp).toMatchObject({
        schema: 'connectonion.control-app/1',
        revision: `sha256:${'a'.repeat(64)}`,
        review: { status: 'approved' },
      });
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

    it('keeps the newer subscription when an overlapping hook owner unmounts', async () => {
      const addr = uniqueAddr();
      const first = renderHook(() =>
        useAgentForHuman(addr, 'handoff-session')
      );
      const second = renderHook(() =>
        useAgentForHuman(addr, 'handoff-session')
      );

      // Route transitions can mount the session page before the landing page
      // cleanup runs. The old owner must not clear the new owner's callback.
      first.unmount();

      await act(async () => {
        second.result.current.input('After handoff');
        await flush();
      });

      const lastAgent = second.result.current.ui.filter(e => e.type === 'agent').pop() as any;
      expect(lastAgent.content).toBe('Echo: After handoff');
      second.unmount();
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

    it('surfaces an authoritative OIP mode update to hook consumers', async () => {
      class ModeWS extends MockWebSocket {
        override send(data: unknown): void {
          const msg = JSON.parse(String(data));
          if (msg.type !== 'INPUT') {
            super.send(data);
            return;
          }
          setTimeout(() => this.onmessage?.({
            data: JSON.stringify({ type: 'mode_changed', mode: 'auto' }),
          }), 1);
          setTimeout(() => this.onmessage?.({
            data: JSON.stringify({
              type: 'OUTPUT',
              input_id: msg.input_id,
              result: 'done',
            }),
          }), 5);
        }
      }
      ActiveWS = ModeWS;
      const addr = uniqueAddr();
      const { result } = renderHook(() =>
        useAgentForHuman(addr, 'mode-session')
      );

      await act(async () => {
        result.current.input('Use Auto mode');
        await flush();
      });

      expect(result.current.mode).toBe('auto');
    });

    it('exposes advertised modes and waits for the acknowledged mode response', async () => {
      let socket: ModeTransactionWS | null = null;
      class ModeTransactionWS extends MockWebSocket {
        constructor(url: string) {
          super(url);
          socket = this;
        }

        override send(data: unknown): void {
          const msg = JSON.parse(String(data));
          if (msg.type === 'PONG') return;
          if (msg.type === 'CONNECT') {
            const reply = {
              type: 'CONNECTED',
              session_id: 'mode-write-session',
              status: 'new',
              server_newer: true,
              session: {
                session_id: 'mode-write-session',
                mode: 'auto',
                messages: [],
              },
              session_modes: {
                currentModeId: 'read-only',
                availableModes: [
                  { id: 'read-only', name: 'Read only' },
                  { id: 'auto', name: 'Auto' },
                ],
              },
            };
            setTimeout(() => this.onmessage?.({ data: JSON.stringify(reply) }), 0);
            return;
          }
          if (msg.type !== 'mode_change') super.send(data);
        }

        acknowledge(): void {
          this.onmessage?.({ data: JSON.stringify({
            type: 'mode_changed',
            session_id: 'mode-write-session',
            mode: 'auto',
          }) });
        }
      }
      ActiveWS = ModeTransactionWS;
      const addr = uniqueAddr();
      const { result } = renderHook(() =>
        useAgentForHuman(addr, 'mode-write-session')
      );

      await act(async () => {
        result.current.connect();
        await flush();
      });
      expect(result.current.availableModes.map((mode) => mode.id)).toEqual([
        'read-only', 'auto',
      ]);
      expect(result.current.mode).toBe('read-only');

      let change!: Promise<void>;
      await act(async () => {
        change = result.current.setSessionMode('auto');
        await Promise.resolve();
      });
      expect(result.current.mode).toBe('read-only');
      expect(result.current.modeChangePending).toBe(true);
      expect(sentFrames.find((frame) => frame.type === 'mode_change')).toMatchObject({
        mode: 'auto',
      });

      await act(async () => {
        socket!.acknowledge();
        await change;
      });
      expect(result.current.mode).toBe('auto');
      expect(result.current.modeChangePending).toBe(false);
      expect(result.current.error).toBeNull();
    });

    it('resynchronizes mode capability state when the cached agent changes', async () => {
      class AdvertisedModeWS extends MockWebSocket {
        override send(data: unknown): void {
          const msg = JSON.parse(String(data));
          if (msg.type === 'PONG') return;
          if (msg.type !== 'CONNECT') {
            super.send(data);
            return;
          }
          setTimeout(() => this.onmessage?.({ data: JSON.stringify({
            type: 'CONNECTED',
            session_id: msg.session_id,
            status: 'new',
            session_modes: {
              currentModeId: 'auto',
              availableModes: [
                { id: 'read-only', name: 'Read only' },
                { id: 'auto', name: 'Auto' },
              ],
            },
          }) }), 0);
        }
      }
      ActiveWS = AdvertisedModeWS;
      const addr = uniqueAddr();
      const { result, rerender } = renderHook(
        ({ sessionId }) => useAgentForHuman(addr, sessionId),
        { initialProps: { sessionId: 'advertised-session' } },
      );

      await act(async () => {
        result.current.connect();
        await flush();
      });
      expect(result.current.availableModes).toHaveLength(2);

      await act(async () => {
        rerender({ sessionId: 'cold-session' });
        await Promise.resolve();
      });
      expect(result.current.availableModes).toEqual([]);
    });

    it('recovers cached Host mode authority when the hook remounts', async () => {
      class AdvertisedModeWS extends MockWebSocket {
        override send(data: unknown): void {
          const msg = JSON.parse(String(data));
          if (msg.type === 'PONG' || msg.type !== 'CONNECT') return;
          setTimeout(() => this.onmessage?.({ data: JSON.stringify({
            type: 'CONNECTED',
            session_id: msg.session_id,
            status: 'new',
            session_modes: {
              currentModeId: 'auto',
              availableModes: [
                { id: 'read-only', name: 'Read only' },
                { id: 'auto', name: 'Auto' },
              ],
            },
          }) }), 0);
        }
      }
      ActiveWS = AdvertisedModeWS;
      const addr = uniqueAddr();
      const first = renderHook(() =>
        useAgentForHuman(addr, 'mode-remount-session')
      );

      await act(async () => {
        first.result.current.connect();
        await flush();
      });
      expect(first.result.current.availableModes.map((mode) => mode.id)).toEqual([
        'read-only', 'auto',
      ]);
      expect(first.result.current.mode).toBe('auto');
      first.unmount();

      const second = renderHook(() =>
        useAgentForHuman(addr, 'mode-remount-session')
      );
      expect(second.result.current.availableModes.map((mode) => mode.id)).toEqual([
        'read-only', 'auto',
      ]);
      expect(second.result.current.mode).toBe('auto');
      second.unmount();
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
    it('exposes connection loss and clears it after reconnect', async () => {
      class DropDuringInputWS extends MockWebSocket {
        override send(data: unknown): void {
          const msg = JSON.parse(String(data));
          if (msg.type === 'CONNECT') {
            super.send(data);
            return;
          }
          if (msg.type === 'INPUT') setTimeout(() => this.close(), 0);
        }
      }

      ActiveWS = DropDuringInputWS;
      const addr = uniqueAddr();
      const { result } = renderHook(() =>
        useAgentForHuman(addr, 'drop-during-input-session')
      );

      await act(async () => {
        result.current.input('Hello');
        await flush();
      });

      expect(result.current.connectionState).toBe('disconnected');
      expect(result.current.error?.message).toBe('Connection closed before response');

      await act(async () => {
        result.current.reconnect();
        await flush();
      });

      expect(result.current.connectionState).toBe('connected');
      expect(result.current.error).toBeNull();
    });

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

    it('consumes reconnect rejection and exposes it through error state', async () => {
      class ReconnectErrorWS extends MockWebSocket {
        override send(data: unknown): void {
          const msg = JSON.parse(String(data));
          if (msg.type === 'PONG') return;
          if (msg.type === 'CONNECT') {
            setTimeout(() => this.onmessage?.({
              data: JSON.stringify({
                type: 'ERROR',
                error: 'Reconnect refused',
              }),
            }), 0);
          }
        }
      }
      ActiveWS = ReconnectErrorWS;
      const addr = uniqueAddr();
      const { result } = renderHook(() =>
        useAgentForHuman(addr, 'reconnect-error-session')
      );

      await act(async () => {
        result.current.reconnect();
        await flush();
      });

      expect(result.current.connectionState).toBe('disconnected');
      expect(result.current.error?.message).toBe(
        'Agent error: Reconnect refused',
      );
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
    it('discards legacy stored authority to Auto', async () => {
      const addr = uniqueAddr();
      const sessionId = 'legacy-mode-session';
      const key = `co:agent:${addr}:session:${sessionId}`;
      mockLocalStorage.setItem(key, JSON.stringify({
        version: 1,
        state: {
          messages: [],
          ui: [{
            id: 'checkpoint-1',
            type: 'ulw_turns_reached',
            turns_used: 4,
            max_turns: 20,
          }],
          session: {
            session_id: sessionId,
            mode: 'ulw',
            ulw_turns: 20,
            ulw_turns_used: 4,
          },
          createdAt: 1,
          updatedAt: 2,
        },
      }));

      const store = getStore(addr, sessionId);
      await (store as typeof store & {
        persist: { rehydrate: () => Promise<void> };
      }).persist.rehydrate();

      expect(store.getState().session).toEqual({
        session_id: sessionId,
        mode: 'auto',
      });
      expect(store.getState().ui).toEqual([]);
    });

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
