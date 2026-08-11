import { RemoteAgent } from '../src/connect/remote-agent';

const SESSION_ID = 'session-cancel';

class FakeSocket {
  sent: string[] = [];
  onopen = null;
  onmessage = null;
  onerror = null;
  onclose = null;
  send(data: string) { this.sent.push(data); }
  close() {}
}

function harness(capability: unknown = {
  acp: {
    schema: 'schema-v1.19.0',
    client_notifications: ['session/cancel'],
  },
}) {
  const agent = new RemoteAgent(`0x${'a'.repeat(64)}`, {}) as any;
  const socket = new FakeSocket();
  agent._ws = socket;
  agent._currentSession = { session_id: SESSION_ID };
  agent._status = 'working';
  const deliver = (frame: object) => {
    agent._handleMessage({ data: JSON.stringify(frame) });
  };
  deliver({
    type: 'CONNECTED',
    session_id: SESSION_ID,
    status: 'running',
    carrier_capabilities: capability,
  });
  const sent = () => socket.sent.map((frame) => JSON.parse(frame));
  return { agent, deliver, sent };
}

function acpPermission() {
  return {
    type: 'ACP_REQUEST',
    acpSchema: 'schema-v1.19.0',
    message: {
      jsonrpc: '2.0',
      id: 'request-1',
      method: 'session/request_permission',
      params: {
        sessionId: SESSION_ID,
        toolCall: {
          toolCallId: 'call-1',
          title: 'Bash(npm test)',
          status: 'pending',
          rawInput: { command: 'npm test' },
        },
        options: [
          { optionId: 'allow_once', name: 'Allow', kind: 'allow_once' },
          { optionId: 'allow_session', name: 'Allow session', kind: 'allow_always' },
          { optionId: 'reject_soft', name: 'Reject', kind: 'reject_once' },
          { optionId: 'reject_hard', name: 'Stop', kind: 'reject_once' },
          { optionId: 'reject_explain', name: 'Explain', kind: 'reject_once' },
        ],
      },
    },
  };
}

describe('negotiated ACP Host cancellation', () => {
  test('an advertised Host receives one exact session/cancel notification', () => {
    const { agent, sent } = harness();

    agent.interrupt();
    agent.interrupt();

    expect(sent()).toEqual([{
      type: 'ACP_NOTIFICATION',
      acpSchema: 'schema-v1.19.0',
      message: {
        jsonrpc: '2.0',
        method: 'session/cancel',
        params: { sessionId: SESSION_ID },
      },
    }]);
  });

  test.each([
    null,
    {},
    { acp: { schema: 'schema-v9', client_notifications: ['session/cancel'] } },
    { acp: { schema: 'schema-v1.19.0', client_notifications: [] } },
  ])('an old or malformed Host receives one legacy interrupt', (capability) => {
    const { agent, sent } = harness(capability);

    agent.interrupt();
    agent.interrupt();

    expect(sent()).toEqual([{ type: 'INTERRUPT' }]);
  });

  test('the raw legacy API is routed through the same negotiated one-shot path', () => {
    const { agent, sent } = harness();

    agent.send({ type: 'INTERRUPT' });
    agent.send({ type: 'INTERRUPT' });

    expect(sent()).toHaveLength(1);
    expect(sent()[0].message.method).toBe('session/cancel');
  });

  test('a new completed turn resets the one-shot guard', async () => {
    const { agent, deliver, sent } = harness();
    agent.interrupt();
    deliver({
      type: 'OUTPUT',
      result: 'stopped',
      session: { session_id: SESSION_ID },
    });

    const next = agent.input('next turn');
    await Promise.resolve();
    agent.interrupt();
    deliver({
      type: 'OUTPUT',
      result: 'stopped again',
      session: { session_id: SESSION_ID },
    });
    await next;

    expect(sent().map((frame) => frame.type)).toEqual([
      'ACP_NOTIFICATION',
      'INPUT',
      'ACP_NOTIFICATION',
    ]);
  });

  test('a pending ACP permission is cancelled without an orphan session signal', () => {
    const { agent, deliver, sent } = harness();
    deliver(acpPermission());

    agent.interrupt();
    agent.interrupt();

    expect(sent()).toEqual([{
      type: 'ACP_RESPONSE',
      acpSchema: 'schema-v1.19.0',
      sessionId: SESSION_ID,
      message: {
        jsonrpc: '2.0',
        id: 'request-1',
        result: { outcome: { outcome: 'cancelled' } },
      },
    }]);
  });

  test('a pending legacy permission receives one hard rejection', () => {
    const { agent, deliver, sent } = harness();
    deliver({
      type: 'approval_needed',
      id: 'request-1',
      tool_call_id: 'call-1',
      tool: 'Bash(npm test)',
      arguments: { command: 'npm test' },
    });

    agent.interrupt();
    agent.interrupt();

    expect(sent()).toEqual([{
      type: 'APPROVAL_RESPONSE',
      approved: false,
      scope: 'once',
      mode: 'reject_hard',
    }]);
  });
});
