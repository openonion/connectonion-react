/** ACP v1.19 compatibility decoding for the ConnectOnion WebSocket carrier. */

import type { SessionNotification, SessionUpdate } from '@agentclientprotocol/sdk';

const ACP_SCHEMA_VERSION = 'schema-v1.19.0';
const TOOL_STATUSES = new Set(['pending', 'in_progress', 'completed', 'failed']);

export interface ACPNotificationFrame {
  type: 'ACP_NOTIFICATION';
  acpSchema: 'schema-v1.19.0';
  message: {
    jsonrpc: '2.0';
    method: 'session/update';
    params: SessionNotification;
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

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}
