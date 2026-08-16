/**
 * What a page served over HTTPS is allowed to probe.
 *
 * An agent publishes every address it can be reached at, and the resolver walks
 * them looking for one that answers. Written for a CLI, that list is sensible:
 * localhost first, then the LAN, then the public IP — nearest wins.
 *
 * In a browser it means something else. `localhost` is the *visitor's* machine,
 * not the agent's. And from an https:// page every http:// candidate is dead on
 * arrival: the browser blocks it as mixed content before the request leaves.
 *
 * Observed on chat.openonion.ai, on every single page load:
 *
 *   http://localhost:8001/info        net::ERR_CONNECTION_REFUSED
 *   http://10.152.0.16:8001/info      blocked: mixed-content
 *   http://34.151.137.226:8001/info   blocked: mixed-content
 *
 * Three guaranteed failures, two console errors, one port scan of the reader's
 * own machine, and the relay fallback delayed behind all of it.
 */
import { fetchAgentInfo, resolveEndpoint } from '../src/connect/endpoint';

const ADDR = '0x' + 'b'.repeat(64);

function relayReturns(endpoints: string[], probed: string[]) {
  return jest.fn(async (url: string) => {
    if (url.includes('/api/agents/')) {
      return { ok: true, json: async () => ({ endpoints }) } as unknown as Response;
    }
    probed.push(url);
    return { ok: true, json: async () => ({ address: ADDR }) } as unknown as Response;
  });
}

function setPageProtocol(protocol: 'http:' | 'https:') {
  Object.defineProperty(globalThis, 'location', {
    value: { protocol, hostname: protocol === 'https:' ? 'chat.openonion.ai' : 'localhost' },
    writable: true,
    configurable: true,
  });
}

afterEach(() => {
  jest.restoreAllMocks();
  // @ts-expect-error - remove the stub between tests
  delete globalThis.location;
});

describe('an https page', () => {
  const ENDPOINTS = [
    'http://localhost:8001',
    'http://10.152.0.16:8001',
    'http://34.151.137.226:8001',
    'https://agent.example.com',
  ];

  test('never probes an http endpoint — the browser would block it anyway', async () => {
    const probed: string[] = [];
    setPageProtocol('https:');
    globalThis.fetch = relayReturns(ENDPOINTS, probed) as unknown as typeof fetch;

    await resolveEndpoint(ADDR, 'wss://oo.openonion.ai');

    expect(probed.filter(u => u.startsWith('http://'))).toEqual([]);
  });

  test('never touches the visitor’s own machine', async () => {
    const probed: string[] = [];
    setPageProtocol('https:');
    globalThis.fetch = relayReturns(ENDPOINTS, probed) as unknown as typeof fetch;

    await resolveEndpoint(ADDR, 'wss://oo.openonion.ai');

    expect(probed.filter(u => u.includes('localhost') || u.includes('127.0.0.1'))).toEqual([]);
  });

  test('still uses an https endpoint when the agent publishes one', async () => {
    const probed: string[] = [];
    setPageProtocol('https:');
    globalThis.fetch = relayReturns(ENDPOINTS, probed) as unknown as typeof fetch;

    const resolved = await resolveEndpoint(ADDR, 'wss://oo.openonion.ai');

    expect(resolved?.httpUrl).toBe('https://agent.example.com');
    expect(resolved?.wsUrl).toBe('wss://agent.example.com/ws');
  });

  test('falls back to the relay when every candidate is http', async () => {
    const probed: string[] = [];
    setPageProtocol('https:');
    globalThis.fetch = relayReturns(ENDPOINTS.slice(0, 3), probed) as unknown as typeof fetch;

    expect(await resolveEndpoint(ADDR, 'wss://oo.openonion.ai')).toBeNull();
    expect(probed).toEqual([]);
  });

  test('all Relay discovery and direct info requests bypass stale browser caches', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    setPageProtocol('https:');
    globalThis.fetch = jest.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (url.includes('/api/agents/')) {
        return {
          ok: true,
          json: async () => ({
            endpoints: ['https://agent.example.com'],
            relay: 'wss://oo.openonion.ai',
          }),
        } as unknown as Response;
      }
      return {
        ok: true,
        json: async () => ({ address: ADDR, name: 'Fresh agent' }),
      } as unknown as Response;
    }) as unknown as typeof fetch;

    await resolveEndpoint(ADDR, 'wss://oo.openonion.ai');
    await fetchAgentInfo(ADDR, 'wss://oo.openonion.ai');

    expect(calls).toHaveLength(4);
    expect(calls.map(call => call.init?.cache)).toEqual([
      'no-store', 'no-store', 'no-store', 'no-store',
    ]);
  });
});

describe('local development is untouched', () => {
  test('an http page still probes http endpoints, localhost first', async () => {
    const probed: string[] = [];
    setPageProtocol('http:');
    globalThis.fetch = relayReturns(
      ['http://34.151.137.226:8001', 'http://localhost:8000'], probed,
    ) as unknown as typeof fetch;

    const resolved = await resolveEndpoint(ADDR, 'ws://localhost:8080');

    expect(probed[0]).toBe('http://localhost:8000/info');
    expect(resolved?.httpUrl).toBe('http://localhost:8000');
  });
});

describe('outside a browser', () => {
  test('no location at all means probe everything, as before', async () => {
    const probed: string[] = [];
    globalThis.fetch = relayReturns(['http://localhost:8000'], probed) as unknown as typeof fetch;

    const resolved = await resolveEndpoint(ADDR, 'ws://localhost:8080');

    expect(resolved?.httpUrl).toBe('http://localhost:8000');
  });
});
