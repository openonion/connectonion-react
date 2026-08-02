/**
 * @llm-note
 *   Dependencies: imports from [src/address] | imported by [src/connect/remote-agent.ts, src/connect/handlers.ts]
 *   Data flow: ensureKeys resolves or generates Ed25519 keypair | signPayload signs messages for authenticated requests
 *   State/Effects: ensureKeys may write to localStorage (browser) | no persistent module state
 */
import * as address from '../address';

export function isBrowser(): boolean {
  return typeof globalThis !== 'undefined' &&
    typeof (globalThis as { window?: unknown }).window !== 'undefined' &&
    typeof (globalThis as { localStorage?: unknown }).localStorage !== 'undefined';
}

export function sortedStringify(obj: Record<string, unknown>): string {
  const sortedKeys = Object.keys(obj).sort();
  const sortedObj: Record<string, unknown> = {};
  for (const key of sortedKeys) {
    sortedObj[key] = obj[key];
  }
  return JSON.stringify(sortedObj);
}

export function ensureKeys(existing?: address.AddressData): address.AddressData {
  if (existing) return existing;
  const inBrowser = isBrowser();
  const loaded = inBrowser ? address.loadBrowser() : address.load();
  if (loaded) return loaded;
  const keys = inBrowser ? address.generateBrowser() : address.generate();
  if (inBrowser) address.saveBrowser(keys);
  return keys;
}

/**
 * Sign a payload with Ed25519 keys.
 * Returns the signed envelope { payload, from, signature, timestamp }
 * or a fallback { prompt } if no keys provided.
 */
export function signPayload(
  keys: address.AddressData | undefined,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  if (!keys) {
    return { prompt: payload.prompt };
  }
  const canonicalMessage = sortedStringify(payload);
  const signer = isBrowser() ? address.signBrowser : address.sign;
  const signature = signer(keys, canonicalMessage);
  return {
    payload,
    from: keys.address,
    signature,
    timestamp: payload.timestamp,
  };
}
