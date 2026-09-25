/**
 * An answer names the request it answers (connectonion#1692).
 *
 * With one session open on a laptop and a phone, the laptop approved request
 * #1 while the phone still showed it. The phone's "approve" for #1 reached the
 * Host, which handed it to whatever the agent was waiting on by then: request
 * #2, a command the phone had never shown. The Host now requires every
 * APPROVAL_RESPONSE and ASK_USER_RESPONSE to carry `request_id` (the `id` it
 * stamped on the event) once two devices can answer, and refuses a stale
 * answer with ERROR code STALE_ANSWER. These tests hold this client to both
 * halves: it names the request, and it takes a refusal quietly without ever
 * re-sending.
 */

import { RemoteAgent } from '../src/connect/remote-agent';

class FakeSocket {
  readyState = 1;
  onmessage: ((event: { data: string }) => void) | null = null;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  sent: Record<string, unknown>[] = [];
  send(data: string) { this.sent.push(JSON.parse(data)); }
  close() {}
}

function device() {
  const agent = new RemoteAgent('0x' + 'a'.repeat(64), {}) as any;
  const socket = new FakeSocket();
  agent._ws = socket;
  agent._authenticated = true;
  agent._currentSession = { session_id: 's1', messages: [] };
  const deliver = (frame: object) => agent._handleMessage({ data: JSON.stringify(frame) });
  return { agent, socket, deliver };
}

const approvalNeeded = (id?: string) => ({
  type: 'approval_needed',
  ...(id && { id }),
  tool: 'bash',
  arguments: { command: 'ls' },
  session_id: 's1',
});

const askUser = (id?: string) => ({
  type: 'ask_user',
  ...(id && { id }),
  text: 'Which day?',
  options: ['Mon', 'Tue'],
  session_id: 's1',
});

describe('an approval answer', () => {
  it('names the approval_needed event it answers', () => {
    const { agent, socket, deliver } = device();
    deliver(approvalNeeded('req-1'));

    agent.respondToApproval(true, 'once');

    expect(socket.sent).toEqual([
      { type: 'APPROVAL_RESPONSE', request_id: 'req-1', approved: true, scope: 'once' },
    ]);
  });

  it('names it through send() and through a Stop that refuses the approval', () => {
    const viaSend = device();
    viaSend.deliver(approvalNeeded('req-2'));
    viaSend.agent.send({ type: 'APPROVAL_RESPONSE', approved: false, mode: 'reject_soft' });
    expect(viaSend.socket.sent[0]).toMatchObject({
      type: 'APPROVAL_RESPONSE', request_id: 'req-2', approved: false, mode: 'reject_soft',
    });

    const viaStop = device();
    viaStop.deliver(approvalNeeded('req-3'));
    viaStop.agent.interrupt();
    expect(viaStop.socket.sent[0]).toMatchObject({
      type: 'APPROVAL_RESPONSE', request_id: 'req-3', approved: false,
    });
  });

  it('names the newest request, not an earlier one', () => {
    const { agent, socket, deliver } = device();
    deliver(approvalNeeded('req-1'));
    agent.respondToApproval(true, 'once');
    deliver(approvalNeeded('req-2'));
    agent.respondToApproval(false, 'once');

    expect(socket.sent.map((frame) => frame.request_id)).toEqual(['req-1', 'req-2']);
  });

  it('sends no made-up id when an older Host stamped none', () => {
    const { agent, socket, deliver } = device();
    deliver(approvalNeeded());

    agent.respondToApproval(true, 'once');

    expect(socket.sent).toEqual([
      { type: 'APPROVAL_RESPONSE', approved: true, scope: 'once' },
    ]);
  });
});

