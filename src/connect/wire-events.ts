/** ACP v1.19 compatibility decoding for the ConnectOnion WebSocket carrier. */

import type {
  CancelNotification,
  PermissionOption,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionMode,
  SessionNotification,
  SessionUpdate,
  SetSessionModeRequest,
  SetSessionModeResponse,
  ToolCallStatus,
} from '@agentclientprotocol/sdk';
import type { ApprovalMode } from './types';

const ACP_SCHEMA_VERSION = 'schema-v1.19.0';
const TOOL_STATUSES = new Set(['pending', 'in_progress', 'completed', 'failed']);
const SERVER_APPROVAL_MODES = new Set<ServerApprovalMode>([
  'safe',
  'accept_edits',
  'ulw',
]);
const HOST_PERMISSION_KINDS = new Map<string, PermissionOption['kind']>([
  ['allow_once', 'allow_once'],
  ['allow_session', 'allow_always'],
  ['reject_soft', 'reject_once'],
  ['reject_hard', 'reject_once'],
  ['reject_explain', 'reject_once'],
]);

export interface ACPNotificationFrame {
  type: 'ACP_NOTIFICATION';
  acpSchema: 'schema-v1.19.0';
  message: {
    jsonrpc: '2.0';
    method: 'session/update';
    params: SessionNotification;
  };
}

export interface ACPPermissionRequest {
  requestId: string;
  sessionId: string;
  toolCallId: string;
  title: string;
  rawInput: Record<string, unknown>;
  options: PermissionOption[];
}

export type ServerApprovalMode = Exclude<ApprovalMode, 'plan'>;

export interface ACPModeUpdate {
  sessionId: string;
  mode: ServerApprovalMode;
}

export interface HostSessionModeState {
  currentModeId: ServerApprovalMode;
  availableModes: SessionMode[];
}

export type ACPSetModeResponse =
  | {
    requestId: string;
    sessionId: string;
    result: SetSessionModeResponse;
  }
  | {
    requestId: string;
    sessionId: string;
    error: {
      code: number;
      message: string;
      data?: unknown;
    };
  };

export type ApprovalRejectMode =
  | 'reject_soft'
  | 'reject_hard'
  | 'reject_explain';

export function hostSupportsACPCancel(
  connected: Record<string, unknown>,
): boolean {
  const capabilities = record(connected.carrier_capabilities);
  const acp = record(capabilities?.acp);
  return acp?.schema === ACP_SCHEMA_VERSION
    && Array.isArray(acp.client_notifications)
    && acp.client_notifications.includes('session/cancel');
}

/** Parse the exact mode state attached to an advertised Host transaction. */
export function hostSessionModeState(
  connected: Record<string, unknown>,
): HostSessionModeState | null {
  const capabilities = record(connected.carrier_capabilities);
  const acp = record(capabilities?.acp);
  if (
    acp?.schema !== ACP_SCHEMA_VERSION
    || !Array.isArray(acp.client_requests)
    || !acp.client_requests.includes('session/set_mode')
  ) return null;

  const state = record(connected.session_modes);
  const currentModeId = parseServerApprovalMode(state?.currentModeId);
  if (!currentModeId || !Array.isArray(state?.availableModes)) return null;

  const availableModes: SessionMode[] = [];
  const seen = new Set<ServerApprovalMode>();
  for (const candidate of state.availableModes) {
    const mode = record(candidate);
    const id = parseServerApprovalMode(mode?.id);
    if (!id || seen.has(id) || !nonEmpty(mode?.name)) return null;
    if (
      mode?.description != null
      && typeof mode.description !== 'string'
    ) return null;
    seen.add(id);
    availableModes.push({
      id,
      name: mode.name,
      ...(typeof mode.description === 'string'
        ? { description: mode.description }
        : {}),
    });
  }
  if (!seen.has(currentModeId)) return null;
  return { currentModeId, availableModes };
}

export function acpCancelFrame(sessionId: string): Record<string, unknown> {
  const params: CancelNotification = { sessionId };
  return {
    type: 'ACP_NOTIFICATION',
    acpSchema: ACP_SCHEMA_VERSION,
    message: {
      jsonrpc: '2.0',
      method: 'session/cancel',
      params,
    },
  };
}

export function acpSetSessionModeFrame(
  requestId: string,
  sessionId: string,
  modeId: ServerApprovalMode,
): Record<string, unknown> {
  const params: SetSessionModeRequest = { sessionId, modeId };
  return {
    type: 'ACP_REQUEST',
    acpSchema: ACP_SCHEMA_VERSION,
    message: {
      jsonrpc: '2.0',
      id: requestId,
      method: 'session/set_mode',
      params,
    },
  };
}

