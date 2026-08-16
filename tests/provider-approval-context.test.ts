import { RemoteAgent } from '../src/connect/remote-agent';

class FakeSocket {
  static OPEN = 1;
  readyState = FakeSocket.OPEN;
  onmessage: ((event: { data: string }) => void) | null = null;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;

  send() {}
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
  }));
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
