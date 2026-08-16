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
const PROVIDER_STATUSES = new Set([
  'starting', 'running', 'awaiting_approval', 'completed', 'failed', 'cancelled',
]);
const TERMINAL_PROVIDER_STATUSES = new Set(['completed', 'failed', 'cancelled']);
const PROVIDER_ACTIVITY_KINDS = new Set([
  'command', 'file_change', 'inspect', 'search', 'tool',
]);
const PROVIDER_ACTIVITY_STATUSES = new Set(['running', 'completed', 'failed']);
const SAFE_PROVIDER_TASK_TITLES = new Set([
  'Complete the requested task',
  'Build and verify the requested C program',
  'Implement and verify the requested change',
  'Review and test the requested change',
  'Inspect the requested workspace',
]);
const SAFE_PROVIDER_INVOCATION_SUMMARIES = new Set([
  'Working in the selected workspace',
  'Waiting for your decision',
  'The provider completed its run',
  'The provider reported an error',
  'The provider stopped',
  'Completed the provider run after the recorded compilation and test checks',
  'Completed the provider run after the recorded test checks',
  'Completed the provider run after the recorded compilation check',
  'Completed the provider run after the recorded program check',
]);
const SAFE_PROVIDER_ACTIVITY_COPY = new Set([
  'Update workspace files\u0000Preparing workspace file changes',
  'Update workspace files\u0000Workspace files updated',
  'Update workspace files\u0000Workspace file change failed',
  'Inspect the workspace\u0000Inspecting workspace context',
  'Inspect the workspace\u0000Workspace inspection completed',
  'Inspect the workspace\u0000Workspace inspection failed',
  'Search for context\u0000Searching for relevant context',
  'Search for context\u0000Context search completed',
  'Search for context\u0000Context search failed',
  'Use a provider tool\u0000Using a provider tool',
  'Use a provider tool\u0000Provider tool completed',
  'Use a provider tool\u0000Provider tool failed',
  'Compile the requested C11 program\u0000Compiling the requested C11 program',
  'Compile the requested C11 program\u0000Compiled the requested C11 program',
  'Compile the requested C11 program\u0000Could not compile the requested C11 program',
  'Compile the requested C program\u0000Compiling the requested C program',
  'Compile the requested C program\u0000Compiled the requested C program',
  'Compile the requested C program\u0000Could not compile the requested C program',
  'Compile and run the requested tests\u0000Compiling and running the requested tests',
  'Compile and run the requested tests\u0000Completed the requested compilation and tests',
  'Compile and run the requested tests\u0000The requested compilation or tests failed',
  'Run the requested tests\u0000Running the requested tests',
  'Run the requested tests\u0000Completed the requested tests',
  'Run the requested tests\u0000The requested tests failed',
  'Run the requested program\u0000Running the requested program',
  'Run the requested program\u0000Completed the requested program run',
  'Run the requested program\u0000The requested program run failed',
  'Run a workspace command\u0000Running a workspace command',
  'Run a workspace command\u0000Completed a workspace command',
  'Run a workspace command\u0000A workspace command failed',
]);

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

function providerInvocation(
  chatItems: ChatItem[],
  parentId: unknown,
  invocationId?: unknown,
) {
  if (typeof parentId !== 'string') return undefined;
  return chatItems.find(
    (item): item is Extract<ChatItem, { type: 'provider_invocation' }> =>
      item.type === 'provider_invocation'
      && item.parentToolCallId === parentId
      && (typeof invocationId !== 'string' || item.id === invocationId)
  );
}

function providerActivityStatus(status: unknown): 'running' | 'done' | 'error' {
  if (status === 'running') return 'running';
  return status === 'completed' ? 'done' : 'error';
}

function providerText(
  value: unknown,
  allowed: ReadonlySet<string>,
): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  return allowed.has(text) ? text : undefined;
}

function providerPermissionMode(value: unknown) {
  return value === 'manual' || value === 'auto_approve' || value === 'full_access'
    ? value
    : undefined;
}

