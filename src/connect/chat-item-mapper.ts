/**
 * @llm-note
 *   Dependencies: imports from [src/connect/types] | imported by [src/connect/handlers.ts]
 *   Data flow: pure function — maps server event → ChatItem mutations on the chatItems array | agent_image payloads already present in the transcript are skipped (reconnect re-delivery must not duplicate images)
 *   State/Effects: mutates chatItems array in-place (push via addItem, update existing entries)
 *   Integration: called by handlers.ts for stream event types (tool_call, llm_call, etc.)
 */
import { ChatItem, ChatItemType } from './types';
import { decodeIncomingEvent } from './wire-events';

const SUCCESSFUL_TOOL_RESULTS = new Set(['success', 'done', 'completed']);
const RUNNING_TOOL_STATUSES = new Set(['pending', 'running', 'in_progress']);

function toolResultStatus(status: unknown): 'done' | 'error' {
  return typeof status === 'string' && SUCCESSFUL_TOOL_RESULTS.has(status)
    ? 'done'
    : 'error';
}

function toolStartStatus(status: unknown): 'running' | 'error' {
  if (status === undefined || RUNNING_TOOL_STATUSES.has(String(status))) {
    return 'running';
  }
  return 'error';
}

export function mapEventToChatItem(
  chatItems: ChatItem[],
  event: Record<string, unknown>,
  addItem: (item: Partial<ChatItem> & { type: ChatItemType }) => void,
  activeSessionId?: string,
): boolean {
  const decoded = decodeIncomingEvent(event);
  if (!decoded) return false;
  if (
    event.type === 'ACP_NOTIFICATION'
    && decoded._acp_session_id !== activeSessionId
  ) return false;

  switch (decoded.type as string) {
    case 'tool_call': {
      const toolId = (decoded.tool_id || decoded.id) as string;
      const existing = chatItems.find(
        (item): item is ChatItem & { type: 'tool_call' } =>
          item.type === 'tool_call' && item.id === toolId
      );
      if (existing) {
        existing.name = decoded.name as string;
        existing.args = decoded.args as Record<string, unknown>;
        existing.status = toolStartStatus(decoded.status);
        break;
      }
      addItem({
        type: 'tool_call',
        id: toolId,
        name: decoded.name as string,
        args: decoded.args as Record<string, unknown>,
        status: toolStartStatus(decoded.status),
      });
      break;
    }

    case 'tool_call_update': {
      const toolId = (decoded.tool_id || decoded.id) as string;
      const existing = chatItems.find(
        (e): e is ChatItem & { type: 'tool_call' } => e.type === 'tool_call' && e.id === toolId
      );
      if (existing) {
        if (decoded.status !== undefined) {
          existing.status = RUNNING_TOOL_STATUSES.has(String(decoded.status))
            ? 'running'
            : toolResultStatus(decoded.status);
        }
        if (typeof decoded.name === 'string') existing.name = decoded.name;
        if (decoded.args && typeof decoded.args === 'object') {
          existing.args = decoded.args as Record<string, unknown>;
        }
        if (typeof decoded.result === 'string') existing.result = decoded.result;
        if (typeof decoded.timing_ms === 'number') {
          existing.timing_ms = decoded.timing_ms;
        }
      }
      break;
    }

    case 'llm_call': {
      addItem({
        type: 'thinking',
        id: event.id as string,
        status: 'running',
        model: event.model as string | undefined,
      });
      break;
    }

    case 'llm_result': {
      const llmId = event.id as string;
      const existingThinking = chatItems.find(
        (e): e is ChatItem & { type: 'thinking' } => e.type === 'thinking' && e.id === llmId
      );
      if (existingThinking) {
        existingThinking.status = event.status === 'error' ? 'error' : 'done';
        if (typeof event.duration_ms === 'number') existingThinking.duration_ms = event.duration_ms;
        if (event.model) existingThinking.model = event.model as string;
        if (event.usage) {
          existingThinking.usage = event.usage as {
            input_tokens?: number; output_tokens?: number;
            prompt_tokens?: number; completion_tokens?: number;
            total_tokens?: number; cost?: number;
          };
        }
        if (typeof event.context_percent === 'number') existingThinking.context_percent = event.context_percent;
      }
      break;
    }

    case 'thinking': {
      addItem({
        type: 'thinking',
        id: event.id != null ? String(event.id) : undefined,
        status: 'done',
        content: event.content as string | undefined,
        kind: event.kind as string | undefined,
      });
      break;
    }

    case 'assistant': {
      if (decoded.content) {
        addItem({
          type: 'agent',
          id: decoded.id != null ? String(decoded.id) : undefined,
          content: decoded.content as string,
        });
      }
      break;
    }

    case 'agent_image': {
      const imageData = event.image as string;
      if (!imageData) break;
      // One bubble per unique image, kept at its latest mention: a re-take of
      // an unchanged page must show up at the turn that asked for it, not be
      // swallowed because the bytes match an old bubble. Same keep-last
      // semantics as oo-chat's dedupeUI on the replay path.
      const prevIndex = chatItems.findIndex(
        (it) => it.type === 'agent' && it.images?.includes(imageData)
      );
      if (prevIndex !== -1) {
        const prev = chatItems[prevIndex] as ChatItem & { type: 'agent' };
        prev.images = prev.images!.filter((img) => img !== imageData);
        if (!prev.content && prev.images.length === 0) {
          chatItems.splice(prevIndex, 1);
        }
      }
      const lastItem = chatItems[chatItems.length - 1];
      if (lastItem?.type === 'agent') {
        const lastAgent = lastItem as ChatItem & { type: 'agent' };
        if (!lastAgent.images) lastAgent.images = [];
        lastAgent.images.push(imageData);
      } else {
        addItem({
          type: 'agent',
          id: event.id != null ? String(event.id) : undefined,
          content: '',
          images: [imageData],
        });
      }
      break;
    }

    case 'intent': {
      const intentId = event.id as string;
      const status = event.status as 'analyzing' | 'understood';
      if (status === 'analyzing') {
        addItem({ type: 'intent', id: intentId, status: 'analyzing' });
      } else if (status === 'understood') {
        const existing = chatItems.find(
          (e): e is ChatItem & { type: 'intent' } => e.type === 'intent' && e.id === intentId
        );
        if (existing) {
          existing.status = 'understood';
          existing.ack = event.ack as string | undefined;
          existing.is_build = event.is_build as boolean | undefined;
        }
      }
      break;
    }

    case 'eval': {
      const evalId = event.id as string;
      const evalStatus = event.status as 'evaluating' | 'done';
      if (evalStatus === 'evaluating') {
        addItem({
          type: 'eval',
          id: evalId,
          status: 'evaluating',
          expected: event.expected as string | undefined,
          eval_path: event.eval_path as string | undefined,
        });
      } else if (evalStatus === 'done') {
        const existing = chatItems.find(
          (e): e is ChatItem & { type: 'eval' } => e.type === 'eval' && e.id === evalId
        );
        if (existing) {
          existing.status = 'done';
          existing.passed = event.passed as boolean | undefined;
          existing.summary = event.summary as string | undefined;
          existing.expected = event.expected as string | undefined;
          existing.eval_path = event.eval_path as string | undefined;
        }
      }
      break;
    }

    case 'compact': {
      const compactId = event.id as string;
      const compactStatus = event.status as 'compacting' | 'done' | 'error';
      if (compactStatus === 'compacting') {
        addItem({
          type: 'compact',
          id: compactId,
          status: 'compacting',
          context_percent: event.context_percent as number | undefined,
        });
      } else {
        const existing = chatItems.find(
          (e): e is ChatItem & { type: 'compact' } => e.type === 'compact' && e.id === compactId
        );
        if (existing) {
          existing.status = compactStatus;
          existing.context_before = event.context_before as number | undefined;
          existing.context_after = event.context_after as number | undefined;
          existing.message = event.message as string | undefined;
          existing.error = event.error as string | undefined;
        }
      }
      break;
    }

    case 'tool_blocked': {
      addItem({
        type: 'tool_blocked',
        tool: event.tool as string,
        reason: event.reason as string,
        message: event.message as string,
        command: event.command as string | undefined,
      });
      break;
    }

    case 'files_received': {
      addItem({
        type: 'files_received',
        files: (event.files || []) as Array<{ name: string; path: string }>,
      });
      break;
    }
  }
  return true;
}
