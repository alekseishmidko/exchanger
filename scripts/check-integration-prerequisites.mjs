#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const rootDirectory = resolve(import.meta.dirname, '..');

for (const [mode, variable] of [
  ['postgres', 'POSTGRES_URL'],
  ['redis', 'RUN_REDIS_INTEGRATION'],
]) {
  const env = { ...process.env };
  delete env[variable];
  const result = spawnSync('node', ['scripts/run-backend-integration-tests.mjs', mode], {
    cwd: rootDirectory,
    env,
    encoding: 'utf8',
  });
  if (result.status !== 2 || !result.stderr.includes('Integration prerequisites are missing')) {
    process.stderr.write(
      `${mode} integration did not fail fast without ${variable}; exit=${result.status}\n`,
    );
    process.exit(1);
  }
}

process.stdout.write(
  'PostgreSQL and Redis integration commands fail fast without prerequisites.\n',
);
