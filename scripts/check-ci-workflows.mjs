#!/usr/bin/env node
import { readFileSync } from 'node:fs';

const workflow = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
const localVerify = readFileSync(new URL('./run-backend-checks.mjs', import.meta.url), 'utf8');
const containerCheck = readFileSync(new URL('./run-container-check.mjs', import.meta.url), 'utf8');
const apiFlowRunner = readFileSync(new URL('./run-api-flows-development.mjs', import.meta.url), 'utf8');
const apiFlowCompose = readFileSync(
  new URL('../docker-compose.api-flows.yml', import.meta.url),
  'utf8',
);
const dockerfile = readFileSync(new URL('../Dockerfile', import.meta.url), 'utf8');
const failures = [];

/** Возвращает YAML-блок шага по его имени до следующего шага. */
function stepBlock(name) {
  const marker = `- name: ${name}`;
  const start = workflow.indexOf(marker);
  if (start < 0) return '';
  const next = workflow.indexOf('\n      - name:', start + marker.length);
  return workflow.slice(start, next < 0 ? workflow.length : next);
}

const parityVerify = stepBlock('Local and CI parity verification');
if (!/run:\s*pnpm verify:local/.test(parityVerify))
  failures.push('CI verify job must call the same verify:local command used by developers');

for (const requiredCheck of [
  'security:audit:prod',
  'security:audit:all',
  'workspace:lint',
  'workspace:format:check',
  'workspace:typecheck',
  'postgres durable integration',
  'redis:check',
  'workspace:test',
  'workspace:build',
  'security:artifact',
  'container:check',
]) {
  if (!localVerify.includes(`'${requiredCheck}'`))
    failures.push(`verify:local is missing required check: ${requiredCheck}`);
}

if (!containerCheck.includes("'fs'") || !containerCheck.includes("'image'"))
  failures.push('container:check must scan both filesystem/IaC and the production image');

const secretScan = stepBlock('Secret scanning');
if (!/GITHUB_TOKEN:\s*\$\{\{\s*secrets\.GITHUB_TOKEN\s*\}\}/.test(secretScan))
  failures.push('Gitleaks PR scan must receive GITHUB_TOKEN');
if (!/fetch-depth:\s*0/.test(workflow)) failures.push('Secret scan requires full Git history');
if (!workflow.includes('Install Redis integration test binary'))
  failures.push('CI must install the redis-server binary required by verify:local');

if (!apiFlowRunner.includes("'docker-compose.api-flows.yml'"))
  failures.push('API flow runner must use the isolated immutable Compose file');
if (!/target:\s*api-flows/.test(apiFlowCompose))
  failures.push('API flow Compose must build the immutable api-flows Docker target');
if (/pnpm install|node_modules:\/workspace/.test(apiFlowCompose))
  failures.push('API flow Compose must not install dependencies at runtime or mount node_modules');
if (
  !/FROM base AS api-flows[\s\S]*pnpm --filter @exchange\/contracts build[\s\S]*pnpm --filter @exchange\/backend build/.test(
    dockerfile,
  )
)
  failures.push('Dockerfile api-flows target must prebuild contracts and backend');
if (!workflow.includes('Show API flow backend logs'))
  failures.push('CI must expose sanitized API flow backend diagnostics on failure');

if (failures.length > 0) {
  process.stderr.write(
    `CI workflow contract failed:\n${failures.map((item) => `- ${item}`).join('\n')}\n`,
  );
  process.exitCode = 1;
} else {
  process.stdout.write('CI workflow contract checks passed.\n');
}
