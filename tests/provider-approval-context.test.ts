import { RemoteAgent } from '../src/connect/remote-agent';

class FakeSocket {
  static OPEN = 1;
  readyState = FakeSocket.OPEN;
  onmessage: ((event: { data: string }) => void) | null = null;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;

  sent: string[] = [];
  send(data: string) { this.sent.push(data); }
  close() {}
}

test('keeps native provider approval correlation without putting it in visible arguments', () => {
  const agent = new RemoteAgent('0x' + 'a'.repeat(64), {}) as any;
  agent._ws = new FakeSocket();

  agent._handleMessage({ data: JSON.stringify({
    id: 'approval-1',
    type: 'approval_needed',
    tool: 'codex',
    arguments: { action: 'Run pytest', cwd: '.workroom-e2e' },
    provider: 'codex',
    invocationId: 'codex:outer-call',
    parentToolCallId: 'outer-call',
    activityId: 'item-7',
    providerApproval: {
      action: 'Run a workspace command',
      scope: 'This Work Room only',
      reason: 'Codex requested approval to continue',
      scopeClassification: 'workroom',
      allowOnce: true,
      allowSession: false,
      files: ['C:\\\\private\\\\sort.c', '/tmp/workroom/result.txt/', '///'],
    },
  }) });

  expect(agent.ui).toContainEqual(expect.objectContaining({
    id: 'approval-1',
    type: 'approval_needed',
    tool: 'codex',
    provider: 'codex',
    providerInvocationId: 'codex:outer-call',
    parentToolCallId: 'outer-call',
    activityId: 'item-7',
    arguments: { action: 'Run pytest', cwd: '.workroom-e2e' },
    providerApproval: {
      action: 'Run a workspace command',
      scope: 'This Work Room only',
      reason: 'Codex requested approval to continue',
      scopeClassification: 'workroom',
      allowOnce: true,
      allowSession: false,
      files: ['sort.c', 'result.txt'],
    },
  }));
});

test('drops malformed provider approval presentation rather than rendering raw fields', () => {
  const agent = new RemoteAgent('0x' + 'a'.repeat(64), {}) as any;
  agent._ws = new FakeSocket();

  agent._handleMessage({ data: JSON.stringify({
    id: 'approval-3',
    type: 'approval_needed',
    tool: 'codex',
    arguments: { action: 'Run pytest' },
    provider: 'codex',
    invocationId: 'codex:outer-call',
    parentToolCallId: 'outer-call',
    providerApproval: {
      action: 'cc --token private-value',
      scopeClassification: 'untrusted-value',
      allowOnce: 'yes',
    },
  }) });

  const approval = agent.ui.find((item: any) => item.id === 'approval-3');
  expect(approval.providerApproval).toBeUndefined();
});

test('drops incomplete native provider correlation instead of guessing a card', () => {
  const agent = new RemoteAgent('0x' + 'a'.repeat(64), {}) as any;
  agent._ws = new FakeSocket();

  agent._handleMessage({ data: JSON.stringify({
    id: 'approval-2',
    type: 'approval_needed',
    tool: 'codex',
    arguments: { action: 'Run pytest' },
    provider: 'codex',
    invocationId: 'codex:outer-call',
  }) });

  expect(agent.ui).toContainEqual({
    id: 'approval-2',
    type: 'approval_needed',
    tool: 'codex',
    arguments: { action: 'Run pytest' },
  });
});

test.each([
  ['unknown', 'Boundary could not be verified'],
  ['elevated', 'Outside this Work Room'],
] as const)('never preserves allow controls for a %s provider boundary', (scopeClassification, scope) => {
  const agent = new RemoteAgent('0x' + 'a'.repeat(64), {}) as any;
  agent._ws = new FakeSocket();

  agent._handleMessage({ data: JSON.stringify({
    id: `approval-${scopeClassification}`,
    type: 'approval_needed',
    tool: 'codex',
    arguments: {},
    provider: 'codex',
    invocationId: 'codex:outer-call',
    parentToolCallId: 'outer-call',
    providerApproval: {
      action: 'Run a workspace command',
      scope,
      reason: 'Codex requested approval to continue',
      scopeClassification,
      allowOnce: true,
      allowSession: true,
    },
  }) });

  expect(agent.ui).toContainEqual(expect.objectContaining({
    id: `approval-${scopeClassification}`,
    providerApproval: expect.objectContaining({
      scopeClassification,
      allowOnce: false,
      allowSession: false,
    }),
  }));
});

test('forwards safe provider activity through the live RemoteAgent dispatcher', () => {
  const agent = new RemoteAgent('0x' + 'a'.repeat(64), {}) as any;
  agent._ws = new FakeSocket();

  agent._handleMessage({ data: JSON.stringify({
    type: 'provider_invocation', invocationId: 'codex:outer-call',
    parentToolCallId: 'outer-call', provider: 'codex', providerDisplayName: 'Codex',
    taskTitle: 'Implement and verify the requested change',
    currentSummary: 'Working in the selected workspace', status: 'running',
  }) });
  agent._handleMessage({ data: JSON.stringify({
    type: 'provider_activity', provider: 'codex', invocationId: 'codex:outer-call',
    parentToolCallId: 'outer-call', activityId: 'step-1', sequence: 1,
    kind: 'inspect', status: 'completed', title: 'Inspect the workspace',
    summary: 'Workspace inspection completed',
  }) });

  expect(agent.ui).toContainEqual(expect.objectContaining({
    id: 'codex:outer-call',
    type: 'provider_invocation',
    taskTitle: 'Implement and verify the requested change',
    currentSummary: 'Working in the selected workspace',
    activities: [{
      id: 'step-1', sequence: 1, kind: 'inspect', status: 'done', legacy: false,
      title: 'Inspect the workspace', summary: 'Workspace inspection completed',
    }],
  }));
});

test('sends a scoped provider interrupt without using the global turn interrupt', () => {
  const agent = new RemoteAgent('0x' + 'a'.repeat(64), {}) as any;
  const socket = new FakeSocket();
  agent._ws = socket;
  agent._authenticated = true;

  agent.interruptProvider('codex:outer-call');

  expect(socket.sent).toEqual([
    JSON.stringify({ type: 'PROVIDER_INTERRUPT', invocationId: 'codex:outer-call' }),
  ]);
  expect(agent._interruptSent).toBe(false);
});
