/**
 * ConnectOnion admission adapter for the official ACP WebSocket stream.
 *
 * Transport selection happens before this module is called.  It never opens
 * legacy /ws and therefore cannot turn a native admission failure into a
 * downgrade or a duplicate protocol connection.
 */
import {
  signBrowser,
  type AddressData,
} from '../address-browser';
import { sortedStringify } from './auth';

const AUTHORIZATION_BODY_LIMIT = 4096;
const AUTHORIZATION_TIMEOUT_MS = 10000;
const MAX_TICKET_TTL_SECONDS = 60;
const TICKET_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/** Exact pre-connection transport discovery shape from ConnectOnion DD-046. */
export interface ACPWebSocketTransport {
  readonly protocol_version: 1;
  readonly type: 'websocket';
  readonly path: '/acp';
  readonly authorization: {
    readonly type: 'connectonion-ticket';
    readonly path: '/acp/authorize';
  };
}

type CryptoProvider = {
  readonly subtle: Pick<SubtleCrypto, 'digest'>;
  randomUUID(): string;
};

export interface ACPBrowserAdmission {
  inviteCode?: string;
  payment?: number;
}

export interface AuthenticatedACPStreamOptions {
  readonly agentAddress: string;
  readonly httpUrl: string;
  readonly transport: ACPWebSocketTransport;
  readonly keys: AddressData;
  readonly admission?: ACPBrowserAdmission;
}

interface NativeACPRuntime {
  readonly fetch: typeof globalThis.fetch;
  readonly crypto: CryptoProvider;
  readonly now: () => number;
}

interface AuthorizedACPWebSocket {
  readonly url: string;
  readonly protocols: string[];
}

/** Admission failure classification used by the React lifecycle gate. */
export class ACPBrowserAdmissionError extends Error {
  constructor(
    readonly status: number,
    readonly reason: 'trust' | 'other',
  ) {
    super(`ACP browser admission refused (${status})`);
    this.name = 'ACPBrowserAdmissionError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === sortedExpected[index]);
}

/**
 * Decode the only native transport this React version supports.
 *
 * Absence is the legacy compatibility signal.  Once an ACP key exists,
 * malformed or future unsupported values throw instead of being treated as
 * absence, because that would create an automatic downgrade.
 */
export function decodeACPTransport(value: unknown): ACPWebSocketTransport | null {
  if (value === undefined) return null;
  if (!isRecord(value)) throw new Error('Malformed ConnectOnion transport discovery');
  if (!Object.prototype.hasOwnProperty.call(value, 'acp')) return null;

  const acp = value.acp;
  if (!isRecord(acp) || !exactKeys(acp, ['authorization', 'path', 'protocol_version', 'type'])) {
    throw new Error('Malformed ConnectOnion ACP transport descriptor');
  }
  const authorization = acp.authorization;
  if (
    acp.protocol_version !== 1
    || acp.type !== 'websocket'
    || acp.path !== '/acp'
    || !isRecord(authorization)
    || !exactKeys(authorization, ['path', 'type'])
    || authorization.type !== 'connectonion-ticket'
    || authorization.path !== '/acp/authorize'
  ) {
    throw new Error('Unsupported ConnectOnion ACP transport descriptor');
  }
  return acp as unknown as ACPWebSocketTransport;
}

function exactURL(base: string, path: string): URL {
  const baseUrl = new URL(base);
  if (
    (baseUrl.protocol !== 'http:' && baseUrl.protocol !== 'https:')
    || baseUrl.username
    || baseUrl.password
    || baseUrl.pathname !== '/'
    || baseUrl.search
    || baseUrl.hash
  ) {
    throw new Error('Native ACP requires a clean HTTP(S) agent origin');
  }
  const url = new URL(path, `${baseUrl.origin}/`);
  if (url.origin !== baseUrl.origin || url.pathname !== path || url.search || url.hash) {
    throw new Error('Native ACP transport path escaped the agent origin');
  }
  return url;
}

function isLoopback(url: URL): boolean {
  return url.hostname === 'localhost'
    || url.hostname === '[::1]'
    || /^127(?:\.\d{1,3}){3}$/.test(url.hostname);
}

function authorizationBody(admission?: ACPBrowserAdmission): string {
  const body: Record<string, unknown> = {};
  if (admission?.inviteCode !== undefined) {
    if (!admission.inviteCode || admission.inviteCode.length > 512) {
      throw new Error('Invalid ACP admission invite code');
    }
    body.invite_code = admission.inviteCode;
  }
  if (admission?.payment !== undefined) {
    if (!Number.isFinite(admission.payment) || admission.payment < 0) {
      throw new Error('Invalid ACP admission payment');
    }
    body.payment = admission.payment;
  }
  return JSON.stringify(body);
}

async function sha256Hex(text: string, crypto: CryptoProvider): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

async function boundedResponseText(response: Response): Promise<string> {
  const declaredLength = response.headers.get('content-length');
  if (declaredLength && /^\d+$/.test(declaredLength)) {
    const size = Number(declaredLength);
    if (!Number.isSafeInteger(size) || size > AUTHORIZATION_BODY_LIMIT) {
      throw new Error('ACP browser admission response is too large');
    }
  }
  if (!response.body) {
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > AUTHORIZATION_BODY_LIMIT) {
      throw new Error('ACP browser admission response is too large');
    }
    return text;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > AUTHORIZATION_BODY_LIMIT) {
      await reader.cancel();
      throw new Error('ACP browser admission response is too large');
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Error('ACP browser admission response is not valid UTF-8');
  }
}

