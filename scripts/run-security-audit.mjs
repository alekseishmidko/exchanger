#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
const mode = process.argv[2] ?? 'all';

if (mode !== 'all' && mode !== 'prod') {
  process.stderr.write('Usage: node scripts/run-security-audit.mjs <all|prod>\n');
  process.exit(2);
}

const args = ['pnpm', 'audit'];
if (mode === 'prod') args.push('--prod');
args.push('--audit-level=moderate');

/**
 * Запускает тот же pnpm audit локально и в CI из корня monorepo.
 *
 * Нулевой retry применяется только по умолчанию: при недоступном registry
 * команда быстро возвращает понятную ошибку вместо ожидания встроенных повторов.
 * Пользователь может явно вернуть retries через npm_config_fetch_retries.
 */
const result = spawnSync('corepack', args, {
  cwd: repositoryRoot,
  encoding: 'utf8',
  env: {
    ...process.env,
    npm_config_fetch_retries: process.env['npm_config_fetch_retries'] ?? '0',
  },
});

if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);

if (result.error) {
  process.stderr.write(`Unable to start pnpm audit: ${result.error.message}\n`);
  process.exit(1);
}

if (result.status !== 0) {
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  if (
    /ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ENETUNREACH|ETIMEDOUT|EPERM|ERR_PNPM_META_FETCH_FAIL/u.test(
      output,
    )
  ) {
    const registry = process.env['npm_config_registry'] ?? 'https://registry.npmjs.org/';
    process.stderr.write(
      `Security audit could not reach ${registry}. Check DNS, proxy/VPN, or npm registry settings.\n`,
    );
  }
  process.exit(result.status ?? 1);
}
