/**
 * An ERROR frame is the host answering, not the transport failing.
 *
 * The case that matters: a mistyped invite code. The host refuses it, keeps the
 * connection open for a second try, and this side used to close it anyway — so the
 * retry went into a dead socket and the caller waited forever.
 */

import { RemoteAgent } from '../src/connect/remote-agent';

class FakeSocket {
  static OPEN = 1;
  static CLOSED = 3;
  readyState = FakeSocket.OPEN;
  sent: string[] = [];
  closed = false;
  onmessage: ((e: { data: string }) => void) | null = null;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;

  send(data: string) {
    if (this.readyState !== FakeSocket.OPEN) throw new Error('socket is closed');
    this.sent.push(data);
  }
  close() {
    this.closed = true;
    this.readyState = FakeSocket.CLOSED;
  }
  receive(frame: object) {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
}

function agentWithSocket() {
  const agent = new RemoteAgent('0x' + 'a'.repeat(64), {}) as any;
  const socket = new FakeSocket();
  agent._ws = socket;
  // _handleMessage takes the WebSocket event, whose data is the raw JSON string.
  const deliver = (frame: object) => agent._handleMessage({ data: JSON.stringify(frame) });
  return { agent, socket, deliver };
}

describe('an ERROR frame', () => {
  it('leaves the socket open, so a retry can be sent', () => {
    const { socket, deliver } = agentWithSocket();

    deliver({ type: 'ERROR', message: 'Invalid invite code' });

    expect(socket.closed).toBe(false);
    expect(() => socket.send('{"type":"ONBOARD_SUBMIT"}')).not.toThrow();
  });

  it('still rejects the pending call', async () => {
    const { agent, deliver } = agentWithSocket();
    const pending = new Promise((_, reject) => { agent._inputReject = reject; });

    deliver({ type: 'ERROR', message: 'Invalid invite code' });

    await expect(pending).rejects.toThrow(/Invalid invite code/);
  });

  it('reports the failure without claiming the connection is gone', () => {
    const { agent, deliver } = agentWithSocket();
    // Start from connected — 'disconnected' is the initial value, so asserting
    // against it on a fresh agent would pass whether or not the bug is fixed.
    agent._connectionState = 'connected';

    deliver({ type: 'ERROR', message: 'Invalid invite code' });

    expect(agent._error?.message).toMatch(/Invalid invite code/);
    expect(agent._status).toBe('idle');
    // The socket is up. Reporting "disconnected" here is what drove callers to
    // reconnect on a refusal, and reconnecting on every refusal loops until the
    // tab dies.
    expect(agent._connectionState).toBe('connected');
  });
});

describe('the OIP protocol descriptor', () => {
  it('accepts a legacy Host with no descriptor during the rolling window', async () => {
    const { agent, deliver } = agentWithSocket();
    const pending = new Promise((resolve, reject) => {
      agent._connectResolve = resolve;
      agent._connectReject = reject;
    });

    deliver({ type: 'CONNECTED', session_id: 's1', status: 'new' });

    await expect(pending).resolves.toMatchObject({ type: 'CONNECTED' });
  });

  it('accepts the supported OIP version', async () => {
    const { agent, deliver } = agentWithSocket();
    const pending = new Promise((resolve, reject) => {
      agent._connectResolve = resolve;
      agent._connectReject = reject;
    });

    deliver({
      type: 'CONNECTED',
      session_id: 's1',
      status: 'new',
      protocol: { name: 'oip', version: '0.1' },
    });

    await expect(pending).resolves.toMatchObject({ type: 'CONNECTED' });
  });

  it('rejects an advertised unsupported protocol', async () => {
    const { agent, socket, deliver } = agentWithSocket();
    const pending = new Promise((resolve, reject) => {
      agent._connectResolve = resolve;
      agent._connectReject = reject;
    });

    deliver({
      type: 'CONNECTED',
      session_id: 's1',
      status: 'new',
      protocol: { name: 'unsupported', version: '1' },
    });

    await expect(pending).rejects.toThrow(/expected oip\/0\.1/);
    expect(agent.error?.message).toMatch(/Unsupported agent protocol/);
    expect(agent.error).toMatchObject({
      code: 'OIP_UNSUPPORTED_VERSION',
      retryable: false,
    });
    expect(socket.closed).toBe(true);
    expect(agent.connectionState).toBe('disconnected');
  });
});
