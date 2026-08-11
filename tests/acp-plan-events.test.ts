import { RemoteAgent } from '../src/connect/remote-agent';
import type { PlanEntry } from '../src/connect/types';
import {
  decodeACPPlanUpdate,
  decodeLegacyPlanUpdate,
  normalizePlanEntries,
} from '../src/connect/wire-events';
import fixture from './fixtures/acp_plan_events.json';

const expected: PlanEntry[] = [
  { content: 'Inspect the current behavior', priority: 'high', status: 'completed' },
  { content: 'Implement the compatible reader', priority: 'high', status: 'in_progress' },
  { content: 'Verify the integration', priority: 'medium', status: 'pending' },
];

function deliver(agent: RemoteAgent, frame: Record<string, unknown>): void {
  (agent as unknown as {
    _handleMessage: (event: { data: string }) => void;
  })._handleMessage({ data: JSON.stringify(frame) });
}

function activeAgent(): RemoteAgent {
  const agent = new RemoteAgent('0xplan');
  agent._currentSession = { session_id: 'session-1', turn: 4 };
  return agent;
}

describe('stable ACP plan decoding', () => {
  it('normalizes ACP and legacy twins to one detached snapshot', () => {
    expect(decodeACPPlanUpdate(fixture.acp[0])).toEqual({
      sessionId: 'session-1',
      entries: expected,
    });
    expect(decodeLegacyPlanUpdate(fixture.legacy[0])).toEqual({
      sessionId: 'session-1',
      entries: expected,
    });

    const source = structuredClone(fixture.acp[0]);
    const decoded = decodeACPPlanUpdate(source)!;
    (source.message.params.update.entries[0] as { content: string }).content = 'mutated';
    expect(decoded.entries).toEqual(expected);
  });

  it('accepts an explicit empty replacement', () => {
    expect(normalizePlanEntries([])).toEqual([]);
  });

  it.each([
    ['not an array', null],
    ['mixed invalid entries', [...expected, { content: 'Bad', priority: 'urgent', status: 'pending' }]],
    ['missing content', [{ priority: 'high', status: 'pending' }]],
    ['empty content', [{ content: '', priority: 'high', status: 'pending' }]],
    ['unknown priority', [{ content: 'Task', priority: 'urgent', status: 'pending' }]],
    ['unknown status', [{ content: 'Task', priority: 'high', status: 'cancelled' }]],
  ])('rejects %s atomically', (_name, entries) => {
    expect(normalizePlanEntries(entries)).toBeNull();
  });

  it.each([
    ['wrong schema', (frame: any) => { frame.acpSchema = 'schema-v1.20.0'; }],
    ['wrong method', (frame: any) => { frame.message.method = 'session/plan'; }],
    ['missing session', (frame: any) => { frame.message.params.sessionId = ''; }],
    ['experimental update', (frame: any) => { frame.message.params.update.sessionUpdate = 'plan_update'; }],
    ['experimental removal', (frame: any) => { frame.message.params.update.sessionUpdate = 'plan_removed'; }],
    ['malformed entry', (frame: any) => { frame.message.params.update.entries[1].status = 'blocked'; }],
  ])('rejects %s', (_name, mutate) => {
    const frame = structuredClone(fixture.acp[0]);
    mutate(frame);
    expect(decodeACPPlanUpdate(frame)).toBeNull();
  });
});

