import {
  selectBrowserTransport,
} from '../src/connect/transport-selection';
import type { ACPWebSocketTransport } from '../src/connect/native-acp';

const AGENT = `0x${'a'.repeat(64)}`;
const TRANSPORT: ACPWebSocketTransport = {
  protocol_version: 1,
  type: 'websocket',
  path: '/acp',
  authorization: {
    type: 'connectonion-ticket',
    path: '/acp/authorize',
  },
};

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'no-store',
    },
  });
}

afterEach(() => {
  jest.restoreAllMocks();
  // @ts-expect-error test page stub
  delete globalThis.location;
});

describe('DD-046 atomic browser transport selection', () => {
  test('exact direct discovery selects native ACP once', async () => {
    const fetcher = jest.fn(async (_input: URL | RequestInfo) => jsonResponse({
      address: AGENT,
      transports: { acp: TRANSPORT },
    }));
    globalThis.fetch = fetcher as unknown as typeof fetch;

    await expect(selectBrowserTransport({
      agentAddress: AGENT,
      relayUrl: 'wss://relay.example',
      directUrl: 'https://agent.example',
    })).resolves.toEqual({
      kind: 'native-acp',
      httpUrl: 'https://agent.example',
      transport: TRANSPORT,
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(String(fetcher.mock.calls[0][0])).toBe('https://agent.example/info');
  });

  test('genuine descriptor absence is the direct legacy signal', async () => {
    globalThis.fetch = jest.fn(async () => jsonResponse({ address: AGENT })) as unknown as typeof fetch;

    await expect(selectBrowserTransport({
      agentAddress: AGENT,
      relayUrl: 'wss://relay.example',
      directUrl: 'https://agent.example',
    })).resolves.toEqual({
      kind: 'legacy-direct',
      httpUrl: 'https://agent.example',
      wsUrl: 'wss://agent.example/ws',
    });
  });

  test.each([
    jsonResponse({ address: AGENT, transports: { acp: null } }),
    jsonResponse({ address: AGENT, transports: { acp: { ...TRANSPORT, protocol_version: 2 } } }),
    jsonResponse({ address: `0x${'b'.repeat(64)}`, transports: { acp: TRANSPORT } }),
    new Response('{', { headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } }),
    new Response('{}', { status: 503, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } }),
    new Response('{}', { headers: { 'content-type': 'application/json' } }),
  ])('direct discovery failures fail closed: %#', async (response) => {
    const fetcher = jest.fn(async () => response.clone());
    globalThis.fetch = fetcher as unknown as typeof fetch;

    await expect(selectBrowserTransport({
      agentAddress: AGENT,
      relayUrl: 'wss://relay.example',
      directUrl: 'https://agent.example',
    })).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  test('relay topology with no browser-reachable direct route selects relay legacy', async () => {
    Object.defineProperty(globalThis, 'location', {
      configurable: true,
      value: { protocol: 'https:' },
    });
    const fetcher = jest.fn(async () => jsonResponse({
      endpoints: ['http://localhost:8001', 'http://10.0.0.2:8001'],
    }));
    globalThis.fetch = fetcher as unknown as typeof fetch;

    await expect(selectBrowserTransport({
      agentAddress: AGENT,
      relayUrl: 'wss://relay.example',
    })).resolves.toEqual({
      kind: 'legacy-relay',
      wsUrl: 'wss://relay.example/ws/input',
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  test('a reachable advertised route makes all probe failures terminal', async () => {
    const fetcher = jest.fn(async (input: URL | RequestInfo) => {
      if (String(input).includes('/api/agents/')) {
        return jsonResponse({ endpoints: ['https://agent.example'] });
      }
      throw new Error('TLS failed');
    });
    globalThis.fetch = fetcher as unknown as typeof fetch;

    await expect(selectBrowserTransport({
      agentAddress: AGENT,
      relayUrl: 'wss://relay.example',
    })).rejects.toThrow('TLS failed');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  test('relay lookup failure is not reinterpreted as no direct candidates', async () => {
    const fetcher = jest.fn(async () => {
      throw new Error('relay TLS failed');
    });
    globalThis.fetch = fetcher as unknown as typeof fetch;

    await expect(selectBrowserTransport({
      agentAddress: AGENT,
      relayUrl: 'wss://relay.example',
    })).rejects.toThrow('relay TLS failed');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  test('bounds /info before parsing', async () => {
    globalThis.fetch = jest.fn(async () => new Response('x'.repeat(70_000), {
      headers: {
        'content-type': 'application/json',
        'cache-control': 'no-store',
      },
    })) as unknown as typeof fetch;

    await expect(selectBrowserTransport({
      agentAddress: AGENT,
      relayUrl: 'wss://relay.example',
      directUrl: 'https://agent.example',
    })).rejects.toThrow('response is too large');
  });
});
