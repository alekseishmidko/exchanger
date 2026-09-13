import { readFileSync } from 'node:fs';

/** Файлы, составляющие минимальный исполняемый контракт этапа 16. */
const requiredFiles = [
  'tests/load/main.js',
  'tests/load/lib/profiles.js',
  'tests/load/lib/data.js',
  'tests/load/lib/http.js',
  'tests/load/baselines/ci-budget.json',
  'docker-compose.load.yml',
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
  for (const threshold of [
    'http_req_failed{scenario:rest}',
    'http_req_duration{scenario:rest}',
    'load_timeout_rate',
    'load_accepted_to_visible_ms',
    'load_duplicate_effect_rate',
  ]) {
    if (!main.includes(threshold)) failures.push(`Отсутствует threshold ${threshold}`);
  }
  const runner = readFileSync('scripts/run-load-test.mjs', 'utf8');
  const compose = readFileSync('docker-compose.load.yml', 'utf8');
  if (!runner.includes('chmod(resultDirectory, 0o777)')) {
    failures.push('Load runner не подготавливает bind-mount каталог для UID контейнера k6');
  }
  if (!runner.includes('k6 не создал k6-summary.json')) {
    failures.push('Load runner маскирует отсутствие k6 summary вторичной ENOENT-ошибкой');
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
}

if (failures.length > 0) {
  process.stderr.write(`${failures.join('\n')}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write('Load suite contract checks passed.\n');
}
