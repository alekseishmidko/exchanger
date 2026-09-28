/** @type {import('jest').Config} */
const shared = {
  rootDir: '.',
  moduleFileExtensions: ['js', 'json', 'ts'],
  transform: { '^.+\\.(t|j)s$': 'ts-jest' },
  testEnvironment: 'node',
  moduleNameMapper: {
    '^@app/(.*)$': '<rootDir>/src/$1',
    '^@exchange/contracts$': '<rootDir>/../../packages/contracts/src/index.ts',
  },
};

/** @type {import('jest').Config} */
module.exports = {
  collectCoverageFrom: ['src/**/*.ts'],
  reporters: ['default', '<rootDir>/../../scripts/jest-required-reporter.cjs'],
  projects: [
    {
      ...shared,
      displayName: 'unit',
      testMatch: ['<rootDir>/src/**/*.spec.ts'],
      testPathIgnorePatterns: ['\\.e2e-spec\\.ts$', '\\.int-spec\\.ts$', '\\.bench\\.spec\\.ts$'],
    },
    {
      ...shared,
      displayName: 'component',
      testMatch: ['<rootDir>/test/**/*.spec.ts'],
      testPathIgnorePatterns: ['\\.e2e-spec\\.ts$', '\\.int-spec\\.ts$'],
    },
    {
      ...shared,
      displayName: 'e2e',
      testMatch: ['<rootDir>/src/**/*.e2e-spec.ts', '<rootDir>/test/**/*.e2e-spec.ts'],
    },
    {
      ...shared,
      displayName: 'integration-postgres',
      testMatch: [
        '<rootDir>/src/modules/ledger/infrastructure/postgres.int-spec.ts',
        '<rootDir>/src/modules/auth/infrastructure/postgres-api-key.registry.int-spec.ts',
      ],
    },
    {
      ...shared,
      displayName: 'integration-redis',
      testMatch: [
        '<rootDir>/src/modules/identity/infrastructure/redis-session.int-spec.ts',
        '<rootDir>/src/modules/realtime-market/infrastructure/redis-quote.int-spec.ts',
      ],
    },
    {
      ...shared,
      displayName: 'benchmark',
      testMatch: ['<rootDir>/src/**/*.bench.spec.ts'],
    },
  ],
};
