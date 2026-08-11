import { RemoteAgent } from '../src/connect/remote-agent';
import {
  acpSetSessionModeFrame,
  decodeACPSetModeResponse,
  hostSessionModeState,
} from '../src/connect/wire-events';

const SESSION_ID = 'session-set-mode-22';

class FakeSocket {
  sent: string[] = [];
  onopen = null;
  onmessage = null;
  onerror = null;
  onclose = null;
  send(data: string) { this.sent.push(data); }
  close() {}
}

function connected(
  currentModeId = 'safe',
  availableModes: Array<Record<string, unknown>> = [
    { id: 'safe', name: 'Safe', description: 'Ask before side effects.' },
    { id: 'accept_edits', name: 'Auto' },
  ],
): Record<string, unknown> {
  return {
    type: 'CONNECTED',
    session_id: SESSION_ID,
    status: 'connected',
    carrier_capabilities: {
      acp: {
        schema: 'schema-v1.19.0',
        client_requests: ['session/set_mode'],
      },
    },
    session_modes: { currentModeId, availableModes },
  };
}

function response(
  requestId: string,
  value: { result?: Record<string, unknown>; error?: Record<string, unknown> }
    = { result: {} },
  sessionId = SESSION_ID,
): Record<string, unknown> {
  return {
    type: 'ACP_RESPONSE',
    acpSchema: 'schema-v1.19.0',
    sessionId,
    message: {
      jsonrpc: '2.0',
      id: requestId,
      ...value,
    },
  };
}

function harness(capability = connected()) {
  const agent = new RemoteAgent(`0x${'a'.repeat(64)}`) as any;
  const socket = new FakeSocket();
  agent._ws = socket;
  agent._currentSession = { session_id: SESSION_ID, mode: 'safe', turn: 4 };
  const deliver = (frame: object) => {
    agent._handleMessage({ data: JSON.stringify(frame) });
  };
  deliver(capability);
  const sent = () => socket.sent.map((frame) => JSON.parse(frame));
  return { agent: agent as RemoteAgent, raw: agent, deliver, sent };
}

async function pendingRequest(agent: RemoteAgent) {
  const promise = agent.setSessionMode('accept_edits');
  await Promise.resolve();
  return promise;
}

describe('Host ACP session mode capability', () => {
  test('parses one exact advertised SessionModeState', () => {
    expect(hostSessionModeState(connected())).toEqual({
      currentModeId: 'safe',
      availableModes: [
        { id: 'safe', name: 'Safe', description: 'Ask before side effects.' },
        { id: 'accept_edits', name: 'Auto' },
      ],
    });
  });

  test('keeps advertised mode authoritative over a stale reconnect snapshot', () => {
    const frame = {
      ...connected('safe'),
      server_newer: true,
      session: {
        session_id: SESSION_ID,
        mode: 'accept_edits',
        messages: [],
      },
    };

    const { agent } = harness(frame);

    expect(agent.mode).toBe('safe');
  });

  test.each([
    ['missing request capability', {
      ...connected(), carrier_capabilities: { acp: { schema: 'schema-v1.19.0' } },
    }],
    ['legacy plan alias', connected('plan')],
    ['unknown mode', connected('safe', [{ id: 'future', name: 'Future' }])],
    ['duplicate mode', connected('safe', [
      { id: 'safe', name: 'Safe' }, { id: 'safe', name: 'Again' },
    ])],
    ['current mode not advertised', connected('accept_edits', [
      { id: 'safe', name: 'Safe' },
    ])],
  ])('rejects %s', (_name, frame) => {
    expect(hostSessionModeState(frame as Record<string, unknown>)).toBeNull();
  });
});

