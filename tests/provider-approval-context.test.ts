import { RemoteAgent } from '../src/connect/remote-agent';

class FakeSocket {
  static OPEN = 1;
  readyState = FakeSocket.OPEN;
  onmessage: ((event: { data: string }) => void) | null = null;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;

  sent: string[] = [];
  send(data: string) { this.sent.push(data); }
  close() {}
}

test('keeps native provider approval correlation without putting it in visible arguments', () => {
  const agent = new RemoteAgent('0x' + 'a'.repeat(64), {}) as any;
  agent._ws = new FakeSocket();

  agent._handleMessage({ data: JSON.stringify({
    id: 'approval-1',
    type: 'approval_needed',
    tool: 'codex',
    arguments: { action: 'Run pytest', cwd: '.workroom-e2e' },
    provider: 'codex',
    invocationId: 'codex:outer-call',
    parentToolCallId: 'outer-call',
    activityId: 'item-7',
    providerApproval: {
      action: 'Run a workspace command',
      scope: 'This Work Room only',
      reason: 'Codex requested approval to continue',
      scopeClassification: 'workroom',
      allowOnce: true,
      allowSession: false,
      files: ['C:\\\\private\\\\sort.c', '/tmp/workroom/result.txt/', '///'],
    },
  }) });

  expect(agent.ui).toContainEqual(expect.objectContaining({
    id: 'approval-1',
    type: 'approval_needed',
    tool: 'codex',
    provider: 'codex',
    providerInvocationId: 'codex:outer-call',
    parentToolCallId: 'outer-call',
    activityId: 'item-7',
    arguments: { action: 'Run pytest', cwd: '.workroom-e2e' },
    providerApproval: {
      action: 'Run a workspace command',
      scope: 'This Work Room only',
      reason: 'Codex requested approval to continue',
      scopeClassification: 'workroom',
      allowOnce: true,
      allowSession: false,
      files: ['sort.c', 'result.txt'],
    },
  }));
});

test('drops malformed provider approval presentation rather than rendering raw fields', () => {
  const agent = new RemoteAgent('0x' + 'a'.repeat(64), {}) as any;
  agent._ws = new FakeSocket();

  agent._handleMessage({ data: JSON.stringify({
    id: 'approval-3',
    type: 'approval_needed',
    tool: 'codex',
    arguments: { action: 'Run pytest' },
    provider: 'codex',
    invocationId: 'codex:outer-call',
    parentToolCallId: 'outer-call',
    providerApproval: {
      action: 'cc --token private-value',
      scopeClassification: 'untrusted-value',
      allowOnce: 'yes',
    },
  }) });

  const approval = agent.ui.find((item: any) => item.id === 'approval-3');
  expect(approval.providerApproval).toBeUndefined();
});

test('drops incomplete native provider correlation instead of guessing a card', () => {
  const agent = new RemoteAgent('0x' + 'a'.repeat(64), {}) as any;
  agent._ws = new FakeSocket();

  agent._handleMessage({ data: JSON.stringify({
    id: 'approval-2',
    type: 'approval_needed',
    tool: 'codex',
    arguments: { action: 'Run pytest' },
    provider: 'codex',
    invocationId: 'codex:outer-call',
  }) });

  expect(agent.ui).toContainEqual({
    id: 'approval-2',
    type: 'approval_needed',
    tool: 'codex',
    arguments: { action: 'Run pytest' },
  });
});

test.each([
  ['unknown', 'Boundary could not be verified'],
  ['elevated', 'Outside this Work Room'],
] as const)('never preserves allow controls for a %s provider boundary', (scopeClassification, scope) => {
  const agent = new RemoteAgent('0x' + 'a'.repeat(64), {}) as any;
  agent._ws = new FakeSocket();

  agent._handleMessage({ data: JSON.stringify({
    id: `approval-${scopeClassification}`,
    type: 'approval_needed',
    tool: 'codex',
    arguments: {},
    provider: 'codex',
    invocationId: 'codex:outer-call',
    parentToolCallId: 'outer-call',
    providerApproval: {
      action: 'Run a workspace command',
      scope,
      reason: 'Codex requested approval to continue',
      scopeClassification,
      allowOnce: true,
      allowSession: true,
    },
  }) });

  expect(agent.ui).toContainEqual(expect.objectContaining({
    id: `approval-${scopeClassification}`,
    providerApproval: expect.objectContaining({
      scopeClassification,
      allowOnce: false,
      allowSession: false,
    }),
  }));
});

