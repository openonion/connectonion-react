/**
 * @jest-environment jsdom
 *
 * Next can evaluate the React package in more than one route bundle. Both copies
 * must lease the same RemoteAgent from the page's window, even when a registry
 * Map was created by another JavaScript realm.
 */

const ADDR = '0x' + 'b'.repeat(64);
const REGISTRY_KEY = '__connectonionReactLiveAgentRegistryV2__';

test('isolated browser bundles share a foreign-realm live-agent registry', () => {
  const backing = new Map<string, unknown>();
  const foreignRealmMap = {
    get: backing.get.bind(backing),
    set: backing.set.bind(backing),
    delete: backing.delete.bind(backing),
    keys: backing.keys.bind(backing),
    values: backing.values.bind(backing),
    clear: backing.clear.bind(backing),
    get size() { return backing.size; },
  };
  Object.defineProperty(window, REGISTRY_KEY, {
    value: { version: 2, liveAgents: foreignRealmMap },
    configurable: true,
  });
  const legacyKey = Symbol.for('@connectonion/react.live-agent-registry.v1');
  Object.defineProperty(window, legacyKey, {
    value: { version: 1, liveAgents: foreignRealmMap },
    configurable: true,
  });

  type CacheModule = typeof import('../src/agent-cache');
  let firstModule!: CacheModule;
  let secondModule!: CacheModule;
  jest.isolateModules(() => {
    firstModule = require('../src/agent-cache') as CacheModule;
  });
  jest.isolateModules(() => {
    secondModule = require('../src/agent-cache') as CacheModule;
  });

  const first = firstModule.acquireAgent(ADDR, 'shared-session');
  const second = secondModule.acquireAgent(ADDR, 'shared-session');
  expect(second).toBe(first);

  firstModule._clearAgentCache();
  delete (window as unknown as Record<string, unknown>)[REGISTRY_KEY];
  delete (window as unknown as Record<PropertyKey, unknown>)[legacyKey];
});
