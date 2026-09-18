import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

const supportedScenarios = new Set([
  'network-faults',
  'postgres-failover',
  'durable-process-kill',
  'postgres-contention',
  'resource-pressure',
  'rolling-ownership',
  'controls-under-load',
]);
const scenario = process.argv[2] ?? 'network-faults';
if (!supportedScenarios.has(scenario)) throw new Error(`Неизвестный staging scenario: ${scenario}`);

const environmentName = process.env['CHAOS_ENVIRONMENT'] ?? '';
if (
  !new Set(['staging', 'github-actions-chaos']).has(environmentName) ||
  process.env['CHAOS_ACK'] !== 'isolated-test-only'
) {
  throw new Error(
    'Staging fault injection запрещён: задайте CHAOS_ENVIRONMENT=staging|github-actions-chaos и CHAOS_ACK=isolated-test-only',
  );
}

const runId = (process.env['CHAOS_RUN_ID'] ?? randomUUID().replaceAll('-', '').slice(0, 12))
  .replace(/[^A-Za-z0-9_-]/g, '')
  .toLowerCase();
const seed = process.env['CHAOS_SEED'] ?? runId;
const projectName = `exchange-resilience-${runId}`;
const resultDirectory = resolve(
  process.env['CHAOS_RESULT_DIR'] ?? `artifacts/resilience/${scenario}/${runId}`,
);
const compose = ['compose', '-f', 'docker-compose.staging.yml', '--project-name', projectName];
const baseUrl = `http://127.0.0.1:${process.env['STAGING_HTTP_PORT'] ?? '5080'}`;
const toxiproxyUrl = `http://127.0.0.1:${process.env['TOXIPROXY_HOST_PORT'] ?? '8474'}`;
const traderKey = 'staging-trader-key';
const adminOneKey = 'staging-admin-key';
const adminTwoKey = 'staging-admin-2-key';
const canary = `resilience-canary-${runId}`;
const startedAt = new Date();
let databaseService = 'postgres';
const timeline = [];
const report = {
  schemaVersion: 1,
  scenario,
  runId,
  seed,
  environment: environmentName,
  buildSha: process.env['BUILD_SHA'] ?? process.env['GITHUB_SHA'] ?? 'local-dirty',
  startedAt: startedAt.toISOString(),
  status: 'failed',
  rtoMs: null,
  rpoAcceptedCommandsLost: null,
  failures: [],
  measurements: {},
  timeline,
};

/** Записывает детерминированную точку сценария без секретных payload. */
function mark(event, details = {}) {
  timeline.push({
    event,
    offsetMs: Date.now() - startedAt.getTime(),
    at: new Date().toISOString(),
    ...details,
  });
}

/** Выполняет subprocess без shell и возвращает его безопасный вывод. */
function command(executable, args, extraEnvironment = {}, print = true) {
  const result = spawnSync(executable, args, {
    cwd: resolve('.'),
    env: { ...process.env, ...extraEnvironment },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  if (print && output) process.stdout.write(output);
  return { code: result.status ?? 1, output };
}

/** Запускает продолжительную команду, используемую как controlled contention. */
function background(executable, args, extraEnvironment = {}) {
  const child = spawn(executable, args, {
    cwd: resolve('.'),
    env: { ...process.env, ...extraEnvironment },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => (output += String(chunk)));
  child.stderr.on('data', (chunk) => (output += String(chunk)));
  const completion = new Promise((complete) => {
    child.once('error', (error) => complete({ code: 1, output: error.message }));
    child.once('close', (code) => complete({ code: code ?? 1, output }));
  });
  return { child, completion };
}

/** Ограниченная задержка допускается только как часть versioned fault timeline. */
function delay(milliseconds) {
  return new Promise((complete) => setTimeout(complete, milliseconds));
}

/** Выполняет HTTP-запрос с bounded timeout и безопасно разбирает JSON. */
async function http(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    signal: AbortSignal.timeout(options.timeoutMs ?? 5000),
  });
  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text.slice(0, 500);
  }
  return { status: response.status, body };
}

/** Ожидает заданный health status и возвращает измеренный RTO. */
async function waitForStatus(path, expected, timeoutMs = 60_000) {
  const started = performance.now();
  let last = 0;
  while (performance.now() - started < timeoutMs) {
    try {
      last = (await http(path, { timeoutMs: 2000 })).status;
      if (last === expected) return Math.round(performance.now() - started);
    } catch {
      last = 0;
    }
    await delay(250);
  }
  throw new Error(`${path} не достиг HTTP ${expected}; последний status=${last}`);
}

