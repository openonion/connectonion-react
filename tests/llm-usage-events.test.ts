import { mapEventToChatItem } from '../src/connect/chat-item-mapper';
import type { ChatItem } from '../src/connect/types';

test('preserves every normalized managed cache and pricing field', () => {
  const items: ChatItem[] = [];
  const apply = (event: Record<string, unknown>) => {
    mapEventToChatItem(items, event, item => items.push(item as ChatItem));
  };

  apply({ type: 'llm_call', id: 'llm-1', model: 'co/claude-sonnet-4-5' });
  apply({
    type: 'llm_result',
    id: 'llm-1',
    status: 'success',
    usage: {
      input_tokens: 600,
      output_tokens: 50,
      cached_tokens: 200,
      cache_write_tokens: 300,
      total_tokens: 650,
      cost: 0.002685,
      input_tokens_total: 600,
      input_tokens_uncached: 100,
      cache_read_input_tokens: 200,
      cache_write_input_tokens: 300,
      cache_write_5m_input_tokens: 100,
      cache_write_1h_input_tokens: 200,
      cache_metadata_status: 'reported',
      provider: 'anthropic',
      requested_model: 'claude-sonnet-4-5',
      provider_model: 'claude-sonnet-4-5-20260801',
      provider_reported_cost_usd: 0.0026,
      pricing_version: '2026-08-22',
      pricing_tier: 'standard',
      cost_details: { total_usd: 0.002685 },
    },
  });

  expect(items).toHaveLength(1);
  expect(items[0]).toMatchObject({
    type: 'thinking',
    status: 'done',
    usage: {
      input_tokens_total: 600,
      input_tokens_uncached: 100,
      cache_read_input_tokens: 200,
      cache_write_input_tokens: 300,
      cache_write_5m_input_tokens: 100,
      cache_write_1h_input_tokens: 200,
      cache_metadata_status: 'reported',
      provider: 'anthropic',
      provider_reported_cost_usd: 0.0026,
      pricing_version: '2026-08-22',
      pricing_tier: 'standard',
      cost_details: { total_usd: 0.002685 },
    },
  });
});
