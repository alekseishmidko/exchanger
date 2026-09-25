#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const rootDirectory = resolve(import.meta.dirname, '..');

/** Печатает безопасное диагностическое сообщение без credential payloads. */
function print(message) {
  process.stderr.write(`${message}\n`);
}

/**
 * Проверяет наличие управляемого Redis binary до запуска integration suite.
 *
 * Тест самостоятельно создаёт Redis на ephemeral loopback-порту, выполняет
 * restart и outage, поэтому подключение к постоянно запущенному development
 * Redis не заменяет локальный `redis-server` executable.
 */
const redisProbe = spawnSync('redis-server', ['--version'], {
  cwd: rootDirectory,
  encoding: 'utf8',
});

if (redisProbe.error?.code === 'ENOENT') {
  print('redis:check requires redis-server in PATH. Install Redis and retry.');
  print('macOS: brew install redis');
  print('Ubuntu/Debian: sudo apt-get install redis-server');
  process.exit(1);
}
if (redisProbe.status !== 0) {
  print('redis-server is present but failed its version probe.');
  process.exit(redisProbe.status ?? 1);
}

/** Запускает единственный real-Redis suite с явным opt-in и serial execution. */
const result = spawnSync(
  'corepack',
  [
    'pnpm',
    '--filter',
    '@exchange/backend',
    'exec',
    'jest',
    'src/modules/identity/infrastructure/redis-session.int-spec.ts',
    '--runInBand',
  ],
  {
    cwd: rootDirectory,
    env: { ...process.env, RUN_REDIS_INTEGRATION: 'true' },
    stdio: 'inherit',
  },
);

if (result.error) {
  print(`redis:check could not start Jest: ${result.error.message}`);
  process.exitCode = 1;
} else {
  process.exitCode = result.status ?? 1;
}
