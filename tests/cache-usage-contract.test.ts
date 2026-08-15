import { mapEventToChatItem } from '../src/connect/chat-item-mapper';
import type { ChatItem } from '../src/connect/types';


test('cache and billing details survive llm result normalization', () => {
  const items: ChatItem[] = [];
  const add = (item: Partial<ChatItem> & { type: ChatItem['type'] }) => {
    items.push(item as ChatItem);
  };

  mapEventToChatItem(items, {
    type: 'llm_call', id: 'llm-1', model: 'co/gemini-3.7-flash',
  }, add);
  mapEventToChatItem(items, {
    type: 'llm_result', id: 'llm-1', status: 'success',
    usage: {
      input_tokens: 10_509,
      output_tokens: 4,
      total_tokens: 10_513,
      cached_tokens: 8_167,
      uncached_input_tokens: 2_342,
      cost: 0.0019,
      cost_usd: 0.0019,
      cost_details: {
        uncached_input_usd: 0.001757,
        cached_input_usd: 0.000613,
        output_usd: 0.000015,
        total_usd: 0.002385,
      },
    },
  }, add);

  expect(items[0]).toMatchObject({
    type: 'thinking',
    usage: {
      input_tokens: 10_509,
      cached_tokens: 8_167,
      uncached_input_tokens: 2_342,
      cost: 0.0019,
      cost_details: { cached_input_usd: 0.000613 },
    },
  });
});
