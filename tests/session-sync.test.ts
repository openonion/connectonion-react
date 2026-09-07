import { RemoteAgent, SessionSyncError } from '../src/connect/remote-agent';

class FakeSocket {
  readyState = 1;
  sent: string[] = [];
  onmessage: ((event: { data: string }) => void) | null = null;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;

  send(data: unknown) { this.sent.push(String(data)); }
  close() { this.readyState = 3; }
}

const summary = (id: string, revision = 1) => ({
  session_id: id,
  revision,
  title: `Chat ${id}`,
  activity: 'idle',
  created_at: '2026-09-01T00:00:00Z',
  updated_at: '2026-09-01T00:01:00Z',
  last_sequence: 2,
});

function readyAgent() {
  const signer = {
    address: `0x${'a'.repeat(64)}`,
    sign: jest.fn(async () => 'signed'),
  };
  const socket = new FakeSocket();
  const agent = new RemoteAgent(`0x${'b'.repeat(64)}`, { signer }) as any;
  agent._ws = socket;
  agent._authenticated = true;
  agent._sessionSyncSupported = true;
  agent._connectionState = 'connected';
  agent._ensureConnected = jest.fn().mockResolvedValue(undefined);
  const deliver = (frame: object) => agent._handleMessage({ data: JSON.stringify(frame) });
  const nextFrame = async (index = socket.sent.length) => {
    for (let tries = 0; tries < 20 && socket.sent.length <= index; tries++) {
      await Promise.resolve();
    }
    return JSON.parse(socket.sent[index]);
  };
  return { agent, socket, signer, deliver, nextFrame };
}

describe('OIP Session Sync', () => {
  test('CONNECTED explicitly selects the extension', () => {
    const { agent, deliver } = readyAgent();
    agent._sessionSyncSupported = false;
    deliver({
      type: 'CONNECTED',
      session_id: 's1',
      status: 'new',
      protocol: {
        name: 'oip',
        version: '0.1',
        extensions: { 'session-sync': '0.1' },
      },
    });
    expect(agent.sessionSyncSupported).toBe(true);
  });

  test('full sync drains pages and signs each owner-scoped command', async () => {
    const { agent, socket, signer, deliver, nextFrame } = readyAgent();
    const result = agent.syncSessions({ limit: 1 });

    const first = await nextFrame(0);
    expect(first.type).toBe('SESSION_SYNC');
    expect(first.payload.request_id).toBe(first.request_id);
    expect(first.payload.to).toBe(agent.address);
    expect(first.payload.nonce).toBeTruthy();
    expect(first.signature).toBe('signed');
    deliver({
      type: 'SESSION_SYNC_RESULT',
      request_id: first.request_id,
      sessions: [summary('s1')],
      removed_session_ids: [],
      next_page_token: 'page-2',
    });

    const second = await nextFrame(1);
    expect(second.payload.page_token).toBe('page-2');
    deliver({
      type: 'SESSION_SYNC_RESULT',
      request_id: second.request_id,
      sessions: [summary('s2')],
      removed_session_ids: ['expired'],
      cursor: 'cursor-2',
    });

    await expect(result).resolves.toEqual({
      sessions: [summary('s1'), summary('s2')],
      removedSessionIds: ['expired'],
      cursor: 'cursor-2',
    });
    expect(socket.sent).toHaveLength(2);
    expect(signer.sign).toHaveBeenCalledTimes(2);
  });

  test('conditional get preserves not-modified semantics', async () => {
    const { agent, deliver, nextFrame } = readyAgent();
    const result = agent.getSession('s1', { ifRevision: 7 });
    const request = await nextFrame();
    expect(request.payload.if_revision).toBe(7);

    deliver({
      type: 'SESSION_NOT_MODIFIED',
      request_id: request.request_id,
      revision: 7,
    });

    await expect(result).resolves.toEqual({ notModified: true, revision: 7 });
  });

  test('correlated Host errors retain stable code and conflict data', async () => {
    const { agent, deliver, nextFrame } = readyAgent();
    const result = agent.updateSession('s1', { title: 'new' }, 1);
    const request = await nextFrame();
    deliver({
      type: 'ERROR',
      request_id: request.request_id,
      code: 'revision_conflict',
      message: 'session revision changed',
      retryable: false,
      data: { summary: summary('s1', 2) },
    });

    await expect(result).rejects.toMatchObject({
      name: 'SessionSyncError',
      code: 'revision_conflict',
      retryable: false,
      data: { summary: summary('s1', 2) },
    } satisfies Partial<SessionSyncError>);
  });

  test('watch changes are typed and stop locally', async () => {
    const { agent, deliver, nextFrame } = readyAgent();
    const listener = jest.fn();
    const watching = agent.watchSessions('cursor-1', listener);
    const request = await nextFrame();
    deliver({
      type: 'SESSION_WATCHED',
      request_id: request.request_id,
      cursor: 'cursor-1',
    });
    await watching;
    deliver({
      type: 'SESSION_CHANGED',
      sessions: [summary('s1', 2)],
      removed_session_ids: ['old'],
      cursor: 'cursor-2',
    });
    expect(listener).toHaveBeenCalledWith({
      sessions: [summary('s1', 2)],
      removedSessionIds: ['old'],
      cursor: 'cursor-2',
    });

    agent.stopSessionWatch(listener);
    deliver({
      type: 'SESSION_CHANGED',
      sessions: [],
      removed_session_ids: [],
      cursor: 'cursor-3',
    });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  test('a legacy Host fails before any history command is sent', async () => {
    const { agent, socket } = readyAgent();
    agent._sessionSyncSupported = false;

    await expect(agent.syncSessions()).rejects.toMatchObject({
      code: 'unsupported_extension',
    });
    expect(socket.sent).toHaveLength(0);
  });
});
