import { mapEventToChatItem } from '../src/connect/chat-item-mapper';
import type { ChatItem } from '../src/connect/types';

function apply(items: ChatItem[], event: Record<string, unknown>) {
  mapEventToChatItem(items, event, item => items.push(item as ChatItem));
}

test('replaces the parent tool with one provider card and nests child activity', () => {
  const items: ChatItem[] = [{
    id: 'call-7', type: 'tool_call', name: 'codex', status: 'running', args: { prompt: 'fix it' },
  }];
  apply(items, {
    type: 'provider_invocation', invocationId: 'codex:call-7', parentToolCallId: 'call-7',
    provider: 'codex', providerDisplayName: 'Codex', taskSummary: 'fix it', status: 'running',
  });
  apply(items, {
    type: 'tool_call', tool_id: 'child-1', name: 'Bash', args: { command: 'pytest' },
    status: 'in_progress', parentToolCallId: 'call-7', invocationId: 'codex:call-7',
  });
  apply(items, {
    type: 'tool_result', tool_id: 'child-1', status: 'completed', result: 'ok',
    parentToolCallId: 'call-7', invocationId: 'codex:call-7',
  });
  apply(items, {
    type: 'provider_invocation', invocationId: 'codex:call-7', parentToolCallId: 'call-7',
    provider: 'codex', providerDisplayName: 'Codex', status: 'completed', elapsedMs: 38,
  });

  expect(items).toHaveLength(1);
  expect(items[0]).toMatchObject({
    type: 'provider_invocation', id: 'codex:call-7', status: 'completed', elapsedMs: 38,
    activities: [{ id: 'child-1', name: 'Bash', status: 'done', result: 'ok' }],
  });
});

test('unknown providers keep the generic tool fallback', () => {
  const items: ChatItem[] = [];
  apply(items, { type: 'tool_call', tool_id: 'x', name: 'future_agent', status: 'in_progress' });
  expect(items).toEqual([{ id: 'x', type: 'tool_call', name: 'future_agent', args: undefined, status: 'running' }]);
});

test('replayed duplicate child events update instead of duplicating', () => {
  const items: ChatItem[] = [];
  const start = {
    type: 'provider_invocation', invocationId: 'claude_code:p', parentToolCallId: 'p',
    provider: 'claude_code', providerDisplayName: 'Claude Code', status: 'running',
  };
  apply(items, start);
  apply(items, start);
  const child = {
    type: 'tool_call', tool_id: 'c', name: 'Read', status: 'in_progress',
    parentToolCallId: 'p', invocationId: 'claude_code:p',
  };
  apply(items, child);
  apply(items, child);
  expect(items).toHaveLength(1);
  expect(items[0].type === 'provider_invocation' && items[0].activities).toHaveLength(1);
});
