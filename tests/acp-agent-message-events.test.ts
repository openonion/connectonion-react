import { mapEventToChatItem } from '../src/connect/chat-item-mapper';
import type { ChatItem } from '../src/connect/types';
import fixture from './fixtures/acp_agent_message_events.json';

function mapMessageEvents(events: Record<string, unknown>[]): ChatItem[] {
  const items: ChatItem[] = [];
  for (const event of events) {
    mapEventToChatItem(items, event, (item) => {
      const id = 'id' in item && item.id ? String(item.id) : `generated-${items.length}`;
      const index = items.findIndex((existing) => existing.id === id);
      if (index === -1) items.push({ ...item, id } as ChatItem);
      else items[index] = { ...items[index], ...item, id } as ChatItem;
    }, 'session-1');
  }
  return items;
}

describe('ACP v1.19 agent message notification compatibility', () => {
  test('legacy and ACP fixtures produce one identical agent card', () => {
    expect(mapMessageEvents(fixture.acp)).toEqual(mapMessageEvents(fixture.legacy));
    expect(mapMessageEvents(fixture.acp)).toEqual([{
      type: 'agent',
      id: '6d1fcd7e-2e31-4ac4-9f39-7de8f73cd82e',
      content: 'The final answer.',
    }]);
  });

  test('rolling dual-read and re-delivery are idempotent by message ID', () => {
    expect(mapMessageEvents([
      ...fixture.acp,
      ...fixture.legacy,
      ...fixture.acp,
    ])).toEqual([{
      type: 'agent',
      id: '6d1fcd7e-2e31-4ac4-9f39-7de8f73cd82e',
      content: 'The final answer.',
    }]);
  });

  test.each([
    ['empty ID', (frame: any) => { frame.message.params.update.messageId = ''; }],
    ['empty text', (frame: any) => { frame.message.params.update.content.text = ''; }],
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
    ['unknown update', (frame: any) => {
      frame.message.params.update.sessionUpdate = 'future_message';
    }],
    ['unknown schema', (frame: any) => { frame.acpSchema = 'schema-v9.0.0'; }],
  ])('ignores %s without mutating state', (_name, mutate) => {
    const malformed: any = structuredClone(fixture.acp[0]);
    mutate(malformed);

    expect(mapMessageEvents([malformed])).toEqual([]);
  });
});
