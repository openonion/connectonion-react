import { RemoteAgent } from '../src/connect/remote-agent';
import {
  decodeACPModeUpdate,
  parseServerApprovalMode,
} from '../src/connect/wire-events';

const SESSION_ID = 'session-mode-20';

function modeFrame(
  mode: unknown,
  sessionId: unknown = SESSION_ID,
): Record<string, unknown> {
  return {
    type: 'ACP_NOTIFICATION',
    acpSchema: 'schema-v1.19.0',
    message: {
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId,
        update: {
          sessionUpdate: 'current_mode_update',
          currentModeId: mode,
        },
      },
    },
  };
}

function deliver(agent: RemoteAgent, frame: Record<string, unknown>): void {
  (agent as unknown as {
    _handleMessage: (event: { data: string }) => void;
  })._handleMessage({ data: JSON.stringify(frame) });
}

describe('ACP current_mode_update decoding', () => {
  it.each([':read-only', ':workspace', ':danger-full-access'] as const)(
    'accepts the persisted server mode %s',
    (mode) => {
      expect(decodeACPModeUpdate(modeFrame(mode))).toEqual({
        sessionId: SESSION_ID,
        mode,
      });
    },
  );

  it.each([
    ['safe', ':read-only'],
    ['accept_edits', ':workspace'],
    ['ulw', ':danger-full-access'],
  ] as const)('normalizes the previous mode %s to %s', (previous, canonical) => {
    expect(decodeACPModeUpdate(modeFrame(previous))).toEqual({
      sessionId: SESSION_ID,
      mode: canonical,
    });
  });

  it.each([
    ['legacy plan alias', modeFrame('plan')],
    ['unknown mode', modeFrame('future')],
    ['empty mode', modeFrame('')],
    ['missing session', modeFrame(':read-only', '')],
    ['null frame', null],
    ['array frame', []],
    ['wrong schema', { ...modeFrame(':read-only'), acpSchema: 'schema-v1.20.0' }],
    ['wrong method', {
      ...modeFrame(':read-only'),
      message: { jsonrpc: '2.0', method: 'session/mode', params: {} },
    }],
  ])('rejects %s', (_name, frame) => {
    expect(decodeACPModeUpdate(frame)).toBeNull();
  });

  it('uses the same known-mode predicate for legacy frames', () => {
    expect(parseServerApprovalMode(':read-only')).toBe(':read-only');
    expect(parseServerApprovalMode('safe')).toBe(':read-only');
    expect(parseServerApprovalMode('plan')).toBeNull();
    expect(parseServerApprovalMode('future')).toBeNull();
    expect(parseServerApprovalMode({ mode: ':danger-full-access' })).toBeNull();
  });
});

describe('RemoteAgent authoritative permission profile state', () => {
  function agent(): RemoteAgent {
    const remote = new RemoteAgent('0xmode');
    remote._currentSession = {
      session_id: SESSION_ID,
      mode: ':read-only',
      turn: 7,
    };
    return remote;
  }

  it('updates the public mode while preserving the session snapshot', () => {
    const remote = agent();

    deliver(remote, modeFrame(':workspace'));

    expect(remote.permissionProfile).toBe(':workspace');
    expect(remote.currentSession).toMatchObject({
      session_id: SESSION_ID,
      mode: ':workspace',
      turn: 7,
    });
  });

  it('clears stale Full access counters when authority returns to Read only', () => {
    const remote = agent();
    remote._currentSession = {
      ...remote._currentSession,
      mode: ':danger-full-access',
      full_access_turns: 10,
      full_access_turns_used: 4,
    };

    deliver(remote, modeFrame(':read-only'));

    expect(remote.currentSession).toMatchObject({ mode: ':read-only' });
    expect(remote.currentSession?.full_access_turns).toBeUndefined();
    expect(remote.currentSession?.full_access_turns_used).toBeUndefined();
  });

  it('cleans stale counters even when the authoritative mode is unchanged', () => {
    const remote = agent();
    remote._currentSession = {
      ...remote._currentSession,
      full_access_turns: 10,
      full_access_turns_used: 4,
    };

    deliver(remote, modeFrame(':read-only'));

    expect(remote.currentSession?.full_access_turns).toBeUndefined();
    expect(remote.currentSession?.full_access_turns_used).toBeUndefined();
  });

  it('ignores a valid update owned by another session', () => {
    const remote = agent();

    deliver(remote, modeFrame(':danger-full-access', 'another-session'));

    expect(remote.permissionProfile).toBe(':read-only');
  });

  it('deduplicates the ACP and legacy representations', () => {
    const remote = agent();
    const onMessage = jest.fn();
    remote.onMessage = onMessage;

    deliver(remote, modeFrame(':danger-full-access'));
    deliver(remote, { type: 'mode_changed', mode: ':danger-full-access' });

    expect(remote.permissionProfile).toBe(':danger-full-access');
    expect(onMessage).toHaveBeenCalledTimes(1);
  });

  it('still accepts a valid legacy-only Host update', () => {
    const remote = agent();

    deliver(remote, { type: 'mode_changed', mode: ':workspace' });

    expect(remote.permissionProfile).toBe(':workspace');
  });

  it.each(['plan', 'future', '', null])(
    'does not let malformed legacy output set mode %p',
    (mode) => {
      const remote = agent();

      deliver(remote, { type: 'mode_changed', mode });

      expect(remote.permissionProfile).toBe(':read-only');
    },
  );
});
