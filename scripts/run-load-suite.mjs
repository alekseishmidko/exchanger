import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

/** Полный каталог load-профилей в порядке роста стоимости и интенсивности. */
const profiles = ['smoke', 'average', 'stress', 'spike', 'soak', 'breakpoint'];
const suiteRunId = (
  process.env['LOAD_SUITE_RUN_ID'] ?? randomUUID().replaceAll('-', '').slice(0, 12)
)
  .replace(/[^A-Za-z0-9_-]/g, '')
  .toLowerCase();
const resultDirectory = resolve(
  process.env['LOAD_SUITE_RESULT_DIR'] ?? `artifacts/load/suite-${suiteRunId}`,
);
const startedAt = new Date();

/** Возвращает длительность шага в секундах с достаточной точностью для CI report. */
function seconds(milliseconds) {
  return Number((milliseconds / 1000).toFixed(2));
}

/**
 * Запускает один профиль через штатный runner и не буферизует его вывод.
 *
 * Каждый дочерний run получает отдельные `LOAD_RUN_ID` и `LOAD_RESULT_DIR`,
 * поэтому summaries и raw points разных профилей не перезаписывают друг друга.
 * Ненулевой код фиксируется, но не прерывает suite: оператор получает результаты
 * soak и breakpoint даже тогда, когда более ранний stress обнаружил регрессию.
 */
function runProfile(profile) {
  const profileResultDirectory = resolve(resultDirectory, profile);
  return new Promise((resolveRun) => {
    const child = spawn(process.execPath, ['scripts/run-load-test.mjs', profile], {
      cwd: resolve('.'),
      env: {
        ...process.env,
        LOAD_RUN_ID: `${suiteRunId}-${profile}`,
        LOAD_RESULT_DIR: profileResultDirectory,
      },
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    let completed = false;
    const complete = (exitCode, error) => {
      if (completed) return;
      completed = true;
      resolveRun({ exitCode, error, resultDirectory: profileResultDirectory });
    };
    child.once('error', (error) => complete(1, error.message));
    child.once('close', (code, signal) =>
      complete(code ?? 1, signal ? `process signal: ${signal}` : undefined),
    );
  });
}

/** Сохраняет агрегированный machine-readable и человекочитаемый результат suite. */
async function writeReports(report) {
  const rows = report.results
    .map(
      ({ profile, status, durationSeconds, exitCode, resultDirectory: artifacts }) =>
        `| ${status === 'passed' ? '✅' : '❌'} | ${profile} | ${durationSeconds} | ${exitCode} | \`${artifacts}\` |`,
    )
    .join('\n');
  const summary = `## Load suite: all\n\n**Run:** ${report.runId}  \n**Status:** ${report.status === 'passed' ? '✅ passed' : '❌ failed'}  \n**Duration:** ${report.durationSeconds}s  \n**Artifacts:** \`${resultDirectory}\`\n\n| Status | Profile | Duration, s | Exit | Artifacts |\n| --- | --- | ---: | ---: | --- |\n${rows}\n`;
  await mkdir(resultDirectory, { recursive: true });
  await Promise.all([
    writeFile(
      resolve(resultDirectory, 'suite-report.json'),
      `${JSON.stringify(report, null, 2)}\n`,
    ),
    writeFile(resolve(resultDirectory, 'suite-summary.md'), summary),
  ]);
  process.stdout.write(`\n${summary}`);
}

const results = [];
process.stdout.write(`Load suite: ${profiles.join(', ')}\nArtifacts: ${resultDirectory}\n`);
for (const profile of profiles) {
  const profileStartedAt = Date.now();
  process.stdout.write(`\n=== load:${profile} ===\n`);
  const execution = await runProfile(profile);
  const status = execution.exitCode === 0 ? 'passed' : 'failed';
  results.push({
    profile,
    status,
    exitCode: execution.exitCode,
    durationSeconds: seconds(Date.now() - profileStartedAt),
    resultDirectory: execution.resultDirectory,
    ...(execution.error ? { error: execution.error } : {}),
  });
  process.stdout.write(`\n${status === 'passed' ? '✓' : '✗'} load:${profile}\n`);
}

const finishedAt = new Date();
const failed = results.some(({ status }) => status === 'failed');
await writeReports({
  schemaVersion: 1,
  runId: suiteRunId,
  status: failed ? 'failed' : 'passed',
  startedAt: startedAt.toISOString(),
  finishedAt: finishedAt.toISOString(),
  durationSeconds: seconds(finishedAt.getTime() - startedAt.getTime()),
  results,
});
if (failed) process.exitCode = 1;
