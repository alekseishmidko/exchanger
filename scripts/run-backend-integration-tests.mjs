#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const rootDirectory = resolve(import.meta.dirname, '..');
const mode = process.argv[2];
if (!['postgres', 'redis', 'all'].includes(mode)) {
  process.stderr.write('Use postgres, redis, or all integration mode.\n');
  process.exit(2);
}

const missing = [];
if ((mode === 'postgres' || mode === 'all') && !process.env['POSTGRES_URL']) {
  missing.push('POSTGRES_URL');
}
if ((mode === 'redis' || mode === 'all') && process.env['RUN_REDIS_INTEGRATION'] !== 'true') {
  missing.push('RUN_REDIS_INTEGRATION=true');
}
if (missing.length > 0) {
  process.stderr.write(`Integration prerequisites are missing: ${missing.join(', ')}\n`);
  process.exit(2);
}

const projects =
  mode === 'all'
    ? ['unit', 'component', 'e2e', 'benchmark', 'integration-postgres', 'integration-redis']
    : [`integration-${mode}`];
const result = spawnSync(
  'corepack',
  [
    'pnpm',
    '--filter',
    '@exchange/backend',
    'exec',
    'jest',
    '--selectProjects',
    ...projects,
    '--runInBand',
    '--testTimeout=15000',
  ],
  { cwd: rootDirectory, env: process.env, stdio: 'inherit' },
);
process.exitCode = result.status ?? 1;
