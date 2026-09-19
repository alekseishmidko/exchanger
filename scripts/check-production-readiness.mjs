import { readFileSync } from 'node:fs';

/** Файлы, необходимые для воспроизводимой production-readiness qualification. */
const requiredFiles = [
  'docs/operations/capacity-plan.md',
  'docs/operations/production-readiness-report-template.md',
  'docs/operations/capacity-trends.md',
  'docs/observability/slo.md',
  'docs/testing/load-testing.md',
  'docs/testing/chaos-testing.md',
  'docs/testing/adversarial-cases.md',
  'docs/runbooks/emergency-stop.md',
  'docs/runbooks/postgres-backup-restore.md',
  'tests/load/baselines/ci-budget.json',
];

const failures = [];

function readRequired(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    failures.push(`Отсутствует обязательный файл: ${path}`);
    return '';
  }
}

for (const file of requiredFiles) readRequired(file);

const packageJson = readRequired('package.json');
for (const scriptName of [
  'api:flows',
  'load:smoke',
  'load:average',
  'load:spike',
  'load:soak',
  'chaos:check',
  'resilience:staging',
  'adversarial:check',
  'postgres:backup-restore',
]) {
  if (!packageJson.includes(`"${scriptName}"`))
    failures.push(`package.json не содержит ${scriptName}`);
}

const ci = readRequired('.github/workflows/ci.yml');
for (const check of [
  'pnpm contracts:check',
  'pnpm adversarial:check',
  'pnpm observability:check',
  'pnpm load:check',
  'pnpm chaos:check',
  'pnpm test',
  'pnpm build',
]) {
  if (!ci.includes(check)) failures.push(`CI не запускает ${check}`);
}

const loadWorkflow = readRequired('.github/workflows/load.yml');
if (!loadWorkflow.includes('profile: [stress, soak]')) {
  failures.push('Scheduled load workflow не содержит stress/soak matrix');
}

const chaosWorkflow = readRequired('.github/workflows/chaos.yml');
if (!chaosWorkflow.includes('pnpm resilience:staging')) {
  failures.push('Scheduled chaos workflow не запускает durable staging resilience suite');
}

const capacityPlan = readRequired('docs/operations/capacity-plan.md');
for (const term of ['headroom', 'N+1', 'Causal autoscaling policy', 'Cost model', 'Owners']) {
  if (!capacityPlan.includes(term)) failures.push(`capacity-plan.md не описывает ${term}`);
}

const reportTemplate = readRequired('docs/operations/production-readiness-report-template.md');
for (const term of [
  'Go/no-go decision',
  'Capacity evidence',
  'Release qualification suites',
  'Risk accepted',
]) {
  if (!reportTemplate.includes(term))
    failures.push(`production-readiness template не содержит ${term}`);
}

if (failures.length > 0) {
  process.stderr.write(`${failures.join('\n')}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write('Production-readiness qualification contract checks passed.\n');
}
