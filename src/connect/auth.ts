/** Shared signer boundary for legacy WebSocket and native ACP authentication. */
import * as address from '../address';
import {
  initializeBrowserIdentity,
  retainPendingBrowserRecovery,
  type MessageSigner,
} from '../browser-identity';

export type { MessageSigner } from '../browser-identity';

export function isBrowser(): boolean {
  return typeof globalThis !== 'undefined'
    && typeof (globalThis as { window?: unknown }).window !== 'undefined';
}

export function sortedStringify(obj: Record<string, unknown>): string {
  const sortedKeys = Object.keys(obj).sort();
  const sortedObj: Record<string, unknown> = {};
  for (const key of sortedKeys) sortedObj[key] = obj[key];
  return JSON.stringify(sortedObj);
}

export function signerFromKeys(keys: address.AddressData, browser = isBrowser()): MessageSigner {
  return {
    address: keys.address,
    sign(message: string): string {
      return browser ? address.signBrowser(keys, message) : address.sign(keys, message);
    },
  };
}

export async function ensureSigner(
  existing?: MessageSigner,
  keys?: address.AddressData,
): Promise<MessageSigner> {
  if (existing) return existing;
  if (keys) return signerFromKeys(keys);
  if (isBrowser()) {
    const initialized = await initializeBrowserIdentity();
    if (initialized.recovery) retainPendingBrowserRecovery(initialized.recovery);
    return initialized.identity;
  }

  const nodeKeys = address.load() ?? address.generate();
  return signerFromKeys(nodeKeys, false);
}

/** Sign one canonical protocol payload through the selected identity provider. */
export async function signPayload(
  signer: MessageSigner | undefined,
  payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  if (!signer) return { prompt: payload.prompt };
  const signature = await signer.sign(sortedStringify(payload));
  return {
    payload,
    from: signer.address,
    signature,
    timestamp: payload.timestamp,
  };
}