async function readTicket(response: Response): Promise<string[]> {
  if (response.status !== 201) {
    let reason: 'trust' | 'other' = 'other';
    try {
      const contentType = response.headers.get('content-type')
        ?.split(';', 1)[0]
        .trim()
        .toLowerCase();
      const cacheDirectives = response.headers.get('cache-control')
        ?.toLowerCase()
        .split(',')
        .map((directive) => directive.trim());
      if (
        response.status === 403
        && contentType === 'application/json'
        && cacheDirectives?.includes('no-store')
      ) {
        const error = JSON.parse(await boundedResponseText(response));
        if (
          isRecord(error)
          && typeof error.error === 'string'
          && error.error.startsWith('forbidden:')
        ) reason = 'trust';
      }
    } catch {
      // The status is still terminal. Malformed error details are never used to
      // grant a trust flow or weaken native transport selection.
    }
    throw new ACPBrowserAdmissionError(response.status, reason);
  }
  const contentType = response.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase();
  if (contentType !== 'application/json') {
    throw new Error('ACP browser admission returned an unsupported content type');
  }
  const cacheDirectives = response.headers.get('cache-control')
    ?.toLowerCase()
    .split(',')
    .map((directive) => directive.trim());
  if (!cacheDirectives?.includes('no-store')) {
    throw new Error('ACP browser admission response is cacheable');
  }

  const text = await boundedResponseText(response);
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error('ACP browser admission returned malformed JSON');
  }
  if (
    !isRecord(value)
    || !exactKeys(value, ['expires_in', 'protocols', 'ticket', 'websocket_path'])
    || typeof value.ticket !== 'string'
    || !TICKET_PATTERN.test(value.ticket)
    || !Number.isInteger(value.expires_in)
    || (value.expires_in as number) <= 0
    || (value.expires_in as number) > MAX_TICKET_TTL_SECONDS
    || value.websocket_path !== '/acp'
    || !Array.isArray(value.protocols)
    || value.protocols.length !== 2
    || value.protocols[0] !== 'acp'
    || value.protocols[1] !== `connectonion.ticket.${value.ticket}`
  ) {
    throw new Error('ACP browser admission returned an invalid ticket');
  }
  return value.protocols as string[];
}

/**
 * Internal, deterministic admission core used by the ESM-only public adapter.
 * Keeping clock, crypto, and fetch seams here avoids making test machinery part
 * of the package's public API.
 */
/** @internal */
export async function authorizeAuthenticatedACP(
  options: AuthenticatedACPStreamOptions,
  runtime: NativeACPRuntime,
): Promise<AuthorizedACPWebSocket> {
  if (!/^0x[0-9a-f]{64}$/.test(options.agentAddress)) {
    throw new Error('Native ACP requires a canonical Agent address');
  }
  if (!/^0x[0-9a-f]{64}$/.test(options.keys.address)) {
    throw new Error('Native ACP requires a canonical caller address');
  }
  const transport = decodeACPTransport({ acp: options.transport });
  if (!transport) throw new Error('Native ACP transport is absent');

  if (!runtime.crypto?.subtle || typeof runtime.crypto.randomUUID !== 'function') {
    throw new Error('Native ACP browser admission requires Web Crypto');
  }
  if (typeof runtime.fetch !== 'function') {
    throw new Error('Native ACP browser admission requires fetch');
  }

  const body = authorizationBody(options.admission);
  const timestamp = Math.floor(runtime.now() / 1000);
  const requestId = runtime.crypto.randomUUID().replace(/-/g, '');
  if (!/^[0-9a-f]{32}$/.test(requestId)) {
    throw new Error('Web Crypto returned an invalid request ID');
  }
  if (!Number.isSafeInteger(timestamp) || timestamp <= 0) {
    throw new Error('Native ACP admission requires a valid timestamp');
  }
  const payload = {
    method: 'POST',
    path: transport.authorization.path,
    query: '',
    body_sha256: await sha256Hex(body, runtime.crypto),
    timestamp,
    request_id: requestId,
    to: options.agentAddress,
  };
  const signature = signBrowser(options.keys, sortedStringify(payload));
  const authorizeUrl = exactURL(options.httpUrl, transport.authorization.path);
  if (authorizeUrl.protocol === 'http:' && !isLoopback(authorizeUrl)) {
    throw new Error('Native ACP requires HTTPS outside loopback');
  }
  // Browser `window.fetch` is a Web IDL method and some engines reject an
  // unbound call. The production ESM driver stores it in the runtime seam, so
  // calling it as `runtime.fetch(...)` supplies the seam object as `this`
  // instead of Window and Chromium throws "Illegal invocation" before the
  // signed authorization request leaves the page. Call with the real global
  // receiver; injected test fetchers remain ordinary functions and ignore it.
  const response = await runtime.fetch.call(globalThis, authorizeUrl, {
    method: 'POST',
    body,
    cache: 'no-store',
    credentials: 'omit',
    redirect: 'error',
    referrerPolicy: 'no-referrer',
    signal: AbortSignal.timeout(AUTHORIZATION_TIMEOUT_MS),
    headers: {
      'content-type': 'application/json',
      'x-co-from': options.keys.address,
      'x-co-signature': signature,
      'x-co-timestamp': String(timestamp),
      'x-co-to': options.agentAddress,
      'x-co-request-id': requestId,
    },
  });
  const protocols = await readTicket(response);

  const websocketUrl = exactURL(options.httpUrl, transport.path);
  websocketUrl.protocol = websocketUrl.protocol === 'https:' ? 'wss:' : 'ws:';
  return { url: websocketUrl.href, protocols };
}
