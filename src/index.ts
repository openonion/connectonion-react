// Connect types
export type {
  Response,
  ChatItem,
  ChatItemType,
  ProviderInvocationItem,
  ProviderInvocationStatus,
  ProviderInterruptAcknowledgement,
  ProviderPermissionAcknowledgement,
  ProviderPermissionOption,
  ProviderPermissionState,
  ProviderActivity,
  ProviderArtifact,
  ProviderApprovalContext,
  FileAttachment,
  AgentStatus,
  ConnectionState,
  AgentInfo,
  AgentAcceptedInputs,
  AgentOnboard,
  SkillInfo,
  Mode,
  PlanEntry,
  PlanEntryPriority,
  PlanEntryStatus,
  SessionActivity,
  SessionOutcome,
  SessionSummary,
  SessionRecord,
  SessionSyncOptions,
  SessionSyncResult,
  SessionGetOptions,
  SessionSnapshot,
  SessionNotModified,
  SessionGetResult,
  SessionMetadataPatch,
  SessionChangeSet,
  OutgoingMessage,
  HostSessionModeState,
  ApprovalRejectMode,
} from './connect';

export {
  connect,
  RemoteAgent,
  SessionSyncError,
  fetchAgentInfo,
  OIP_PROTOCOL,
  OIP_REQUESTED_EXTENSIONS,
  SESSION_SYNC_EXTENSION,
  SESSION_SYNC_VERSION,
  OipCompatibilityError,
  supportsOip,
  supportsSessionSync,
} from './connect';

// Store types
export { type Message } from './store';

// useAgentForHuman hook
export { useAgentForHuman, isChatItemType, isEventType } from './use-agent-for-human';
export type { UseAgentForHumanReturn } from './use-agent-for-human';

/** @deprecated Use ChatItem instead */
export type { ChatItem as UIEvent } from './connect';

// Voice input
export {
  useVoiceInput,
  type UseVoiceInputOptions,
  type UseVoiceInputReturn,
  type VoiceInputStatus,
} from './useVoiceInput';

// Persistent browser identity (non-extractable Ed25519 key in IndexedDB)
export {
  initializeBrowserIdentity,
  loadBrowserIdentity,
  createBrowserIdentity,
  importBrowserIdentity,
  claimPendingBrowserRecovery,
  BrowserIdentityUnavailableError,
  BrowserIdentityCorruptError,
  type BrowserIdentity,
  type BrowserIdentityInitialization,
  type BrowserRecoverySecret,
  type MessageSigner,
} from './browser-identity';

// Explicit in-memory raw-key helpers. These functions never persist keys.
export {
  generateBrowser,
  signBrowser,
  createSignedPayloadBrowser,
  type AddressData,
} from './address-browser';
