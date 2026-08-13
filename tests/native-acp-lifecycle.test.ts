import * as address from '../src/address-browser';
import { RemoteAgent } from '../src/connect/remote-agent';
import {
  registerNativeACPDriver,
  type NativeACPConnection,
  type NativeACPDriver,
  type NativeACPDriverHandlers,
} from '../src/connect/native-acp-runtime';
import type { ACPWebSocketTransport } from '../src/connect/native-acp';
import { ACPBrowserAdmissionError } from '../src/connect/native-acp';

const AGENT = `0x${'a'.repeat(64)}`;
const TRANSPORT: ACPWebSocketTransport = {
  protocol_version: 1,
  type: 'websocket',
  path: '/acp',
  authorization: { type: 'connectonion-ticket', path: '/acp/authorize' },
};

function discovery(onboard?: { invite_code: boolean; payment: number | null }): Response {
  return new Response(JSON.stringify({
    address: AGENT,
    transports: { acp: TRANSPORT },
    ...(onboard ? { onboard } : {}),
  }), {
    headers: {
      'content-type': 'application/json',
      'cache-control': 'no-store',
    },
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function harness(overrides: Partial<NativeACPConnection> = {}) {
  let handlers!: NativeACPDriverHandlers;
  const calls = {
    opens: 0,
    newSession: [] as unknown[],
    resumes: [] as unknown[],
    prompts: [] as unknown[],
    modes: [] as unknown[],
    cancels: [] as unknown[],
    closes: [] as unknown[],
    connectionClose: 0,
  };
  const connection: NativeACPConnection = {
    protocolVersion: 1,
    agentCapabilities: {
      promptCapabilities: { image: true, embeddedContext: true },
      sessionCapabilities: { resume: {}, close: {} },
    },
    agentInfo: { name: 'Native Agent', version: '1.7.0' },
    async newSession(request) {
      calls.newSession.push(request);
      return {
        sessionId: 'server-session-1',
        modes: {
          currentModeId: ':read-only',
          availableModes: [
            { id: ':read-only', name: 'Read only' },
            { id: ':workspace', name: 'Auto' },
          ],
        },
      };
    },
    async resumeSession(request) {
      calls.resumes.push(request);
      return {
        modes: {
          currentModeId: ':read-only',
          availableModes: [{ id: ':read-only', name: 'Read only' }],
        },
      };
    },
    async prompt(request) {
      calls.prompts.push(request);
      handlers.onSessionUpdate(request.sessionId, {
        sessionUpdate: 'agent_message_chunk',
        messageId: 'answer-1',
        content: { type: 'text', text: 'Native ' },
      });
      handlers.onSessionUpdate(request.sessionId, {
        sessionUpdate: 'agent_message_chunk',
        messageId: 'answer-1',
        content: { type: 'text', text: 'answer' },
      });
      return { stopReason: 'end_turn' };
    },
    async setSessionMode(request) { calls.modes.push(request); },
    async cancel(request) { calls.cancels.push(request); },
    async closeSession(request) { calls.closes.push(request); },
    close() { calls.connectionClose += 1; },
    ...overrides,
  };
  const driver: NativeACPDriver = {
    async open(_options, nextHandlers) {
      calls.opens += 1;
      handlers = nextHandlers;
      return connection;
    },
  };
  return {
    driver,
    connection,
    calls,
    get handlers() { return handlers; },
    setHandlers(next: NativeACPDriverHandlers) { handlers = next; },
  };
}

function agent() {
  const openedLegacy: string[] = [];
  class NeverLegacyWebSocket {
    onopen = null;
    onmessage = null;
    onerror = null;
    onclose = null;
    constructor(url: string) { openedLegacy.push(url); }
    send() {}
    close() {}
  }
  const remote = new RemoteAgent(AGENT, {
    directUrl: 'https://agent.example',
    keys: address.generateBrowser(),
    wsCtor: NeverLegacyWebSocket,
  });
  (remote as any)._currentSession = { session_id: 'ui-route-session' };
  return { remote, openedLegacy };
}

beforeEach(() => {
  globalThis.fetch = jest.fn(async () => discovery()) as unknown as typeof fetch;
});

afterEach(() => {
  registerNativeACPDriver(null);
  jest.restoreAllMocks();
});

describe('native ACP RemoteAgent lifecycle', () => {
  test('creates one native session with the virtual network workspace and never opens legacy /ws', async () => {
    const native = harness();
    registerNativeACPDriver(native.driver);
    const { remote, openedLegacy } = agent();

    const response = await remote.input('Hello', {
      images: ['data:image/png;base64,aGVsbG8='],
      files: [{
        name: 'notes.txt',
        type: 'text/plain',
        size: 5,
        dataUrl: 'data:text/plain;base64,aGVsbG8=',
      }],
    });

    expect(openedLegacy).toEqual([]);
    expect(native.calls.newSession).toEqual([{ cwd: '/', mcpServers: [] }]);
    expect(remote.currentSession).toMatchObject({
      session_id: 'ui-route-session',
      acp_session_id: 'server-session-1',
      mode: ':read-only',
    });
    expect(native.calls.prompts).toEqual([{
      sessionId: 'server-session-1',
      prompt: [
        { type: 'text', text: 'Hello' },
        { type: 'image', mimeType: 'image/png', data: 'aGVsbG8=' },
        {
          type: 'resource',
          resource: {
            uri: 'connectonion-upload:/notes.txt',
            mimeType: 'text/plain',
            blob: 'aGVsbG8=',
          },
        },
      ],
    }]);
    expect(response).toEqual({ text: 'Native answer', done: true });
    expect(remote.ui).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'agent', id: 'answer-1', content: 'Native answer' }),
    ]));
  });

  test('resumes the server-issued ACP ID without replaying or replacing persisted ChatItems', async () => {
    const native = harness();
    registerNativeACPDriver(native.driver);
    const { remote } = agent();
    (remote as any)._currentSession.acp_session_id = 'durable-acp-session';
    (remote as any)._chatItems = [{ id: 'old', type: 'agent', content: 'Persisted' }];

    await remote.reconnect('ui-route-session');

    expect(native.calls.newSession).toEqual([]);
    expect(native.calls.resumes).toEqual([{
      sessionId: 'durable-acp-session',
      cwd: '/',
      mcpServers: [],
    }]);
    expect(remote.ui).toEqual([{ id: 'old', type: 'agent', content: 'Persisted' }]);
  });

  test('pauses the first prompt for native onboarding and resumes it exactly once', async () => {
    globalThis.fetch = jest.fn(async () => discovery({
      invite_code: true,
      payment: 5,
    })) as unknown as typeof fetch;
    const firstAdmission = deferred<void>();
    const native = harness();
    const admissions: unknown[] = [];
    registerNativeACPDriver({
      async open(options, handlers) {
        admissions.push(options.admission);
        if (!options.admission) {
          firstAdmission.resolve();
          throw new ACPBrowserAdmissionError(403, 'trust');
        }
        native.setHandlers(handlers);
        return native.connection;
      },
    });
    const { remote, openedLegacy } = agent();

    const turn = remote.input('Do not lose this');
    await firstAdmission.promise;
    await Promise.resolve();

    expect(remote.status).toBe('waiting');
    expect(remote.ui).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'onboard_required',
        methods: ['invite_code', 'payment'],
        paymentAmount: 5,
        paymentAddress: AGENT,
      }),
    ]));

    remote.send(remote.signOnboard({ inviteCode: 'BETA' }));
    const response = await turn;

    expect(admissions).toEqual([undefined, { inviteCode: 'BETA', payment: undefined }]);
    expect(native.calls.prompts).toHaveLength(1);
    expect(native.calls.prompts[0]).toMatchObject({
      prompt: [{ type: 'text', text: 'Do not lose this' }],
    });
    expect(response).toEqual({ text: 'Native answer', done: true });
    expect(openedLegacy).toEqual([]);
  });

  test('keeps one native onboarding gate retryable after a refused invite', async () => {
    globalThis.fetch = jest.fn(async () => discovery({
      invite_code: true,
      payment: null,
    })) as unknown as typeof fetch;
    const firstAdmission = deferred<void>();
    const refusedAdmission = deferred<void>();
    const native = harness();
    registerNativeACPDriver({
      async open(options, handlers) {
        if (options.admission?.inviteCode !== 'BETA') {
          if (options.admission) refusedAdmission.resolve();
          else firstAdmission.resolve();
          throw new ACPBrowserAdmissionError(403, 'trust');
        }
        native.setHandlers(handlers);
        return native.connection;
      },
    });
    const { remote } = agent();

    const turn = remote.input('Run after admission');
    await firstAdmission.promise;
    await Promise.resolve();
    remote.send(remote.signOnboard({ inviteCode: 'WRONG' }));
    await refusedAdmission.promise;
    await Promise.resolve();

    expect(remote.status).toBe('waiting');
    expect(remote.error?.message).toContain('admission refused');
    expect(remote.ui.filter((item) => item.type === 'onboard_required')).toHaveLength(1);

    remote.send(remote.signOnboard({ inviteCode: 'BETA' }));
    await expect(turn).resolves.toEqual({ text: 'Native answer', done: true });
    expect(native.calls.prompts).toHaveLength(1);
    expect(remote.ui.filter((item) => item.type === 'onboard_success')).toHaveLength(1);
  });

  test('reset cancels a native onboarding waiter without reviving stale state', async () => {
    globalThis.fetch = jest.fn(async () => discovery({
      invite_code: true,
      payment: null,
    })) as unknown as typeof fetch;
    const firstAdmission = deferred<void>();
    registerNativeACPDriver({
      async open() {
        firstAdmission.resolve();
        throw new ACPBrowserAdmissionError(403, 'trust');
      },
    });
    const { remote } = agent();

    const turn = remote.input('Cancel this pending turn');
    await firstAdmission.promise;
    await Promise.resolve();
    remote.reset();

    await expect(turn).rejects.toThrow('Connection reset');
    expect(remote.status).toBe('idle');
    expect(remote.error).toBeNull();
    expect(remote.currentSession).toBeNull();
    expect(remote.ui).toEqual([]);
  });

  test('reset immediately rejects an in-flight native prompt without reviving reset state', async () => {
    const prompt = deferred<{ stopReason: string }>();
    const promptStarted = deferred<void>();
    const native = harness({
      async prompt() {
        promptStarted.resolve();
        return prompt.promise;
      },
    });
    registerNativeACPDriver(native.driver);
    const { remote } = agent();

    const turn = remote.input('Keep running');
    await promptStarted.promise;
    remote.reset();

    await expect(turn).rejects.toThrow('Connection reset');
    expect(remote.status).toBe('idle');
    expect(remote.error).toBeNull();
    expect(remote.currentSession).toBeNull();
    expect(remote.ui).toEqual([]);
  });

  test('rejects a concurrent native prompt before it mutates chat state', async () => {
    const prompt = deferred<{ stopReason: string }>();
    const promptStarted = deferred<void>();
    const native = harness({
      async prompt() {
        promptStarted.resolve();
        return prompt.promise;
      },
    });
    registerNativeACPDriver(native.driver);
    const { remote } = agent();

    const first = remote.input('First');
    await promptStarted.promise;
    const before = remote.ui.map((item) => ({ ...item }));

    await expect(remote.input('Second')).rejects.toThrow(
      'Native ACP session is already processing a prompt',
    );
    expect(remote.ui).toEqual(before);
    expect(remote.status).toBe('working');

    prompt.resolve({ stopReason: 'end_turn' });
    await expect(first).resolves.toEqual({ text: '', done: true });
  });

  test('native quota or prompt failure is terminal and cannot open legacy transport', async () => {
    const native = harness({
      async newSession() { throw new Error('ACP durable session quota exceeded'); },
    });
    registerNativeACPDriver(native.driver);
    const { remote, openedLegacy } = agent();

    await expect(remote.input('Hello')).rejects.toThrow('quota exceeded');
    expect(openedLegacy).toEqual([]);
    expect(native.calls.opens).toBe(1);
    expect(remote.status).toBe('idle');
  });

  test('correlates one permission reply and does not also send cancellation', async () => {
    const permissionStarted = deferred<void>();
    const native = harness({
      async prompt(request) {
        const response = native.handlers.requestPermission({
          requestId: 'permission-1',
          sessionId: request.sessionId,
          toolCall: {
            toolCallId: 'tool-1',
            title: 'Write file',
            rawInput: { path: 'README.md' },
            status: 'pending',
          },
          options: [
            { optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' },
            { optionId: 'reject_once', name: 'Reject', kind: 'reject_once' },
          ],
        });
        permissionStarted.resolve();
        expect(await response).toEqual({
          outcome: { outcome: 'selected', optionId: 'allow_once' },
        });
        return { stopReason: 'end_turn' };
      },
    });
    registerNativeACPDriver(native.driver);
    const { remote } = agent();

    const turn = remote.input('Edit it');
    await permissionStarted.promise;
    expect(remote.status).toBe('waiting');
    expect(remote.ui).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'tool-1',
        type: 'tool_call',
        name: 'Write file',
        args: { path: 'README.md' },
        status: 'running',
      }),
      expect.objectContaining({
        id: 'permission-1',
        type: 'approval_needed',
        tool: 'Write file',
      }),
    ]));
    expect(remote.ui.filter((item) => item.id === 'tool-1')).toHaveLength(1);
    remote.respondToApproval(true, 'once');
    remote.respondToApproval(true, 'once');
    await turn;

    expect(native.calls.cancels).toEqual([]);
    expect(remote.ui).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'tool-1', type: 'tool_call', status: 'error' }),
      expect.objectContaining({ id: 'permission-1', type: 'approval_needed', answered: true }),
    ]));
  });

  test('preserves the Host terminal status for a permission tool', async () => {
    const permissionStarted = deferred<void>();
    const native = harness({
      async prompt(request) {
        const response = native.handlers.requestPermission({
          requestId: 'permission-1',
          sessionId: request.sessionId,
          toolCall: {
            toolCallId: 'tool-1',
            title: 'Write file',
            rawInput: { path: 'README.md' },
            status: 'pending',
          },
          options: [
            { optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' },
            { optionId: 'reject_once', name: 'Reject', kind: 'reject_once' },
          ],
        });
        permissionStarted.resolve();
        await response;
        native.handlers.onSessionUpdate(request.sessionId, {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'tool-1',
          status: 'completed',
        });
        return { stopReason: 'end_turn' };
      },
    });
    registerNativeACPDriver(native.driver);
    const { remote } = agent();

    const turn = remote.input('Edit it');
    await permissionStarted.promise;
    remote.respondToApproval(true, 'once');
    await turn;

    expect(remote.ui).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'tool-1', type: 'tool_call', status: 'done' }),
      expect.objectContaining({ id: 'permission-1', type: 'approval_needed', answered: true }),
    ]));
  });

  test('settles every unanswered-terminal tool when one prompt requests permission repeatedly', async () => {
    const firstStarted = deferred<void>();
    const secondStarted = deferred<void>();
    const options = [
      { optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' },
      { optionId: 'reject_once', name: 'Reject', kind: 'reject_once' },
    ];
    const native = harness({
      async prompt(request) {
        const first = native.handlers.requestPermission({
          requestId: 'permission-1',
          sessionId: request.sessionId,
          toolCall: {
            toolCallId: 'tool-1',
            title: 'Write first file',
            status: 'pending',
          },
          options,
        });
        firstStarted.resolve();
        await first;
        const second = native.handlers.requestPermission({
          requestId: 'permission-2',
          sessionId: request.sessionId,
          toolCall: {
            toolCallId: 'tool-2',
            title: 'Write second file',
            status: 'pending',
          },
          options,
        });
        secondStarted.resolve();
        await second;
        return { stopReason: 'cancelled' };
      },
    });
    registerNativeACPDriver(native.driver);
    const { remote } = agent();

    const turn = remote.input('Edit twice');
    await firstStarted.promise;
    remote.respondToApproval(true, 'once');
    await secondStarted.promise;
    remote.respondToApproval(false, 'once', 'reject_hard');
    await expect(turn).resolves.toEqual({ text: '', done: false });

    expect(remote.ui).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'tool-1', type: 'tool_call', status: 'error' }),
      expect.objectContaining({ id: 'tool-2', type: 'tool_call', status: 'error' }),
      expect.objectContaining({ id: 'permission-1', type: 'approval_needed', answered: true }),
      expect.objectContaining({ id: 'permission-2', type: 'approval_needed', answered: true }),
    ]));
  });

  test('settles a permission tool when the native prompt fails', async () => {
    const permissionStarted = deferred<void>();
    const native = harness({
      async prompt(request) {
        const response = native.handlers.requestPermission({
          requestId: 'permission-1',
          sessionId: request.sessionId,
          toolCall: {
            toolCallId: 'tool-1',
            title: 'Write file',
            status: 'pending',
          },
          options: [
            { optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' },
          ],
        });
        permissionStarted.resolve();
        await response;
        throw new Error('tool failed');
      },
    });
    registerNativeACPDriver(native.driver);
    const { remote } = agent();

    const turn = remote.input('Edit it');
    await permissionStarted.promise;
    remote.respondToApproval(true, 'once');
    await expect(turn).rejects.toThrow('tool failed');

    expect(remote.ui).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'tool-1', type: 'tool_call', status: 'error' }),
      expect.objectContaining({ id: 'permission-1', type: 'approval_needed', answered: true }),
    ]));
  });

  test('awaits acknowledged mode change and closes the runtime without deleting its durable ID', async () => {
    const native = harness();
    registerNativeACPDriver(native.driver);
    const { remote } = agent();
    await remote.connect();

    await remote.setPermissionProfile(':workspace');
    expect(native.calls.modes).toEqual([{
      sessionId: 'server-session-1',
      modeId: ':workspace',
    }]);
    expect(remote.permissionProfile).toBe(':workspace');

    const durable = remote.currentSession?.acp_session_id;
    remote.reset();
    await Promise.resolve();
    expect(native.calls.closes).toEqual([{ sessionId: durable }]);
  });
});
