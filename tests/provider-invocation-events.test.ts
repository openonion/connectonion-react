import {
  mapEventToChatItem,
  normalizeProviderInvocationSnapshot,
} from '../src/connect/chat-item-mapper';
import type { ChatItem } from '../src/connect/types';

const screenshot = (
  'data:image/png;base64,'
  + 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9WlRjyoAAAAASUVORK5CYII='
);

function apply(items: ChatItem[], event: Record<string, unknown>) {
  mapEventToChatItem(items, event, item => items.push(item as ChatItem));
}

test('replaces the parent tool with one provider card and nests child activity', () => {
  const items: ChatItem[] = [{
    id: 'call-7', type: 'tool_call', name: 'codex', status: 'running', args: { prompt: 'fix it' },
  }];
  apply(items, {
    type: 'provider_invocation', invocationId: 'codex:call-7', parentToolCallId: 'call-7',
    provider: 'codex', providerDisplayName: 'Codex', taskSummary: 'fix it',
    currentSummary: 'Working in the selected workspace', status: 'running',
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
    resultSummary: 'The provider completed its run',
  });

  expect(items).toHaveLength(1);
  expect(items[0]).toMatchObject({
    type: 'provider_invocation', id: 'codex:call-7', status: 'completed', elapsedMs: 38,
    resultSummary: 'The provider completed its run',
    activities: [{ id: 'child-1', name: 'Bash', status: 'done', result: 'ok' }],
  });
  expect((items[0] as Extract<ChatItem, { type: 'provider_invocation' }>).currentSummary).toBeUndefined();
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

test('an approval update replaces a stale live summary with the explicit waiting state', () => {
  const items: ChatItem[] = [{
    id: 'call-7', type: 'tool_call', name: 'codex', status: 'running', args: {},
  }];
  apply(items, {
    type: 'provider_invocation', invocationId: 'codex:call-7', parentToolCallId: 'call-7',
    provider: 'codex', providerDisplayName: 'Codex',
    currentSummary: 'Working in the selected workspace', status: 'running',
  });
  apply(items, {
    type: 'provider_invocation', invocationId: 'codex:call-7', parentToolCallId: 'call-7',
    provider: 'codex', providerDisplayName: 'Codex',
    currentSummary: 'Waiting for your decision', status: 'awaiting_approval',
  });

  expect(items[0]).toMatchObject({
    type: 'provider_invocation',
    status: 'awaiting_approval',
    currentSummary: 'Waiting for your decision',
  });
});

test('a replay cannot regress a newer provider lifecycle revision', () => {
  const items: ChatItem[] = [];
  apply(items, {
    type: 'provider_invocation', invocationId: 'codex:revision', parentToolCallId: 'revision',
    provider: 'codex', providerDisplayName: 'Codex',
    currentSummary: 'Working in the selected workspace', status: 'running', stateRevision: 4,
  });
  apply(items, {
    type: 'provider_invocation', invocationId: 'codex:revision', parentToolCallId: 'revision',
    provider: 'codex', providerDisplayName: 'Codex',
    status: 'cancelled', resultSummary: 'The provider stopped', stateRevision: 5,
  });
  // Reconnect replay can arrive after the new terminal state. The mapper must
  // not infer freshness from arrival time or let this old running frame revive
  // a Work Room's controls.
  apply(items, {
    type: 'provider_invocation', invocationId: 'codex:revision', parentToolCallId: 'revision',
    provider: 'codex', providerDisplayName: 'Codex',
    currentSummary: 'Working in the selected workspace', status: 'running', stateRevision: 4,
  });

  expect(items[0]).toMatchObject({
    type: 'provider_invocation',
    status: 'cancelled',
    stateRevision: 5,
    resultSummary: 'The provider stopped',
  });
  expect((items[0] as Extract<ChatItem, { type: 'provider_invocation' }>).currentSummary).toBeUndefined();
});

test('accepts only a safe preview bound to the current provider state revision', () => {
  const items: ChatItem[] = [];
  apply(items, {
    type: 'provider_invocation', invocationId: 'codex:preview', parentToolCallId: 'preview',
    provider: 'codex', providerDisplayName: 'Codex', status: 'running', stateRevision: 4,
  });
  apply(items, {
    type: 'provider_artifact', provider: 'codex', invocationId: 'codex:preview',
    parentToolCallId: 'preview', artifactId: 'screen-4', kind: 'screenshot',
    stateRevision: 4, thumbnailDataUrl: screenshot,
    alt: 'Latest provider workspace view',
  });
  apply(items, {
    type: 'provider_artifact', provider: 'codex', invocationId: 'codex:preview',
    parentToolCallId: 'preview', artifactId: 'stale-screen', kind: 'screenshot',
    stateRevision: 3, thumbnailDataUrl: screenshot,
    alt: 'Latest provider browser view',
  });
  apply(items, {
    type: 'provider_artifact', provider: 'codex', invocationId: 'codex:preview',
    parentToolCallId: 'preview', artifactId: 'unsafe-screen', kind: 'screenshot',
    stateRevision: 4, thumbnailDataUrl: 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=',
    alt: 'Latest provider workspace view',
  });

  expect(items[0]).toMatchObject({
    type: 'provider_invocation',
    artifact: {
      id: 'screen-4', stateRevision: 4,
      thumbnailDataUrl: screenshot,
      alt: 'Latest provider workspace view',
    },
  });
});

test('revalidates a nested reconnect preview before exposing a snapshot', () => {
  const snapshot: Extract<ChatItem, { type: 'provider_invocation' }> = {
    id: 'codex:snapshot', type: 'provider_invocation', parentToolCallId: 'snapshot',
    provider: 'codex', providerDisplayName: 'Codex', status: 'running', activities: [],
    stateRevision: 4,
    artifact: {
      id: 'screen-4', kind: 'screenshot', stateRevision: 4,
      thumbnailDataUrl: screenshot, alt: 'Latest provider workspace view',
    },
  };

  expect(normalizeProviderInvocationSnapshot(snapshot).artifact).toEqual(snapshot.artifact);
  expect(normalizeProviderInvocationSnapshot({
    ...snapshot,
    artifact: {
      ...snapshot.artifact!,
      stateRevision: 3,
    },
  }).artifact).toBeUndefined();
  expect(normalizeProviderInvocationSnapshot({
    ...snapshot,
    artifact: {
      ...snapshot.artifact!,
      thumbnailDataUrl: 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=',
    },
  }).artifact).toBeUndefined();
});

test('safe typed activity replaces legacy raw data and keeps native sequence order', () => {
  const items: ChatItem[] = [{
    id: 'parent', type: 'tool_call', name: 'codex', status: 'running', args: {},
  }];
  apply(items, {
    type: 'provider_invocation', invocationId: 'codex:parent', parentToolCallId: 'parent',
    provider: 'codex', providerDisplayName: 'Codex',
    taskTitle: 'Implement and verify the requested change',
    taskSummary: 'Implement and verify the requested change',
    currentSummary: 'Working in the selected workspace', status: 'running',
  });
  apply(items, {
    type: 'tool_call', tool_id: 'compile', name: 'cc --token private-value',
    args: { cwd: '/private/tmp/private-workroom' }, status: 'in_progress',
    parentToolCallId: 'parent', invocationId: 'codex:parent',
  });
  apply(items, {
    type: 'provider_activity', provider: 'codex', activityId: 'compile', sequence: 2,
    kind: 'command', status: 'running', title: 'Run a workspace command',
    summary: 'Running a workspace command', parentToolCallId: 'parent', invocationId: 'codex:parent',
  });
  apply(items, {
    type: 'provider_activity', provider: 'codex', activityId: 'inspect', sequence: 1,
    kind: 'inspect', status: 'completed', title: 'Inspect the workspace',
    summary: 'Workspace inspection completed', parentToolCallId: 'parent', invocationId: 'codex:parent',
  });
  apply(items, {
    type: 'tool_result', tool_id: 'compile', status: 'completed', result: 'private output',
    parentToolCallId: 'parent', invocationId: 'codex:parent',
  });
  apply(items, {
    type: 'provider_activity', provider: 'codex', activityId: 'compile', sequence: 2,
    kind: 'command', status: 'completed', title: 'Run a workspace command',
    summary: 'Completed a workspace command', parentToolCallId: 'parent', invocationId: 'codex:parent',
  });

  const invocation = items[0] as Extract<ChatItem, { type: 'provider_invocation' }>;
  expect(invocation.taskTitle).toBe('Implement and verify the requested change');
  expect(invocation.currentSummary).toBe('Working in the selected workspace');
  expect(invocation.activities).toEqual([
    {
      id: 'inspect', sequence: 1, kind: 'inspect', status: 'done', legacy: false,
      title: 'Inspect the workspace', summary: 'Workspace inspection completed',
    },
    {
      id: 'compile', sequence: 2, kind: 'command', status: 'done', legacy: false,
      title: 'Run a workspace command', summary: 'Completed a workspace command',
    },
  ]);
  expect(JSON.stringify(invocation.activities)).not.toContain('private');
});

test('drops raw provider text instead of treating the transport as a presentation authority', () => {
  const items: ChatItem[] = [{
    id: 'parent', type: 'tool_call', name: 'codex', status: 'running', args: {},
  }];
  apply(items, {
    type: 'provider_invocation', invocationId: 'codex:parent', parentToolCallId: 'parent',
    provider: 'codex', providerDisplayName: 'untrusted provider label',
    taskTitle: 'Run curl https://example.invalid/?token=private',
    taskSummary: 'private prompt',
    currentSummary: 'private native output',
    status: 'running',
  });
  apply(items, {
    type: 'provider_activity', provider: 'codex', activityId: 'raw', sequence: 1,
    kind: 'command', status: 'completed', title: 'curl https://example.invalid',
    summary: 'private native output', parentToolCallId: 'parent', invocationId: 'codex:parent',
  });

  const invocation = items[0] as Extract<ChatItem, { type: 'provider_invocation' }>;
  expect(invocation.providerDisplayName).toBe('Codex');
  expect(invocation.taskTitle).toBeUndefined();
  expect(invocation.taskSummary).toBeUndefined();
  expect(invocation.currentSummary).toBeUndefined();
  expect(invocation.activities).toEqual([]);
  expect(JSON.stringify(invocation)).not.toContain('private');
});

test('typed activity with mismatched invocation correlation is ignored', () => {
  const items: ChatItem[] = [];
  apply(items, {
    type: 'provider_invocation', invocationId: 'codex:one', parentToolCallId: 'one',
    provider: 'codex', providerDisplayName: 'Codex', status: 'running',
  });
  apply(items, {
    type: 'provider_activity', provider: 'codex', activityId: 'wrong-parent', sequence: 1,
    kind: 'command', status: 'running', title: 'Run a workspace command',
    summary: 'Running a workspace command', parentToolCallId: 'other', invocationId: 'codex:one',
  });

  const invocation = items[0] as Extract<ChatItem, { type: 'provider_invocation' }>;
  expect(invocation.activities).toEqual([]);
});

test('keeps only bounded basenames from safe provider activity file evidence', () => {
  const items: ChatItem[] = [];
  apply(items, {
    type: 'provider_invocation', invocationId: 'codex:files', parentToolCallId: 'files',
    provider: 'codex', providerDisplayName: 'Codex', status: 'running',
  });
  apply(items, {
    type: 'provider_activity', provider: 'codex', activityId: 'files', sequence: 1,
    kind: 'file_change', status: 'completed', title: 'Update workspace files',
    summary: 'Workspace files updated', parentToolCallId: 'files', invocationId: 'codex:files',
    files: ['C:\\\\private\\\\sort.c', '/tmp/workroom/result.txt/', '///'],
  });

  const invocation = items[0] as Extract<ChatItem, { type: 'provider_invocation' }>;
  expect(invocation.activities[0].files).toEqual(['sort.c', 'result.txt']);
});
