import { createHash, webcrypto } from 'crypto';

import * as address from '../src/address-browser';
import { verify } from '../src/address';
import {
  ACPBrowserAdmissionError,
  authorizeAuthenticatedACP,
  decodeACPTransport,
  type ACPWebSocketTransport,
} from '../src/connect/native-acp';

const AGENT = `0x${'a'.repeat(64)}`;
const TICKET = 'b'.repeat(43);
const TRANSPORT: ACPWebSocketTransport = {
  protocol_version: 1,
  type: 'websocket',
  path: '/acp',
  authorization: {
    type: 'connectonion-ticket',
    path: '/acp/authorize',
  },
};

function ticketResponse(overrides: Record<string, unknown> = {}): Response {
  return new Response(JSON.stringify({
    ticket: TICKET,
    expires_in: 60,
    websocket_path: '/acp',
    protocols: ['acp', `connectonion.ticket.${TICKET}`],
    ...overrides,
  }), {
    status: 201,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'no-store',
    },
  });
}

function deterministicCrypto() {
  return {
    subtle: webcrypto.subtle,
    randomUUID: () => '12345678-1234-4234-8234-123456789abc',
  };
}

describe('DD-046 transport discovery', () => {
  test('absence is the only legacy fallback signal', () => {
    expect(decodeACPTransport(undefined)).toBeNull();
    expect(decodeACPTransport({})).toBeNull();
    expect(decodeACPTransport({ relay: { type: 'websocket' } })).toBeNull();
  });

  test('accepts only the exact native ACP descriptor', () => {
    expect(decodeACPTransport({ acp: TRANSPORT })).toEqual(TRANSPORT);
  });

  test.each([
    null,
    { acp: { ...TRANSPORT, protocol_version: 2 } },
    { acp: { ...TRANSPORT, path: '/ws' } },
    { acp: { ...TRANSPORT, surprise: true } },
    { acp: { ...TRANSPORT, authorization: { ...TRANSPORT.authorization, path: '/token' } } },
    { acp: null },
    [],
  ])('fails closed on malformed or unsupported discovery: %#', (value) => {
    expect(() => decodeACPTransport(value)).toThrow(/ACP transport|transport discovery/);
  });

});

