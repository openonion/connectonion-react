/**
 * Experimental native ACP browser transport.
 *
 * This entry point is ESM-only because the official ACP SDK 1.2.1 WebSocket
 * adapter is ESM-only. Keeping it outside the package root preserves existing
 * CommonJS consumers and lets modern browser bundlers follow the SDK's native
 * package exports without a require(ESM) compatibility trap.
 */
import type { Stream } from '@agentclientprotocol/sdk';
import {
  createWebSocketStream,
} from '@agentclientprotocol/sdk/experimental/ws-client';

import * as core from '../connect/native-acp.js';
import type {
  ACPBrowserAdmission,
  ACPWebSocketTransport,
  AuthenticatedACPStreamOptions,
} from '../connect/native-acp.js';

export type {
  ACPBrowserAdmission,
  ACPWebSocketTransport,
  AuthenticatedACPStreamOptions,
};

export const decodeACPTransport = core.decodeACPTransport;

/**
 * Exchange one signed request for a one-use ticket and immediately construct
 * the official ACP stream. The ticket is never returned, logged, persisted, or
 * placed in a URL; it exists only in the WebSocket subprotocol negotiation.
 */
export async function createAuthenticatedACPStream(
  options: AuthenticatedACPStreamOptions,
): Promise<Stream> {
  const crypto = globalThis.crypto;
  if (!crypto) throw new Error('Native ACP browser admission requires Web Crypto');

  const authorized = await core.authorizeAuthenticatedACP(options, {
    fetch: globalThis.fetch,
    crypto,
    now: Date.now,
  });
  return createWebSocketStream(authorized.url, {
    protocols: authorized.protocols,
    cookies: 'omit',
  });
}
