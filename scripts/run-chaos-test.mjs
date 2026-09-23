import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chaosScenario } from '../tests/chaos/scenarios.mjs';

const scenarioId = process.argv[2] ?? 'observability-outage';
const scenario = chaosScenario(scenarioId);
if (!scenario) throw new Error(`Неизвестный chaos scenario: ${scenarioId}`);
if (scenario.status !== 'automated') {
  throw new Error(
    `Сценарий ${scenarioId} нельзя запустить: ${scenario.blockedBy ?? scenario.status}`,
  );
}

const environmentName = process.env['CHAOS_ENVIRONMENT'] ?? '';
const allowedEnvironments = new Set([
  'test',
  'staging',
  'development-compose',
  'github-actions-chaos',
]);
if (
  !allowedEnvironments.has(environmentName) ||
  process.env['CHAOS_ACK'] !== 'isolated-test-only'
) {
  throw new Error(
    'Chaos injection запрещён: задайте CHAOS_ENVIRONMENT=test|staging|development-compose|github-actions-chaos и CHAOS_ACK=isolated-test-only',
  );
}

const runId = (process.env['CHAOS_RUN_ID'] ?? randomUUID().replaceAll('-', '').slice(0, 12))
  .replace(/[^A-Za-z0-9_-]/g, '')
  .toLowerCase();
const seed = process.env['CHAOS_SEED'] ?? runId;
const resultDirectory = resolve(process.env['CHAOS_RESULT_DIR'] ?? `artifacts/chaos/${runId}`);
const loadDirectory = resolve(resultDirectory, 'load');
const hostBaseUrl = (process.env['CHAOS_BASE_URL'] ?? 'http://localhost:5001').replace(/\/+$/, '');
const composeFiles = [
  '-f',
  'docker-compose.development.yml',
  '-f',
  'docker-compose.observability.yml',
  '-f',
  'docker-compose.load.yml',
];
const environment = {
  COMPOSE_PROJECT_NAME: `exchange-chaos-${runId}`,
  LOAD_ENVIRONMENT: environmentName,
};
const timeline = [];
const startedAt = new Date();

/** Добавляет детерминированную операцию в машиночитаемый timeline. */
function mark(event, details = {}) {
  timeline.push({
    at: new Date().toISOString(),
    offsetMs: Date.now() - startedAt.getTime(),
    event,
    ...details,
  });
}

/** Выполняет команду без shell и возвращает exit code. */
function run(command, args, extraEnvironment = {}) {
  const result = spawnSync(command, args, {
    cwd: resolve('.'),
    env: { ...process.env, ...environment, ...extraEnvironment },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  return result.status ?? 1;
}

/** Читает вывод команды, не печатая потенциальный canary secret в job log. */
function capture(command, args) {
  const result = spawnSync(command, args, {
    cwd: resolve('.'),
    env: { ...process.env, ...environment },
    encoding: 'utf8',
  });
  return { code: result.status ?? 1, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

/** Ограниченная задержка используется только внутри versioned chaos timeline. */
function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

/** Ожидает HTTP status без бесконечного retry и возвращает фактический RTO. */
async function waitForHttp(url, expectedStatus, timeoutMs) {
  const started = performance.now();
  let lastStatus = 0;
  while (performance.now() - started < timeoutMs) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2000) });
      lastStatus = response.status;
      if (lastStatus === expectedStatus) return Math.round(performance.now() - started);
    } catch {
      lastStatus = 0;
    }
    await delay(500);
  }
  throw new Error(`${url} не достиг HTTP ${expectedStatus}; последний status=${lastStatus}`);
}

/** Выполняет авторизованный JSON GET без записи credential в artifacts. */
async function getJson(path, apiKey) {
  const response = await fetch(`${hostBaseUrl}${path}`, {
    headers: { 'x-api-key': apiKey },
    signal: AbortSignal.timeout(5000),
  });
  return { status: response.status, body: await response.json().catch(() => null) };
}