describe('acknowledged ACP session/set_mode', () => {
  test('sends the exact request and changes no policy before success', async () => {
    const { agent, deliver, sent } = harness();
    const promise = pendingRequest(agent);
    await Promise.resolve();
    const request = sent()[0];
    const requestId = request.message.id as string;

    expect(request).toEqual(
      acpSetSessionModeFrame(requestId, SESSION_ID, 'accept_edits'),
    );
    expect(agent.mode).toBe('safe');
    expect(agent.modeChangePending).toBe(true);

    deliver(response(requestId));
    await expect(promise).resolves.toBeUndefined();
    expect(agent.mode).toBe('accept_edits');
    expect(agent.currentSession).toMatchObject({ turn: 4 });
    expect(agent.modeChangePending).toBe(false);
  });

  test('keeps authoritative policy unchanged on a Host error', async () => {
    const { agent, deliver, sent } = harness();
    const promise = pendingRequest(agent);
    await Promise.resolve();
    const requestId = sent()[0].message.id as string;

    deliver(response(requestId, {
      error: { code: -32000, message: 'Session is busy', data: { retryable: true } },
    }));

    await expect(promise).rejects.toMatchObject({
      message: 'Session is busy',
      code: -32000,
      data: { retryable: true },
    });
    expect(agent.mode).toBe('safe');
    expect(agent.modeChangePending).toBe(false);
  });

  test('ignores a stale ID but rejects a malformed owned response', async () => {
    const { agent, deliver, sent } = harness();
    const promise = pendingRequest(agent);
    await Promise.resolve();
    const requestId = sent()[0].message.id as string;

    deliver(response('stale-request'));
    expect(agent.modeChangePending).toBe(true);
    deliver(response(requestId, { result: {}, error: {
      code: -32603, message: 'both result and error are invalid',
    } }));

    await expect(promise).rejects.toThrow('Malformed or wrong-session');
    expect(agent.mode).toBe('safe');
  });

  test('rejects a matching response bound to another session', async () => {
    const { agent, deliver, sent } = harness();
    const promise = pendingRequest(agent);
    await Promise.resolve();
    const requestId = sent()[0].message.id as string;

    deliver(response(requestId, { result: {} }, 'other-session'));

    await expect(promise).rejects.toThrow('wrong-session');
    expect(agent.mode).toBe('safe');
  });

  test('allows only one in-flight mode transaction', async () => {
    const { agent, deliver, sent } = harness();
    const first = pendingRequest(agent);
    await Promise.resolve();

    await expect(agent.setSessionMode('safe')).rejects.toThrow(
      'already pending',
    );
    const requestId = sent()[0].message.id as string;
    deliver(response(requestId));
    await expect(first).resolves.toBeUndefined();
  });

  test.each(['plan', 'future'])('never serializes invalid mode %s', async (mode) => {
    const { agent, sent } = harness();

    await expect(agent.setSessionMode(mode as any)).rejects.toThrow(
      'Unsupported server session mode',
    );
    expect(sent()).toEqual([]);
  });

  test('rejects a mode the authenticated Host did not advertise', async () => {
    const { agent, sent } = harness(connected('safe', [
      { id: 'safe', name: 'Safe' },
    ]));

    await expect(agent.setSessionMode('accept_edits')).rejects.toThrow(
      'not available',
    );
    expect(sent()).toEqual([]);
  });

  test('rejects instead of inventing durability for an old Host', async () => {
    const old = connected();
    delete (old as any).session_modes;
    const { agent, sent } = harness(old);

    await expect(agent.setSessionMode('accept_edits')).rejects.toThrow(
      'does not support',
    );
    expect(sent()).toEqual([]);
    expect(agent.mode).toBe('safe');
  });

  test('connection loss rejects the owned request without changing mode', async () => {
    const { agent, raw } = harness();
    const promise = pendingRequest(agent);
    await Promise.resolve();

    raw._handleConnectionLoss();

    await expect(promise).rejects.toThrow('before session mode acknowledgement');
    expect(agent.mode).toBe('safe');
    expect(agent.availableModes).toEqual([]);
  });

  test('timeout rejects and clears the pending transaction', async () => {
    jest.useFakeTimers();
    try {
      const { agent } = harness();
      const promise = agent.setSessionMode('accept_edits');
      await Promise.resolve();

      jest.advanceTimersByTime(30000);

      await expect(promise).rejects.toThrow('timed out');
      expect(agent.mode).toBe('safe');
      expect(agent.modeChangePending).toBe(false);
      expect(agent.error?.message).toContain('timed out');
    } finally {
      jest.useRealTimers();
    }
  });

  test('a matching success response has one exact result shape', () => {
    expect(decodeACPSetModeResponse(response('request-1'))).toEqual({
      requestId: 'request-1',
      sessionId: SESSION_ID,
      result: {},
    });
    expect(decodeACPSetModeResponse(response('request-1', {
      result: { inventedAuthority: true },
    }))).toBeNull();
  });
});
