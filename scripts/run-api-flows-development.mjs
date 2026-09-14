import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const runId = randomUUID().replaceAll('-', '').slice(0, 12).toLowerCase();
const projectName = `exchange-api-flows-${runId}`;
const composeArgs = ['compose', '-f', 'docker-compose.development.yml'];
const reportDirectory = resolve(process.env['API_FLOW_REPORT_DIR'] ?? 'artifacts/api-flows');
const environment = { ...process.env, COMPOSE_PROJECT_NAME: projectName };

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
  process.stdout.write(`Starting isolated API flow environment: ${projectName}\n`);
  const startup = run('docker', [...composeArgs, 'up', '-d', '--build']);
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