function safeProviderDisplayName(provider: 'codex' | 'claude_code') {
  return provider === 'codex' ? 'Codex' : 'Claude Code';
}

function providerFiles(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const files = [...new Set(value
    .filter((file): file is string => typeof file === 'string')
    .map(file => {
      const parts = file.replace(/\\/g, '/').replace(/\/+$/, '').split('/');
      return parts[parts.length - 1] || '';
    })
    .filter(Boolean)
    .map(file => file.slice(0, 128)))]
    .slice(0, 8);
  return files.length ? files : undefined;
}

function sortProviderActivities(invocation: Extract<ChatItem, { type: 'provider_invocation' }>) {
  invocation.activities.sort((left, right) =>
    (left.sequence ?? Number.MAX_SAFE_INTEGER) - (right.sequence ?? Number.MAX_SAFE_INTEGER)
  );
}

export function mapEventToChatItem(
  chatItems: ChatItem[],
  event: Record<string, unknown>,
  addItem: (item: Partial<ChatItem> & { type: ChatItemType }) => void,
  _activeSessionId?: string,
): boolean {
  const decoded = decodeIncomingEvent(event);

  switch (decoded.type as string) {
    case 'provider_invocation': {
      if (
        typeof decoded.invocationId !== 'string'
        || typeof decoded.parentToolCallId !== 'string'
        || (decoded.provider !== 'codex' && decoded.provider !== 'claude_code')
      ) break;
      const id = decoded.invocationId;
      const existing = chatItems.find(
        (item): item is Extract<ChatItem, { type: 'provider_invocation' }> =>
          item.type === 'provider_invocation' && item.id === id
      );
      const provider = decoded.provider as 'codex' | 'claude_code';
      const taskTitle = providerText(decoded.taskTitle, SAFE_PROVIDER_TASK_TITLES);
      const currentSummary = providerText(
        decoded.currentSummary,
        SAFE_PROVIDER_INVOCATION_SUMMARIES,
      );
      const resultSummary = providerText(
        decoded.resultSummary,
        SAFE_PROVIDER_INVOCATION_SUMMARIES,
      );
      const errorSummary = providerText(
        decoded.errorSummary,
        SAFE_PROVIDER_INVOCATION_SUMMARIES,
      );
      const update = {
        ...(taskTitle && { taskTitle }),
        ...(currentSummary && { currentSummary }),
        ...(typeof decoded.status === 'string' && PROVIDER_STATUSES.has(decoded.status) && {
          status: decoded.status as Extract<ChatItem, { type: 'provider_invocation' }>['status'],
        }),
        ...(typeof decoded.sessionId === 'string' && { sessionId: decoded.sessionId }),
        ...(typeof decoded.elapsedMs === 'number' && Number.isFinite(decoded.elapsedMs)
          && decoded.elapsedMs >= 0 && { elapsedMs: decoded.elapsedMs }),
        ...(resultSummary && { resultSummary }),
        ...(errorSummary && { errorSummary }),
      };
      if (existing) {
        Object.assign(existing, update);
        // A later terminal event is authoritative over a streamed progress
        // summary. Keeping the old `currentSummary` makes a completed or failed
        // Work Room look as if it were still on its last live step.
        if (update.status && TERMINAL_PROVIDER_STATUSES.has(update.status)) {
          delete existing.currentSummary;
        }
        break;
      }
      const item = {
        id,
        type: 'provider_invocation' as const,
        parentToolCallId: decoded.parentToolCallId,
        provider,
        providerDisplayName: safeProviderDisplayName(provider),
        permissionMode: providerPermissionMode(decoded.permissionMode),
        status: (
          typeof decoded.status === 'string' && PROVIDER_STATUSES.has(decoded.status)
            ? decoded.status : 'running'
        ) as Extract<ChatItem, { type: 'provider_invocation' }>['status'],
        activities: [],
        ...update,
      } as Extract<ChatItem, { type: 'provider_invocation' }>;
      const parentIndex = chatItems.findIndex(
        candidate => candidate.type === 'tool_call' && candidate.id === decoded.parentToolCallId
      );
      if (parentIndex >= 0) chatItems.splice(parentIndex, 1, item);
      else addItem(item);
      break;
    }
    case 'provider_activity': {
      if (
        typeof decoded.invocationId !== 'string'
        || typeof decoded.parentToolCallId !== 'string'
        || (decoded.provider !== 'codex' && decoded.provider !== 'claude_code')
        || typeof decoded.activityId !== 'string'
        || !Number.isInteger(decoded.sequence)
        || (decoded.sequence as number) < 1
        || typeof decoded.kind !== 'string'
        || !PROVIDER_ACTIVITY_KINDS.has(decoded.kind)
        || typeof decoded.status !== 'string'
        || !PROVIDER_ACTIVITY_STATUSES.has(decoded.status)
      ) break;
      const invocation = providerInvocation(
        chatItems,
        decoded.parentToolCallId,
        decoded.invocationId,
      );
      const title = typeof decoded.title === 'string' ? decoded.title.trim() : undefined;
      const summary = typeof decoded.summary === 'string' ? decoded.summary.trim() : undefined;
      if (!invocation || !title || !summary
        || !SAFE_PROVIDER_ACTIVITY_COPY.has(`${title}\u0000${summary}`)) break;
      const activity = {
        id: decoded.activityId,
        sequence: decoded.sequence as number,
        kind: decoded.kind as Extract<ChatItem, { type: 'provider_invocation' }>['activities'][number]['kind'],
        status: providerActivityStatus(decoded.status),
        title,
        summary,
        legacy: false,
        ...(providerFiles(decoded.files) && { files: providerFiles(decoded.files) }),
      };
      const existing = invocation.activities.find(item => item.id === activity.id);
      if (existing) {
        delete existing.name;
        delete existing.args;
        delete existing.result;
        Object.assign(existing, activity);
      } else {
        invocation.activities.push(activity);
      }
      sortProviderActivities(invocation);
      break;
    }
    case 'tool_call': {
      const toolId = (decoded.tool_id || decoded.id) as string;
      const invocation = providerInvocation(
        chatItems,
        decoded.parentToolCallId,
        decoded.invocationId,
      );
      if (invocation) {
        const existingActivity = invocation.activities.find(item => item.id === toolId);
        if (existingActivity && existingActivity.legacy === false) break;
        const activity = {
          id: toolId,
          name: decoded.name as string,
          args: decoded.args as Record<string, unknown>,
          status: toolStartStatus(decoded.status),
          legacy: true,
        };
        if (existingActivity) Object.assign(existingActivity, activity);
        else invocation.activities.push(activity);
        break;
      }
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
      const invocation = providerInvocation(
        chatItems,
        decoded.parentToolCallId,
        decoded.invocationId,
      );
      if (invocation) {
        const activity = invocation.activities.find(item => item.id === toolId);
        if (activity) {
          if (activity.legacy === false) break;
          activity.status = RUNNING_TOOL_STATUSES.has(String(decoded.status))
            ? 'running' : toolResultStatus(decoded.status);
          if (typeof decoded.result === 'string') activity.result = decoded.result;
        }
        break;
      }
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
      const thoughtId = decoded.id != null ? String(decoded.id) : undefined;
      const content = typeof decoded.content === 'string'
        ? decoded.content
        : undefined;
      const kind = typeof decoded.kind === 'string' ? decoded.kind : undefined;
      const item: Partial<ChatItem> & { type: 'thinking' } = {
        type: 'thinking',
        id: thoughtId,
        status: 'done',
      };
      // Do not erase richer product metadata when an update arrives without it.
      // RemoteAgent upserts stable IDs by spreading only present keys.
      if (content != null) item.content = content;
      if (kind != null) item.kind = kind;
      addItem(item);
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
