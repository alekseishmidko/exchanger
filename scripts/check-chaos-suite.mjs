import { readFileSync } from 'node:fs';
import { CHAOS_SCENARIOS } from '../tests/chaos/scenarios.mjs';

/** Файлы executable-контракта этапа resilience. */
const requiredFiles = [
  'tests/chaos/scenarios.mjs',
  'scripts/run-chaos-test.mjs',
  'scripts/run-staging-resilience.mjs',
  'scripts/run-staging-resilience-suite.mjs',
  'docker-compose.staging.yml',
  '.env.staging.example',
  'deploy/staging/Caddyfile',
  'deploy/staging/postgres-primary-init.sh',
  'deploy/staging/postgres-standby-entrypoint.sh',
  'deploy/chaos/Dockerfile',
  'apps/backend/test/resilience-chaos.spec.ts',
  'docs/testing/chaos-testing.md',
  'docs/testing/failure-matrix.md',
  'docs/runbooks/dependency-outage.md',
  'docs/runbooks/reconciliation.md',
  '.github/workflows/chaos.yml',
];
const failures = [];

for (const file of requiredFiles) {
  try {
    readFileSync(file, 'utf8');
  } catch {
    failures.push(`Отсутствует обязательный chaos-файл: ${file}`);
  }
}

if (failures.length === 0) {
  const runner = readFileSync('scripts/run-chaos-test.mjs', 'utf8');
  const stagingRunner = readFileSync('scripts/run-staging-resilience.mjs', 'utf8');
  for (const guard of ['CHAOS_ENVIRONMENT', 'CHAOS_ACK', 'isolated-test-only']) {
    if (!runner.includes(guard)) failures.push(`Chaos runner не содержит safety guard ${guard}`);
  }
  for (const artifact of ['report.json', 'timeline.json', 'summary.md']) {
    if (!runner.includes(artifact)) failures.push(`Chaos runner не сохраняет ${artifact}`);
    if (!stagingRunner.includes(artifact)) {
      failures.push(`Staging resilience runner не сохраняет ${artifact}`);
    }
  }
  for (const guard of ['CHAOS_ENVIRONMENT', 'CHAOS_ACK', 'emergencyAbort']) {
    if (!stagingRunner.includes(guard)) {
      failures.push(`Staging resilience runner не содержит safety guard ${guard}`);
    }
  }
  for (const scenario of CHAOS_SCENARIOS) {
    for (const field of ['id', 'status', 'dependency', 'injection', 'expected', 'alert', 'owner']) {
      if (!scenario[field]) failures.push(`Сценарий ${scenario.id} не содержит поле ${field}`);
    }
    if (scenario.status === 'blocked' && !scenario.blockedBy) {
      failures.push(`Blocked-сценарий ${scenario.id} не объясняет блокировку`);
    }
  }
}

if (failures.length > 0) {
  process.stderr.write(`${failures.join('\n')}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write('Chaos suite contract checks passed.\n');
}