describe('RemoteAgent plan session state', () => {
  it('replaces the plan without creating a ChatItem or changing lifecycle state', () => {
    const agent = activeAgent();
    const onMessage = jest.fn();
    agent.onMessage = onMessage;

    deliver(agent, fixture.acp[0] as Record<string, unknown>);

    expect(agent.plan).toEqual(expected);
    expect(agent.ui).toEqual([]);
    expect(agent.status).toBe('idle');
    expect(agent.currentSession).toMatchObject({ session_id: 'session-1', turn: 4 });
    expect(onMessage).toHaveBeenCalledTimes(1);
  });

  it('deduplicates rolling ACP/legacy twins by value', () => {
    const agent = activeAgent();
    const onMessage = jest.fn();
    agent.onMessage = onMessage;

    deliver(agent, fixture.acp[0] as Record<string, unknown>);
    deliver(agent, fixture.legacy[0] as Record<string, unknown>);
    deliver(agent, fixture.acp[0] as Record<string, unknown>);

    expect(agent.plan).toEqual(expected);
    expect(onMessage).toHaveBeenCalledTimes(1);
  });

  it('returns detached readonly observations', () => {
    const agent = activeAgent();
    deliver(agent, fixture.acp[0] as Record<string, unknown>);

    const observation = agent.plan as PlanEntry[];
    observation[0] = { content: 'Mutated', priority: 'low', status: 'pending' };

    expect(agent.plan).toEqual(expected);
  });

  it('uses an empty list to clear the current plan', () => {
    const agent = activeAgent();
    deliver(agent, fixture.acp[0] as Record<string, unknown>);
    const clear = structuredClone(fixture.acp[0]) as any;
    clear.message.params.update.entries = [];

    deliver(agent, clear);

    expect(agent.plan).toEqual([]);
  });

  it('ignores another session and preserves the last valid plan after malformed input', () => {
    const agent = activeAgent();
    deliver(agent, fixture.acp[0] as Record<string, unknown>);
    const foreign = structuredClone(fixture.acp[0]) as any;
    foreign.message.params.sessionId = 'session-2';
    const malformed = structuredClone(fixture.acp[0]) as any;
    malformed.message.params.update.entries[0].priority = 'urgent';

    deliver(agent, foreign);
    deliver(agent, malformed);

    expect(agent.plan).toEqual(expected);
  });

  it('normalizes snapshots and preserves valid plan state across rolling old Hosts', () => {
    const agent = activeAgent();
    deliver(agent, fixture.acp[0] as Record<string, unknown>);

    deliver(agent, {
      type: 'session_sync',
      session: { session_id: 'session-1', turn: 5 },
    });
    expect(agent.plan).toEqual(expected);

    deliver(agent, {
      type: 'session_sync',
      session: {
        session_id: 'session-1',
        turn: 6,
        plan: [{ content: 'Corrupt', priority: 'urgent', status: 'pending' }],
      },
    });
    expect(agent.plan).toEqual(expected);
    expect(agent.currentSession?.turn).toBe(6);

    deliver(agent, {
      type: 'session_sync',
      session: { session_id: 'session-1', plan: [] },
    });
    expect(agent.plan).toEqual([]);
  });

  it('never carries a plan across a session boundary', () => {
    const agent = activeAgent();
    deliver(agent, fixture.acp[0] as Record<string, unknown>);

    deliver(agent, {
      type: 'session_sync',
      session: { session_id: 'session-2', turn: 1 },
    });

    expect(agent.currentSession?.session_id).toBe('session-2');
    expect(agent.plan).toEqual([]);
  });

  it('preserves the plan through a same-session reconnect snapshot', () => {
    const agent = activeAgent();
    deliver(agent, fixture.acp[0] as Record<string, unknown>);

    deliver(agent, {
      type: 'CONNECTED',
      status: 'connected',
      server_newer: true,
      session_id: 'session-1',
      session: { session_id: 'session-1', turn: 8 },
    });

    expect(agent.plan).toEqual(expected);
    expect(agent.currentSession?.turn).toBe(8);
  });

  it('keeps interactive plan_review independent from observational plan state', () => {
    const agent = activeAgent();
    deliver(agent, fixture.acp[0] as Record<string, unknown>);

    deliver(agent, { type: 'plan_review', plan_content: '# Proposed changes' });

    expect(agent.plan).toEqual(expected);
    expect(agent.status).toBe('waiting');
    expect(agent.ui).toEqual([
      expect.objectContaining({ type: 'plan_review', plan_content: '# Proposed changes' }),
    ]);
  });

  it('reset clears plan together with the session', () => {
    const agent = activeAgent();
    deliver(agent, fixture.acp[0] as Record<string, unknown>);

    agent.reset();

    expect(agent.plan).toEqual([]);
    expect(agent.currentSession).toBeNull();
  });
});
