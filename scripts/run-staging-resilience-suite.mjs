import { spawn } from 'node:child_process';
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

/** Запускает сценарий с потоковым выводом, не накапливая chaos logs в памяти. */
function runScenario(scenario) {
  return new Promise((resolveRun) => {
    const child = spawn(process.execPath, ['scripts/run-staging-resilience.mjs', scenario], {
      cwd: resolve('.'),
      env: process.env,
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    let completed = false;
    const complete = (exitCode, error) => {
      if (completed) return;
      completed = true;
      resolveRun({ exitCode, error });
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
