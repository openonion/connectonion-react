/** Native-capable package root for modern ESM/browser consumers. */
import { registerNativeACPDriver } from '../connect/native-acp-runtime.js';
import { officialNativeACPDriver } from './native-acp.mjs';

registerNativeACPDriver(officialNativeACPDriver);

// Keep runtime exports explicit. Node can synthesize named exports through the
// CommonJS barrel below, but browser bundlers such as Vite/Rolldown cannot
// statically discover them through `export *` alone.
export {
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
