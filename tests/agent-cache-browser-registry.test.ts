/**
 * @jest-environment jsdom
 *
 * Browser bundlers can evaluate agent-cache once per route. These tests model
 * those isolated modules while keeping the browser realm shared.
 */

export {};

const ADDR = '0x' + 'a'.repeat(64);
const REGISTRY_KEY = '__connectonionReactLiveAgentRegistryV3__';
type CacheModule = typeof import('../src/agent-cache');

function isolatedCacheModule(): CacheModule {
  let cache!: CacheModule;
  jest.isolateModules(() => {
    cache = require('../src/agent-cache') as CacheModule;
  });
  return cache;
}

test('shares an agent across isolated module instances in one browser realm', () => {
  const landingRoute = isolatedCacheModule();
  const sessionRoute = isolatedCacheModule();

  const landingAgent = landingRoute.acquireAgent(ADDR, 'shared-session');
  const sessionAgent = sessionRoute.acquireAgent(ADDR, 'shared-session');

  expect(sessionAgent).toBe(landingAgent);
  expect(Object.getOwnPropertyDescriptor(document, REGISTRY_KEY)).toMatchObject({
    enumerable: false,
    configurable: false,
    writable: false,
  });

  sessionRoute._clearAgentCache();
  expect(landingRoute.acquireAgent(ADDR, 'shared-session')).not.toBe(landingAgent);
  landingRoute._clearAgentCache();
});