test('forwards safe provider activity through the live RemoteAgent dispatcher', () => {
  const agent = new RemoteAgent('0x' + 'a'.repeat(64), {}) as any;
  agent._ws = new FakeSocket();

  agent._handleMessage({ data: JSON.stringify({
    type: 'provider_invocation', invocationId: 'codex:outer-call',
    parentToolCallId: 'outer-call', provider: 'codex', providerDisplayName: 'Codex',
    taskTitle: 'Implement and verify the requested change',
    currentSummary: 'Working in the selected workspace', status: 'running',
  }) });
  agent._handleMessage({ data: JSON.stringify({
    type: 'provider_activity', provider: 'codex', invocationId: 'codex:outer-call',
    parentToolCallId: 'outer-call', activityId: 'step-1', sequence: 1,
    kind: 'inspect', status: 'completed', title: 'Inspect the workspace',
    summary: 'Workspace inspection completed',
  }) });

  expect(agent.ui).toContainEqual(expect.objectContaining({
    id: 'codex:outer-call',
    type: 'provider_invocation',
    taskTitle: 'Implement and verify the requested change',
    currentSummary: 'Working in the selected workspace',
    activities: [{
      id: 'step-1', sequence: 1, kind: 'inspect', status: 'done', legacy: false,
      title: 'Inspect the workspace', summary: 'Workspace inspection completed',
    }],
  }));
});

test('forwards a bounded native Codex message through the live dispatcher', () => {
  const agent = new RemoteAgent('0x' + 'a'.repeat(64), {}) as any;
  agent._ws = new FakeSocket();

  agent._handleMessage({ data: JSON.stringify({
    type: 'provider_invocation', invocationId: 'codex:outer-call',
    parentToolCallId: 'outer-call', provider: 'codex', providerDisplayName: 'Codex',
    status: 'running', stateRevision: 7,
  }) });
  agent._handleMessage({ data: JSON.stringify({
    type: 'provider_message', provider: 'codex', invocationId: 'codex:outer-call',
    parentToolCallId: 'outer-call', messageId: 'assistant:1', role: 'assistant',
    text: 'The reverse-order fixture passes.',
  }) });

  expect(agent.ui).toContainEqual(expect.objectContaining({
    id: 'codex:outer-call',
    messages: [{
      id: 'assistant:1', role: 'assistant', text: 'The reverse-order fixture passes.',
    }],
  }));
});

test('resolves a scoped provider stop only after its Host acknowledgement', async () => {
  const agent = new RemoteAgent('0x' + 'a'.repeat(64), {}) as any;
  const socket = new FakeSocket();
  agent._ws = socket;
  agent._authenticated = true;
  agent._handleMessage({ data: JSON.stringify({
    type: 'provider_invocation', invocationId: 'codex:outer-call',
    parentToolCallId: 'outer-call', provider: 'codex', providerDisplayName: 'Codex',
    currentSummary: 'Working in the selected workspace', status: 'running', stateRevision: 7,
  }) });

  const stopped = agent.interruptProvider('codex:outer-call');
  const request = JSON.parse(socket.sent[0]);

  expect(request).toEqual(expect.objectContaining({
    type: 'PROVIDER_INTERRUPT',
    invocationId: 'codex:outer-call',
    requestId: expect.any(String),
    stateRevision: 7,
  }));
  expect(agent._interruptSent).toBe(false);

  agent._handleMessage({ data: JSON.stringify({
    type: 'PROVIDER_INTERRUPT_ACK',
    requestId: request.requestId,
    invocationId: 'codex:outer-call',
    accepted: true,
    stateRevision: 7,
  }) });

  await expect(stopped).resolves.toEqual({
    invocationId: 'codex:outer-call',
    stateRevision: 7,
  });
  expect(agent._pendingProviderInterrupt).toBeNull();
});

