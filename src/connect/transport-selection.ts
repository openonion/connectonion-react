import { normalizeRelayUrl } from './endpoint';
import {
  decodeACPTransport,
  type ACPWebSocketTransport,
} from './native-acp';

const DISCOVERY_BODY_LIMIT = 64 * 1024;
const DISCOVERY_TIMEOUT_MS = 3000;

export type BrowserTransportSelection =
  | {
    readonly kind: 'native-acp';
    readonly httpUrl: string;
    readonly transport: ACPWebSocketTransport;
    readonly onboard?: {
      readonly inviteCode: boolean;
      readonly payment: number | null;
    };
  }
  | { readonly kind: 'legacy-direct'; readonly httpUrl: string; readonly wsUrl: string }
  | { readonly kind: 'legacy-relay'; readonly wsUrl: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function reachableFromHere(endpoints: readonly string[]): string[] {
  const pageIsSecure = typeof location !== 'undefined'
    && location?.protocol === 'https:';
  return endpoints.filter((endpoint) => {
    if (!endpoint.startsWith('http://') && !endpoint.startsWith('https://')) return false;
    return !pageIsSecure || endpoint.startsWith('https://');
  });
}

function sortByProximity(endpoints: readonly string[]): string[] {
  const priority = (url: string): number => {
    if (url.includes('localhost') || url.includes('127.0.0.1')) return 0;
    if (url.includes('192.168.') || url.includes('10.') || url.includes('172.16.')) return 1;
    return 2;
  };
  return [...endpoints].sort((a, b) => priority(a) - priority(b));
}

function cleanOrigin(value: string): string {
  const url = new URL(value);
  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:')
    || url.username
    || url.password
    || (url.pathname !== '/' && url.pathname !== '')
    || url.search
    || url.hash
  ) throw new Error('Agent endpoint must be a clean HTTP(S) origin');
  return url.origin;
}

function legacyWsUrl(httpUrl: string): string {
  const url = new URL('/ws', `${httpUrl}/`);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.href;
}

async function boundedText(response: Response): Promise<string> {
  const declared = response.headers.get('content-length');
  if (declared && /^\d+$/.test(declared) && Number(declared) > DISCOVERY_BODY_LIMIT) {
    throw new Error('Agent transport discovery response is too large');
  }
  if (!response.body) {
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > DISCOVERY_BODY_LIMIT) {
      throw new Error('Agent transport discovery response is too large');
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
    if (total > DISCOVERY_BODY_LIMIT) {
      await reader.cancel();
      throw new Error('Agent transport discovery response is too large');
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
    throw new Error('Agent transport discovery response is not valid UTF-8');
  }
}

async function boundedJson(response: Response, label: string): Promise<unknown> {
  try {
    return JSON.parse(await boundedText(response));
  } catch (cause) {
    if (cause instanceof SyntaxError) {
      throw new Error(`${label} returned malformed JSON`);
    }
    throw cause;
  }
}

async function discoverAt(
  httpUrl: string,
  agentAddress: string,
  timeoutMs: number,
): Promise<Exclude<BrowserTransportSelection, { kind: 'legacy-relay' }>> {
  const origin = cleanOrigin(httpUrl);
  const response = await fetch(`${origin}/info`, {
    cache: 'no-store',
    credentials: 'omit',
    redirect: 'error',
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`Agent transport discovery failed (${response.status})`);
  const cacheControl = response.headers.get('cache-control')
    ?.split(',')
    .map((part) => part.trim().toLowerCase());
  if (!cacheControl?.includes('no-store')) {
    throw new Error('Agent transport discovery response is cacheable');
  }
  const contentType = response.headers.get('content-type')
    ?.split(';', 1)[0]
    .trim()
    .toLowerCase();
  if (contentType !== 'application/json') {
    throw new Error('Agent transport discovery returned an unsupported content type');
  }
  const info = await boundedJson(response, 'Agent transport discovery');
  if (!isRecord(info) || info.address !== agentAddress) {
    throw new Error('Agent transport discovery returned the wrong Agent address');
  }
  const transports = Object.prototype.hasOwnProperty.call(info, 'transports')
    ? info.transports
    : undefined;
  const transport = decodeACPTransport(transports);
  const onboardValue = Object.prototype.hasOwnProperty.call(info, 'onboard')
    ? info.onboard
    : undefined;
  let onboard: { inviteCode: boolean; payment: number | null } | undefined;
  if (onboardValue !== undefined) {
    if (
      !isRecord(onboardValue)
      || typeof onboardValue.invite_code !== 'boolean'
      || !(
        onboardValue.payment === null
        || (typeof onboardValue.payment === 'number'
          && Number.isFinite(onboardValue.payment)
          && onboardValue.payment >= 0)
      )
    ) throw new Error('Agent transport discovery returned malformed onboarding metadata');
    onboard = {
      inviteCode: onboardValue.invite_code,
      payment: onboardValue.payment,
    };
  }
  return transport
    ? {
      kind: 'native-acp',
      httpUrl: origin,
      transport,
      ...(onboard ? { onboard } : {}),
    }
    : { kind: 'legacy-direct', httpUrl: origin, wsUrl: legacyWsUrl(origin) };
}

/**
 * Choose one browser transport before admission or prompt delivery.
 *
 * A reachable direct endpoint is an explicit branch: if all of its /info
 * probes fail, the caller fails closed and never turns that failure into relay
 * delivery.  Relay legacy is selected only when relay topology advertises no
 * browser-reachable direct endpoint.
 */
export async function selectBrowserTransport(options: {
  readonly agentAddress: string;
  readonly relayUrl: string;
  readonly directUrl?: string;
  readonly timeoutMs?: number;
}): Promise<BrowserTransportSelection> {
  const timeoutMs = options.timeoutMs ?? DISCOVERY_TIMEOUT_MS;
  if (options.directUrl) {
    return discoverAt(options.directUrl, options.agentAddress, timeoutMs);
  }

  const relay = normalizeRelayUrl(options.relayUrl);
  const relayHttp = relay
    .replace(/^wss:\/\//, 'https://')
    .replace(/^ws:\/\//, 'http://');
  const relayResponse = await fetch(
    `${relayHttp}/api/agents/${encodeURIComponent(options.agentAddress)}`,
    {
    cache: 'no-store',
    credentials: 'omit',
    signal: AbortSignal.timeout(timeoutMs),
    },
  );
  if (!relayResponse.ok) {
    throw new Error(`Relay transport lookup failed (${relayResponse.status})`);
  }
  const relayInfo = await boundedJson(
    relayResponse,
    'Relay transport lookup',
  ) as {
    endpoints?: unknown;
  } | null;
  if (!isRecord(relayInfo)) {
    throw new Error('Relay transport lookup returned an invalid response');
  }
  const endpoints = Array.isArray(relayInfo?.endpoints)
    ? relayInfo.endpoints.filter((item): item is string => typeof item === 'string')
    : [];
  const reachable = sortByProximity(reachableFromHere(endpoints));
  if (reachable.length === 0) {
    return { kind: 'legacy-relay', wsUrl: `${relay}/ws/input` };
  }

  let lastError: Error | null = null;
  for (const endpoint of reachable) {
    try {
      return await discoverAt(endpoint, options.agentAddress, timeoutMs);
    } catch (cause) {
      lastError = cause instanceof Error ? cause : new Error(String(cause));
    }
  }
  throw lastError ?? new Error('All advertised Agent endpoints failed discovery');
}
