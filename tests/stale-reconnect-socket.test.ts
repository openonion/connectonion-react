import { RemoteAgent } from '../src/connect/remote-agent';

describe('RemoteAgent replacement socket ownership', () => {
  const socket = () => ({
    readyState: 1,
    send: jest.fn(),
    close: jest.fn(),
    onopen: null,
    onmessage: null,
    onerror: null,
    onclose: null,
  });

  test('a stale close cannot disconnect an authenticated replacement', () => {
    const agent = new RemoteAgent(`0x${'a'.repeat(64)}`) as any;
    const stale = socket();
    const replacement = socket();

    agent._ws = replacement;
    agent._authenticated = true;
    agent._connectionState = 'connected';

    agent._handleSocketConnectionLoss(stale);

    expect(agent._ws).toBe(replacement);
    expect(agent._authenticated).toBe(true);
    expect(agent.connectionState).toBe('connected');
  });

  test('the currently owned socket still reports a real connection loss', () => {
    const agent = new RemoteAgent(`0x${'b'.repeat(64)}`) as any;
    const current = socket();

    agent._ws = current;
    agent._authenticated = true;
    agent._connectionState = 'connected';

    agent._handleSocketConnectionLoss(current);

    expect(agent._ws).toBeNull();
    expect(agent._authenticated).toBe(false);
    expect(agent.connectionState).toBe('disconnected');
  });
});
