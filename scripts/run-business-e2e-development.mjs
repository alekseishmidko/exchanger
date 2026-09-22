import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const runId = randomUUID().replaceAll('-', '').slice(0, 12);
const projectName = `exchange-business-e2e-${runId}`;
let flowCode = 1;

function run(command, args, options = {}) {
  const child = spawn(command, args, {
    stdio: 'inherit',
    env: { ...process.env, COMPOSE_PROJECT_NAME: projectName, ...options.env },
  });
  return child;
}

function exitCode(child) {
  return new Promise((resolveExit) => child.once('close', (code) => resolveExit(code ?? 1)));
}

try {
  process.stdout.write(`Starting isolated business E2E environment: ${projectName}\n`);
  const up = run('docker', ['compose', '-f', 'docker-compose.development.yml', 'up', '-d', '--build']);
  const upCode = await exitCode(up);
  if (upCode !== 0) throw new Error(`docker compose up завершился с кодом ${upCode}`);
  const flow = run(process.execPath, ['scripts/run-business-e2e.mjs'], {
    env: {
      BUSINESS_E2E_BASE_URL: process.env['BUSINESS_E2E_BASE_URL'] ?? 'http://localhost:5001',
      BUSINESS_E2E_TOPOLOGY: 'development-compose',
      BUSINESS_E2E_REPORT_DIR: process.env['BUSINESS_E2E_REPORT_DIR'] ?? 'artifacts/business-e2e',
      BUSINESS_E2E_SIGKILL_COMMAND:
        process.env['BUSINESS_E2E_SIGKILL_COMMAND'] ??
        'docker compose -f docker-compose.development.yml kill -s SIGKILL backend && docker compose -f docker-compose.development.yml up -d backend',
      BUSINESS_E2E_LOG_COMMAND:
        process.env['BUSINESS_E2E_LOG_COMMAND'] ??
        'docker compose -f docker-compose.development.yml logs --tail=400 backend',
    },
  });
  flowCode = await exitCode(flow);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : 'Business E2E failed'}\n`);
  flowCode = 1;
} finally {
  process.stdout.write(`Stopping isolated business E2E environment: ${projectName}\n`);
  const down = run('docker', [
    'compose',
    '-f',
    'docker-compose.development.yml',
    'down',
    '--volumes',
    '--remove-orphans',
  ]);
  await exitCode(down);
}

if (flowCode !== 0) process.exitCode = 1;