/** Return a response only when the complete owned JSON-RPC shape is valid. */
export function decodeACPSetModeResponse(
  frame: unknown,
): ACPSetModeResponse | null {
  const carrier = record(frame);
  if (
    carrier?.type !== 'ACP_RESPONSE'
    || carrier.acpSchema !== ACP_SCHEMA_VERSION
    || !nonEmpty(carrier.sessionId)
  ) return null;
  const message = record(carrier.message);
  if (message?.jsonrpc !== '2.0' || !nonEmpty(message.id)) return null;

  const hasResult = Object.prototype.hasOwnProperty.call(message, 'result');
  const hasError = Object.prototype.hasOwnProperty.call(message, 'error');
  if (hasResult === hasError) return null;
  const allowedMessageKeys = new Set([
    'jsonrpc', 'id', hasResult ? 'result' : 'error',
  ]);
  if (Object.keys(message).some((key) => !allowedMessageKeys.has(key))) {
    return null;
  }
  if (hasResult) {
    const result = record(message.result);
    if (!result || Object.keys(result).some((key) => key !== '_meta')) {
      return null;
    }
    if (result._meta != null && !record(result._meta)) return null;
    return {
      requestId: message.id,
      sessionId: carrier.sessionId,
      result: result as SetSessionModeResponse,
    };
  }

  const error = record(message.error);
  if (
    !error
    || !Number.isInteger(error.code)
    || !nonEmpty(error.message)
  ) return null;
  return {
    requestId: message.id,
    sessionId: carrier.sessionId,
    error: {
      code: error.code as number,
      message: error.message,
      ...(Object.prototype.hasOwnProperty.call(error, 'data')
        ? { data: error.data }
        : {}),
    },
  };
}

/** Extract only correlation identity so malformed owned responses fail fast. */
export function acpResponseRequestId(frame: unknown): string | null {
  const carrier = record(frame);
  if (carrier?.type !== 'ACP_RESPONSE') return null;
  const message = record(carrier.message);
  return nonEmpty(message?.id) ? message.id : null;
}

export function decodeACPPermissionRequest(
  frame: Record<string, unknown>,
): ACPPermissionRequest | null {
  if (
    frame.type !== 'ACP_REQUEST'
    || frame.acpSchema !== ACP_SCHEMA_VERSION
  ) return null;
  const message = record(frame.message);
  if (
    message?.jsonrpc !== '2.0'
    || message.method !== 'session/request_permission'
    || !nonEmpty(message.id)
  ) return null;
  const params = record(message.params);
  const toolCall = record(params?.toolCall);
  if (
    !nonEmpty(params?.sessionId)
    || !toolCall
    || !nonEmpty(toolCall.toolCallId)
    || !nonEmpty(toolCall.title)
  ) return null;
  const rawInput = record(toolCall.rawInput);
  const options = permissionOptions(params.options);
  const status = toolStatus(toolCall.status);
  if (!rawInput || !options?.length || status !== 'pending') return null;

  const request: RequestPermissionRequest = {
    sessionId: params.sessionId,
    toolCall: {
      toolCallId: toolCall.toolCallId,
      title: toolCall.title,
      status,
      rawInput,
    },
    options,
  };
  return {
    requestId: message.id,
    sessionId: request.sessionId,
    toolCallId: request.toolCall.toolCallId,
    title: request.toolCall.title!,
    rawInput,
    options,
  };
}

export function acpPermissionResponseFrame(
  request: ACPPermissionRequest,
  approved: boolean,
  scope: 'once' | 'session',
  mode: ApprovalRejectMode = 'reject_hard',
  feedback?: string,
): Record<string, unknown> {
  const optionId = approved
    ? scope === 'session' ? 'allow_session' : 'allow_once'
    : mode;
  const advertised = request.options.some(
    (option) => option.optionId === optionId,
  );
  const result: RequestPermissionResponse = advertised
    ? { outcome: { outcome: 'selected', optionId } }
    : { outcome: { outcome: 'cancelled' } };
  if (!approved && advertised && feedback) {
    result._meta = { connectonion: { feedback } };
  }
  return {
    type: 'ACP_RESPONSE',
    acpSchema: ACP_SCHEMA_VERSION,
    sessionId: request.sessionId,
    message: {
      jsonrpc: '2.0',
      id: request.requestId,
      result,
    },
  };
}

export function acpPermissionCancelledFrame(
  request: ACPPermissionRequest,
): Record<string, unknown> {
  const result: RequestPermissionResponse = {
    outcome: { outcome: 'cancelled' },
  };
  return {
    type: 'ACP_RESPONSE',
    acpSchema: ACP_SCHEMA_VERSION,
    sessionId: request.sessionId,
    message: {
      jsonrpc: '2.0',
      id: request.requestId,
      result,
    },
  };
}

export function parseServerApprovalMode(
  value: unknown,
): ServerApprovalMode | null {
  return typeof value === 'string'
    && SERVER_APPROVAL_MODES.has(value as ServerApprovalMode)
    ? value as ServerApprovalMode
    : null;
}

