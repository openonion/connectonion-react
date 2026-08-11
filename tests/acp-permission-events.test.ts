import { RemoteAgent } from '../src/connect/remote-agent';

const SESSION_ID = 'session-1';
const REQUEST_ID = 'approval-event-1';
const TOOL_CALL_ID = 'call-1';

class FakeSocket {
  sent: string[] = [];
  onopen = null;
  onmessage = null;
  onerror = null;
  onclose = null;
  send(data: string) { this.sent.push(data); }
  close() {}
}

const OPTIONS = [
  { optionId: 'allow_once', name: 'Allow this call', kind: 'allow_once' },
  { optionId: 'allow_session', name: 'Allow for this session', kind: 'allow_always' },
  { optionId: 'reject_soft', name: 'Reject this call and continue', kind: 'reject_once' },
  { optionId: 'reject_hard', name: 'Reject and stop this turn', kind: 'reject_once' },
  { optionId: 'reject_explain', name: 'Reject and explain first', kind: 'reject_once' },
];

function acpRequest(overrides: Record<string, unknown> = {}) {
  return {
    type: 'ACP_REQUEST',
    acpSchema: 'schema-v1.19.0',
    message: {
      jsonrpc: '2.0',
      id: REQUEST_ID,
      method: 'session/request_permission',
      params: {
        sessionId: SESSION_ID,
        toolCall: {
          toolCallId: TOOL_CALL_ID,
          title: 'Bash(npm test)',
          status: 'pending',
          rawInput: { command: 'npm test' },
        },
        options: OPTIONS,
      },
    },
    ...overrides,
  };
}

function harness() {
  const agent = new RemoteAgent(`0x${'a'.repeat(64)}`, {}) as any;
  const socket = new FakeSocket();
  agent._ws = socket;
  agent._currentSession = { session_id: SESSION_ID };
  const deliver = (frame: object) => {
    agent._handleMessage({ data: JSON.stringify(frame) });
  };
  const sent = () => socket.sent.map((frame) => JSON.parse(frame));
  return { agent, deliver, sent };
}

describe('ACP v1.19 Host permission requests', () => {
  test('an ACP request becomes one normalized approval item', () => {
    const { agent, deliver } = harness();

    deliver(acpRequest());

    expect(agent.ui).toEqual([{
      id: TOOL_CALL_ID,
      type: 'approval_needed',
      tool: 'Bash(npm test)',
      arguments: { command: 'npm test' },
    }]);
    expect(agent.status).toBe('waiting');
  });

  test('the paired legacy frame enriches rather than duplicates the card', () => {
    const { agent, deliver } = harness();
    deliver(acpRequest());

    deliver({
      type: 'approval_needed',
      id: REQUEST_ID,
      tool_call_id: TOOL_CALL_ID,
      tool: 'Bash(npm test)',
      arguments: { command: 'npm test' },
      description: 'Run the test suite',
      batch_remaining: [{ tool: 'read_file', arguments: '{}' }],
    });

    expect(agent.ui).toHaveLength(1);
    expect(agent.ui[0]).toMatchObject({
      id: TOOL_CALL_ID,
      description: 'Run the test suite',
      batch_remaining: [{ tool: 'read_file', arguments: '{}' }],
    });
  });

  test('replay of the same request is idempotent', () => {
    const { agent, deliver } = harness();

    deliver(acpRequest());
    deliver(acpRequest());

    expect(agent.ui).toHaveLength(1);
  });

  test('wrong-session and malformed ACP fall back to the legacy frame', () => {
    const { agent, deliver } = harness();
    const wrongSession = acpRequest();
    wrongSession.message.params.sessionId = 'other';
    deliver(wrongSession);
    deliver({
      type: 'approval_needed',
      id: REQUEST_ID,
      tool_call_id: TOOL_CALL_ID,
      tool: 'Bash(npm test)',
      arguments: { command: 'npm test' },
    });

    expect(agent.ui).toHaveLength(1);
    expect(agent.ui[0]).toMatchObject({ type: 'approval_needed' });
  });

  test('an unknown option profile is ignored rather than treated as authority', () => {
    const { agent, deliver } = harness();
    const request = acpRequest();
    request.message.params.options = [
      ...OPTIONS,
      { optionId: 'allow_forever', name: 'Allow forever', kind: 'allow_always' },
    ];

    deliver(request);

    expect(agent.ui).toEqual([]);
  });

  test.each([
    [true, 'once', undefined, 'allow_once'],
    [true, 'session', undefined, 'allow_session'],
    [false, 'once', 'reject_soft', 'reject_soft'],
    [false, 'once', 'reject_hard', 'reject_hard'],
    [false, 'once', 'reject_explain', 'reject_explain'],
  ] as const)(
    'one normalized decision sends %s/%s/%s as %s',
    (approved, scope, mode, optionId) => {
      const { agent, deliver, sent } = harness();
      deliver(acpRequest());

      agent.respondToApproval(approved, scope, mode);
      agent.respondToApproval(approved, scope, mode);

      expect(sent()).toEqual([{
        type: 'ACP_RESPONSE',
        acpSchema: 'schema-v1.19.0',
        sessionId: SESSION_ID,
        message: {
          jsonrpc: '2.0',
          id: REQUEST_ID,
          result: { outcome: { outcome: 'selected', optionId } },
        },
      }]);
    },
  );

  test('replay after a decision cannot reopen or resend the same request', () => {
    const { agent, deliver, sent } = harness();
    deliver(acpRequest());

    agent.respondToApproval(true, 'once');
    deliver(acpRequest());
    agent.respondToApproval(true, 'once');

    expect(sent()).toHaveLength(1);
    expect(agent.ui[0]).toMatchObject({ answered: true });
  });

  test('rejection feedback is namespaced text, not an authority field', () => {
    const { agent, deliver, sent } = harness();
    deliver(acpRequest());

    agent.respondToApproval(
      false,
      'once',
      'reject_explain',
      'Why is this needed?',
    );

    expect(sent()[0].message.result).toEqual({
      outcome: { outcome: 'selected', optionId: 'reject_explain' },
      _meta: { connectonion: { feedback: 'Why is this needed?' } },
    });
  });

  test('an unadvertised choice cancels instead of manufacturing permission', () => {
    const { agent, deliver, sent } = harness();
    const request = acpRequest();
    request.message.params.options = OPTIONS.filter(
      (option) => option.optionId !== 'allow_session',
    );
    deliver(request);

    agent.respondToApproval(true, 'session');

    expect(sent()[0].message.result).toEqual({
      outcome: { outcome: 'cancelled' },
    });
  });

  test('legacy Hosts still receive one strict legacy response', () => {
    const { agent, deliver, sent } = harness();
    deliver({
      type: 'approval_needed',
      id: REQUEST_ID,
      tool_call_id: TOOL_CALL_ID,
      tool: 'Bash(npm test)',
      arguments: { command: 'npm test' },
    });

    agent.respondToApproval(true, 'once');
    agent.respondToApproval(true, 'once');

    expect(sent()).toEqual([{
      type: 'APPROVAL_RESPONSE',
      approved: true,
      scope: 'once',
    }]);
  });

  test('the existing raw send path is routed through the same one-shot encoder', () => {
    const { agent, deliver, sent } = harness();
    deliver(acpRequest());

    agent.send({ type: 'APPROVAL_RESPONSE', approved: true, scope: 'once' });
    agent.send({ type: 'APPROVAL_RESPONSE', approved: true, scope: 'once' });

    expect(sent()).toHaveLength(1);
    expect(sent()[0].type).toBe('ACP_RESPONSE');
  });
});
