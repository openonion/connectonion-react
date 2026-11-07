import { RemoteAgent } from '../src/connect/remote-agent';

const SESSION_ID = 'reconnect-session';

class FakeSocket {
  static instances: FakeSocket[] = [];

  onopen = null;
  onmessage = null;
  onerror = null;
  onclose = null;
  readyState = 0;
  closeCalls = 0;
  sendCalls = 0;
  sent: string[] = [];

  constructor(_url = '') {
    FakeSocket.instances.push(this);
  }

  send(data = ''): void {
    this.sendCalls += 1;
    if (this.readyState !== 1) {
      throw new Error('raw WebSocket InvalidStateError');
    }
    this.sent.push(data);
  }

  close(): void {
    this.closeCalls += 1;
    this.readyState = 3;
  }
}

function remoteAgent() {
  const agent = new RemoteAgent('agent-name', {
    directUrl: 'https://agent.example',
    wsCtor: FakeSocket as any,
    keys: {
      address: `0x${'a'.repeat(64)}`,
      shortAddress: '0xaaaa...aaaa',
      publicKey: new Uint8Array(32),
      privateKey: new Uint8Array(64),
    },
    signer: {
      address: `0x${'a'.repeat(64)}`,
      sign: () => 'signature',
    },
  }) as any;
  agent._currentSession = { session_id: SESSION_ID };
  return agent;
}

async function settleSigner(): Promise<void> {
  for (let i = 0; i < 6; i += 1) await Promise.resolve();
}

