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
  OutgoingMessage,
  HostSessionModeState,
  ApprovalRejectMode,
} from './connect';

export {
  fetchAgentInfo,
  OIP_PROTOCOL,
  OipCompatibilityError,
  supportsOip,
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
