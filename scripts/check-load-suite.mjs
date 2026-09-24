import { readFileSync } from 'node:fs';

/** Файлы, составляющие минимальный исполняемый контракт этапа 16. */
const requiredFiles = [
  'tests/load/main.js',
  'tests/load/lib/profiles.js',
  'tests/load/lib/data.js',
  'tests/load/lib/http.js',
  'tests/load/baselines/ci-budget.json',
  'docker-compose.load.yml',
  'scripts/run-load-suite.mjs',
  'docs/testing/load-testing.md',
];

const failures = [];
for (const file of requiredFiles) {
  try {
    readFileSync(file, 'utf8');
  } catch {
    failures.push(`Отсутствует обязательный файл: ${file}`);
  }
}

if (failures.length === 0) {
  const profiles = readFileSync('tests/load/lib/profiles.js', 'utf8');
  for (const name of ['smoke', 'average', 'stress', 'spike', 'soak', 'breakpoint']) {
    if (!new RegExp(`\\b${name}:`).test(profiles)) failures.push(`Отсутствует профиль ${name}`);
  }
  const main = readFileSync('tests/load/main.js', 'utf8');
  if (!main.includes("'/api/v1/machine-auth/api-keys'")) {
    failures.push('Load setup не использует изолированный machine-auth API key endpoint');
  }
  if (main.includes("'/api/v1/auth/api-keys'")) {
    failures.push('Load setup содержит устаревший human-auth URL для API keys');
  }
  if (!main.includes("scopes: ['admin:*', 'trading:read', 'trading:write']")) {
    failures.push('Load approval identity выпускается без явных минимальных scopes');
  }
  for (const threshold of [
    'http_req_failed{scenario:rest}',
    'http_req_duration{scenario:rest}',
    'load_timeout_rate',
    'load_accepted_to_visible_ms',
    'load_duplicate_effect_rate',
    'load_accepted_visibility_failure_rate',
  ]) {
    if (!main.includes(threshold)) failures.push(`Отсутствует threshold ${threshold}`);
  }
  const runner = readFileSync('scripts/run-load-test.mjs', 'utf8');
  const suite = readFileSync('scripts/run-load-suite.mjs', 'utf8');
  const packageJson = JSON.parse(readFileSync('package.json', 'utf8'));
  const compose = readFileSync('docker-compose.load.yml', 'utf8');
  if (!runner.includes('chmod(resultDirectory, 0o777)')) {
    failures.push('Load runner не подготавливает bind-mount каталог для UID контейнера k6');
  }
  if (!runner.includes('k6 не создал k6-summary.json')) {
    failures.push('Load runner маскирует отсутствие k6 summary вторичной ENOENT-ошибкой');
  }
  if (!runner.includes("resolve(resultDirectory, 'k6-output.log')")) {
    failures.push('Load runner не сохраняет первичный stdout/stderr k6 в artifact');
  }
  if (!runner.includes("'--name', k6ContainerName")) {
    failures.push('Load runner не именует one-off k6 container для гарантированной очистки');
  }
  if (!main.includes("import ws from 'k6/ws'") || !main.includes('socket.setTimeout')) {
    failures.push('WebSocket workload не использует bounded blocking socket lifecycle');
  }
  if (!main.includes('applyDurationOverride(restScenario, durationOverride)')) {
    failures.push('LOAD_DURATION не применяется единообразно к ramping-профилям');
  }
  if (
    !runner.includes('LOAD_GENERATOR_UID: generatorUid') ||
    !runner.includes('LOAD_GENERATOR_GID: generatorGid')
  ) {
    failures.push('Load runner не передаёт host UID/GID в контейнер генератора');
  }
  if (!compose.includes('${LOAD_GENERATOR_UID:-0}:${LOAD_GENERATOR_GID:-0}')) {
    failures.push('Compose не запускает k6 от имени владельца host-каталога artifacts');
  }
  if (!runner.includes('failedK6Thresholds')) {
    failures.push('Load report не перечисляет проваленные k6 thresholds');
  }
  if (!runner.includes("executionStage = 'sut-readiness'")) {
    failures.push('Load runner запускает k6 до host-side readiness barrier');
  }
  for (const name of ['smoke', 'average', 'stress', 'spike', 'soak', 'breakpoint']) {
    if (!suite.includes(`'${name}'`)) failures.push(`Load all suite не запускает профиль ${name}`);
  }
  if (!suite.includes('LOAD_RESULT_DIR: profileResultDirectory')) {
    failures.push('Load all suite не изолирует artifacts отдельных профилей');
  }
  if (packageJson.scripts?.['load:all'] !== 'node scripts/run-load-suite.mjs') {
    failures.push('package.json не публикует команду load:all');
  }
}

if (failures.length > 0) {
  process.stderr.write(`${failures.join('\n')}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write('Load suite contract checks passed.\n');
}
