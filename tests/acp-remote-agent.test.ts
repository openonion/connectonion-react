import { RemoteAgent } from '../src/connect/remote-agent';
import fixture from './fixtures/acp_tool_events.json';

function remoteAgent() {
  const agent = new RemoteAgent(`0x${'a'.repeat(64)}`, {}) as any;
  const deliver = (frame: object) => {
    agent._handleMessage({ data: JSON.stringify(frame) });
  };
  return { agent, deliver };
}

describe('ACP notifications through RemoteAgent', () => {
  test('the rollout dual-write creates one tool card', () => {
    const { agent, deliver } = remoteAgent();

    for (const event of [
      fixture.acp[0], fixture.legacy[0], fixture.acp[1], fixture.legacy[1],
    ]) deliver(event);

    expect(agent.ui).toEqual([{
      type: 'tool_call',
      id: 'call-1',
      name: 'search_docs',
      args: { query: 'ACP' },
      status: 'done',
      result: '2 matches',
      timing_ms: 42,
    }]);
  });

  test('a reconnect snapshot remains authoritative before live updates', () => {
    const { agent, deliver } = remoteAgent();
    deliver({
      type: 'CONNECTED',
      status: 'running',
      server_newer: true,
      session: { session_id: 'session-1' },
      chat_items: [{
        type: 'tool_call', id: 'call-1', name: 'search_docs', status: 'running',
      }],
    });

    deliver(fixture.acp[1]);
    deliver(fixture.legacy[1]);

    expect(agent.ui).toHaveLength(1);
    expect(agent.ui[0]).toMatchObject({ id: 'call-1', status: 'done' });
  });
});