/** Отправляет уникальную place command; decimal values всегда остаются строками. */
async function place(name, idempotencyKey = `idem-${name}`) {
  return http('/api/v1/orders', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': traderKey,
      'idempotency-key': idempotencyKey,
    },
    body: JSON.stringify({
      commandId: `command-${name}`,
      orderId: `order-${name}`,
      accountId: 'staging-user',
      instrumentId: 'BTC-USD',
      clientOrderId: `client-${name}`,
      side: 'BUY',
      orderType: 'LIMIT',
      quantity: '1',
      limitPrice: '100',
      timeInForce: 'GTC',
    }),
  });
}

/** Повторяет команду только до bounded deadline, сохраняя последний status. */
async function eventuallyPlace(name, idempotencyKey, timeoutMs = 20_000) {
  const started = performance.now();
  let response = { status: 0, body: null };
  while (performance.now() - started < timeoutMs) {
    try {
      response = await place(name, idempotencyKey);
      if (response.status === 201) {
        return { response, durationMs: Math.round(performance.now() - started) };
      }
    } catch {
      response = { status: 0, body: null };
    }
    await delay(250);
  }
  throw new Error(`command-${name} не принят; последний HTTP ${response.status}`);
}

/** Вызывает Toxiproxy API; fault mutation возможна только после interlock выше. */
async function toxic(path, method = 'POST', body) {
  const response = await fetch(`${toxiproxyUrl}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok && response.status !== 404) {
    throw new Error(`Toxiproxy ${method} ${path}: HTTP ${response.status}`);
  }
}

/** Удаляет все toxics и netem qdisc; вызывается также из аварийного cleanup. */
async function emergencyAbort() {
  try {
    const response = await fetch(`${toxiproxyUrl}/proxies/postgres-outbox`, {
      signal: AbortSignal.timeout(2000),
    });
    if (response.ok) {
      const proxy = await response.json();
      for (const current of proxy.toxics ?? []) {
        await toxic(`/proxies/postgres-outbox/toxics/${current.name}`, 'DELETE');
      }
      await toxic('/proxies/postgres-outbox', 'PATCH', { enabled: true });
    }
  } catch {
    report.failures.push('emergency abort не смог очистить Toxiproxy через API');
  }
  command(
    'docker',
    [
      ...compose,
      '--profile',
      'fault-injection',
      'exec',
      '-T',
      'fault-agent',
      'tc',
      'qdisc',
      'del',
      'dev',
      'eth0',
      'root',
    ],
    {},
    false,
  );
  for (const agent of ['pressure-agent-a', 'pressure-agent-b']) {
    command(
      'docker',
      [
        ...compose,
        '--profile',
        'resource-injection',
        'exec',
        '-T',
        agent,
        'pkill',
        '-CONT',
        '-f',
        'node.*dist/main',
      ],
      {},
      false,
    );
  }
  command('docker', [...compose, 'unpause', 'backend-a', 'backend-b'], {}, false);
}

/** Проверяет degradation/recovery для одного Toxiproxy toxic. */
async function verifyToxic(name, type, attributes, expectUnavailable = true) {
  mark('fault.inject', { name, type });
  await toxic('/proxies/postgres-outbox/toxics', 'POST', {
    name,
    type,
    stream: 'downstream',
    toxicity: 1,
    attributes,
  });
  if (expectUnavailable) await waitForStatus('/health/ready', 503, 10_000);
  else await delay(1000);
  const recoveryStarted = performance.now();
  await toxic(`/proxies/postgres-outbox/toxics/${name}`, 'DELETE');
  const rtoMs = await waitForStatus('/health/ready', 200, 15_000);
  report.measurements[name] = {
    rtoMs: Math.max(rtoMs, Math.round(performance.now() - recoveryStarted)),
  };
  mark('fault.recovered', { name, rtoMs });
}

/** Проверяет latency, timeout, reset, bandwidth, disconnect и packet loss. */
async function networkFaults() {
  await verifyToxic('latency', 'latency', { latency: 2500, jitter: 0 });
  await verifyToxic('timeout', 'timeout', { timeout: 0 });
  await verifyToxic('reset', 'reset_peer', { timeout: 100 });
  await verifyToxic('bandwidth', 'bandwidth', { rate: 1 }, false);

  mark('fault.inject', { name: 'temporary-disconnect', type: 'proxy-disable' });
  await toxic('/proxies/postgres-outbox', 'PATCH', { enabled: false });
  await waitForStatus('/health/ready', 503, 10_000);
  const reconnectStarted = performance.now();
  await toxic('/proxies/postgres-outbox', 'PATCH', { enabled: true });
  report.measurements.temporaryDisconnect = {
    rtoMs: await waitForStatus('/health/ready', 200, 15_000),
    recoveryStartedOffsetMs: Date.now() - startedAt.getTime(),
  };

  mark('fault.inject', { name: 'packet-loss', type: 'netem', percent: 100 });
  const netem = command('docker', [
    ...compose,
    '--profile',
    'fault-injection',
    'exec',
    '-T',
    'fault-agent',
    'tc',
    'qdisc',
    'replace',
    'dev',
    'eth0',
    'root',
    'netem',
    'loss',
    '100%',
  ]);
  if (netem.code !== 0) throw new Error('Не удалось включить bounded packet loss');
  await waitForStatus('/health/ready', 503, 10_000);
  const packetRecovery = performance.now();
  command('docker', [
    ...compose,
    '--profile',
    'fault-injection',
    'exec',
    '-T',
    'fault-agent',
    'tc',
    'qdisc',
    'del',
    'dev',
    'eth0',
    'root',
  ]);
  report.measurements.packetLoss = {
    rtoMs: await waitForStatus('/health/ready', 200, 15_000),
    recoveryStartedOffsetMs: Date.now() - startedAt.getTime(),
  };
}

/** Подтверждает RPO=0 и прежний public result после SIGKILL active replica. */
async function durableProcessKill() {
  const first = await place(`${runId}-accepted`, `${runId}-accepted-key`);
  if (first.status !== 201) throw new Error(`pre-kill command не принята: HTTP ${first.status}`);
  const acceptedBefore = await scalar(
    "SELECT count(*) FROM command_journal WHERE status='APPLIED'",
  );
  mark('process.kill', { service: 'backend-a', signal: 'SIGKILL' });
  const killed = command('docker', [...compose, 'kill', '-s', 'SIGKILL', 'backend-a']);
  if (killed.code !== 0) throw new Error('SIGKILL backend-a завершился ошибкой');
  await waitForStatus('/health/live', 200, 10_000);

  const retry = await eventuallyPlace(`${runId}-accepted`, `${runId}-accepted-key`, 5000);
  // PostgreSQL jsonb не гарантирует исходный порядок ключей, поэтому public result
  // сравнивается структурно. Например, `{ commandId, status }` и
  // `{ status, commandId }` являются одним идемпотентным результатом.
  if (!isDeepStrictEqual(retry.response.body, first.body)) {
    throw new Error('idempotent result изменился после restart/failover');
  }
  const takeover = await eventuallyPlace(`${runId}-after-kill`, `${runId}-after-kill-key`);
  report.rtoMs = takeover.durationMs;
  const acceptedAfter = await scalar("SELECT count(*) FROM command_journal WHERE status='APPLIED'");
  report.rpoAcceptedCommandsLost = Math.max(0, acceptedBefore - acceptedAfter);
  if (report.rpoAcceptedCommandsLost !== 0) throw new Error('RPO accepted commands больше нуля');
}

/**
 * Останавливает primary, продвигает физическую standby и переключает proxy.
 * Перед аварией runner ждёт replay принятой команды на replica; после promote
 * прежний idempotency key обязан вернуть тот же public result, а новая команда
 * подтверждает открытие write path уже на новом primary.
 */
async function postgresFailover() {
  const name = `${runId}-before-pg-failover`;
  const key = `${runId}-before-pg-failover-key`;
  const first = await place(name, key);
  if (first.status !== 201)
    throw new Error(`pre-failover command не принята: HTTP ${first.status}`);
  const acceptedBefore = Number(
    await scalar("SELECT count(*) FROM command_journal WHERE status='APPLIED'"),
  );
  const replayDeadline = performance.now() + 15_000;
  let replayed = 0;
  while (performance.now() < replayDeadline) {
    replayed = Number(
      await scalar(
        "SELECT count(*) FROM command_journal WHERE status='APPLIED'",
        'postgres-standby',
      ),
    );
    if (replayed >= acceptedBefore) break;
    await delay(200);
  }
  if (replayed < acceptedBefore) throw new Error('standby не достигла durable high watermark');

  mark('postgres.primary.stop', { service: 'postgres' });
  const stopped = command('docker', [...compose, '--profile', 'ha', 'stop', 'postgres']);
  if (stopped.code !== 0) throw new Error('PostgreSQL primary не остановлен');
  const promoted = command('docker', [
    ...compose,
    '--profile',
    'ha',
    'exec',
    '-T',
    'postgres-standby',
    'pg_ctl',
    '-D',
    '/var/lib/postgresql/data',
    'promote',
    '-w',
  ]);
  if (promoted.code !== 0) throw new Error('PostgreSQL standby promotion завершился ошибкой');
  await toxic('/proxies/postgres-outbox', 'PATCH', {
    upstream: 'postgres-standby:5432',
    enabled: true,
  });
  databaseService = 'postgres-standby';

  const rtoStarted = performance.now();
  await waitForStatus('/health/ready', 200, 30_000);
  report.rtoMs = Math.round(performance.now() - rtoStarted);
  const retry = await eventuallyPlace(name, key, 10_000);
  if (!isDeepStrictEqual(retry.response.body, first.body)) {
    throw new Error('idempotent result изменился после PostgreSQL failover');
  }
  await eventuallyPlace(`${runId}-after-pg-failover`, `${runId}-after-pg-failover-key`);
  const acceptedAfter = Number(
    await scalar("SELECT count(*) FROM command_journal WHERE status='APPLIED'"),
  );
  report.rpoAcceptedCommandsLost = Math.max(0, acceptedBefore - acceptedAfter);
  if (report.rpoAcceptedCommandsLost !== 0) throw new Error('PostgreSQL failover RPO больше нуля');
}

/** Проверяет последовательный takeover A → B → A без двух действующих epoch. */
async function rollingOwnership() {
  if ((await place(`${runId}-rolling-1`)).status !== 201) throw new Error('sequence 1 не принят');
  command('docker', [...compose, 'stop', 'backend-a']);
  const second = await eventuallyPlace(`${runId}-rolling-2`, `idem-${runId}-rolling-2`);
  report.measurements.failoverToBackendBMs = second.durationMs;

  const started = command('docker', [...compose, 'up', '-d', 'backend-a']);
  if (started.code !== 0) throw new Error('backend-a не перезапущен');
  command('docker', [...compose, 'stop', 'backend-b']);
  const third = await eventuallyPlace(`${runId}-rolling-3`, `idem-${runId}-rolling-3`);
  report.measurements.failbackToBackendAMs = third.durationMs;
  const sequences = await rows(
    "SELECT sequence::text FROM command_journal WHERE instrument_id='BTC-USD' ORDER BY sequence",
  );
  if (sequences.join(',') !== '1,2,3') throw new Error(`sequence после rolling: ${sequences}`);
  const leaseCount = Number(
    await scalar("SELECT count(*) FROM partition_leases WHERE instrument_id='BTC-USD'"),
  );
  if (leaseCount !== 1) throw new Error(`active owners для BTC-USD: ${leaseCount}`);
}

/** Воспроизводит lock wait, pool pressure, deadlock и read-only recovery. */
async function postgresContention() {
  const lock = background('docker', [
    ...compose,
    'exec',
    '-T',
    'postgres',
    'psql',
    '-U',
    'exchange',
    '-d',
    'exchange',
    '-v',
    'ON_ERROR_STOP=1',
    '-c',
    'BEGIN; LOCK TABLE command_journal IN ACCESS EXCLUSIVE MODE; SELECT pg_sleep(4); COMMIT;',
  ]);
  await delay(500);
  const blocked = await Promise.allSettled(
    Array.from({ length: 16 }, (_, index) =>
      place(`${runId}-pool-${index}`, `${runId}-pool-key-${index}`),
    ),
  );
  await lock.completion;
  report.measurements.poolPressureRequests = blocked.length;
  await eventuallyPlace(`${runId}-contention-recovery`, `${runId}-contention-recovery-key`);

  await sql(
    "INSERT INTO admission_controls(control_type,target_id,state,version,effective_at,command_id,actor_id,reason_code) VALUES ('USER','deadlock-a','ALLOW',1,clock_timestamp(),'deadlock-a','runner','TEST'),('USER','deadlock-b','ALLOW',1,clock_timestamp(),'deadlock-b','runner','TEST') ON CONFLICT DO NOTHING",
  );
  try {
    const deadlockOne = background('docker', [
      ...compose,
      'exec',
      '-T',
      'postgres',
      'psql',
      '-U',
      'exchange',
      '-d',
      'exchange',
      '-v',
      'ON_ERROR_STOP=1',
      '-c',
      "BEGIN; UPDATE admission_controls SET updated_at=clock_timestamp() WHERE target_id='deadlock-a'; SELECT pg_sleep(1); UPDATE admission_controls SET updated_at=clock_timestamp() WHERE target_id='deadlock-b'; COMMIT;",
    ]);
    const deadlockTwo = background('docker', [
      ...compose,
      'exec',
      '-T',
      'postgres',
      'psql',
      '-U',
      'exchange',
      '-d',
      'exchange',
      '-v',
      'ON_ERROR_STOP=1',
      '-c',
      "BEGIN; UPDATE admission_controls SET updated_at=clock_timestamp() WHERE target_id='deadlock-b'; SELECT pg_sleep(1); UPDATE admission_controls SET updated_at=clock_timestamp() WHERE target_id='deadlock-a'; COMMIT;",
    ]);
    const deadlockResults = await Promise.all([deadlockOne.completion, deadlockTwo.completion]);
    if (!deadlockResults.some(({ code }) => code !== 0)) {
      throw new Error('deterministic deadlock не был обнаружен PostgreSQL');
    }
  } finally {
    // Fixture создаётся напрямую только для lock graph и удаляется до общей
    // reconciliation: operational control без audit event не должен пережить тест.
    await sql(
      "DELETE FROM admission_controls WHERE target_id IN ('deadlock-a','deadlock-b')",
      true,
    );
  }

  try {
    await sql('ALTER DATABASE exchange SET default_transaction_read_only=on');
    command('docker', [...compose, 'restart', 'backend-a', 'backend-b']);
    await waitForStatus('/health/live', 200, 30_000);
    const readOnly = await place(`${runId}-read-only`, `${runId}-read-only-key`);
    if (readOnly.status === 201) throw new Error('read-only database приняла write command');
  } finally {
    // ALTER выполняется через отдельную административную БД: новая сессия к
    // `exchange` уже наследует read-only default и не может восстановить саму себя.
    const restoreWritable = command('docker', [
      ...compose,
      'exec',
      '-T',
      'postgres',
      'psql',
      '-U',
      'exchange',
      '-d',
      'postgres',
      '-v',
      'ON_ERROR_STOP=1',
      '-c',
      'ALTER DATABASE exchange SET default_transaction_read_only=off',
    ]);
    if (restoreWritable.code !== 0)
      throw new Error('Не удалось вернуть PostgreSQL в read-write mode');
    command('docker', [...compose, 'restart', 'backend-a', 'backend-b']);
  }
  await waitForStatus('/health/ready', 200, 30_000);
}

/**
 * Создаёт bounded CPU/memory/FD/event-loop pressure внутри backend cgroup.
 * CPU и memory создаются дочерним Node process с конечным deadline, FD pressure
 * использует пониженный startup ulimit, а SIGSTOP всегда снимается в finally.
 */
async function resourcePressure() {
  const statuses = [];
  const workload = async (prefix, count = 80) => {
    const started = performance.now();
    const responses = await Promise.allSettled(
      Array.from({ length: count }, (_, index) =>
        place(`${runId}-${prefix}-${index}`, `${runId}-${prefix}-key-${index}`),
      ),
    );
    for (const response of responses) {
      statuses.push(response.status === 'fulfilled' ? response.value.status : 0);
    }
    return Math.round(performance.now() - started);
  };

  const cpu = ['backend-a', 'backend-b'].map((service) =>
    background('docker', [
      ...compose,
      'exec',
      '-T',
      service,
      'node',
      '-e',
      'const end=Date.now()+3000;while(Date.now()<end){Math.sqrt(Date.now())}',
    ]),
  );
  report.measurements.cpuPressureWorkloadMs = await workload('cpu', 40);
  await Promise.all(cpu.map(({ completion }) => completion));

  const memory = ['backend-a', 'backend-b'].map((service) =>
    background('docker', [
      ...compose,
      'exec',
      '-T',
      service,
      'node',
      '-e',
      'const blocks=[];for(let i=0;i<12;i++)blocks.push(Buffer.alloc(16*1024*1024,1));setTimeout(()=>{},3000)',
    ]),
  );
  report.measurements.memoryPressureWorkloadMs = await workload('memory', 40);
  await Promise.all(memory.map(({ completion }) => completion));

  report.measurements.fdPressureWorkloadMs = await workload('fd', 160);
  if (!statuses.includes(201))
    throw new Error('resource pressure не оставил ни одной accepted command');

  try {
    const stopped = command('docker', [...compose, 'pause', 'backend-a', 'backend-b']);
    if (stopped.code !== 0)
      throw new Error('Не удалось остановить event loop через container freezer');
    await waitForStatus('/health/ready', 503, 10_000);
  } finally {
    command('docker', [...compose, 'unpause', 'backend-a', 'backend-b']);
  }
  report.measurements.eventLoopRecoveryMs = await waitForStatus('/health/ready', 200, 15_000);
  await eventuallyPlace(`${runId}-after-pressure`, `${runId}-after-pressure-key`);
  report.measurements.resourcePressureStatuses = Object.fromEntries(
    [...new Set(statuses)]
      .sort()
      .map((status) => [status, statuses.filter((item) => item === status).length]),
  );
}

/** Создаёт продолжающийся command stream и проверяет freeze/circuit transitions. */
async function controlsUnderLoad() {
  let running = true;
  const statuses = [];
  const workload = (async () => {
    let index = 0;
    while (running && index < 200) {
      try {
        statuses.push((await place(`${runId}-control-load-${index}`)).status);
      } catch {
        statuses.push(0);
      }
      index += 1;
      await delay(40);
    }
  })();
  try {
    await delay(300);
    await admin('/api/v1/admin/freezes', adminOneKey, `${runId}-freeze-key`, {
      commandId: `${runId}-freeze`,
      targetType: 'USER',
      targetId: 'staging-user',
      action: 'FREEZE',
    });
    await delay(300);
    const frozen = await place(`${runId}-frozen-check`);
    if (frozen.status !== 409) throw new Error(`freeze не закрыл admission: HTTP ${frozen.status}`);
    await admin('/api/v1/admin/freezes', adminOneKey, `${runId}-unfreeze-key`, {
      commandId: `${runId}-unfreeze`,
      targetType: 'USER',
      targetId: 'staging-user',
      action: 'UNFREEZE',
    });
    await eventuallyPlace(`${runId}-after-unfreeze`, `${runId}-after-unfreeze-key`);

    // Pending dual-control request пока принадлежит памяти AdminService. На время
    // request+approval оставляем один admin owner, но command workload продолжает
    // идти через ingress. Cross-replica pending persistence остаётся отдельным gate.
    command('docker', [...compose, 'stop', 'backend-b']);
    await admin('/api/v1/admin/circuit-breakers', adminOneKey, `${runId}-stop-key`, {
      commandId: `${runId}-stop`,
      targetId: '*',
      action: 'STOP',
    });
    await admin(`/api/v1/admin/approvals/${runId}-stop`, adminTwoKey, `${runId}-stop-approve-key`);
    if ((await place(`${runId}-stopped-check`)).status !== 409) {
      throw new Error('circuit breaker не закрыл admission');
    }
    await admin('/api/v1/admin/circuit-breakers', adminOneKey, `${runId}-resume-key`, {
      commandId: `${runId}-resume`,
      targetId: '*',
      action: 'RESUME',
    });
    await admin(
      `/api/v1/admin/approvals/${runId}-resume`,
      adminTwoKey,
      `${runId}-resume-approve-key`,
    );
    await eventuallyPlace(`${runId}-after-resume`, `${runId}-after-resume-key`);
    const restoreReplica = command('docker', [...compose, 'up', '-d', 'backend-b']);
    if (restoreReplica.code !== 0) throw new Error('backend-b не восстановлен после control test');
  } finally {
    running = false;
    await workload;
  }
  report.measurements.controlLoadStatuses = Object.fromEntries(
    [...new Set(statuses)]
      .sort()
      .map((status) => [status, statuses.filter((item) => item === status).length]),
  );
}

/** Вызывает защищённую admin command/approval boundary. */
async function admin(path, key, idempotencyKey, body) {
  const headers = {
    'x-api-key': key,
    'idempotency-key': idempotencyKey,
  };
  // Approval endpoint не имеет DTO body. Content-Type без payload заставляет
  // JSON parser вернуть 400 до вызова контроллера, поэтому добавляем его только
  // для административных команд с фактическим JSON-документом.
  if (body !== undefined) headers['content-type'] = 'application/json';
  const result = await http(path, {
    method: 'POST',
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (result.status !== 201) {
    const code =
      typeof result.body === 'object' && result.body !== null && 'code' in result.body
        ? String(result.body.code)
        : 'UNKNOWN';
    throw new Error(`${path} завершился HTTP ${result.status} (${code})`);
  }
  return result.body;
}

/** Выполняет SQL через staging postgres без передачи password в process args. */
async function sql(statement, tolerateFailure = false) {
  const result = command('docker', [
    ...compose,
    'exec',
    '-T',
    'postgres',
    'psql',
    '-U',
    'exchange',
    '-d',
    'exchange',
    '-v',
    'ON_ERROR_STOP=1',
    '-c',
    statement,
  ]);
  if (result.code !== 0 && !tolerateFailure)
    throw new Error('SQL staging check завершился ошибкой');
  return result.output;
}

/** Возвращает одно скалярное значение из PostgreSQL в unaligned режиме. */
async function scalar(statement, service = databaseService) {
  const values = await rows(statement, service);
  return values[0] ?? '';
}

/** Возвращает строки read-only reconciliation query. */
async function rows(statement, service = databaseService) {
  const result = command(
    'docker',
    [
      ...compose,
      'exec',
      '-T',
      service,
      'psql',
      '-U',
      'exchange',
      '-d',
      'exchange',
      '-At',
      '-c',
      statement,
    ],
    {},
    false,
  );
  if (result.code !== 0) throw new Error('Reconciliation SQL завершился ошибкой');
  return result.output.trim() ? result.output.trim().split('\n') : [];
}

/** Сверяет durable commands/events/ledger/offsets/sequence/projections/audit. */
async function reconcile() {
  const checks = {
    nonTerminalCommands: Number(
      await scalar(
        "SELECT count(*) FROM command_journal WHERE status NOT IN ('APPLIED','REJECTED')",
      ),
    ),
    commandEventDifference: Number(
      await scalar(
        "SELECT abs((SELECT count(*) FROM command_journal WHERE status='APPLIED')-(SELECT count(*) FROM outbox_events WHERE aggregate_type='order'))",
      ),
    ),
    duplicateSequences: Number(
      await scalar(
        'SELECT count(*) FROM (SELECT instrument_id,sequence FROM command_journal GROUP BY instrument_id,sequence HAVING count(*)>1) duplicate_sequence',
      ),
    ),
    sequenceGaps: Number(
      await scalar(
        'SELECT count(*) FROM (SELECT sequence,lag(sequence) OVER (PARTITION BY instrument_id ORDER BY sequence) previous FROM command_journal) ordered WHERE previous IS NOT NULL AND sequence<>previous+1',
      ),
    ),
    invalidBalances: Number(
      await scalar('SELECT count(*) FROM balances WHERE available<0 OR reserved<0'),
    ),
    unbalancedOperations: Number(
      await scalar(
        "SELECT count(*) FROM (SELECT operation_id,asset_id FROM postings GROUP BY operation_id,asset_id HAVING sum(CASE WHEN direction='DEBIT' THEN amount ELSE -amount END)<>0) unbalanced",
      ),
    ),
    invalidOffsets: Number(
      await scalar(
        'SELECT count(*) FROM consumer_offsets WHERE committed_offset>(SELECT COALESCE(max(event_offset),0) FROM outbox_events)',
      ),
    ),
    invalidProjectionVersions: Number(
      await scalar(
        'SELECT count(*) FROM projection_versions WHERE applied_sequence>source_sequence',
      ),
    ),
    auditSequenceGaps: Number(
      await scalar(
        'SELECT count(*) FROM (SELECT sequence,lag(sequence) OVER (ORDER BY sequence) previous FROM audit_records) ordered WHERE previous IS NOT NULL AND sequence<>previous+1',
      ),
    ),
  };
  const dashboard = await http('/api/v1/admin/reconciliation', {
    headers: { 'x-api-key': adminOneKey },
  });
  checks.auditIntegrity = dashboard.status === 200 && dashboard.body?.auditIntegrity === true;
  report.reconciliation = checks;
  if (Object.entries(checks).some(([, value]) => value !== 0 && value !== true)) {
    throw new Error(`Post-scenario reconciliation не сошлась: ${JSON.stringify(checks)}`);
  }
}

/** Собирает и проверяет логи, не сохраняя canary/credentials в artifacts. */
async function collectDiagnostics() {
  await http('/api/v1/auth/me', { headers: { 'x-api-key': canary } }).catch(() => undefined);
  const logs = command('docker', [...compose, 'logs', '--no-color'], {}, false).output;
  const forbidden = [canary, traderKey, adminOneKey, adminTwoKey, 'staging-only-password'];
  report.secretLeakDetected = forbidden.some((value) => logs.includes(value));
  if (report.secretLeakDetected)
    report.failures.push('credential/canary обнаружен в container logs');
  let sanitized = logs;
  for (const value of forbidden) sanitized = sanitized.replaceAll(value, '[REDACTED]');
  await writeFile(resolve(resultDirectory, 'containers.log'), sanitized.slice(-5_000_000));
  const topology = command('docker', [...compose, 'ps', '--format', 'json'], {}, false).output;
  await writeFile(resolve(resultDirectory, 'topology.jsonl'), topology);
}

await mkdir(resultDirectory, { recursive: true });
await chmod(resultDirectory, 0o777);
let cleanupSuccessful = false;

try {
  mark('environment.start');
  const startProfiles = ['--profile', 'fault-injection'];
  if (scenario === 'postgres-failover') startProfiles.push('--profile', 'ha');
  if (scenario === 'resource-pressure') startProfiles.push('--profile', 'resource-injection');
  const start = command('docker', [...compose, ...startProfiles, 'up', '-d', '--build'], {
    CHAOS_ENVIRONMENT: environmentName === 'github-actions-chaos' ? 'staging' : environmentName,
    CHAOS_ACK: 'isolated-test-only',
    BUILD_SHA: report.buildSha,
    ...(scenario === 'resource-pressure' ? { STAGING_BACKEND_NOFILE: '96' } : {}),
  });
  if (start.code !== 0) throw new Error('Staging topology не запустилась');
  const startupRto = await waitForStatus('/health/ready', 200, 180_000);
  report.measurements.startupRtoMs = startupRto;
  mark('environment.ready', { rtoMs: startupRto });

  if (scenario === 'network-faults') await networkFaults();
  else if (scenario === 'postgres-failover') await postgresFailover();
  else if (scenario === 'durable-process-kill') await durableProcessKill();
  else if (scenario === 'postgres-contention') await postgresContention();
  else if (scenario === 'resource-pressure') await resourcePressure();
  else if (scenario === 'rolling-ownership') await rollingOwnership();
  else if (scenario === 'controls-under-load') await controlsUnderLoad();

  await waitForStatus('/health/ready', 200, 30_000);
  await reconcile();
  report.status = 'passed';
} catch (error) {
  report.failures.push(error instanceof Error ? error.message : 'Неизвестная staging ошибка');
  mark('scenario.failed');
} finally {
  await emergencyAbort();
  await collectDiagnostics().catch((error) =>
    report.failures.push(`diagnostics: ${error instanceof Error ? error.message : 'unknown'}`),
  );
  mark('environment.cleanup');
  const profileArguments = [
    '--profile',
    'fault-injection',
    '--profile',
    'load',
    '--profile',
    'ha',
    '--profile',
    'resource-injection',
  ];
  const down = command('docker', [
    ...compose,
    ...profileArguments,
    'down',
    '--volumes',
    '--remove-orphans',
  ]);
  const remaining = command('docker', [...compose, ...profileArguments, 'ps', '-q'], {}, false);
  cleanupSuccessful = down.code === 0 && remaining.output.trim() === '';
  report.cleanupSuccessful = cleanupSuccessful;
  if (!cleanupSuccessful) report.failures.push('cleanup verification завершилась ошибкой');
  if (report.failures.length > 0) report.status = 'failed';
  report.finishedAt = new Date().toISOString();
  const summary = `## Staging resilience: ${scenario}\n\n**Status:** ${report.status === 'passed' ? '✅ passed' : '❌ failed'}  \n**Run:** ${runId}  \n**Seed:** ${seed}  \n**Build:** ${report.buildSha}  \n**RTO:** ${report.rtoMs ?? 'per-fault; see report.json'}  \n**RPO:** ${report.rpoAcceptedCommandsLost ?? 'n/a'}  \n**Cleanup:** ${cleanupSuccessful ? '✅' : '❌'}  \n**Failures:** ${report.failures.length}\n`;
  await Promise.all([
    writeFile(resolve(resultDirectory, 'report.json'), `${JSON.stringify(report, null, 2)}\n`),
    writeFile(resolve(resultDirectory, 'timeline.json'), `${JSON.stringify(timeline, null, 2)}\n`),
    writeFile(resolve(resultDirectory, 'summary.md'), summary),
    writeFile(
      resolve(resultDirectory, 'resource-limits.json'),
      `${JSON.stringify(
        {
          backend: {
            cpus: process.env['STAGING_BACKEND_CPUS'] ?? '1.0',
            memory: process.env['STAGING_BACKEND_MEMORY'] ?? '512m',
            pids: process.env['STAGING_BACKEND_PIDS'] ?? '256',
            nofile: process.env['STAGING_BACKEND_NOFILE'] ?? '4096',
          },
          postgres: {
            cpus: process.env['STAGING_POSTGRES_CPUS'] ?? '1.0',
            memory: process.env['STAGING_POSTGRES_MEMORY'] ?? '512m',
            maxConnections: process.env['STAGING_POSTGRES_MAX_CONNECTIONS'] ?? '64',
          },
        },
        null,
        2,
      )}\n`,
    ),
  ]);
  process.stdout.write(summary);
}

if (report.status !== 'passed') process.exitCode = 1;
