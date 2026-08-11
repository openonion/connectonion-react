import { RemoteAgent } from '../src/connect/remote-agent';
import fixture from './fixtures/acp_tool_events.json';
import messageFixture from './fixtures/acp_agent_message_events.json';

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
    deliver({
      type: 'CONNECTED',
      status: 'running',
      server_newer: true,
      session: { session_id: 'session-1' },
    });

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

  test('an ACP final answer and legacy OUTPUT create one stable agent card', () => {
    const { agent, deliver } = remoteAgent();
    deliver({
      type: 'CONNECTED',
      status: 'running',
      server_newer: true,
      session: { session_id: 'session-1' },
    });

    deliver(messageFixture.acp[0]);
    deliver({
      type: 'OUTPUT',
      result: 'The final answer.',
      session: {
        session_id: 'session-1',
        messages: [
          { role: 'system', content: 'Help' },
          { role: 'user', content: 'Question' },
          {
            role: 'assistant',
            content: 'The final answer.',
            id: '6d1fcd7e-2e31-4ac4-9f39-7de8f73cd82e',
          },
        ],
      },
      chat_items: [
        { type: 'user', id: 'msg-1', content: 'Question' },
        {
          type: 'agent',
          id: '6d1fcd7e-2e31-4ac4-9f39-7de8f73cd82e',
          content: 'The final answer.',
        },
      ],
    });

    expect(agent.ui).toEqual([{
      type: 'agent',
      id: '6d1fcd7e-2e31-4ac4-9f39-7de8f73cd82e',
      content: 'The final answer.',
    }]);
  });

  test('an authoritative snapshot and re-delivered ACP message converge by ID', () => {
    const { agent, deliver } = remoteAgent();
    deliver({
      type: 'CONNECTED',
      status: 'running',
      server_newer: true,
      session: { session_id: 'session-1' },
      chat_items: [{
        type: 'agent',
        id: '6d1fcd7e-2e31-4ac4-9f39-7de8f73cd82e',
        content: 'The final answer.',
      }],
    });

    deliver(messageFixture.acp[0]);
    deliver(messageFixture.acp[0]);

    expect(agent.ui).toEqual([{
      type: 'agent',
      id: '6d1fcd7e-2e31-4ac4-9f39-7de8f73cd82e',
      content: 'The final answer.',
    }]);
  });

  test('an ACP update from another session cannot mutate the active chat', () => {
    const { agent, deliver } = remoteAgent();
    deliver({
      type: 'CONNECTED',
      status: 'running',
      server_newer: true,
      session: { session_id: 'session-1' },
      chat_items: [{
        type: 'agent',
        id: '6d1fcd7e-2e31-4ac4-9f39-7de8f73cd82e',
        content: 'Authoritative answer.',
      }],
    });
    const foreign = structuredClone(messageFixture.acp[0]) as any;
    foreign.message.params.sessionId = 'session-2';
    foreign.session = { session_id: 'session-2' };
    agent._addChatItem({
      type: 'thinking', id: '__optimistic__', status: 'running',
    });
    const before = structuredClone(agent.ui);

    deliver(foreign);

    expect(agent.ui).toEqual(before);
    expect(agent.currentSession?.session_id).toBe('session-1');
  });

  test('an ACP update without an active session fails closed', () => {
    const { agent, deliver } = remoteAgent();

    deliver(messageFixture.acp[0]);

    expect(agent.ui).toEqual([]);
  });
});