describe('RemoteAgent reconnect races', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    FakeSocket.instances = [];
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  test('a subscriber calling connect shares the initial handshake', async () => {
    const agent = remoteAgent();
    let requested = false;
    let following: Promise<void> | undefined;
    agent.onMessage = () => {
      if (!['connecting', 'reconnecting'].includes(agent.connectionState) || requested) return;
      requested = true;
      following = agent.connect();
    };

    const connecting = agent.connect();
    await settleSigner();

    expect(requested).toBe(true);
    expect(FakeSocket.instances).toHaveLength(1);
    const socket = FakeSocket.instances[0] as any;
    socket.readyState = 1;
    socket.onopen?.({});
    await settleSigner();
    socket.onmessage?.({ data: JSON.stringify({ type: 'CONNECTED', session_id: SESSION_ID }) });
    await Promise.all([connecting, following]);
    expect(FakeSocket.instances).toHaveLength(1);
    expect(socket.sent.map((frame: string) => JSON.parse(frame).type)).toEqual(['CONNECT']);
    expect(agent.connectionState).toBe('connected');
    agent.reset();
  });

  test.each([null, { session_id: SESSION_ID }])('a first connect reports connecting with session %p', async (session) => {
    const agent = remoteAgent();
    agent._currentSession = session;
    const observed: string[] = [];
    agent.onMessage = () => observed.push(agent.connectionState);
    const connecting = agent.connect();
    expect(agent.connectionState).toBe('connecting');
    expect(observed).toEqual(['connecting']);
    await settleSigner();
    const socket = FakeSocket.instances[0] as any;
    socket.readyState = 1;
    socket.onopen?.({});
    await settleSigner();
    expect(agent.connectionState).toBe('connecting');
    socket.onmessage?.({ data: JSON.stringify({ type: 'CONNECTED', session_id: SESSION_ID }) });
    await connecting;
    expect(agent.connectionState).toBe('connected');
    agent.reset();
  });

  test('a socket closing before open rejects connect and reports disconnected with an error', async () => {
    const agent = remoteAgent();
    const outcome = agent.connect().then(() => 'resolved', (error: Error) => error);
    await settleSigner();
    const socket = FakeSocket.instances[0] as any;
    socket.readyState = 3;
    socket.onclose?.({ code: 1012 });
    await settleSigner();
    expect(agent.connectionState).toBe('disconnected');
    expect(agent.error?.message).toBe('WebSocket closed before opening');
    await expect(outcome).resolves.toEqual(new Error('WebSocket closed before opening'));
    expect(socket.sent).toEqual([]);
    expect(agent._ws).toBeNull();
    expect(agent._connecting).toBeNull();
  });

  test.each([
    { type: 'thinking', id: 'host-thinking' },
    { type: 'RUNTIME_INPUT_ACK', session_id: SESSION_ID, id: 'runtime-input' },
    { type: 'PROVIDER_INPUT_ACK', requestId: 'provider-input', invocationId: 'provider-1', accepted: true },
    { type: 'approval_needed', id: 'approval-1', tool: 'shell', arguments: {} },
  ])('a relay ERROR after Host $type ends the turn without resending', async (hostFrame) => {
    const agent = remoteAgent();
    agent._directUrl = undefined;
    agent._resolveEndpointOnce = async () => {};
    const connecting = agent.connect();
    await settleSigner();
    const socket = FakeSocket.instances[0] as any;
    socket.readyState = 1;
    socket.onopen?.({});
    await settleSigner();
    socket.onmessage?.({ data: JSON.stringify({ type: 'CONNECTED', session_id: SESSION_ID }) });
    await connecting;

    const outcome = agent.input('inspect the repo').catch((error: Error) => error);
    await settleSigner();
    const queuedClose = socket.onclose;
    socket.onmessage?.({ data: JSON.stringify(hostFrame) });
    socket.onmessage?.({ data: JSON.stringify({
      type: 'ERROR', message: 'Agent not connected: 0xabc; reconnect with a fresh CONNECT',
    }) });
    await settleSigner();

    expect(FakeSocket.instances).toHaveLength(1);
    expect(socket.sent.map((frame: string) => JSON.parse(frame).type)).toEqual(['CONNECT', 'INPUT']);
    expect(agent.connectionState).toBe('disconnected');
    expect(agent.status).toBe('idle');
    expect(agent.error?.message).toBe(
      'Connection lost: Host disconnected. Your input may already have been received. Automatic retry has stopped.',
    );
    await expect(outcome).resolves.toEqual(agent.error);
    expect(agent._authenticated).toBe(false);
    expect(agent._pendingInputMessage).toBeNull();
    expect(agent.ui).not.toContainEqual(expect.objectContaining({ id: '__optimistic__' }));
    queuedClose?.({ code: 1012 });
    expect(agent.connectionState).toBe('disconnected');
    expect(FakeSocket.instances).toHaveLength(1);
    agent.reset();
  });

  test.each([false, true])('an idle relay ERROR reports only connection loss (completed input: %p)', async (completedInput) => {
    const agent = remoteAgent();
    const connecting = agent.connect();
    await settleSigner();
    const socket = FakeSocket.instances[0] as any;
    socket.readyState = 1;
    socket.onopen?.({});
    await settleSigner();
    socket.onmessage?.({ data: JSON.stringify({ type: 'CONNECTED', session_id: SESSION_ID }) });
    await connecting;

    if (completedInput) {
      const response = agent.input('inspect the repo');
      await settleSigner();
      socket.onmessage?.({ data: JSON.stringify({ type: 'OUTPUT', result: 'done' }) });
      await response;
    }

    socket.onmessage?.({ data: JSON.stringify({
      type: 'ERROR', message: 'Agent not connected: 0xabc; reconnect with a fresh CONNECT',
    }) });
    expect(agent.error?.message).toBe('Connection lost: Host disconnected.');
    expect(agent.connectionState).toBe('disconnected');
    expect(agent.status).toBe('idle');
    expect(agent._authenticated).toBe(false);
    expect(agent._pendingInputMessage).toBeNull();
    expect(socket.closeCalls).toBe(1);
    expect(FakeSocket.instances).toHaveLength(1);
    agent.reset();
  });

  test('an interjection after streaming cannot re-enable relay recovery', async () => {
    const agent = remoteAgent();
    const socket = new FakeSocket();
    socket.readyState = 1;
    agent._ws = socket;
    agent._authenticated = true;
    agent._connectionState = 'connected';

    const first = agent.input('inspect the repo').catch((error: Error) => error);
    await settleSigner();
    agent._handleMessage({ data: JSON.stringify({ type: 'thinking', id: 'host-thinking' }) });
    const interjection = agent.input('also inspect the tests').catch((error: Error) => error);
    await settleSigner();
    agent._handleMessage({ data: JSON.stringify({
      type: 'ERROR', message: 'Agent not connected: 0xabc; reconnect with a fresh CONNECT',
    }) });
    await settleSigner();

    expect(FakeSocket.instances).toHaveLength(1);
    expect(socket.sent.map((frame) => JSON.parse(frame).type)).toEqual(['INPUT', 'INPUT']);
    expect(agent.connectionState).toBe('disconnected');
    await expect(first).resolves.toEqual(agent.error);
    await expect(interjection).resolves.toEqual(agent.error);
    agent.reset();
  });

  test('a relay ERROR before any Host response followed by close 1012 retries the input only once', async () => {
    const agent = remoteAgent();
    agent._directUrl = undefined;
    agent._resolveEndpointOnce = async () => {};
    const connecting = agent.connect();
    await settleSigner();
    const stale = FakeSocket.instances[0] as any;
    stale.readyState = 1;
    stale.onopen?.({});
    await settleSigner();
    stale.onmessage?.({ data: JSON.stringify({ type: 'CONNECTED', session_id: SESSION_ID }) });
    await connecting;

    const response = agent.input('inspect the repo');
    const outcome = response.then((value: unknown) => value, (error: Error) => error);
    await settleSigner();
    const originalInput = JSON.parse(stale.sent[1]);
    const staleClose = stale.onclose;
    stale.onmessage?.({ data: JSON.stringify({ type: 'PING' }) });
    stale.onmessage?.({ data: JSON.stringify({ type: 'PONG' }) });
    const frame = { type: 'ERROR', message: 'Agent not connected: 0xabc; reconnect with a fresh CONNECT' };
    stale.onmessage?.({ data: JSON.stringify(frame) });
    stale.readyState = 3;
    staleClose?.({ code: 1012 });
    expect(agent.error).toBeNull();
    await settleSigner();

    expect(FakeSocket.instances).toHaveLength(2);
    const replacement = FakeSocket.instances[1] as any;
    replacement.readyState = 1;
    replacement.onopen?.({});
    await settleSigner();
    expect(replacement.sent.map((data: string) => JSON.parse(data).type)).toEqual(['CONNECT']);
    expect(agent.connectionState).toBe('reconnecting');
    replacement.onmessage?.({ data: JSON.stringify({ type: 'CONNECTED', session_id: SESSION_ID }) });
    await settleSigner();
    expect(replacement.sent.map((data: string) => JSON.parse(data))).toEqual([
      expect.objectContaining({ type: 'CONNECT' }), originalInput,
    ]);
    expect(agent.ui.filter((item: { type: string }) => item.type === 'user')).toHaveLength(1);
    expect(agent.error).toBeNull();
    staleClose?.({ code: 1012 });
    expect(agent.connectionState).toBe('connected');

    replacement.onmessage?.({ data: JSON.stringify(frame) });
    await expect(outcome).resolves.toEqual(new Error(
      'Connection lost: Host disconnected. Your input may already have been received. Automatic retry has stopped.',
    ));
    expect(agent.connectionState).toBe('disconnected');
    expect(FakeSocket.instances).toHaveLength(2);
    expect(replacement.sent).toHaveLength(2);
    agent.reset();
  });

  test.each(['onclose', 'onerror'])('a relay %s invalidates auth and the next input waits for CONNECTED', async (event) => {
    const agent = remoteAgent();
    agent._directUrl = undefined;
    agent._resolveEndpointOnce = async () => {};
    const connecting = agent.connect();
    await settleSigner();
    const socket = FakeSocket.instances[0] as any;
    socket.readyState = 1;
    socket.onopen?.({});
    await settleSigner();
    socket.onmessage?.({ data: JSON.stringify({ type: 'CONNECTED', session_id: SESSION_ID }) });
    await connecting;

    const observed: string[] = [];
    agent.onMessage = () => observed.push(agent.connectionState);
    socket.readyState = 3;
    socket[event]?.({});
    expect(agent.connectionState).toBe('disconnected');
    expect(agent._authenticated).toBe(false);
    expect(observed).toContain('disconnected');

    const response = agent.input('inspect the workspace');
    await settleSigner();
    const replacement = FakeSocket.instances[1] as any;
    replacement.readyState = 1;
    replacement.onopen?.({});
    await settleSigner();
    replacement.onmessage?.({ data: JSON.stringify({ type: 'PING' }) });
    expect(replacement.sent.map((frame: string) => JSON.parse(frame).type)).toEqual(['CONNECT', 'PONG']);
    expect(agent.connectionState).toBe('reconnecting');
    expect(observed[observed.length - 1]).toBe('reconnecting');
    expect(agent._authenticated).toBe(false);

    replacement.onmessage?.({ data: JSON.stringify({ type: 'CONNECTED', session_id: SESSION_ID }) });
    await settleSigner();
    expect(replacement.sent.map((frame: string) => JSON.parse(frame).type)).toEqual(['CONNECT', 'PONG', 'INPUT']);
    replacement.onmessage?.({ data: JSON.stringify({ type: 'OUTPUT', result: 'Ready' }) });
    await expect(response).resolves.toEqual({ text: 'Ready', done: true });
    expect(agent.connectionState).toBe('connected');
    expect(socket.sent.map((frame: string) => JSON.parse(frame).type)).toEqual(['CONNECT']);
    agent.reset();
  });

  test('keepalive expiry invalidates auth without waiting for the socket close handshake', () => {
    const agent = remoteAgent();
    const socket = new FakeSocket();
    socket.readyState = 1;
    agent._ws = socket;
    agent._authenticated = true;
    agent._connectionState = 'connected';
    agent._lastActivityTime = Date.now();
    const onMessage = jest.fn();
    agent.onMessage = onMessage;
    agent._startPingMonitor();

    jest.advanceTimersByTime(70000);

    expect(socket.closeCalls).toBe(1);
    expect(agent.connectionState).toBe('disconnected');
    expect(agent._authenticated).toBe(false);
    expect(onMessage).toHaveBeenCalled();
  });

  test('an OIP status query never reconnects the owned transport', async () => {
    const agent = remoteAgent();
    agent._transportSelection = {
      kind: 'oip-direct',
      httpUrl: 'https://agent.example',
      wsUrl: 'wss://agent.example/ws',
    };
    agent._ensureConnected = jest.fn().mockResolvedValue(undefined);

    const checking = agent.checkSessionStatus(SESSION_ID);
    await settleSigner();

    const statusSocket = FakeSocket.instances[0] as any;
    statusSocket.readyState = 1;
    statusSocket.onopen?.({});
    statusSocket.onmessage?.({
      data: JSON.stringify({ type: 'SESSION_STATUS', status: 'not_found' }),
    });

    await expect(checking).resolves.toBe('not_found');
    expect(agent._ensureConnected).not.toHaveBeenCalled();
    expect(agent.connectionState).toBe('disconnected');
  });

  test('reconnect is a no-op for an authenticated open session', async () => {
    const agent = remoteAgent();
    const socket = new FakeSocket();
    socket.readyState = 1;
    agent._ws = socket;
    agent._authenticated = true;
    agent._connectionState = 'connected';
    // Hosts may canonicalize the caller's route ID. The live RemoteAgent still
    // owns that one session and must not tear it down to reconcile two names.
    agent._currentSession = { session_id: 'server-session-id' };

    await expect(agent.reconnect(SESSION_ID)).resolves.toEqual({
      text: '',
      done: true,
    });

    expect(socket.closeCalls).toBe(0);
    expect(FakeSocket.instances).toHaveLength(1);
    expect(agent.connectionState).toBe('connected');
  });

  test('reconnect shares an in-flight eager connect', async () => {
    const agent = remoteAgent();

    const connecting = agent.connect().catch(() => undefined);
    const reconnecting = agent.reconnect(SESSION_ID).catch(() => undefined);

    await settleSigner();
    expect(FakeSocket.instances).toHaveLength(1);

    agent.reset();
    void connecting;
    void reconnecting;
  });

  test('parallel session-index CONNECT payloads are unique within one second', async () => {
    const firstAgent = remoteAgent();
    const secondAgent = remoteAgent();
    firstAgent._sessionSyncOnly = true;
    secondAgent._sessionSyncOnly = true;
    firstAgent._currentSession = null;
    secondAgent._currentSession = null;

    const firstConnect = firstAgent.connect();
    const secondConnect = secondAgent.connect();
    await settleSigner();

    const [firstSocket, secondSocket] = FakeSocket.instances as any[];
    firstSocket.readyState = 1;
    secondSocket.readyState = 1;
    firstSocket.onopen?.({});
    secondSocket.onopen?.({});
    await settleSigner();

    const firstFrame = JSON.parse(firstSocket.sent[0]);
    const secondFrame = JSON.parse(secondSocket.sent[0]);
    expect(firstFrame.payload.timestamp).toBe(secondFrame.payload.timestamp);
    expect(firstFrame.payload.to).toBe(secondFrame.payload.to);
    expect(firstFrame.payload.session_sync_only).toBe(1);
    expect(firstFrame.payload.nonce).toEqual(expect.any(String));
    expect(secondFrame.payload.nonce).toEqual(expect.any(String));
    expect(firstFrame.payload.nonce).not.toBe(secondFrame.payload.nonce);

    firstSocket.onmessage?.({
      data: JSON.stringify({ type: 'CONNECTED', status: 'index' }),
    });
    secondSocket.onmessage?.({
      data: JSON.stringify({ type: 'CONNECTED', status: 'index' }),
    });
    await Promise.all([firstConnect, secondConnect]);
  });

  test.each([
    'authenticate first (send CONNECT)',
    'INPUT rejected: not authenticated (send CONNECT first)',
    'Agent not connected: 0xabc; reconnect with a fresh CONNECT',
  ])('an input rejected with "%s" reconnects and is sent exactly once', async (message) => {
    const agent = remoteAgent();
    const staleSocket = new FakeSocket();
    staleSocket.readyState = 1;
    agent._ws = staleSocket;
    agent._authenticated = true;
    agent._connectionState = 'connected';

    const response = agent.input('inspect the repo');
    await Promise.resolve();
    expect(staleSocket.sent.map((frame) => JSON.parse(frame))).toEqual([
      expect.objectContaining({ type: 'INPUT', prompt: 'inspect the repo' }),
    ]);

    agent._handleMessage({
      data: JSON.stringify({ type: 'ERROR', message }),
    });
    await settleSigner();

    const recoveredSocket = FakeSocket.instances[FakeSocket.instances.length - 1] as any;
    expect(recoveredSocket).not.toBe(staleSocket);
    recoveredSocket.readyState = 1;
    recoveredSocket.onopen?.({});
    await settleSigner();
    expect(recoveredSocket.sent.map((frame: string) => JSON.parse(frame))).toEqual([
      expect.objectContaining({ type: 'CONNECT' }),
    ]);

    recoveredSocket.onmessage?.({
      data: JSON.stringify({
        type: 'CONNECTED',
        protocol: { name: 'oip', version: '0.1' },
        session_id: SESSION_ID,
        status: 'new',
      }),
    });
    await settleSigner();
    expect(recoveredSocket.sent.map((frame: string) => JSON.parse(frame))).toEqual([
      expect.objectContaining({ type: 'CONNECT' }),
      expect.objectContaining({ type: 'INPUT', prompt: 'inspect the repo' }),
    ]);

    recoveredSocket.onmessage?.({
      data: JSON.stringify({ type: 'OUTPUT', result: 'README.md' }),
    });
    await expect(response).resolves.toEqual({ text: 'README.md', done: true });
    expect(agent.ui.filter((item: { type: string }) => item.type === 'user')).toHaveLength(1);
  });

  test('eager connect shares an in-flight hydration reconnect', async () => {
    const agent = remoteAgent();

    const reconnecting = agent.reconnect(SESSION_ID).catch(() => undefined);
    const connecting = agent.connect().catch(() => undefined);

    await settleSigner();
    expect(FakeSocket.instances).toHaveLength(1);

    agent.reset();
    void reconnecting;
    void connecting;
  });

  test('two rapid reconnect requests share one attempt', async () => {
    const agent = remoteAgent();

    const first = agent.reconnect(SESSION_ID).catch(() => undefined);
    const second = agent.reconnect(SESSION_ID).catch(() => undefined);

    expect(agent.connectionState).toBe('reconnecting');
    await settleSigner();
    expect(FakeSocket.instances).toHaveLength(1);

    agent.reset();
    void first;
    void second;
  });

  test('an idle CONNECTED frame completes reconnect readiness', async () => {
    const agent = remoteAgent();
    const reconnecting = agent.reconnect(SESSION_ID);
    await settleSigner();
    const socket = FakeSocket.instances[0] as any;
    socket.readyState = 1;
    socket.onopen?.({});
    socket.onmessage?.({
      data: JSON.stringify({
        type: 'CONNECTED',
        session_id: 'server-session-id',
        status: 'idle',
      }),
    });

    await expect(reconnecting).resolves.toEqual({ text: '', done: true });
    expect(agent.connectionState).toBe('connected');
    expect(agent.status).toBe('idle');
  });

  test('send rejects through React state before touching a non-open socket', () => {
    const agent = remoteAgent();
    const socket = new FakeSocket();
    agent._ws = socket;
    agent._authenticated = true;

    expect(() => agent.send({
      type: 'ASK_USER_RESPONSE',
      answer: 'continue',
    })).toThrow('Agent connection is not ready');

    expect(socket.sendCalls).toBe(0);
    expect(agent.error?.message).toBe('Agent connection is not ready');
    expect(agent.status).toBe('idle');
    expect(agent.ui).not.toContainEqual(
      expect.objectContaining({ id: '__optimistic__' }),
    );
  });

  test('input never exposes a raw send error if readiness changes after connect', async () => {
    const agent = remoteAgent();
    const socket = new FakeSocket();
    agent._ws = socket;
    agent._authenticated = true;
    agent._ensureConnected = jest.fn().mockResolvedValue(undefined);

    await expect(agent.input('hello')).rejects.toThrow(
      'Agent connection is not ready',
    );

    expect(socket.sendCalls).toBe(0);
    expect(agent.error?.message).toBe('Agent connection is not ready');
    expect(agent.status).toBe('idle');
    expect(agent.ui).not.toContainEqual(
      expect.objectContaining({ id: '__optimistic__' }),
    );
  });

  test('connect does not reuse an authenticated socket that is no longer open', async () => {
    const agent = remoteAgent();
    const stale = new FakeSocket();
    stale.readyState = 3;
    agent._ws = stale;
    agent._authenticated = true;

    const connecting = agent.connect().catch(() => undefined);
    await settleSigner();

    expect(stale.closeCalls).toBe(1);
    expect(FakeSocket.instances).toHaveLength(2);

    agent.reset();
    void connecting;
  });

  test('onboarding can answer on an open socket before authentication', () => {
    const agent = remoteAgent();
    const socket = new FakeSocket();
    socket.readyState = 1;
    agent._ws = socket;
    agent._authenticated = false;

    expect(() => agent.send({
      type: 'ONBOARD_SUBMIT',
      invite_code: 'invite-code',
    })).not.toThrow();

    expect(socket.sendCalls).toBe(1);
  });
});
