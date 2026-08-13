jest.mock('../src/browser-identity', () => ({
  initializeBrowserIdentity: jest.fn(),
  retainPendingBrowserRecovery: jest.fn(),
}));

import {
  initializeBrowserIdentity,
  retainPendingBrowserRecovery,
} from '../src/browser-identity';
import { transcribe } from '../src/transcribe';

const mockInitializeBrowserIdentity = initializeBrowserIdentity as jest.MockedFunction<
  typeof initializeBrowserIdentity
>;
const mockRetainPendingBrowserRecovery = retainPendingBrowserRecovery as jest.MockedFunction<
  typeof retainPendingBrowserRecovery
>;

describe('transcription signer boundary', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    jest.clearAllMocks();
  });

  test('awaits the supplied browser signer and sends no bearer credential', async () => {
    const sign = jest.fn(async () => 'ed25519-signature');
    let request: RequestInit | undefined;
    globalThis.fetch = jest.fn(async (_input, init) => {
      request = init;
      return new Response(JSON.stringify({
        choices: [{ message: { content: 'hello from audio' } }],
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;

    const result = await transcribe(new Blob([new Uint8Array([1, 2, 3])], {
      type: 'audio/wav',
    }), {
      signer: { address: `0x${'a'.repeat(64)}`, sign },
      baseUrl: 'https://voice.example',
    });

    expect(result).toBe('hello from audio');
    expect(sign).toHaveBeenCalledTimes(1);
    const headers = new Headers(request?.headers);
    expect(headers.get('x-from')).toBe(`0x${'a'.repeat(64)}`);
    expect(headers.get('x-signature')).toBe('ed25519-signature');
    expect(headers.has('authorization')).toBe(false);
  });

  test('hands a default signer recovery phrase to the application', async () => {
    const recovery = { kind: 'mnemonic', value: 'one-time recovery words' } as const;
    const sign = jest.fn(async () => 'default-signature');
    mockInitializeBrowserIdentity.mockResolvedValue({
      source: 'created',
      recovery,
      identity: {
        address: `0x${'b'.repeat(64)}`,
        shortAddress: '0xbbbb...bbbb',
        publicKey: new Uint8Array(32),
        sign,
      },
    });
    globalThis.fetch = jest.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: 'secure default' } }],
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as typeof fetch;

    await expect(transcribe(new Blob([new Uint8Array([1])], {
      type: 'audio/wav',
    }))).resolves.toBe('secure default');

    expect(mockRetainPendingBrowserRecovery).toHaveBeenCalledWith(recovery);
    expect(sign).toHaveBeenCalledTimes(1);
  });
});
