/**
 * CommonJS-safe boundary between RemoteAgent and the ESM-only official ACP SDK.
 *
 * The package's ESM root registers the production driver.  The legacy CommonJS
 * root does not, so existing require() consumers keep their current transport
 * until they deliberately move to the native-capable import condition.
 */
import type { AddressData } from '../address-browser';
import type {
  ACPBrowserAdmission,
  ACPWebSocketTransport,
} from './native-acp';

export type NativeACPContentBlock =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'image'; readonly data: string; readonly mimeType: string }
  | {
    readonly type: 'resource';
    readonly resource:
      | { readonly uri: string; readonly mimeType: string; readonly text: string }
      | { readonly uri: string; readonly mimeType: string; readonly blob: string };
  };

export interface NativeACPPermissionOption {
  readonly optionId: string;
  readonly name: string;
  readonly kind: string;
}

export interface NativeACPPermissionRequest {
  readonly requestId: string;
  readonly sessionId: string;
  readonly toolCall: {
    readonly toolCallId: string;
    readonly title?: string | null;
    readonly rawInput?: unknown;
    readonly status?: string | null;
  };
  readonly options: readonly NativeACPPermissionOption[];
}

export type NativeACPPermissionResponse = {
  readonly outcome:
    | { readonly outcome: 'selected'; readonly optionId: string }
    | { readonly outcome: 'cancelled' };
  readonly _meta?: Record<string, unknown>;
};

export interface NativeACPSessionMode {
  readonly id: string;
  readonly name: string;
  readonly description?: string | null;
}

export interface NativeACPSessionModes {
  readonly currentModeId: string;
  readonly availableModes: readonly NativeACPSessionMode[];
}

export interface NativeACPAgentCapabilities {
  readonly promptCapabilities?: {
    readonly image?: boolean;
    readonly embeddedContext?: boolean;
  };
  readonly sessionCapabilities?: {
    readonly resume?: object | null;
    readonly close?: object | null;
  };
}

export interface NativeACPConnection {
  readonly protocolVersion: number;
  readonly agentCapabilities: NativeACPAgentCapabilities;
  readonly agentInfo?: { readonly name: string; readonly version: string } | null;
  newSession(request: {
    readonly cwd: '/';
    readonly mcpServers: readonly [];
  }): Promise<{ readonly sessionId: string; readonly modes?: NativeACPSessionModes | null }>;
  resumeSession(request: {
    readonly sessionId: string;
    readonly cwd: '/';
    readonly mcpServers: readonly [];
  }): Promise<{ readonly modes?: NativeACPSessionModes | null }>;
  prompt(request: {
    readonly sessionId: string;
    readonly prompt: readonly NativeACPContentBlock[];
  }): Promise<{ readonly stopReason: string }>;
  setSessionMode(request: {
    readonly sessionId: string;
    readonly modeId: string;
  }): Promise<void>;
  cancel(request: { readonly sessionId: string }): Promise<void>;
  closeSession(request: { readonly sessionId: string }): Promise<void>;
  close(): void;
}

export interface NativeACPDriverHandlers {
  onSessionUpdate(sessionId: string, update: unknown): void;
  requestPermission(
    request: NativeACPPermissionRequest,
  ): Promise<NativeACPPermissionResponse>;
  onClose(error?: Error): void;
}

export interface NativeACPDriverOptions {
  readonly agentAddress: string;
  readonly httpUrl: string;
  readonly transport: ACPWebSocketTransport;
  readonly keys: AddressData;
  readonly admission?: ACPBrowserAdmission;
}

export interface NativeACPDriver {
  open(
    options: NativeACPDriverOptions,
    handlers: NativeACPDriverHandlers,
  ): Promise<NativeACPConnection>;
}

let registeredDriver: NativeACPDriver | null = null;

/** @internal Package ESM bootstrap and deterministic tests only. */
export function registerNativeACPDriver(driver: NativeACPDriver | null): void {
  registeredDriver = driver;
}

/** @internal */
export function getNativeACPDriver(): NativeACPDriver | null {
  return registeredDriver;
}
