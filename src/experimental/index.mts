/** ESM/browser package root for the OIP client. */

// Keep runtime exports explicit. Node can synthesize named exports through the
// CommonJS barrel below, but browser bundlers such as Vite/Rolldown cannot
// statically discover them through `export *` alone.
export {
  connect,
  RemoteAgent,
  SessionSyncError,
  OIP_PROTOCOL,
  OIP_REQUESTED_EXTENSIONS,
  SESSION_SYNC_EXTENSION,
  SESSION_SYNC_VERSION,
  supportsOip,
  supportsSessionSync,
  fetchAgentInfo,
  useAgentForHuman,
  isChatItemType,
  isEventType,
  useVoiceInput,
  initializeBrowserIdentity,
  loadBrowserIdentity,
  createBrowserIdentity,
  importBrowserIdentity,
  claimPendingBrowserRecovery,
  BrowserIdentityUnavailableError,
  BrowserIdentityCorruptError,
  generateBrowser,
  signBrowser,
  createSignedPayloadBrowser,
} from '../index.js';

// Preserve the complete public type surface without duplicating it here.
export * from '../index.js';
