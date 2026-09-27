import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { resolve } from 'node:path';

const scenarios = [
  'network-faults',
  'postgres-failover',
  'durable-process-kill',
  'postgres-contention',
  'resource-pressure',
  'rolling-ownership',
  'controls-under-load',
];
const results = [];

/**
 * Просит ОС выделить свободный loopback port для одного ephemeral topology.
 * Suite не переиспользует staging defaults, поэтому может работать рядом с
 * ручным staging/development environment без collision на host networking.
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
        reject(new Error('Не удалось выделить host port для resilience scenario'));
      });
    });
  });
}

/** Выделяет разные host ports всем опубликованным staging services. */
async function scenarioPorts() {
  const names = [
    'STAGING_HTTP_PORT',
    'STAGING_HTTPS_PORT',
    'TOXIPROXY_HOST_PORT',
    'STAGING_PROMETHEUS_PORT',
    'STAGING_GRAFANA_PORT',
  ];
  const values = await Promise.all(names.map(() => findFreePort()));
  return Object.fromEntries(names.map((name, index) => [name, String(values[index])]));
}

/**
 * Запускает сценарий с потоковым выводом, не накапливая chaos logs в памяти.
 *
 * Сам вызов `resilience:all` является явным запуском isolated fault suite,
 * поэтому orchestrator передаёт interlock дочернему runner. Если caller задал
 * другое CHAOS_ENVIRONMENT/CHAOS_ACK, значение сохраняется и child fail-closed
 * отклоняет его. Одиночные scenario-команды этот interlock не получают.
 */
async function runScenario(scenario) {
  const ports = await scenarioPorts();
  const childEnvironment = {
    ...process.env,
    ...ports,
    CHAOS_ENVIRONMENT: process.env['CHAOS_ENVIRONMENT'] ?? 'staging',
    CHAOS_ACK: process.env['CHAOS_ACK'] ?? 'isolated-test-only',
  };
  return new Promise((resolveRun) => {
    const child = spawn(process.execPath, ['scripts/run-staging-resilience.mjs', scenario], {
      cwd: resolve('.'),
      env: childEnvironment,
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    let completed = false;
    const complete = (exitCode, error) => {
      if (completed) return;
      completed = true;
      resolveRun({ exitCode, error, ports });
    };
    child.once('error', (error) => complete(1, error.message));
    child.once('close', (code, signal) =>
      complete(code ?? 1, signal ? `process signal: ${signal}` : undefined),
    );
  });
}

/**
 * Последовательно запускает изолированные сценарии, чтобы каждый получил чистые
 * volumes, lease state и timeline. Ненулевой код одного сценария не мешает
 * собрать diagnostics остальных, но итоговый pipeline всё равно завершается
 * ошибкой.
 */
for (const scenario of scenarios) {
  const startedAt = Date.now();
  const result = await runScenario(scenario);
  results.push({
    scenario,
    exitCode: result.exitCode,
    durationSeconds: Number(((Date.now() - startedAt) / 1000).toFixed(2)),
    ports: result.ports,
    ...(result.error ? { error: result.error } : {}),
  });
}

const output = resolve('artifacts/resilience');
await mkdir(output, { recursive: true });
const failed = results.filter(({ exitCode }) => exitCode !== 0);
const summary = `## Staging resilience suite\n\n${results
  .map(({ scenario, exitCode }) => `- ${exitCode === 0 ? '✅' : '❌'} ${scenario}`)
  .join('\n')}\n`;
await Promise.all([
  writeFile(resolve(output, 'suite-report.json'), `${JSON.stringify({ results }, null, 2)}\n`),
  writeFile(resolve(output, 'suite-summary.md'), summary),
]);
process.stdout.write(summary);
if (failed.length > 0) process.exitCode = 1;
