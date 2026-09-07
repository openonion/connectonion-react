/** The rolling OIP window shared with ConnectOnion Host 1.7.0a5. */
export const OIP_PROTOCOL = Object.freeze({
  name: 'oip',
  version: '0.1',
  min_version: '0.1',
  max_version: '0.1',
});

export const SESSION_SYNC_EXTENSION = 'session-sync';
export const SESSION_SYNC_VERSION = '0.1';
export const OIP_REQUESTED_EXTENSIONS = Object.freeze({
  [SESSION_SYNC_EXTENSION]: Object.freeze([SESSION_SYNC_VERSION]),
});

export class OipCompatibilityError extends Error {
  readonly code = 'OIP_UNSUPPORTED_VERSION';
  readonly retryable = false;

  constructor(readonly received: unknown) {
    const value = received as { name?: unknown; version?: unknown } | undefined;
    super(
      `Unsupported agent protocol: ${String(value?.name)}/${String(value?.version)}; expected oip/0.1`,
    );
    this.name = 'OipCompatibilityError';
  }
}

/** Missing is the legacy 0.1 Host during the bounded reader-first window. */
export function supportsOip(value: unknown): boolean {
  if (value == null) return true;
  if (typeof value !== 'object') return false;
  const descriptor = value as { name?: unknown; version?: unknown };
  return descriptor.name === OIP_PROTOCOL.name
    && descriptor.version === OIP_PROTOCOL.version;
}

/** CONNECTED explicitly selects extensions; absence means a legacy Host. */
export function supportsSessionSync(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const extensions = (value as { extensions?: unknown }).extensions;
  if (typeof extensions !== 'object' || extensions === null) return false;
  return (extensions as Record<string, unknown>)[SESSION_SYNC_EXTENSION]
    === SESSION_SYNC_VERSION;
}
