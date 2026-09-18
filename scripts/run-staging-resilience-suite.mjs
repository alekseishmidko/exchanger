import { spawnSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
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
 * Последовательно запускает изолированные сценарии, чтобы каждый получил чистые
 * volumes, lease state и timeline. Ненулевой код одного сценария не мешает
 * собрать diagnostics остальных, но итоговый pipeline всё равно завершается
 * ошибкой.
 */
for (const scenario of scenarios) {
  const result = spawnSync(process.execPath, ['scripts/run-staging-resilience.mjs', scenario], {
    cwd: resolve('.'),
    env: process.env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  results.push({ scenario, exitCode: result.status ?? 1 });
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