test('resolves a direct Codex Work Room message only after its matching Host acknowledgement', async () => {
  const agent = new RemoteAgent('0x' + 'a'.repeat(64), {}) as any;
  const socket = new FakeSocket();
  agent._ws = socket;
  agent._authenticated = true;
  agent._handleMessage({ data: JSON.stringify({
    type: 'provider_invocation', invocationId: 'codex:outer-call',
    parentToolCallId: 'outer-call', provider: 'codex', providerDisplayName: 'Codex',
    currentSummary: 'Working in the selected workspace', status: 'running', stateRevision: 7,
  }) });

  const sent = agent.sendProviderInput(
    'codex:outer-call',
    'Please add a reverse-order fixture.',
  );
  const request = JSON.parse(socket.sent[0]);
  expect(request).toEqual(expect.objectContaining({
    type: 'PROVIDER_INPUT',
    invocationId: 'codex:outer-call',
    requestId: expect.any(String),
    stateRevision: 7,
    text: 'Please add a reverse-order fixture.',
  }));
  expect(request.type).not.toBe('INPUT');

  agent._handleMessage({ data: JSON.stringify({
    type: 'PROVIDER_INPUT_ACK',
    requestId: request.requestId,
    invocationId: 'codex:outer-call',
    accepted: true,
    stateRevision: 7,
  }) });

  await expect(sent).resolves.toEqual({
    invocationId: 'codex:outer-call',
    stateRevision: 7,
  });
  expect(agent._pendingProviderInput).toBeNull();
});

test('commits a provider permission only after a newer authoritative Host acknowledgement', async () => {
  const agent = new RemoteAgent('0x' + 'a'.repeat(64), {}) as any;
  const socket = new FakeSocket();
  agent._ws = socket;
  agent._authenticated = true;
  const permission = {
    provider: 'codex', activeOptionId: 'codex:workspace-ask',
    appliesTo: 'subsequent_turn', effectiveRevision: 4,
    options: [{
      id: 'codex:workspace-ask', nativeProfileId: ':workspace', reviewer: 'user',
      label: 'Ask for approval', description: 'Ask before protected actions.',
      risk: 'standard', selectable: true,
    }, {
      id: 'codex:workspace-auto', nativeProfileId: ':workspace', reviewer: 'auto',
      label: 'Approve for me', description: 'Automatically review workspace actions.',
      risk: 'standard', selectable: true,
    }],
  };
  agent._handleMessage({ data: JSON.stringify({
    type: 'provider_invocation', invocationId: 'codex:outer-call',
    parentToolCallId: 'outer-call', provider: 'codex', providerDisplayName: 'Codex',
    status: 'completed', stateRevision: 4, providerPermission: permission,
  }) });

  const changing = agent.setProviderPermission(
    'codex:outer-call',
    'codex:workspace-auto',
  );
  const request = JSON.parse(socket.sent[0]);
  expect(request).toEqual(expect.objectContaining({
    type: 'PROVIDER_PERMISSION_CHANGE', invocationId: 'codex:outer-call',
    optionId: 'codex:workspace-auto', stateRevision: 4, confirmRisk: false,
    requestId: expect.any(String),
  }));
  expect(agent.ui[0].providerPermission.activeOptionId).toBe('codex:workspace-ask');

  agent._handleMessage({ data: JSON.stringify({
    type: 'PROVIDER_PERMISSION_ACK', requestId: request.requestId,
    invocationId: 'codex:outer-call', accepted: true, stateRevision: 5,
    providerPermission: {
      ...permission, activeOptionId: 'codex:workspace-auto', effectiveRevision: 5,
    },
  }) });

  await expect(changing).resolves.toEqual({
    invocationId: 'codex:outer-call', stateRevision: 5,
  });
  expect(agent.ui[0]).toMatchObject({
    stateRevision: 5,
    providerPermission: { activeOptionId: 'codex:workspace-auto', effectiveRevision: 5 },
  });
});

