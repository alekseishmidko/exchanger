#!/usr/bin/env node
import { createServer } from 'node:net';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const rootDir = resolve(import.meta.dirname, '..');
const profile = process.argv[2] ?? 'default';
const runId = `${profile}-${randomUUID().slice(0, 12)}`;
const artifactDir = resolve(rootDir, 'artifacts', 'backend-checks', runId);

/**
 * Печатает строку в stdout без использования console.*.
 *
 * В репозитории console.log/error запрещены security-check'ом, поэтому скрипты
 * используют прямую запись в stdout/stderr. Это оставляет вывод удобным для
 * локального терминала и CI, но не конфликтует с правилом, которое защищает
 * application-код от случайного вывода секретов.
 *
 * @param {string} message Сообщение для вывода.
 */
function print(message = '') {
  process.stdout.write(`${message}\n`);
}

/**
 * Описывает одну проверку backend quality gate.
 *
 * @typedef {object} BackendCheckStep
 * @property {string} name Человекочитаемое имя проверки.
 * @property {string} command Исполняемый файл.
 * @property {string[]} args Аргументы без shell-обработки.
 * @property {NodeJS.ProcessEnv} [env] Дополнительные переменные окружения.
 * @property {boolean} [requiresPostgres] Нужно ли передать POSTGRES_URL.
 */

/**
 * Создаёт описание проверки без shell-композиции.
 *
 * Скрипт намеренно не использует `sh -c`, `&&` и подстановки. Так проще
 * поддерживать кроссплатформенность, а аргументы не проходят через shell,
 * что снижает риск случайного выполнения пользовательских значений.
 *
 * @param {string} name Имя проверки в отчёте.
 * @param {string} command Исполняемый файл.
 * @param {string[]} args Аргументы команды.
 * @param {Partial<BackendCheckStep>} [options] Дополнительные настройки шага.
 * @returns {BackendCheckStep}
 */
function step(name, command, args, options = {}) {
  return { name, command, args, ...options };
}

/**
 * Находит свободный локальный TCP-порт для временного PostgreSQL.
 *
 * Порт нужен только локальному docker-контейнеру, который поднимается на время
 * интеграционного теста durable repository. Если пользователь уже передал
 * POSTGRES_URL, контейнер не создаётся и тест идёт против указанной БД.
 *
 * @returns {Promise<number>} Свободный порт на 127.0.0.1.
 */
function findFreePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => {
        if (typeof address === 'object' && address !== null) {
          resolvePort(address.port);
          return;
        }
        reject(new Error('Cannot allocate local port for PostgreSQL check'));
      });
    });
  });
}

/**
 * Запускает команду и возвращает машинный результат для итогового отчёта.
 *
 * @param {BackendCheckStep} check Проверка, которую надо выполнить.
 * @param {NodeJS.ProcessEnv} baseEnv Базовое окружение suite.
 * @returns {{name: string, status: 'passed' | 'failed', exitCode: number | null, durationMs: number}}
 */
function runStep(check, baseEnv, index) {
  const startedAt = Date.now();
  print('');
  print(`=== ${check.name} ===`);

  const result = spawnSync(check.command, check.args, {
    cwd: rootDir,
    env: { ...process.env, ...baseEnv, ...check.env },
    encoding: 'utf8',
    maxBuffer: 100 * 1024 * 1024,
  });

  const slug = check.name
    .replace(/[^a-z0-9]+/gi, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase();
  const prefix = `${String(index + 1).padStart(2, '0')}-${slug}`;
  const stdoutLog = resolve(artifactDir, `${prefix}.stdout.log`);
  const stderrLog = resolve(artifactDir, `${prefix}.stderr.log`);
  const errorDiagnostic = result.error ? `${result.error.stack ?? result.error.message}\n` : '';
  writeFileSync(stdoutLog, result.stdout ?? '');
  writeFileSync(stderrLog, `${result.stderr ?? ''}${errorDiagnostic}`);
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (errorDiagnostic) process.stderr.write(errorDiagnostic);

  const durationMs = Date.now() - startedAt;
  const exitCode = result.status ?? result.signal ?? 1;
  const status = result.status === 0 ? 'passed' : 'failed';
  const mark = status === 'passed' ? '✓' : '✗';
  print(`${mark} ${check.name} (${(durationMs / 1000).toFixed(2)}s)`);

  return { name: check.name, status, exitCode, durationMs, stdoutLog, stderrLog };
}

/**
 * Запускает временный PostgreSQL-контейнер для локального durable int-spec.
 *
 * GitHub Actions обычно предоставляет PostgreSQL как сервис, но на локальной
 * машине его часто нет. Этот helper делает `pnpm backend:check` самодостаточным:
 * поднимает одноразовую БД, ждёт `pg_isready`, передаёт POSTGRES_URL в тест и
 * удаляет контейнер в `finally`.
 *
 * @returns {Promise<{url: string, containerName: string} | null>} Настройки БД или null, если POSTGRES_URL уже задан.
 */
async function ensurePostgres() {
  if (process.env.POSTGRES_URL) {
    print('POSTGRES_URL already provided; using external PostgreSQL for durable int-spec.');
    return null;
  }

  const port = await findFreePort();
  const containerName = `exchange-backend-check-postgres-${runId}`;
  const password = 'postgres';
  const database = 'exchange';
  const user = 'postgres';

  print(`Starting temporary PostgreSQL container ${containerName} on 127.0.0.1:${port}...`);
  const run = spawnSync(
    'docker',
    [
      'run',
      '--rm',
      '-d',
      '--name',
      containerName,
      '-e',
      `POSTGRES_USER=${user}`,
      '-e',
      `POSTGRES_PASSWORD=${password}`,
      '-e',
      `POSTGRES_DB=${database}`,
      '-p',
      `127.0.0.1:${port}:5432`,
      'postgres:16-alpine',
    ],
    { cwd: rootDir, stdio: 'inherit' },
  );

  if (run.status !== 0) {
    throw new Error('Cannot start temporary PostgreSQL container. Is Docker running?');
  }

  for (let attempt = 1; attempt <= 30; attempt += 1) {
    const ready = spawnSync(
      'docker',
      ['exec', containerName, 'pg_isready', '-U', user, '-d', database],
      {
        cwd: rootDir,
        stdio: 'ignore',
      },
    );
    if (ready.status === 0) {
      return {
        containerName,
        url: `postgresql://${user}:${password}@127.0.0.1:${port}/${database}`,
      };
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 1000));
  }

  throw new Error('Temporary PostgreSQL did not become ready in 30 seconds');
}

