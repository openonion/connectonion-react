/**
 * Experimental native ACP browser transport.
 *
 * This entry point is ESM-only because the official ACP SDK 1.2.1 WebSocket
 * adapter is ESM-only. Keeping it outside the package root preserves existing
 * CommonJS consumers and lets modern browser bundlers follow the SDK's native
 * package exports without a require(ESM) compatibility trap.
 */
import {
  PROTOCOL_VERSION,
  client,
  methods,
  type AgentCapabilities,
  type ContentBlock,
  type RequestPermissionResponse,
  type Stream,
} from '@agentclientprotocol/sdk';
import {
  createWebSocketStream,
} from '@agentclientprotocol/sdk/experimental/ws-client';

import * as core from '../connect/native-acp.js';
import type {
  ACPBrowserAdmission,
  ACPWebSocketTransport,
  AuthenticatedACPStreamOptions,
} from '../connect/native-acp.js';
import type {
  NativeACPConnection,
  NativeACPDriver,
  NativeACPSessionModes,
} from '../connect/native-acp-runtime.js';

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

function sessionModes(value: unknown): NativeACPSessionModes | null | undefined {
  if (value == null) return value as null | undefined;
  return value as NativeACPSessionModes;
}

/** Production driver registered by the package's conditional ESM root. */
export const officialNativeACPDriver: NativeACPDriver = {
  async open(options, handlers): Promise<NativeACPConnection> {
    const stream = await createAuthenticatedACPStream(options);
    const app = client({ name: '@connectonion/react' })
      .onRequest(methods.client.session.requestPermission, async (context) => {
        const response = await handlers.requestPermission({
          requestId: String(context.requestId),
          sessionId: context.params.sessionId,
          toolCall: context.params.toolCall,
          options: context.params.options,
        });
        return response as RequestPermissionResponse;
      })
      .onNotification(methods.client.session.update, (context) => {
        handlers.onSessionUpdate(context.params.sessionId, context.params.update);
      });
    const connection = app.connect(stream);
    let deliberatelyClosed = false;
    connection.closed.then(
      () => { if (!deliberatelyClosed) handlers.onClose(); },
      (cause: unknown) => {
        if (!deliberatelyClosed) {
          handlers.onClose(cause instanceof Error ? cause : new Error(String(cause)));
        }
      },
    );

    try {
      const initialized = await connection.agent.request(methods.agent.initialize, {
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: {},
        clientInfo: { name: '@connectonion/react', version: 'native-acp-preview' },
      });
      if (initialized.protocolVersion !== PROTOCOL_VERSION) {
        throw new Error(`Unsupported ACP protocol version: ${initialized.protocolVersion}`);
      }
      const capabilities = (initialized.agentCapabilities ?? {}) as AgentCapabilities;

      return {
        protocolVersion: initialized.protocolVersion,
        agentCapabilities: capabilities,
        agentInfo: initialized.agentInfo,
        async newSession(request) {
          const response = await connection.agent.request(methods.agent.session.new, {
            cwd: request.cwd,
            mcpServers: [],
          });
          return { sessionId: response.sessionId, modes: sessionModes(response.modes) };
        },
        async resumeSession(request) {
          const response = await connection.agent.request(methods.agent.session.resume, {
            sessionId: request.sessionId,
            cwd: request.cwd,
            mcpServers: [],
          });
          return { modes: sessionModes(response.modes) };
        },
        async prompt(request) {
          const response = await connection.agent.request(methods.agent.session.prompt, {
            sessionId: request.sessionId,
            prompt: request.prompt.map((block) => ({ ...block })) as ContentBlock[],
          });
          return { stopReason: response.stopReason };
        },
        async setSessionMode(request) {
          await connection.agent.request(methods.agent.session.setMode, request);
        },
        async cancel(request) {
          await connection.agent.notify(methods.agent.session.cancel, request);
        },
        async closeSession(request) {
          await connection.agent.request(methods.agent.session.close, request);
        },
        close() {
          deliberatelyClosed = true;
          connection.close();
        },
      };
    } catch (cause) {
      deliberatelyClosed = true;
      connection.close(cause);
      throw cause;
    }
  },
};