/** Decode an authoritative server mode observation, never a policy grant. */
export function decodeACPModeUpdate(
  frame: unknown,
): ACPModeUpdate | null {
  const carrier = record(frame);
  if (
    carrier?.type !== 'ACP_NOTIFICATION'
    || carrier.acpSchema !== ACP_SCHEMA_VERSION
  ) return null;
  const message = record(carrier.message);
  if (
    message?.jsonrpc !== '2.0'
    || message.method !== 'session/update'
  ) return null;
  const params = record(message.params);
  const update = record(params?.update);
  if (
    !nonEmpty(params?.sessionId)
    || update?.sessionUpdate !== 'current_mode_update'
  ) return null;
  const mode = parseServerApprovalMode(update.currentModeId);
  if (!mode) return null;

  return {
    sessionId: params.sessionId,
    mode,
  };
}

export function decodeIncomingEvent(
  event: Record<string, unknown>,
): Record<string, unknown> | null {
  if (event.type === 'ACP_NOTIFICATION') return decodeACPFrame(event);
  if (event.type === 'tool_result') {
    return {
      ...event,
      type: 'tool_call_update',
      status: event.status ?? 'unknown_terminal',
    };
  }
  return event;
}

function decodeACPFrame(
  frame: Record<string, unknown>,
): Record<string, unknown> | null {
  if (frame.acpSchema !== ACP_SCHEMA_VERSION) return null;
  const message = record(frame.message);
  if (message?.jsonrpc !== '2.0' || message.method !== 'session/update') return null;
  const params = record(message.params);
  const update = record(params?.update);
  if (!nonEmpty(params?.sessionId) || !update) return null;
  const decoded = decodeACPUpdate(update as SessionUpdate);
  return decoded ? { ...decoded, _acp_session_id: params.sessionId } : null;
}

function decodeACPUpdate(update: SessionUpdate): Record<string, unknown> | null {
  if (update.sessionUpdate === 'agent_message_chunk') {
    if (!nonEmpty(update.messageId)) return null;
    const content = record(update.content);
    if (content?.type !== 'text' || !nonEmpty(content.text)) return null;
    return {
      type: 'assistant',
      id: update.messageId,
      content: content.text,
    };
  }
  if (update.sessionUpdate === 'agent_thought_chunk') {
    // ACP allows messageId to be omitted, but the ConnectOnion Host profile
    // dual-writes this update beside a persisted legacy event. Stable identity
    // is therefore required to make live, compatibility, and replay paths
    // converge on one ChatItem.
    if (!nonEmpty(update.messageId)) return null;
    const content = record(update.content);
    if (content?.type !== 'text' || !nonEmpty(content.text)) return null;
    const kind = thoughtKind(update._meta);
    return {
      type: 'thinking',
      id: update.messageId,
      content: content.text,
      ...(kind ? { kind } : {}),
    };
  }
  if (update.sessionUpdate === 'tool_call') {
    if (!nonEmpty(update.toolCallId) || !nonEmpty(update.title)) return null;
    if (update.status != null && !TOOL_STATUSES.has(String(update.status))) return null;
    return {
      type: 'tool_call',
      tool_id: update.toolCallId,
      name: update.title,
      args: record(update.rawInput),
      status: update.status,
    };
  }
  if (update.sessionUpdate !== 'tool_call_update' || !nonEmpty(update.toolCallId)) {
    return null;
  }
  return {
    type: 'tool_call_update',
    tool_id: update.toolCallId,
    name: update.title,
    args: record(update.rawInput),
    status: update.status,
    result: toolResultText(update),
    timing_ms: timingMs(update._meta),
  };
}

function toolResultText(update: Extract<SessionUpdate, { sessionUpdate: 'tool_call_update' }>): string | undefined {
  const texts = update.content?.flatMap((item) => {
    if (item.type !== 'content' || item.content.type !== 'text') return [];
    return [item.content.text];
  });
  if (texts?.length) return texts.join('\n');
  return typeof update.rawOutput === 'string' ? update.rawOutput : undefined;
}

function timingMs(value: unknown): number | undefined {
  const timing = record(record(value)?.connectonion)?.timingMs;
  return typeof timing === 'number' ? timing : undefined;
}

function thoughtKind(value: unknown): string | undefined {
  const kind = record(record(value)?.connectonion)?.kind;
  return nonEmpty(kind) ? kind : undefined;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function permissionOptions(value: unknown): PermissionOption[] | null {
  if (!Array.isArray(value)) return null;
  const options: PermissionOption[] = [];
  const seen = new Set<string>();
  for (const candidate of value) {
    const option = record(candidate);
    if (!option) return null;

    const optionId = option.optionId;
    if (!nonEmpty(optionId) || !nonEmpty(option.name)) return null;

    const expectedKind = HOST_PERMISSION_KINDS.get(optionId);
    if (!expectedKind || option.kind !== expectedKind || seen.has(optionId)) return null;
    seen.add(optionId);
    options.push({
      optionId,
      name: option.name,
      kind: expectedKind,
    });
  }
  return options;
}

function toolStatus(value: unknown): ToolCallStatus | null {
  return typeof value === 'string' && TOOL_STATUSES.has(value)
    ? value as ToolCallStatus
    : null;
}