describe('an ask_user answer', () => {
  it('names the ask_user event it answers', () => {
    const { agent, socket, deliver } = device();
    deliver(askUser('ask-1'));

    agent.send({ type: 'ASK_USER_RESPONSE', answer: 'Tue' });

    expect(socket.sent).toEqual([
      { type: 'ASK_USER_RESPONSE', answer: 'Tue', request_id: 'ask-1' },
    ]);
    const question = agent.ui.find((item: any) => item.type === 'ask_user');
    expect(question).toMatchObject({ answered: true, answer: 'Tue' });
    expect(agent.status).toBe('working');
  });

  it('keeps a request_id the caller already named', () => {
    const { agent, socket, deliver } = device();
    deliver(askUser('ask-1'));
    deliver(askUser('ask-2'));

    agent.send({ type: 'ASK_USER_RESPONSE', request_id: 'ask-1', answer: 'Mon' });

    expect(socket.sent[0]).toMatchObject({ request_id: 'ask-1', answer: 'Mon' });
    const answered = agent.ui
      .filter((item: any) => item.type === 'ask_user' && item.answered)
      .map((item: any) => item.id);
    expect(answered).toEqual(['ask-1']);
  });

  it('sends no made-up id when an older Host stamped none', () => {
    const { agent, socket, deliver } = device();
    deliver(askUser());

    agent.send({ type: 'ASK_USER_RESPONSE', answer: 'Mon' });

    expect(socket.sent).toEqual([{ type: 'ASK_USER_RESPONSE', answer: 'Mon' }]);
  });
});

describe('a STALE_ANSWER refusal', () => {
  it('closes the approval as answered on another device and never re-sends', () => {
    const { agent, socket, deliver } = device();
    const onMessage = jest.fn();
    agent.onMessage = onMessage;
    deliver(approvalNeeded('req-1'));
    agent.respondToApproval(true, 'once');

    deliver({
      type: 'ERROR', code: 'STALE_ANSWER', reason: 'stale',
      request_id: 'req-1', session_id: 's1', message: 'already answered',
    });

    const card = agent.ui.find((item: any) => item.id === 'req-1');
    expect(card).toMatchObject({ answered: true, answeredElsewhere: true });
    expect(socket.sent).toHaveLength(1);
    expect(agent.error).toBeNull();
    expect(onMessage).toHaveBeenCalled();

    // A second tap on the stale card sends nothing either.
    agent.respondToApproval(true, 'once');
    expect(socket.sent).toHaveLength(1);
  });

  it('does not touch the next request that arrived meanwhile', () => {
    const { agent, socket, deliver } = device();
    deliver(approvalNeeded('req-1'));
    agent.respondToApproval(true, 'once');
    deliver(approvalNeeded('req-2'));

    deliver({
      type: 'ERROR', code: 'STALE_ANSWER', reason: 'stale',
      request_id: 'req-1', session_id: 's1',
    });

    expect(agent.ui.find((item: any) => item.id === 'req-2')).not.toHaveProperty('answered', true);
    expect(agent.status).toBe('waiting');
    agent.respondToApproval(false, 'once');
    expect(socket.sent.map((frame) => frame.request_id)).toEqual(['req-1', 'req-2']);
  });

  it('closes a stale question and drops the answer that was not applied', () => {
    const { agent, deliver } = device();
    deliver(askUser('ask-1'));
    agent.send({ type: 'ASK_USER_RESPONSE', answer: 'Tue' });

    deliver({
      type: 'ERROR', code: 'STALE_ANSWER', reason: 'stale',
      request_id: 'ask-1', session_id: 's1',
    });

    const question = agent.ui.find((item: any) => item.id === 'ask-1');
    expect(question).toMatchObject({ answered: true, answeredElsewhere: true });
    expect(question).not.toHaveProperty('answer');
    expect(agent.error).toBeNull();
  });

  it('is not a failed turn: the pending input stays open for the turn on the other device', () => {
    const { agent, deliver } = device();
    const reject = jest.fn();
    agent._inputReject = reject;
    deliver(approvalNeeded('req-1'));
    agent.respondToApproval(true, 'once');

    deliver({
      type: 'ERROR', code: 'STALE_ANSWER', reason: 'request_id_required',
      request_id: null, session_id: 's1',
    });

    expect(reject).not.toHaveBeenCalled();
    expect(agent.error).toBeNull();
    expect(agent.ui.find((item: any) => item.id === 'req-1'))
      .toMatchObject({ answered: true, answeredElsewhere: true });
  });
});
