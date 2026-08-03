/**
 * A trust denial arrives during CONNECT, and someone has to hear it.
 *
 * An agent with `default: deny` — which is what `strict` ships, and the correct
 * posture for one holding customer data — refuses an unknown client and the host
 * says so plainly:
 *
 *     {"type": "ERROR", "message": "forbidden: no matching allow condition"}
 *
 * The ERROR branch rejected the in-flight `input()`. During CONNECT there is no
 * in-flight input; there is an in-flight connect, and it was left hanging until
 * its own 30-second timeout — by which point the reason had been dropped and the
 * caller got a generic timeout instead.
 *
 * So the failure mode of every correctly configured production agent, the first
 * time a new client connects, was a page that sits there and then says the
 * connection timed out. #434.
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
}

function connecting() {
  const agent = new RemoteAgent('0x' + 'a'.repeat(64), {}) as any;
  agent._ws = new FakeSocket();
  const pending = new Promise((resolve, reject) => {
    agent._connectResolve = resolve;
    agent._connectReject = reject;
  });
  const deliver = (frame: object) => agent._handleMessage({ data: JSON.stringify(frame) });
  return { agent, pending, deliver };
}

describe('an ERROR during CONNECT', () => {
  it('rejects the connect instead of leaving it to time out', async () => {
    const { pending, deliver } = connecting();

    deliver({ type: 'ERROR', message: 'forbidden: no matching allow condition' });

    await expect(pending).rejects.toThrow(/forbidden/);
  });

  it('carries the reason, not a generic failure', async () => {
    const { pending, deliver } = connecting();

    deliver({ type: 'ERROR', message: 'forbidden: client is blocked' });

    await expect(pending).rejects.toThrow(/client is blocked/);
  });

  it('cancels the connect deadline', async () => {
    const { agent, pending, deliver } = connecting();
    agent._connectTimer = setTimeout(() => {}, 30_000);

    deliver({ type: 'ERROR', message: 'forbidden: nope' });
    await expect(pending).rejects.toThrow();

    expect(agent._connectTimer).toBeNull();
  });

  it('leaves the socket open, as the onboarding retry needs', () => {
    const { agent, pending, deliver } = connecting();
    pending.catch(() => {});

    deliver({ type: 'ERROR', message: 'Invalid invite code' });

    expect(agent._ws.closed).toBe(false);
  });

  it('still rejects an in-flight input when there is one', async () => {
    const agent = new RemoteAgent('0x' + 'a'.repeat(64), {}) as any;
    agent._ws = new FakeSocket();
    const input = new Promise((_, reject) => { agent._inputReject = reject; });

    agent._handleMessage({ data: JSON.stringify({ type: 'ERROR', message: 'boom' }) });

    await expect(input).rejects.toThrow(/boom/);
  });
});

describe('an ERROR while a human is onboarding', () => {
  /**
   * The distinction the fix above has to make.
   *
   * ONBOARD_REQUIRED deliberately leaves the connect promise pending — the host
   * keeps the interrupted CONNECT stashed and finishes it after a successful
   * code, so there is no client retry to resolve anything else. A wrong code
   * also arrives as ERROR, and rejecting the connect there would strand the
   * retry exactly as it did before 0.3.1: the button sits on "Checking…"
   * forever and reloading is the only way out.
   *
   * Invite codes are hyphenated strings typed by hand on phones. A first-try
   * miss is ordinary, not an error path.
   */
  function onboarding() {
    const agent = new RemoteAgent('0x' + 'a'.repeat(64), {}) as any;
    agent._ws = new FakeSocket();
    let settled = false;
    const pending = new Promise((resolve, reject) => {
      agent._connectResolve = (v: unknown) => { settled = true; resolve(v); };
      agent._connectReject = (e: unknown) => { settled = true; reject(e); };
    });
    pending.catch(() => {});
    const deliver = (frame: object) => agent._handleMessage({ data: JSON.stringify(frame) });
    deliver({ type: 'ONBOARD_REQUIRED', identity: '0xabc', methods: ['invite_code'] });
    return { agent, deliver, settled: () => settled };
  }

  it('leaves the connect pending, so the retry has something to resolve', () => {
    const { deliver, settled } = onboarding();

    deliver({ type: 'ERROR', message: 'Invalid invite code' });

    expect(settled()).toBe(false);
  });

  it('and the right code on the second try still connects', async () => {
    const { agent, deliver } = onboarding();
    const resolved = new Promise((resolve) => { agent._connectResolve = resolve; });

    deliver({ type: 'ERROR', message: 'Invalid invite code' });
    deliver({ type: 'CONNECTED', session_id: 's1', status: 'new' });

    await expect(resolved).resolves.toBeDefined();
  });
});