/**
 * Удаляет временный PostgreSQL-контейнер после проверки.
 *
 * @param {string | undefined} containerName Имя контейнера.
 */
function cleanupPostgres(containerName) {
  if (!containerName) {
    return;
  }
  print(`Stopping temporary PostgreSQL container ${containerName}...`);
  spawnSync('docker', ['rm', '-f', containerName], { cwd: rootDir, stdio: 'inherit' });
}

const sharedChecks = [
  step('toolchain:check', 'corepack', ['pnpm', 'toolchain:check']),
  step('security:check', 'corepack', ['pnpm', 'security:check']),
  step('maintainability:report', 'corepack', ['pnpm', 'maintainability:report'], {
    env: { MAINTAINABILITY_ENFORCE: 'true' },
  }),
  step('backend:lint', 'corepack', ['pnpm', '--filter', '@exchange/backend', 'lint']),
  step('backend:format:check', 'corepack', [
    'pnpm',
    '--filter',
    '@exchange/backend',
    'format:check',
  ]),
  step('backend:typecheck', 'corepack', ['pnpm', '--filter', '@exchange/backend', 'typecheck']),
  step('contracts:check', 'corepack', ['pnpm', 'contracts:check']),
  step('adversarial:check', 'corepack', ['pnpm', 'adversarial:check']),
  step('observability:check', 'corepack', ['pnpm', 'observability:check']),
  step('load:check', 'corepack', ['pnpm', 'load:check']),
  step('chaos:check', 'corepack', ['pnpm', 'chaos:check']),
  step('chaos:component', 'corepack', ['pnpm', 'chaos:component']),
  step('readiness:check', 'corepack', ['pnpm', 'readiness:check']),
  step(
    'postgres durable int-spec',
    'corepack',
    ['pnpm', '--filter', '@exchange/backend', 'test:integration:postgres'],
    { requiresPostgres: true },
  ),
  step('backend:test', 'corepack', ['pnpm', '--filter', '@exchange/backend', 'test']),
  step('backend:build', 'corepack', ['pnpm', '--filter', '@exchange/backend', 'build']),
];

const fullOnlyChecks = [
  step('ci:check', 'corepack', ['pnpm', 'ci:check']),
  step('redis:check', 'corepack', ['pnpm', 'redis:check']),
  step('container:check', 'corepack', ['pnpm', 'container:check']),
  step('api:flows', 'corepack', ['pnpm', 'api:flows']),
  step('load:smoke', 'node', ['scripts/run-load-test.mjs', 'smoke'], {
    env: {
      LOAD_DURATION: process.env.LOAD_DURATION ?? '15s',
      LOAD_ENVIRONMENT: process.env.LOAD_ENVIRONMENT ?? 'local-backend-check',
    },
  }),
];

/**
 * Portable часть GitHub `verify`, которая обязана одинаково работать локально.
 * CI вызывает этот же профиль вместо собственного расходящегося списка команд.
 */
