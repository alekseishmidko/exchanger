#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const rootDirectory = resolve(import.meta.dirname, '..');
const authSpec = 'src/modules/auth/human-auth.e2e-spec.ts';
const seeds = Array.from({ length: 10 }, (_, index) => 20260928 + index);
const mode = process.argv[2] ?? 'all';
if (!['all', 'seeds', 'isolation'].includes(mode)) {
  process.stderr.write('Use randomized test mode: all, seeds, or isolation.\n');
  process.exit(2);
}
const authTests = [
  'registers, normalizes email and never exposes credentials or internal roles',
  'uses case-insensitive login, CSRF and per-session revoke',
  'rotates identity after password change and rejects unknown self-service fields',
  'returns the same recovery response for known and unknown email',
  'consumes verification/reset tokens once and invalidates stale sessions',
  'supports logout and logout-all with CSRF and fixation-safe distinct sessions',
  'rejects protected endpoints without human session',
  'allows only the preconfigured isolated test identity and audits admin revoke',
];

function run(args) {
  const result = spawnSync('corepack', args, {
    cwd: rootDirectory,
    env: process.env,
    stdio: 'inherit',
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

if (mode === 'all' || mode === 'seeds') {
  for (const seed of seeds) {
    run([
      'pnpm',
      '--filter',
      '@exchange/backend',
      'exec',
      'jest',
      '--selectProjects',
      'e2e',
      '--runTestsByPath',
      authSpec,
      '--runInBand',
      '--randomize',
      `--seed=${seed}`,
      '--showSeed',
    ]);
  }

  run([
    'pnpm',
    '--filter',
    '@exchange/backend',
    'exec',
    'jest',
    '--selectProjects',
    'component',
    'e2e',
    '--runInBand',
    '--testTimeout=15000',
    '--randomize',
    `--seed=${seeds[0]}`,
    '--showSeed',
  ]);
}

if (mode === 'all' || mode === 'isolation') {
  for (const testName of authTests) {
    run([
      'pnpm',
      '--filter',
      '@exchange/backend',
      'exec',
      'jest',
      '--selectProjects',
      'e2e',
      '--runTestsByPath',
      authSpec,
      '--runInBand',
      '--testNamePattern',
      testName,
    ]);
  }
  run([
    'pnpm',
    '--filter',
    '@exchange/backend',
    'exec',
    'jest',
    '--selectProjects',
    'e2e',
    '--runTestsByPath',
    authSpec,
    '--runInBand',
    '--detectOpenHandles',
    '--testTimeout=15000',
    '--showSeed',
  ]);
}