describe('signed browser ticket admission', () => {
  test('invokes a captured browser fetch with the Window/global receiver', async () => {
    const browserFetch = jest.fn(function (this: unknown) {
      if (this !== globalThis) throw new TypeError('Illegal invocation');
      return Promise.resolve(ticketResponse());
    });

    await expect(authorizeAuthenticatedACP({
      agentAddress: AGENT,
      httpUrl: 'https://agent.example',
      transport: TRANSPORT,
      keys: address.generateBrowser(),
    }, {
      fetch: browserFetch as unknown as typeof fetch,
      crypto: deterministicCrypto() as never,
      now: Date.now,
    })).resolves.toEqual({
      url: 'wss://agent.example/acp',
      protocols: ['acp', `connectonion.ticket.${TICKET}`],
    });
    expect(browserFetch).toHaveBeenCalledTimes(1);
  });

  test('signs exact bytes, omits credentials, and opens one stream through the official adapter contract', async () => {
    const keys = address.generateBrowser();
    let request: { url: string; init: RequestInit } | undefined;
    const fetcher = jest.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      request = { url: String(input), init: init ?? {} };
      return ticketResponse();
    });

    const authorized = await authorizeAuthenticatedACP({
      agentAddress: AGENT,
      httpUrl: 'https://agent.example',
      transport: TRANSPORT,
      keys,
    }, {
      fetch: fetcher as typeof fetch,
      crypto: deterministicCrypto() as never,
      now: () => 1_700_000_000_000,
    });

    expect(request?.url).toBe('https://agent.example/acp/authorize');
    expect(request?.init).toMatchObject({
      method: 'POST',
      body: '{}',
      cache: 'no-store',
      credentials: 'omit',
      redirect: 'error',
      referrerPolicy: 'no-referrer',
    });
    const headers = new Headers(request?.init.headers);
    expect(headers.get('x-co-from')).toBe(keys.address);
    expect(headers.get('x-co-to')).toBe(AGENT);
    expect(headers.get('x-co-timestamp')).toBe('1700000000');
    expect(headers.get('x-co-request-id')).toBe('12345678123442348234123456789abc');

    const payload = {
      method: 'POST',
      path: '/acp/authorize',
      query: '',
      body_sha256: createHash('sha256').update('{}').digest('hex'),
      timestamp: 1_700_000_000,
      request_id: '12345678123442348234123456789abc',
      to: AGENT,
    };
    expect(verify(
      keys.address,
      JSON.stringify(payload, Object.keys(payload).sort()),
      headers.get('x-co-signature')!,
    )).toBe(true);
    expect(authorized).toEqual({
      url: 'wss://agent.example/acp',
      protocols: ['acp', `connectonion.ticket.${TICKET}`],
    });
  });

  test('binds onboarding fields into the exact signed body', async () => {
    const keys = address.generateBrowser();
    let sentBody: BodyInit | null | undefined;
    const fetcher = jest.fn(async (_input: URL | RequestInfo, init?: RequestInit) => {
      sentBody = init?.body;
      return ticketResponse();
    });

    await authorizeAuthenticatedACP({
      agentAddress: AGENT,
      httpUrl: 'https://agent.example',
      transport: TRANSPORT,
      keys,
      admission: { inviteCode: 'BETA', payment: 5 },
    }, {
      fetch: fetcher as typeof fetch,
      crypto: deterministicCrypto() as never,
      now: Date.now,
    });

    expect(sentBody).toBe('{"invite_code":"BETA","payment":5}');
  });

  test.each([
    [403, 'no-store', 'trust'],
    [403, null, 'other'],
    [500, 'no-store', 'other'],
  ] as const)(
    'recognizes only a non-cacheable 403 forbidden response as a trust gate',
    async (status, cacheControl, reason) => {
      const response = new Response(JSON.stringify({ error: 'forbidden: onboard required' }), {
        status,
        headers: {
          'content-type': 'application/json',
          ...(cacheControl ? { 'cache-control': cacheControl } : {}),
        },
      });

      const attempt = authorizeAuthenticatedACP({
        agentAddress: AGENT,
        httpUrl: 'https://agent.example',
        transport: TRANSPORT,
        keys: address.generateBrowser(),
      }, {
        fetch: jest.fn(async () => response) as unknown as typeof fetch,
        crypto: deterministicCrypto() as never,
        now: Date.now,
      });

      await expect(attempt).rejects.toEqual(expect.objectContaining({
        name: ACPBrowserAdmissionError.name,
        status,
        reason,
      }));
    },
  );

  test.each([
    new Response('{}', { status: 403, headers: { 'content-type': 'application/json' } }),
    new Response('{}', { status: 201, headers: { 'content-type': 'text/plain', 'cache-control': 'no-store' } }),
    new Response('{}', { status: 201, headers: { 'content-type': 'application/json' } }),
    new Response('{}', { status: 201, headers: { 'content-type': 'application/json', 'cache-control': 'public-x-no-store' } }),
    ticketResponse({ expires_in: 61 }),
    ticketResponse({ protocols: ['acp', `connectonion.ticket.${TICKET}`, 'extra'] }),
  ])('fails closed before WebSocket on invalid admission response: %#', async (response) => {
    await expect(authorizeAuthenticatedACP({
      agentAddress: AGENT,
      httpUrl: 'https://agent.example',
      transport: TRANSPORT,
      keys: address.generateBrowser(),
    }, {
      fetch: jest.fn(async () => response.clone()) as unknown as typeof fetch,
      crypto: deterministicCrypto() as never,
      now: Date.now,
    })).rejects.toThrow();
  });

  test('refuses plaintext outside loopback before sending identity or admission', async () => {
    const fetcher = jest.fn();

    await expect(authorizeAuthenticatedACP({
      agentAddress: AGENT,
      httpUrl: 'http://agent.example',
      transport: TRANSPORT,
      keys: address.generateBrowser(),
    }, {
      fetch: fetcher as typeof fetch,
      crypto: deterministicCrypto() as never,
      now: Date.now,
    })).rejects.toThrow('requires HTTPS outside loopback');

    expect(fetcher).not.toHaveBeenCalled();
  });

  test('bounds the authorization response while reading it', async () => {
    const response = new Response('x'.repeat(5000), {
      status: 201,
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    });

    await expect(authorizeAuthenticatedACP({
      agentAddress: AGENT,
      httpUrl: 'https://agent.example',
      transport: TRANSPORT,
      keys: address.generateBrowser(),
    }, {
      fetch: jest.fn(async () => response) as unknown as typeof fetch,
      crypto: deterministicCrypto() as never,
      now: Date.now,
    })).rejects.toThrow('response is too large');
  });
});