const verifyChecks = [
  step('toolchain:check', 'corepack', ['pnpm', 'toolchain:check']),
  step('test:options', 'corepack', ['pnpm', 'test:options']),
  step('test:prerequisites', 'corepack', ['pnpm', 'test:prerequisites']),
  step('test:randomized', 'corepack', ['pnpm', 'test:randomized']),
  step('security:check', 'corepack', ['pnpm', 'security:check']),
  step('ci:check', 'corepack', ['pnpm', 'ci:check']),
  step('security:audit:prod', 'corepack', ['pnpm', 'security:audit:prod']),
  step('security:audit:all', 'corepack', ['pnpm', 'security:audit:all']),
  step('maintainability:report', 'corepack', ['pnpm', 'maintainability:report'], {
    env: { MAINTAINABILITY_ENFORCE: 'true' },
  }),
  step('workspace:lint', 'corepack', ['pnpm', 'lint']),
  step('workspace:format:check', 'corepack', ['pnpm', 'format:check']),
  step('workspace:typecheck', 'corepack', ['pnpm', 'typecheck']),
  step('contracts:check', 'corepack', ['pnpm', 'contracts:check']),
  step('adversarial:check', 'corepack', ['pnpm', 'adversarial:check']),
  step('observability:check', 'corepack', ['pnpm', 'observability:check']),
  step('load:check', 'corepack', ['pnpm', 'load:check']),
  step('chaos:check', 'corepack', ['pnpm', 'chaos:check']),
  step('chaos:component', 'corepack', ['pnpm', 'chaos:component']),
  step('readiness:check', 'corepack', ['pnpm', 'readiness:check']),
  step(
    'postgres durable integration',
    'corepack',
    ['pnpm', '--filter', '@exchange/backend', 'test:integration:postgres'],
    { requiresPostgres: true },
  ),
  step('redis:check', 'corepack', ['pnpm', 'redis:check']),
  // Ограниченный пул сохраняет process isolation между suites, но не создаёт
  // resource spike, из-за которого auth admission мог отвечать 503. Более
  // широкий timeout учитывает intentionally adversarial HTTP concurrency tests.
  step('workspace:test', 'corepack', [
    'pnpm',
    '--filter',
    '@exchange/contracts',
    '--filter',
    '@exchange/backend',
    '--workspace-concurrency=1',
    'test',
    '--maxWorkers=2',
    '--testTimeout=15000',
    '--showSeed',
  ]),
  step('workspace:build', 'corepack', ['pnpm', 'build']),
  step('clean-checkout:check', 'corepack', ['pnpm', 'clean-checkout:check']),
  step('security:artifact', 'corepack', ['pnpm', 'security:artifact']),
  step('container:check', 'corepack', ['pnpm', 'container:check']),
];

if (!['default', 'full', 'verify'].includes(profile)) {
  print(`Unknown backend check profile "${profile}". Use "default", "full", or "verify".`);
  process.exit(2);
}

mkdirSync(artifactDir, { recursive: true });
print(`Backend check profile: ${profile}`);
print(`Artifacts: ${artifactDir}`);

const checks =
  profile === 'verify'
    ? verifyChecks
    : profile === 'full'
      ? [...sharedChecks, ...fullOnlyChecks]
      : sharedChecks;
const results = [];
let postgres = null;
let postgresStarted = null;

/** Гарантирует удаление временной БД и при ручной остановке локального verify. */
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    cleanupPostgres(postgresStarted?.containerName);
    process.exit(signal === 'SIGINT' ? 130 : 143);
  });
}

try {
  for (const [index, check] of checks.entries()) {
    if (check.requiresPostgres && !postgres) {
      postgresStarted = await ensurePostgres();
      postgres = postgresStarted?.url ?? process.env.POSTGRES_URL;
    }
    const baseEnv = postgres ? { POSTGRES_URL: postgres } : {};
    const result = runStep(check, baseEnv, index);
    results.push(result);
    if (result.status === 'failed') break;
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  print(`✗ backend check setup failed: ${message}`);
  results.push({ name: 'backend check setup', status: 'failed', exitCode: 1, durationMs: 0 });
} finally {
  cleanupPostgres(postgresStarted?.containerName);
}

const failed = results.filter((result) => result.status === 'failed');
const report = {
  runId,
  profile,
  artifactDir,
  generatedAt: new Date().toISOString(),
  runtime: {
    node: process.version,
    pnpm:
      spawnSync('corepack', ['pnpm', '--version'], {
        cwd: rootDir,
        encoding: 'utf8',
      }).stdout?.trim() ?? 'unknown',
  },
  passed: failed.length === 0,
  plannedChecks: checks.map((check) => check.name),
  remainingChecks: checks.slice(results.length).map((check) => check.name),
  checks: results,
};

writeFileSync(resolve(artifactDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
writeFileSync(
  resolve(artifactDir, 'summary.md'),
  [
    `# Backend checks ${failed.length === 0 ? 'passed' : 'failed'}`,
    '',
    `- Run: \`${runId}\``,
    `- Profile: \`${profile}\``,
    `- Node: \`${report.runtime.node}\``,
    `- pnpm: \`${report.runtime.pnpm}\``,
    `- Passed: ${results.length - failed.length}/${results.length}`,
    `- Planned checks: ${checks.length}`,
    '',
    '| Check | Status | Duration |',
    '| --- | --- | ---: |',
    ...results.map(
      (result) =>
        `| ${result.name} | ${result.status} | ${(result.durationMs / 1000).toFixed(2)}s |`,
    ),
    '',
  ].join('\n'),
);

print('');
if (failed.length > 0) {
  print(`Backend checks failed: ${results.length - failed.length}/${results.length} passed`);
  print(`Reports: ${artifactDir}`);
  process.exit(1);
}

print(`Backend checks passed: ${results.length}/${results.length}`);
print(`Reports: ${artifactDir}`);
