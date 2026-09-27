import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { resolve } from 'node:path';

const runId = randomUUID().replaceAll('-', '').slice(0, 12).toLowerCase();
const projectName = `exchange-api-flows-${runId}`;
const composeArgs = ['compose', '-f', 'docker-compose.development.yml'];
const reportDirectory = resolve(process.env['API_FLOW_REPORT_DIR'] ?? 'artifacts/api-flows');

/**
 * Просит ОС выбрать свободный loopback-порт для изолированного backend.
 *
 * Development Compose по умолчанию публикует `5001`, но quality gate должен
 * работать одновременно с уже запущенной консолью разработчика. Порт закрывается
 * непосредственно перед `docker compose up`; отдельный project name изолирует
 * containers/network/volumes, а per-run host port изолирует networking.
 *
 * @returns {Promise<number>} Свободный TCP-порт на 127.0.0.1.
 */
function findFreePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => {
        if (typeof address === 'object' && address !== null) {
          resolvePort(address.port);
          return;
        }
        reject(new Error('Не удалось выделить host port для API flow environment'));
      });
    });
  });
}

/**
 * Позволяет явно закрепить порт через API_FLOW_HOST_PORT, сохраняя dynamic port
 * безопасным default. Dedicated variable не переиспользует BACKEND_HOST_PORT
 * работающего development environment.
 *
 * @returns {Promise<number>} Проверенный explicit либо выделенный ОС порт.
 */
async function resolveBackendHostPort() {
  const configured = process.env['API_FLOW_HOST_PORT'];
  if (!configured) return findFreePort();
  const port = Number(configured);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('API_FLOW_HOST_PORT должен быть целым числом от 1 до 65535');
  }
  return port;
}

const backendHostPort = await resolveBackendHostPort();
const environment = {
  ...process.env,
  COMPOSE_PROJECT_NAME: projectName,
  BACKEND_HOST_PORT: String(backendHostPort),
  API_FLOW_BASE_URL: `http://127.0.0.1:${backendHostPort}`,
};

/** Выполняет Docker/Node subprocess без shell и возвращает полный результат. */
function run(command, args, printOutput = true) {
  const result = spawnSync(command, args, {
    cwd: resolve('.'),
    env: environment,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (printOutput && result.stdout) process.stdout.write(result.stdout);
  if (printOutput && result.stderr) process.stderr.write(result.stderr);
  return result;
}

/** Возвращает exit code, включая случай невозможности запустить subprocess. */
function exitCode(result) {
  return result.status ?? 1;
}

let flowCode = 1;
await mkdir(reportDirectory, { recursive: true });
// Каждый запуск публикует только собственную диагностику: старый failure log не
// должен попасть в artifact успешного pipeline и создать ложный incident signal.
await rm(resolve(reportDirectory, 'backend.log'), { force: true });
try {
  process.stdout.write(
    `Starting isolated API flow environment: ${projectName} on 127.0.0.1:${backendHostPort}\n`,
  );
  // API flows обращаются только к backend; frontend/simulator не запускаются и
  // поэтому не занимают их обычные development ports 5173/5055.
  const startup = run('docker', [...composeArgs, 'up', '-d', '--build', 'backend']);
  if (exitCode(startup) !== 0) {
    throw new Error('Не удалось запустить development Compose environment');
  }
  const flow = run(process.execPath, ['scripts/run-api-flows.mjs']);
  flowCode = exitCode(flow);
  if (flowCode !== 0) {
    const logs = run('docker', [...composeArgs, 'logs', '--no-color', 'backend'], false);
    const apiKey = process.env['API_FLOW_API_KEY'] ?? 'dev-key';
    const sanitized = `${logs.stdout ?? ''}${logs.stderr ?? ''}`.replaceAll(
      apiKey,
      '[REDACTED_API_KEY]',
    );
    await writeFile(resolve(reportDirectory, 'backend.log'), sanitized);
  }
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : 'API flow startup failed'}\n`);
} finally {
  process.stdout.write(`Stopping isolated API flow environment: ${projectName}\n`);
  run('docker', [...composeArgs, 'down', '--volumes', '--remove-orphans']);
}

if (flowCode !== 0) process.exitCode = 1;
