module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  setupFiles: ['<rootDir>/tests/setup.ts'],
  testPathIgnorePatterns: ['/node_modules/', '/dist/'],
  transform: {
    // ts-jest forces module=commonjs by default, which drags moduleResolution
    // back to node10 — and node10 cannot see the core package's exports map,
    // so every `connectonion/*` subpath import fails to resolve.
    '^.+\\.tsx?$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.test.json' }],
  },
};
