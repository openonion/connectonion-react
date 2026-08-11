import { mapEventToChatItem } from '../src/connect/chat-item-mapper';
import type { ChatItem } from '../src/connect/types';
import fixture from './fixtures/acp_thought_events.json';

function mapThoughtEvents(
  events: Record<string, unknown>[],
  options?: { activeSessionId?: string },
): ChatItem[] {
  const items: ChatItem[] = [];
  for (const event of events) {
    mapEventToChatItem(items, event, (item) => {
      const id = 'id' in item && item.id
        ? String(item.id)
        : `generated-${items.length}`;
      const index = items.findIndex((existing) => existing.id === id);
      if (index === -1) items.push({ ...item, id } as ChatItem);
      else items[index] = { ...items[index], ...item, id } as ChatItem;
    }, options === undefined ? 'session-1' : options.activeSessionId);
  }
  return items;
}

const expectedThought: ChatItem = {
  type: 'thinking',
  id: 'fe524e77-f886-48de-a0c2-84f67f4db706',
  status: 'done',
  content: 'The search result needs one more check.',
  kind: 'reflect',
};

describe('ACP v1.19 public thought notification compatibility', () => {
  test('legacy and ACP fixtures produce one identical thinking card', () => {
    expect(mapThoughtEvents(fixture.acp)).toEqual([expectedThought]);
    expect(mapThoughtEvents(fixture.legacy)).toEqual([expectedThought]);
  });

  test.each([
    ['ACP then legacy', [...fixture.acp, ...fixture.legacy]],
    ['legacy then ACP', [...fixture.legacy, ...fixture.acp]],
    ['re-delivery', [...fixture.acp, ...fixture.legacy, ...fixture.acp]],
    ['ACP-only re-delivery', [...fixture.acp, ...fixture.acp]],
  ])('%s converges by persisted thought ID', (_name, events) => {
    expect(mapThoughtEvents(events)).toEqual([expectedThought]);
  });

  test('an absent or malformed product kind never erases the thought', () => {
    const withoutKind: any = structuredClone(fixture.acp[0]);
    delete withoutKind.message.params.update._meta;
    const malformedKind: any = structuredClone(fixture.acp[0]);
    malformedKind.message.params.update._meta.connectonion.kind = 42;

    expect(mapThoughtEvents([withoutKind])).toEqual([{
      ...expectedThought,
      kind: undefined,
    }]);
    expect(mapThoughtEvents([malformedKind])).toEqual([{
      ...expectedThought,
      kind: undefined,
    }]);
    expect(mapThoughtEvents([
      ...fixture.legacy,
      withoutKind,
    ])).toEqual([expectedThought]);
  });

  test.each([
    ['missing ID', (frame: any) => {
      delete frame.message.params.update.messageId;
    }],
    ['empty ID', (frame: any) => {
      frame.message.params.update.messageId = '';
    }],
    ['empty text', (frame: any) => {
      frame.message.params.update.content.text = '';
    }],
    ['non-text content', (frame: any) => {
      frame.message.params.update.content = {
        type: 'resource',
        resource: { uri: 'https://example.com' },
      };
    }],
    ['missing content', (frame: any) => {
      delete frame.message.params.update.content;
    }],
    ['empty session ID', (frame: any) => {
      frame.message.params.sessionId = '';
    }],
    ['wrong JSON-RPC version', (frame: any) => {
      frame.message.jsonrpc = '1.0';
    }],
    ['wrong method', (frame: any) => {
      frame.message.method = 'session/prompt';
    }],
    ['unknown update', (frame: any) => {
      frame.message.params.update.sessionUpdate = 'future_thought';
    }],
    ['unknown schema', (frame: any) => {
      frame.acpSchema = 'schema-v9.0.0';
    }],
  ])('ignores %s without mutating state', (_name, mutate) => {
    const malformed: any = structuredClone(fixture.acp[0]);
    mutate(malformed);

    expect(mapThoughtEvents([malformed])).toEqual([]);
  });

  test('a valid thought from another or missing active session fails closed', () => {
    expect(mapThoughtEvents(fixture.acp, {
      activeSessionId: 'session-2',
    })).toEqual([]);
    expect(mapThoughtEvents(fixture.acp, {})).toEqual([]);
  });

  test('provider status events remain status-only legacy UI', () => {
    const events = [
      { type: 'llm_call', id: 'provider-1', model: 'example' },
      {
        type: 'llm_result',
        id: 'provider-1',
        status: 'done',
        content: 'must not become public reasoning',
      },
    ];

    expect(mapThoughtEvents(events)).toEqual([{
      type: 'thinking',
      id: 'provider-1',
      status: 'done',
      model: 'example',
    }]);
  });
});
