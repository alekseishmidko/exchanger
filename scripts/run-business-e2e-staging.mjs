import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const runId = randomUUID().replaceAll('-', '').slice(0, 12);
const projectName = `exchange-business-e2e-staging-${runId}`;
const buyerKey = `staging-buyer-${runId}-key`;
const sellerKey = `staging-seller-${runId}-key`;
const gatewayApiKeys = [
  'staging-admin-key:admin:staging-admin',
  'staging-admin-2-key:admin:staging-admin-2',
  'staging-risk-key:risk_manager:staging-risk',
  `${buyerKey}:trader:buyer-${runId}`,
  `${sellerKey}:trader:seller-${runId}`,
].join(',');
let flowCode = 1;

function run(command, args, options = {}) {
  return spawn(command, args, {
    stdio: 'inherit',
    env: {
      ...process.env,
      COMPOSE_PROJECT_NAME: projectName,
      GATEWAY_API_KEYS: gatewayApiKeys,
      ...options.env,
    },
  });
}

function exitCode(child) {
  return new Promise((resolveExit) => child.once('close', (code) => resolveExit(code ?? 1)));
}

try {
  process.stdout.write(`Starting isolated staging business E2E environment: ${projectName}\n`);
  const up = run('docker', ['compose', '-f', 'docker-compose.staging.yml', 'up', '-d', '--build']);
  const upCode = await exitCode(up);
  if (upCode !== 0) throw new Error(`docker compose staging up завершился с кодом ${upCode}`);

  const flow = run(process.execPath, ['scripts/run-business-e2e.mjs'], {
    env: {
      BUSINESS_E2E_RUN_ID: runId,
      BUSINESS_E2E_BASE_URL: process.env['BUSINESS_E2E_BASE_URL'] ?? 'http://localhost:5080',
      BUSINESS_E2E_WS_URL: process.env['BUSINESS_E2E_WS_URL'] ?? 'ws://localhost:5080/market-data',
      BUSINESS_E2E_TOPOLOGY: 'staging-compose',
      BUSINESS_E2E_REPORT_DIR:
        process.env['BUSINESS_E2E_REPORT_DIR'] ?? 'artifacts/business-e2e-staging',
      BUSINESS_E2E_ADMIN_KEY: process.env['BUSINESS_E2E_ADMIN_KEY'] ?? 'staging-admin-key',
      BUSINESS_E2E_SECOND_ADMIN_KEY:
        process.env['BUSINESS_E2E_SECOND_ADMIN_KEY'] ?? 'staging-admin-2-key',
      BUSINESS_E2E_BUYER_KEY: process.env['BUSINESS_E2E_BUYER_KEY'] ?? buyerKey,
      BUSINESS_E2E_SELLER_KEY: process.env['BUSINESS_E2E_SELLER_KEY'] ?? sellerKey,
      BUSINESS_E2E_SIGKILL_COMMAND:
        process.env['BUSINESS_E2E_SIGKILL_COMMAND'] ??
        'docker compose -f docker-compose.staging.yml kill -s SIGKILL backend-a && docker compose -f docker-compose.staging.yml up -d backend-a',
      BUSINESS_E2E_LOG_COMMAND:
        process.env['BUSINESS_E2E_LOG_COMMAND'] ??
        'docker compose -f docker-compose.staging.yml logs --tail=500 backend-a backend-b ingress migrate',
    },
  });
  flowCode = await exitCode(flow);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : 'Business E2E staging failed'}\n`);
  flowCode = 1;
} finally {
  process.stdout.write(`Stopping isolated staging business E2E environment: ${projectName}\n`);
  const down = run('docker', [
    'compose',
    '-f',
    'docker-compose.staging.yml',
    'down',
    '--volumes',
    '--remove-orphans',
  ]);
  await exitCode(down);
}

if (flowCode !== 0) process.exitCode = 1;