test('fails closed for an elevated provider profile without separate confirmation', async () => {
  const agent = new RemoteAgent('0x' + 'a'.repeat(64), {}) as any;
  const socket = new FakeSocket();
  agent._ws = socket;
  agent._authenticated = true;
  agent._handleMessage({ data: JSON.stringify({
    type: 'provider_invocation', invocationId: 'codex:outer-call',
    parentToolCallId: 'outer-call', provider: 'codex', providerDisplayName: 'Codex',
    status: 'completed', stateRevision: 4,
    providerPermission: {
      provider: 'codex', activeOptionId: 'codex:workspace-ask',
      appliesTo: 'subsequent_turn', effectiveRevision: 4,
      options: [{
        id: 'codex:workspace-ask', nativeProfileId: ':workspace', reviewer: 'user',
        label: 'Ask for approval', description: 'Ask before protected actions.',
        risk: 'standard', selectable: true,
      }, {
        id: 'codex:full-access', nativeProfileId: ':danger-full-access', reviewer: 'auto',
        label: 'Full Access', description: 'Allow work outside the workspace.',
        risk: 'elevated', selectable: true,
      }],
    },
  }) });

  await expect(agent.setProviderPermission(
    'codex:outer-call',
    'codex:full-access',
  )).rejects.toThrow('Confirm the provider Full Access risk before applying it.');
  expect(socket.sent).toHaveLength(0);
});

test('rejects a provider permission acknowledgement that does not prove newer state', async () => {
  const agent = new RemoteAgent('0x' + 'a'.repeat(64), {}) as any;
  const socket = new FakeSocket();
  agent._ws = socket;
  agent._authenticated = true;
  const permission = {
    provider: 'codex', activeOptionId: 'codex:workspace-ask',
    appliesTo: 'subsequent_turn', effectiveRevision: 4,
    options: [{
      id: 'codex:workspace-ask', nativeProfileId: ':workspace', reviewer: 'user',
      label: 'Ask for approval', description: 'Ask before protected actions.',
      risk: 'standard', selectable: true,
    }, {
      id: 'codex:workspace-auto', nativeProfileId: ':workspace', reviewer: 'auto',
      label: 'Approve for me', description: 'Automatically review workspace actions.',
      risk: 'standard', selectable: true,
    }],
  };
  agent._handleMessage({ data: JSON.stringify({
    type: 'provider_invocation', invocationId: 'codex:outer-call',
    parentToolCallId: 'outer-call', provider: 'codex', providerDisplayName: 'Codex',
    status: 'completed', stateRevision: 4, providerPermission: permission,
  }) });

  const changing = agent.setProviderPermission('codex:outer-call', 'codex:workspace-auto');
  const request = JSON.parse(socket.sent[0]);
  agent._handleMessage({ data: JSON.stringify({
    type: 'PROVIDER_PERMISSION_ACK', requestId: request.requestId,
    invocationId: 'codex:outer-call', accepted: true, stateRevision: 4,
    providerPermission: permission,
  }) });

  await expect(changing).rejects.toThrow(
    'The Host did not prove the provider permission change applies to a newer state.',
  );
  expect(agent.ui[0]).toMatchObject({
    stateRevision: 4,
    providerPermission: { activeOptionId: 'codex:workspace-ask' },
  });
});

test('sends a direct Claude Code Work Room message through the same provider envelope', async () => {
  const agent = new RemoteAgent('0x' + 'a'.repeat(64), {}) as any;
  const socket = new FakeSocket();
  agent._ws = socket;
  agent._authenticated = true;
  agent._handleMessage({ data: JSON.stringify({
    type: 'provider_invocation', invocationId: 'claude_code:outer-call',
    parentToolCallId: 'outer-call', provider: 'claude_code', providerDisplayName: 'Claude Code',
    currentSummary: 'Working in the selected workspace', status: 'completed', stateRevision: 4,
  }) });

  const sent = agent.sendProviderInput(
    'claude_code:outer-call',
    'Continue this Claude Code session.',
  );
  const request = JSON.parse(socket.sent[0]);
  expect(request).toEqual(expect.objectContaining({
    type: 'PROVIDER_INPUT',
    invocationId: 'claude_code:outer-call',
    requestId: expect.any(String),
    stateRevision: 4,
    text: 'Continue this Claude Code session.',
  }));

  agent._handleMessage({ data: JSON.stringify({
    type: 'PROVIDER_INPUT_ACK',
    requestId: request.requestId,
    invocationId: 'claude_code:outer-call',
    accepted: true,
    stateRevision: 4,
  }) });

  await expect(sent).resolves.toEqual({
    invocationId: 'claude_code:outer-call',
    stateRevision: 4,
  });
});

