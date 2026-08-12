import {
  normalizeChatItems,
  normalizeSessionState,
} from '../src/connect/mode-compat';
import { RemoteAgent } from '../src/connect/remote-agent';

describe('previous permission vocabulary compatibility', () => {
  test.each([
    ['safe', ':read-only'],
    ['default', ':read-only'],
    ['accept_edits', ':workspace'],
    ['auto_approve', ':workspace'],
    ['ulw', ':danger-full-access'],
    ['full_access', ':danger-full-access'],
  ])('normalizes session profile %s to %s', (previous, canonical) => {
    const state = previous === 'ulw' || previous === 'full_access'
      ? { mode: previous, ulw_turns: 20, ulw_turns_used: 4 }
      : { mode: previous };
    expect(normalizeSessionState(state)?.mode).toBe(canonical);
  });

  test.each([
    { mode: 'future', full_access_turns: 20, full_access_turns_used: 4 },
    { mode: ':danger-full-access', full_access_turns: 0, full_access_turns_used: 0 },
    { mode: ':danger-full-access', full_access_turns: 20, full_access_turns_used: 20 },
    { mode: ':danger-full-access', full_access_turns: 20.5, full_access_turns_used: 4 },
  ])('fails malformed presentation state closed to Read only', (state) => {
    expect(normalizeSessionState(state)).toEqual({ mode: ':read-only' });
  });

  test('keeps Plan as collaboration state over Read only permission', () => {
    expect(normalizeSessionState({ mode: 'plan' })).toEqual({
      mode: ':read-only',
      collaboration_mode: 'plan',
    });
  });

  test('removes stale Full access counters outside Full access', () => {
    expect(normalizeSessionState({
      mode: ':read-only',
      full_access_turns: 20,
      full_access_turns_used: 4,
    })).toEqual({ mode: ':read-only' });
  });

  test('moves previous Full access fields and drops their old keys', () => {
    expect(normalizeSessionState({
      mode: 'ulw',
      ulw_turns: 20,
      ulw_turns_used: 4,
      ulw_prompt: 'keep going',
    })).toEqual({
      mode: ':danger-full-access',
      full_access_turns: 20,
      full_access_turns_used: 4,
    });
  });

  test('normalizes a previous checkpoint card before exposing it', () => {
    expect(normalizeChatItems([{
      id: 'checkpoint-1',
      type: 'ulw_turns_reached',
      turns_used: 10,
      max_turns: 10,
    }])).toEqual([{
      id: 'checkpoint-1',
      type: 'full_access_checkpoint',
      turns_used: 10,
      max_turns: 10,
    }]);
  });

  test.each(['full_access_checkpoint', 'ulw_turns_reached'])(
    'exposes live %s as a canonical checkpoint card',
    (type) => {
      const agent = new RemoteAgent('0xmode-compat');
      agent._currentSession = { mode: ':danger-full-access' };
      (agent as unknown as {
        _handleMessage: (event: { data: string }) => void;
      })._handleMessage({
        data: JSON.stringify({ type, turns_used: 10, max_turns: 10 }),
      });

      expect(agent.currentSession?.full_access_turns_used).toBe(10);
      expect(agent.ui[agent.ui.length - 1]).toMatchObject({
        type: 'full_access_checkpoint',
        turns_used: 10,
        max_turns: 10,
      });
    },
  );

  test.each(['full_access_checkpoint', 'ulw_turns_reached'])(
    'drops malformed persisted %s cards',
    (type) => {
      expect(normalizeChatItems([{
        id: 'bad-checkpoint',
        type,
        turns_used: -1,
        max_turns: 0,
      }])).toEqual([]);
    },
  );
});