/**
 * Запускает k6 отдельным процессом, пока основной runner управляет fault timeline.
 * Вывод сохраняется bounded, чтобы retry storm не исчерпал память orchestrator.
 */
async function startLoad() {
  const chunks = [];
  let bytes = 0;
  const maximumBytes = 2 * 1024 * 1024;
  const child = spawn(process.execPath, ['scripts/run-load-test.mjs', 'average'], {
    cwd: resolve('.'),
    env: {
      ...process.env,
      ...environment,
      LOAD_MANAGE_SUT: 'false',
      LOAD_DURATION: process.env['CHAOS_LOAD_DURATION'] ?? '20s',
      LOAD_WS_SESSION_MS: process.env['CHAOS_WS_SESSION_MS'] ?? '500',
      LOAD_RESULT_DIR: loadDirectory,
      LOAD_RUN_ID: runId,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const collect = (chunk) => {
    process.stdout.write(chunk);
    if (bytes >= maximumBytes) return;
    const value = Buffer.from(chunk);
    chunks.push(value.subarray(0, maximumBytes - bytes));
    bytes += value.length;
  };
  child.stdout.on('data', collect);
  child.stderr.on('data', collect);
  const completion = new Promise((resolveCompletion) => {
    child.once('error', (error) => resolveCompletion({ code: 1, error: error.message }));
    child.once('close', (code) => resolveCompletion({ code: code ?? 1 }));
  });
  return { child, completion, output: () => Buffer.concat(chunks).toString('utf8') };
}

await mkdir(loadDirectory, { recursive: true });
await chmod(resultDirectory, 0o777);
const report = {
  schemaVersion: 1,
  runId,
  seed,
  scenario: scenarioId,
  environment: environmentName,
  startedAt: startedAt.toISOString(),
  status: 'failed',
  rtoMs: null,
  rpoAcceptedCommandsLost: null,
  failures: [],
  timeline,
};
let loadProcess;

try {
  mark('environment.start');
  const startCode = run('docker', [
    'compose',
    ...composeFiles,
    'up',
    '-d',
    '--build',
    'backend',
    'otel-collector',
    'tempo',
    'prometheus',
    'alertmanager',
    'grafana',
  ]);
  if (startCode !== 0) throw new Error('Не удалось запустить изолированное chaos-окружение');
  const startupMs = await waitForHttp(`${hostBaseUrl}/health/ready`, 200, 120_000);
  mark('environment.ready', { durationMs: startupMs });

  const canarySecret = `chaos-canary-${runId}`;
  await fetch(`${hostBaseUrl}/api/v1/machine-auth/me`, {
    headers: { 'x-api-key': canarySecret },
    signal: AbortSignal.timeout(5000),
  });
  loadProcess = await startLoad();
  mark('load.started');
  await delay(Number(process.env['CHAOS_INJECT_AFTER_MS'] ?? 5000));

  mark('fault.inject', { target: 'observability' });
  if (
    run('docker', [
      'compose',
      ...composeFiles,
      'stop',
      'otel-collector',
      'tempo',
      'prometheus',
      'alertmanager',
      'grafana',
    ]) !== 0
  ) {
    throw new Error('Не удалось остановить observability services');
  }
  const degradedReady = await fetch(`${hostBaseUrl}/health/ready`, {
    signal: AbortSignal.timeout(5000),
  });
  if (degradedReady.status !== 200) {
    report.failures.push(`observability outage изменил readiness: HTTP ${degradedReady.status}`);
  }
  mark('fault.hold', { readinessStatus: degradedReady.status });
  await delay(Number(process.env['CHAOS_FAULT_DURATION_MS'] ?? 5000));

  const recoveryStarted = performance.now();
  mark('fault.recover');
  if (
    run('docker', [
      'compose',
      ...composeFiles,
      'start',
      'otel-collector',
      'tempo',
      'prometheus',
      'alertmanager',
      'grafana',
    ]) !== 0
  ) {
    throw new Error('Не удалось восстановить observability services');
  }
  await waitForHttp('http://localhost:9090/-/ready', 200, 60_000);
  report.rtoMs = Math.round(performance.now() - recoveryStarted);
  mark('fault.recovered', { rtoMs: report.rtoMs });

  const loadResult = await loadProcess.completion;
  const loadOutput = loadProcess.output();
  await writeFile(resolve(resultDirectory, 'load-output.log'), loadOutput);
  mark('load.finished', { exitCode: loadResult.code });
  if (loadResult.code !== 0) report.failures.push(`k6 load завершился с code ${loadResult.code}`);

  const loadReport = JSON.parse(await readFile(resolve(loadDirectory, 'report.json'), 'utf8'));
  const k6Summary = JSON.parse(await readFile(resolve(loadDirectory, 'k6-summary.json'), 'utf8'));
  const acceptedCommands = Number(k6Summary.report?.acceptedCommands ?? 0);
  const duplicateEffectRate = Number(k6Summary.report?.duplicateEffectRate ?? 1);
  const acceptedVisibilityFailureRate = Number(
    k6Summary.report?.acceptedVisibilityFailureRate ?? 1,
  );
  report.acceptedCommands = acceptedCommands;
  if (acceptedCommands < 1) report.failures.push('под fault не принято ни одной команды');
  if (
    duplicateEffectRate !== 0 ||
    acceptedVisibilityFailureRate !== 0 ||
    loadReport.failedK6Thresholds?.length > 0 ||
    loadReport.regressionFailures?.length > 0
  ) {
    report.failures.push('load thresholds/idempotency/reconciliation содержит ошибки');
  } else {
    report.rpoAcceptedCommandsLost = 0;
  }

  const reconciliation = await getJson('/api/v1/admin/reconciliation', 'dev-admin-key');
  report.reconciliation = reconciliation.body;
  if (reconciliation.status !== 200 || reconciliation.body?.auditIntegrity !== true) {
    report.failures.push('post-chaos reconciliation не сошлась');
  }

  const backendLogs = capture('docker', [
    'compose',
    ...composeFiles,
    'logs',
    '--no-color',
    'backend',
  ]);
  const secretLeaked = backendLogs.output.includes(canarySecret);
  const sanitizedLogs = backendLogs.output.replaceAll(canarySecret, '[REDACTED_CANARY]');
  await writeFile(resolve(resultDirectory, 'backend.log'), sanitizedLogs);
  report.secretLeakDetected = secretLeaked;
  if (secretLeaked) report.failures.push('canary secret обнаружен в backend logs');

  report.status = report.failures.length === 0 ? 'passed' : 'failed';
} catch (error) {
  report.failures.push(error instanceof Error ? error.message : 'Неизвестная ошибка chaos runner');
  mark('runner.failed');
} finally {
  if (loadProcess?.child && loadProcess.child.exitCode === null) loadProcess.child.kill('SIGTERM');
  report.finishedAt = new Date().toISOString();
  const summary = `## Chaos: ${scenarioId}\n\n**Status:** ${report.status === 'passed' ? '✅ passed' : '❌ failed'}  \n**Run:** ${runId}  \n**Seed:** ${seed}  \n**Environment:** ${environmentName}  \n**RTO:** ${report.rtoMs ?? 'n/a'} ms  \n**RPO:** ${report.rpoAcceptedCommandsLost ?? 'n/a'} accepted commands lost  \n**Failures:** ${report.failures.length}\n`;
  await Promise.all([
    writeFile(resolve(resultDirectory, 'report.json'), `${JSON.stringify(report, null, 2)}\n`),
    writeFile(resolve(resultDirectory, 'timeline.json'), `${JSON.stringify(timeline, null, 2)}\n`),
    writeFile(resolve(resultDirectory, 'summary.md'), summary),
  ]);
  process.stdout.write(summary);
  run('docker', ['compose', ...composeFiles, 'down', '--volumes']);
}

if (report.status !== 'passed') process.exitCode = 1;