test('fails closed when a direct Codex acknowledgement has a different revision', async () => {
  const agent = new RemoteAgent('0x' + 'a'.repeat(64), {}) as any;
  const socket = new FakeSocket();
  agent._ws = socket;
  agent._authenticated = true;
  agent._handleMessage({ data: JSON.stringify({
    type: 'provider_invocation', invocationId: 'codex:outer-call',
    parentToolCallId: 'outer-call', provider: 'codex', providerDisplayName: 'Codex',
    status: 'completed', stateRevision: 4,
  }) });

  const sent = agent.sendProviderInput('codex:outer-call', 'Continue the test.');
  const request = JSON.parse(socket.sent[0]);
  agent._handleMessage({ data: JSON.stringify({
    type: 'PROVIDER_INPUT_ACK',
    requestId: request.requestId,
    invocationId: 'codex:outer-call',
    accepted: true,
    stateRevision: 5,
  }) });

  await expect(sent).rejects.toThrow(
    'The Host did not prove the message applies to the current provider state.',
  );
  expect(agent._pendingProviderInput).toBeNull();
});

test('returns a retryable failure when the Host rejects a scoped provider stop', async () => {
  const agent = new RemoteAgent('0x' + 'a'.repeat(64), {}) as any;
  const socket = new FakeSocket();
  agent._ws = socket;
  agent._authenticated = true;
  agent._handleMessage({ data: JSON.stringify({
    type: 'provider_invocation', invocationId: 'codex:outer-call',
    parentToolCallId: 'outer-call', provider: 'codex', providerDisplayName: 'Codex',
    currentSummary: 'Working in the selected workspace', status: 'running', stateRevision: 3,
  }) });

  const stopped = agent.interruptProvider('codex:outer-call');
  const request = JSON.parse(socket.sent[0]);
  agent._handleMessage({ data: JSON.stringify({
    type: 'PROVIDER_INTERRUPT_ACK',
    requestId: request.requestId,
    invocationId: 'codex:outer-call',
    accepted: false,
    reason: 'not_active',
    stateRevision: 3,
  }) });

  await expect(stopped).rejects.toThrow('The provider run is no longer active. Try again.');
  expect(agent._pendingProviderInterrupt).toBeNull();
});

test('fails closed when a stop acknowledgement does not prove the observed revision', async () => {
  const agent = new RemoteAgent('0x' + 'a'.repeat(64), {}) as any;
  const socket = new FakeSocket();
  agent._ws = socket;
  agent._authenticated = true;
  agent._handleMessage({ data: JSON.stringify({
    type: 'provider_invocation', invocationId: 'codex:outer-call',
    parentToolCallId: 'outer-call', provider: 'codex', providerDisplayName: 'Codex',
    currentSummary: 'Working in the selected workspace', status: 'running', stateRevision: 11,
  }) });

  const stopped = agent.interruptProvider('codex:outer-call');
  const request = JSON.parse(socket.sent[0]);
  agent._handleMessage({ data: JSON.stringify({
    type: 'PROVIDER_INTERRUPT_ACK',
    requestId: request.requestId,
    invocationId: 'codex:outer-call',
    accepted: true,
    stateRevision: 10,
  }) });

  await expect(stopped).rejects.toThrow('The Host did not prove the stop applies to the current provider state.');
  expect(agent._pendingProviderInterrupt).toBeNull();
});

test('a reconnect snapshot cannot regress a newer local provider lifecycle', () => {
  const agent = new RemoteAgent('0x' + 'a'.repeat(64), {}) as any;
  agent._handleMessage({ data: JSON.stringify({
    type: 'provider_invocation', invocationId: 'codex:outer-call',
    parentToolCallId: 'outer-call', provider: 'codex', providerDisplayName: 'Codex',
    status: 'cancelled', resultSummary: 'The provider stopped', stateRevision: 9,
  }) });

  agent._mergeServerChatItems([{
    id: 'codex:outer-call', type: 'provider_invocation',
    parentToolCallId: 'outer-call', provider: 'codex', providerDisplayName: 'Codex',
    status: 'running', activities: [], stateRevision: 8,
  }]);

  expect(agent.ui).toContainEqual(expect.objectContaining({
    id: 'codex:outer-call',
    status: 'cancelled',
    stateRevision: 9,
  }));
});
