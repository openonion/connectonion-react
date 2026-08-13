/**
 * @jest-environment jsdom
 */

export {};

const ADDR = '0x' + 'a'.repeat(64);
const REGISTRY_KEY = Symbol.for('@connectonion/react.live-agent-registry.v1');

test('does not overwrite an incompatible browser registry', () => {
  const incompatible = { version: 2, liveAgents: new Map() };
  Object.defineProperty(globalThis, REGISTRY_KEY, {
    value: incompatible,
    enumerable: false,
    configurable: false,
    writable: false,
  });

  type CacheModule = typeof import('../src/agent-cache');
  let landingRoute!: CacheModule;
  let sessionRoute!: CacheModule;
  jest.isolateModules(() => {
    landingRoute = require('../src/agent-cache') as CacheModule;
  });
  jest.isolateModules(() => {
    sessionRoute = require('../src/agent-cache') as CacheModule;
  });

  expect(landingRoute.acquireAgent(ADDR, 'safe-fallback')).not.toBe(
    sessionRoute.acquireAgent(ADDR, 'safe-fallback'),
  );
  expect(Object.getOwnPropertyDescriptor(globalThis, REGISTRY_KEY)?.value).toBe(incompatible);
  landingRoute._clearAgentCache();
  sessionRoute._clearAgentCache();
});
