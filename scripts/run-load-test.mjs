import { spawnSync } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { cpus, totalmem, platform, arch } from 'node:os';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';

/** Разрешённые профили предотвращают shell argument injection. */
const allowedProfiles = new Set(['smoke', 'average', 'stress', 'spike', 'soak', 'breakpoint']);
const profile = process.argv[2] ?? 'smoke';
if (!allowedProfiles.has(profile)) throw new Error(`Неизвестный load profile: ${profile}`);

const runId = (process.env['LOAD_RUN_ID'] ?? randomUUID().replaceAll('-', '').slice(0, 12)).replace(
  /[^A-Za-z0-9_-]/g,
  '',
);
const resultDirectory = resolve(process.env['LOAD_RESULT_DIR'] ?? `artifacts/load/${runId}`);
const composeFiles = [
  '-f',
  'docker-compose.development.yml',
  '-f',
  'docker-compose.observability.yml',
  '-f',
  'docker-compose.load.yml',
];
const startedAt = new Date();
const generatorUid = String(process.getuid?.() ?? 0);
const generatorGid = String(process.getgid?.() ?? 0);

/** Выполняет subprocess без shell и возвращает его exit code. */
function run(command, args, environment = {}) {
  const result = spawnSync(command, args, {
    cwd: resolve('.'),
    env: { ...process.env, ...environment },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  return result.status ?? 1;
}

/** Возвращает текущий commit без ошибки в source archive вне Git. */
function buildSha() {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : (process.env['GITHUB_SHA'] ?? 'unknown');
}

/** Показывает, что image собран не из чистого checkout указанного build SHA. */
function workingTreeDirty() {
  const result = spawnSync('git', ['status', '--porcelain'], { encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim().length > 0 : null;
}

/** Читает JSON endpoint с bounded timeout и не сохраняет credentials. */
async function getJson(url, apiKey) {
  const response = await fetch(url, {
    headers: apiKey ? { 'x-api-key': apiKey } : {},
    signal: AbortSignal.timeout(5000),
  });
  return { status: response.status, body: await response.json().catch(() => null) };
}

/** Извлекает HTTP latency points из streaming JSON output без загрузки soak-файла в память. */
async function latencySeries(path) {
  const points = [];
  const lines = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  let seen = 0;
  for await (const line of lines) {
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (record.type !== 'Point' || record.metric !== 'http_req_duration') continue;
    seen += 1;
    if (points.length < 600) points.push(Number(record.data?.value ?? 0));
    else {
      const replace = seen % 600;
      points[replace] = Number(record.data?.value ?? 0);
    }
  }
  return points;
}

/** Строит автономный SVG latency trend, пригодный для GitHub artifact preview. */
function trendSvg(points) {
  const width = 1000;
  const height = 260;
  const max = Math.max(1, ...points);
  const coordinates = points
    .map((value, index) => {
      const x = points.length < 2 ? 0 : (index / (points.length - 1)) * width;
      const y = height - (value / max) * (height - 20);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="100%" height="100%" fill="#111827"/><polyline fill="none" stroke="#22d3ee" stroke-width="2" points="${coordinates}"/><text x="12" y="22" fill="#f9fafb" font-family="sans-serif" font-size="14">HTTP latency sample, max ${max.toFixed(2)} ms</text></svg>\n`;
}

/** Сравнивает aggregate с версионируемым budget сопоставимого CI-контура. */
function compareBaseline(report, baseline) {
  const failures = [];
  const regressionMultiplier = 1 + baseline.maximumRegressionPercent / 100;
  for (const [name, baselineValue] of Object.entries(baseline.metrics)) {
    const actual = report[name];
    const allowed = baselineValue * regressionMultiplier;
    if (typeof actual !== 'number' || actual > allowed) {
      failures.push({ metric: name, actual: actual ?? null, baseline: baselineValue, allowed });
    }
  }
  return failures;
}

/** Возвращает имена k6 metrics, у которых нарушен хотя бы один threshold. */
function failedThresholds(metrics) {
  return Object.entries(metrics)
    .filter(([, metric]) =>
      Object.values(metric.thresholds ?? {}).some((threshold) => threshold.ok === false),
    )
    .map(([name]) => name)
    .sort();
}

/** Возвращает bounded описание ошибки без stack и чувствительных metadata. */
function safeError(error) {
  if (!(error instanceof Error)) return 'Неизвестная ошибка load runner';
  return `${error.name}: ${error.message}`.slice(0, 1000);
}

await mkdir(resultDirectory, { recursive: true });
// Изолированный runId-каталог должен быть доступен UID из Docker image k6.
// На Linux bind mount сохраняет host permissions, в отличие от Docker Desktop.
await chmod(resultDirectory, 0o777);
const metadata = {
  runId,
  profile,
  distribution: process.env['LOAD_DISTRIBUTION'] ?? 'hot',
  startedAt: startedAt.toISOString(),
  buildSha: buildSha(),
  workingTreeDirty: workingTreeDirty(),
  environment: process.env['LOAD_ENVIRONMENT'] ?? 'development-compose',
  generator: {
    platform: platform(),
    architecture: arch(),
    cpuModel: cpus()[0]?.model ?? 'unknown',
    logicalCpuCount: cpus().length,
    totalMemoryBytes: totalmem(),
    separateContainer: true,
    containerUid: generatorUid,
    containerGid: generatorGid,
  },
  topology: 'k6 container → Docker network → NestJS backend; Prometheus/OTel sidecars',
  dataset: {
    accountIsolation: 'runId',
    expectedAccountId: process.env['LOAD_ACCOUNT_ID'] ?? 'dev-user',
    accountCount: 1,
    instrumentCount: 4,
    quantityBucketCount: 8,
    generatedDuringRun: true,
  },
  configuration: {
    durationOverride: process.env['LOAD_DURATION'] ?? null,
    requestTimeout: process.env['LOAD_REQUEST_TIMEOUT'] ?? '5s',
    websocketSessionMs: Number(process.env['LOAD_WS_SESSION_MS'] ?? 1500),
    gatewayRateLimit: Number(process.env['LOAD_GATEWAY_RATE_LIMIT'] ?? 100000),
  },
};
await writeFile(
  resolve(resultDirectory, 'run-metadata.json'),
  `${JSON.stringify(metadata, null, 2)}\n`,
);

const environment = {
  LOAD_PROFILE: profile,
  LOAD_RUN_ID: runId,
  LOAD_RESULT_DIR: resultDirectory,
  // Linux bind mount проверяет UID/GID процесса внутри контейнера. Передача
  // идентификаторов runner позволяет k6 создавать результаты от имени владельца
  // host-каталога и устраняет permission denied в GitHub Actions.
  LOAD_GENERATOR_UID: generatorUid,
  LOAD_GENERATOR_GID: generatorGid,
};
let loadExit = 1;
let postFailures = [];
let executionStage = 'environment-start';
try {
  if (process.env['LOAD_MANAGE_SUT'] !== 'false') {
    const startExit = run(
      'docker',
      [
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
      ],
      environment,
    );
    if (startExit !== 0) throw new Error('Не удалось запустить load environment');
  }
  executionStage = 'k6-run';
  loadExit = run('docker', ['compose', ...composeFiles, 'run', '--rm', 'k6'], environment);

  executionStage = 'k6-artifacts';
  let summaryText;
  try {
    summaryText = await readFile(resolve(resultDirectory, 'k6-summary.json'), 'utf8');
  } catch {
    throw new Error(
      `k6 не создал k6-summary.json (exit code ${loadExit}); проверьте вывод контейнера выше`,
    );
  }
  const summary = JSON.parse(summaryText);
  const failedK6Thresholds = failedThresholds(summary.metrics);
  const baseline = JSON.parse(
    await readFile(resolve('tests/load/baselines/ci-budget.json'), 'utf8'),
  );
  postFailures = compareBaseline(summary.report, baseline);
  const points = await latencySeries(resolve(resultDirectory, 'raw.json'));
  await writeFile(resolve(resultDirectory, 'latency-trend.svg'), trendSvg(points));

  executionStage = 'post-load-verification';
  const hostBaseUrl = (process.env['LOAD_HOST_BASE_URL'] ?? 'http://localhost:5001').replace(
    /\/+$/,
    '',
  );
  const [reconciliation, projection, metricsResponse] = await Promise.all([
    getJson(
      `${hostBaseUrl}/api/v1/admin/reconciliation`,
      process.env['LOAD_ADMIN_API_KEY'] ?? 'dev-admin-key',
    ),
    getJson(`${hostBaseUrl}/api/v1/projections/metrics`, process.env['LOAD_API_KEY'] ?? 'dev-key'),
    fetch(`${hostBaseUrl}/internal/metrics`, { signal: AbortSignal.timeout(5000) }),
  ]);
  const metricsText = await metricsResponse.text();
  await writeFile(resolve(resultDirectory, 'openmetrics-after.txt'), metricsText);
  if (reconciliation.status !== 200 || reconciliation.body?.auditIntegrity !== true) {
    postFailures.push({
      metric: 'reconciliation.auditIntegrity',
      actual: reconciliation.body?.auditIntegrity ?? null,
      maximum: true,
    });
  }
  const finalReport = {
    ...metadata,
    finishedAt: new Date().toISOString(),
    k6ExitCode: loadExit,
    failedK6Thresholds,
    regressionFailures: postFailures,
    reconciliation: reconciliation.body,
    projection: projection.body,
    runtimeSignals: {
      metricsEndpointStatus: metricsResponse.status,
      eventLoopMetricPresent: metricsText.includes('exchange_nodejs_eventloop_lag'),
      processCpuMetricPresent: metricsText.includes('exchange_process_cpu'),
      processMemoryMetricPresent: metricsText.includes('exchange_process_resident_memory_bytes'),
      gcMetricPresent: metricsText.includes('exchange_nodejs_gc_duration_seconds'),
    },
  };
  await writeFile(
    resolve(resultDirectory, 'report.json'),
    `${JSON.stringify(finalReport, null, 2)}\n`,
  );
  const summaryMarkdown = `## Load test ${profile}\n\n**Run:** ${runId}  \n**Build:** ${metadata.buildSha}  \n**Environment:** ${metadata.environment}  \n**k6:** ${loadExit === 0 ? '✅ passed' : '❌ failed'}  \n**Failed thresholds:** ${failedK6Thresholds.length === 0 ? 'none' : failedK6Thresholds.join(', ')}  \n**Reconciliation:** ${reconciliation.body?.auditIntegrity === true ? '✅ converged' : '❌ failed'}  \n**Regression budget:** ${postFailures.length === 0 ? '✅ passed' : `❌ ${postFailures.length} failures`}  \n**Artifacts:** \`${resultDirectory}\`\n`;
  await writeFile(resolve(resultDirectory, 'summary.md'), summaryMarkdown);
  process.stdout.write(summaryMarkdown);
} catch (error) {
  const diagnostic = safeError(error);
  postFailures.push({ metric: 'runner.execution', stage: executionStage, diagnostic });
  const failureReport = {
    ...metadata,
    finishedAt: new Date().toISOString(),
    status: 'failed',
    k6ExitCode: loadExit,
    failure: { stage: executionStage, diagnostic },
  };
  await writeFile(
    resolve(resultDirectory, 'report.json'),
    `${JSON.stringify(failureReport, null, 2)}\n`,
  );
  const failureSummary = `## Load test ${profile}\n\n**Run:** ${runId}  \n**Status:** ❌ failed  \n**Stage:** ${executionStage}  \n**Diagnostic:** ${diagnostic}  \n**Artifacts:** \`${resultDirectory}\`\n`;
  await writeFile(resolve(resultDirectory, 'summary.md'), failureSummary);
  process.stderr.write(`${failureSummary}\n`);
} finally {
  if (process.env['LOAD_KEEP_ENV'] !== 'true' && process.env['LOAD_MANAGE_SUT'] !== 'false') {
    run('docker', ['compose', ...composeFiles, 'down', '--volumes'], environment);
  }
}

if (loadExit !== 0 || postFailures.length > 0) process.exitCode = 1;
