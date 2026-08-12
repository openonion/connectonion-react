// Connect types
export type {
  Response,
  ChatItem,
  ChatItemType,
  FileAttachment,
  AgentStatus,
  ConnectionState,
  AgentInfo,
  AgentAcceptedInputs,
  AgentOnboard,
  SkillInfo,
  ApprovalMode,
  ServerApprovalMode,
  PlanEntry,
  PlanEntryPriority,
  PlanEntryStatus,
  OutgoingMessage,
  ACPNotificationFrame,
  ACPPermissionRequest,
  ACPPlanUpdate,
  HostSessionModeState,
  ApprovalRejectMode,
} from './connect';

export { fetchAgentInfo } from './connect';

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

// Browser identity (Ed25519 keys for authentication)
export {
  generateBrowser,
  saveBrowser,
  loadBrowser,
  signBrowser,
  createSignedPayloadBrowser,
  type AddressData,
} from './address-browser';
