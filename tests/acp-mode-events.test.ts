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
  it.each(['default', 'auto_approve', 'full_access'] as const)(
    'accepts the persisted server mode %s',
    (mode) => {
      expect(decodeACPModeUpdate(modeFrame(mode))).toEqual({
        sessionId: SESSION_ID,
        mode,
      });
    },
  );

  it.each([
    ['safe', 'default'],
    ['accept_edits', 'auto_approve'],
    ['ulw', 'full_access'],
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
    ['missing session', modeFrame('default', '')],
    ['null frame', null],
    ['array frame', []],
    ['wrong schema', { ...modeFrame('default'), acpSchema: 'schema-v1.20.0' }],
    ['wrong method', {
      ...modeFrame('default'),
      message: { jsonrpc: '2.0', method: 'session/mode', params: {} },
    }],
  ])('rejects %s', (_name, frame) => {
    expect(decodeACPModeUpdate(frame)).toBeNull();
  });

  it('uses the same known-mode predicate for legacy frames', () => {
    expect(parseServerApprovalMode('default')).toBe('default');
    expect(parseServerApprovalMode('safe')).toBe('default');
    expect(parseServerApprovalMode('plan')).toBeNull();
    expect(parseServerApprovalMode('future')).toBeNull();
    expect(parseServerApprovalMode({ mode: 'full_access' })).toBeNull();
  });
});

describe('RemoteAgent authoritative mode state', () => {
  function agent(): RemoteAgent {
    const remote = new RemoteAgent('0xmode');
    remote._currentSession = {
      session_id: SESSION_ID,
      mode: 'default',
      turn: 7,
    };
    return remote;
  }

  it('updates the public mode while preserving the session snapshot', () => {
    const remote = agent();

    deliver(remote, modeFrame('auto_approve'));

    expect(remote.mode).toBe('auto_approve');
    expect(remote.currentSession).toMatchObject({
      session_id: SESSION_ID,
      mode: 'auto_approve',
      turn: 7,
    });
  });

  it('ignores a valid update owned by another session', () => {
    const remote = agent();

    deliver(remote, modeFrame('full_access', 'another-session'));

    expect(remote.mode).toBe('default');
  });

  it('deduplicates the ACP and legacy representations', () => {
    const remote = agent();
    const onMessage = jest.fn();
    remote.onMessage = onMessage;

    deliver(remote, modeFrame('full_access'));
    deliver(remote, { type: 'mode_changed', mode: 'full_access' });

    expect(remote.mode).toBe('full_access');
    expect(onMessage).toHaveBeenCalledTimes(1);
  });

  it('still accepts a valid legacy-only Host update', () => {
    const remote = agent();

    deliver(remote, { type: 'mode_changed', mode: 'auto_approve' });

    expect(remote.mode).toBe('auto_approve');
  });

  it.each(['plan', 'future', '', null])(
    'does not let malformed legacy output set mode %p',
    (mode) => {
      const remote = agent();

      deliver(remote, { type: 'mode_changed', mode });

      expect(remote.mode).toBe('default');
    },
  );
});
