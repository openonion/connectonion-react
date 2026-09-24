/**
 * One conversation open on a laptop and a phone (connectonion#1606).
 *
 * The Host streams a turn to every device that has the conversation open. The
 * device that did not type the prompt receives it as `user_message` first, so
 * it can show the question, the work in progress, and then the answer.
 */

import { RemoteAgent } from '../src/connect/remote-agent';

function phone(sessionId = 's1') {
  const agent = new RemoteAgent('0x' + 'a'.repeat(64), {}) as any;
  agent._currentSession = { session_id: sessionId, messages: [] };
  agent._status = 'idle';
  const deliver = (frame: object) => agent._handleMessage({ data: JSON.stringify(frame) });
  return { agent, deliver };
}

describe('a turn started on another device', () => {
  it('shows the question that device typed, and the turn as in progress', () => {
    const { agent, deliver } = phone();

    deliver({ type: 'user_message', content: 'find flights', session_id: 's1' });

    const users = agent._chatItems.filter((item: any) => item.type === 'user');
    expect(users.map((item: any) => item.content)).toEqual(['find flights']);
    expect(agent._status).toBe('working');
  });

  it('ends idle with the answer after the question, once', () => {
    const { agent, deliver } = phone();

    deliver({ type: 'user_message', content: 'find flights', session_id: 's1' });
    deliver({ type: 'OUTPUT', result: 'Three flights found', session_id: 's1' });

    const shown = agent._chatItems
      .filter((item: any) => item.type === 'user' || item.type === 'agent')
      .map((item: any) => [item.type, item.content]);
    expect(shown).toEqual([['user', 'find flights'], ['agent', 'Three flights found']]);
    expect(agent._status).toBe('idle');
  });

  it('ignores a prompt for a different conversation', () => {
    const { agent, deliver } = phone('s1');

    deliver({ type: 'user_message', content: 'not this chat', session_id: 's2' });

    expect(agent._chatItems).toEqual([]);
    expect(agent._status).toBe('idle');
  });
});
