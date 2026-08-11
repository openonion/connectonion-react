import { mapEventToChatItem } from '../src/connect/chat-item-mapper';
import type { ChatItem } from '../src/connect/types';
import fixture from './fixtures/acp_tool_events.json';

function mapToolEvents(events: Record<string, unknown>[]): ChatItem[] {
  const items: ChatItem[] = [];
  for (const event of events) {
    mapEventToChatItem(
      items,
      event,
      (item) => items.push(item as ChatItem),
      'session-1',
    );
  }
  return items;
}

describe('ACP v1.19 tool notification compatibility', () => {
  test('legacy and ACP fixtures produce one identical tool card', () => {
    expect(mapToolEvents(fixture.acp)).toEqual(mapToolEvents(fixture.legacy));
    expect(mapToolEvents(fixture.acp)).toEqual([{
      type: 'tool_call',
      id: 'call-1',
      name: 'search_docs',
      args: { query: 'ACP' },
      status: 'done',
      result: '2 matches',
      timing_ms: 42,
    }]);
  });

  test('rolling-upgrade aliases do not duplicate a stable tool ID', () => {
    const events = [...fixture.legacy, ...fixture.acp];

    expect(mapToolEvents(events)).toHaveLength(1);
  });

  test('malformed ACP carriers are ignored', () => {
    const malformed = structuredClone(fixture.acp[0]);
    malformed.message.method = 'session/prompt';

    expect(mapToolEvents([malformed])).toEqual([]);
  });

  test('unknown carrier versions and start statuses are rejected', () => {
    const futureSchema = structuredClone(fixture.acp[0]);
    futureSchema.acpSchema = 'schema-v9.0.0';
    const futureStatus = structuredClone(fixture.acp[0]);
    futureStatus.message.params.update.status = 'future';

    expect(mapToolEvents([futureSchema, futureStatus])).toEqual([]);
  });

  test('unknown ACP terminal statuses fail closed', () => {
    const events = structuredClone(fixture.acp);
    events[1].message.params.update.status = 'future';

    expect(mapToolEvents(events)[0]).toMatchObject({ status: 'error' });
  });

  test('partial and content-free ACP updates preserve the card', () => {
    const partial: any = structuredClone(fixture.acp[1]);
    partial.message.params.update = {
      toolCallId: 'call-1',
      title: 'searching',
      status: 'in_progress',
      sessionUpdate: 'tool_call_update',
    };
    const completed: any = structuredClone(partial);
    completed.message.params.update = {
      toolCallId: 'call-1',
      status: 'completed',
      sessionUpdate: 'tool_call_update',
    };

    expect(mapToolEvents([fixture.acp[0], partial, completed])).toEqual([{
      type: 'tool_call',
      id: 'call-1',
      name: 'searching',
      args: { query: 'ACP' },
      status: 'done',
    }]);
  });
});
