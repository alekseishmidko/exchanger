import { check, sleep } from 'k6';
import { Counter, Rate, Trend } from 'k6/metrics';
import { WebSocket } from 'k6/websockets';
import exec from 'k6/execution';
import { profile } from './lib/profiles.js';
import { cancelOrderData, multiFillData, placeOrderData, uniqueId } from './lib/data.js';
import { getQuery, postCommand } from './lib/http.js';

const selectedProfile = __ENV.LOAD_PROFILE || 'smoke';
const selected = profile(selectedProfile);
const baseUrl = (__ENV.LOAD_BASE_URL || 'http://backend:5000').replace(/\/+$/, '');
const wsUrl = (__ENV.LOAD_WS_URL || baseUrl.replace(/^http/, 'ws')).replace(/\/+$/, '');
const apiKey = __ENV.LOAD_API_KEY || 'dev-key';
const runId = __ENV.LOAD_RUN_ID || 'local';
const distribution = __ENV.LOAD_DISTRIBUTION || 'hot';
const durationOverride = __ENV.LOAD_DURATION;
const profileAcceptedRate = {
  smoke: 0.5,
  average: 15,
  stress: 25,
  spike: 15,
  soak: 25,
  breakpoint: 40,
}[selectedProfile];
// В коротком CI-профиле setup и отложенный старт WebSocket занимают заметную
// долю wall time, по которому k6 вычисляет Counter.rate. Полные профили используют
// целевой budget, сокращённые — отдельный smoke guard от потери throughput.
const minimumAcceptedRate = durationOverride
  ? selectedProfile === 'smoke'
    ? 0.5
    : 8
  : profileAcceptedRate;

/** Доля запросов, завершившихся client/network timeout. */
export const timeoutRate = new Rate('load_timeout_rate');
/** Число успешно принятых place/cancel команд. */
export const acceptedCommands = new Counter('load_accepted_commands');
/** Время от принятия команды до появления в query boundary. */
export const acceptedToVisible = new Trend('load_accepted_to_visible_ms', true);
/** Успешность Socket.IO handshake/subscription protocol. */
export const websocketSuccess = new Rate('load_websocket_success');
/** Доля повторов, которые вернули отличный от первого business result. */
export const duplicateEffectRate = new Rate('load_duplicate_effect_rate');
/** Доля accepted-команд, не найденных через публичную query boundary. */
export const acceptedVisibilityFailureRate = new Rate('load_accepted_visibility_failure_rate');

const restScenario = { ...selected.rest, exec: 'restWorkload', tags: { contour: 'rest' } };
const websocketScenario = {
  ...selected.websocket,
  exec: 'websocketWorkload',
  tags: { contour: 'websocket' },
  startTime: selectedProfile === 'smoke' ? '0s' : '5s',
};
if (durationOverride) {
  if ('duration' in restScenario) restScenario.duration = durationOverride;
  if ('duration' in websocketScenario) websocketScenario.duration = durationOverride;
}

/**
 * Thresholds являются executable SLO/regression gate: k6 возвращает non-zero
 * exit code при нарушении хотя бы одного выражения.
 */
export const options = {
  scenarios: { rest: restScenario, websocket: websocketScenario },
  thresholds: {
    checks: ['rate>0.99'],
    'http_req_failed{scenario:rest}': ['rate<0.01'],
    'http_req_duration{scenario:rest}': ['p(50)<100', 'p(95)<300', 'p(99)<800', 'max<5000'],
    load_timeout_rate: ['rate<0.005'],
    load_accepted_commands: [`rate>${minimumAcceptedRate}`],
    load_accepted_to_visible_ms: ['p(95)<1000', 'p(99)<2000', 'max<5000'],
    load_websocket_success: ['rate>0.99'],
    load_duplicate_effect_rate: ['rate==0'],
    load_accepted_visibility_failure_rate: ['rate==0'],
  },
  systemTags: ['status', 'method', 'name', 'scenario'],
  discardResponseBodies: false,
  noConnectionReuse: false,
  summaryTrendStats: ['min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
};

/**
 * Ожидает readiness перед созданием нагрузки.
 * Compose может уже считать контейнер запущенным, пока Nest watcher завершает
 * установку workspace dependencies, поэтому setup использует bounded polling.
 */
export function setup() {
  const attempts = Number(__ENV.LOAD_STARTUP_ATTEMPTS || 60);
  let status = 0;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const response = getQuery(baseUrl, '/health/ready', apiKey, '/health/ready');
    status = response.status;
    if (status === 200) return { runId };
    sleep(1);
  }
  throw new Error(`SUT не готов после ${attempts} попыток: HTTP ${status}`);
}

/**
 * Моделирует смешанный command/query workload.
 * Каждая десятая итерация создаёт multi-fill shape, остальные — обычную заявку;
 * примерно каждая пятая заявка отменяется, затем проверяется query visibility.
 */
export function restWorkload(data) {
  const context = {
    runId: data.runId,
    scenario: exec.scenario.name,
    vu: exec.vu.idInTest,
    iteration: exec.scenario.iterationInTest,
    distribution,
  };
  const commands =
    context.iteration % 10 === 0 ? multiFillData(context) : [placeOrderData(context)];
  for (const [commandIndex, command] of commands.entries()) {
    const startedAt = Date.now();
    const idempotencyKey = uniqueId(
      data.runId,
      'idem-place',
      context.scenario,
      context.vu,
      context.iteration,
      command.orderId.slice(-2),
    );
    const response = postCommand(baseUrl, '/api/v1/orders', command, apiKey, idempotencyKey, {
      flow: commands.length > 1 ? 'multi-fill' : 'single',
    });
    timeoutRate.add(response.error_code === 1050);
    const accepted = check(response, { 'place принят': (value) => value.status === 201 });
    if (!accepted) continue;
    acceptedCommands.add(1);
    if (context.iteration % 20 === 0) {
      const duplicate = postCommand(baseUrl, '/api/v1/orders', command, apiKey, idempotencyKey, {
        flow: 'idempotent-retry',
      });
      const sameResult = duplicate.status === response.status && duplicate.body === response.body;
      duplicateEffectRate.add(!sameResult);
      check(duplicate, { 'идемпотентный повтор идентичен': () => sameResult });
    }
    // До текущей итерации каждая десятая итерация добавляет две дополнительные
    // multi-fill команды. Окно начинается на 50 записей раньше ожидаемой позиции,
    // чтобы учитывать конкурентное завершение соседних VU без полного O(n) scan.
    const expectedPosition =
      context.iteration + 2 * Math.ceil(context.iteration / 10) + commandIndex;
    const visibilityCursor = Math.max(0, expectedPosition - 50);
    const visible = getQuery(
      baseUrl,
      `/api/v1/orders?limit=100&cursor=${visibilityCursor}`,
      apiKey,
      '/api/v1/orders',
    );
    const found = check(visible, {
      'принятая команда видима': (value) =>
        value.status === 200 && value.body.includes(command.orderId),
    });
    acceptedVisibilityFailureRate.add(!found);
    if (found) acceptedToVisible.add(Date.now() - startedAt);
    if (context.iteration % 5 === 0) {
      const cancel = cancelOrderData(
        command,
        data.runId,
        context.scenario,
        context.vu,
        context.iteration,
      );
      const cancelResponse = postCommand(
        baseUrl,
        `/api/v1/orders/${command.orderId}/cancel`,
        cancel,
        apiKey,
        uniqueId(
          data.runId,
          'idem-cancel',
          context.scenario,
          context.vu,
          context.iteration,
          command.orderId.slice(-2),
        ),
      );
      timeoutRate.add(cancelResponse.error_code === 1050);
      check(cancelResponse, { 'cancel принят': (value) => value.status === 201 });
    }
  }
  getQuery(baseUrl, '/api/v1/projections/orders?limit=20', apiKey, '/api/v1/projections/orders');
  getQuery(baseUrl, '/api/v1/projections/trades?limit=20', apiKey, '/api/v1/projections/trades');
  getQuery(
    baseUrl,
    '/api/v1/projections/balances?limit=20',
    apiKey,
    '/api/v1/projections/balances',
  );
  sleep(0.05);
}

/**
 * Создаёт короткую Socket.IO-сессию с public/private subscriptions и reconnect.
 * Реализован Engine.IO v4 framing: `0` handshake, `40` namespace connect,
 * `42` event; на server ping `2` клиент отвечает pong `3`.
 */
export async function websocketWorkload(data) {
  const privateSession = exec.scenario.iterationInTest % 2 === 0;
  const socket = new WebSocket(`${wsUrl}/socket.io/?EIO=4&transport=websocket`);
  let namespaceConnected = false;
  let acknowledged = false;
  await new Promise((resolve) => {
    const deadline = setTimeout(
      () => {
        socket.close();
        resolve();
      },
      Number(__ENV.LOAD_WS_SESSION_MS || 1500),
    );
    socket.addEventListener('message', (event) => {
      const frame = String(event.data);
      if (frame.startsWith('0')) {
        socket.send(`40/market-data,${privateSession ? JSON.stringify({ apiKey }) : ''}`);
      } else if (frame.startsWith('40/market-data,')) {
        namespaceConnected = true;
        const requestId = uniqueId(
          data.runId,
          'ws',
          exec.scenario.name,
          exec.vu.idInTest,
          exec.scenario.iterationInTest,
        );
        const request = privateSession
          ? { requestId, channel: 'user', userId: __ENV.LOAD_ACCOUNT_ID || 'dev-user' }
          : { requestId, channel: 'ticker', instrumentId: instrumentForWs() };
        socket.send(`42/market-data,["market.subscribe",${JSON.stringify(request)}]`);
      } else if (frame.startsWith('42/market-data,["market.ack"')) {
        acknowledged = true;
      } else if (frame === '2') socket.send('3');
    });
    socket.addEventListener('close', () => {
      clearTimeout(deadline);
      resolve();
    });
    socket.addEventListener('error', () => resolve());
  });
  websocketSuccess.add(namespaceConnected && acknowledged);
  check(null, { 'websocket subscription подтверждена': () => namespaceConnected && acknowledged });
}

/** Выбирает bounded public instrument для WebSocket workload. */
function instrumentForWs() {
  return distribution === 'hot' || exec.scenario.iterationInTest % 2 === 0 ? 'BTC-USD' : 'ETH-USD';
}

/** Сохраняет машиночитаемый aggregate и GitHub-compatible краткий отчёт. */
export function handleSummary(data) {
  const metric = (name, field) => data.metrics[name]?.values?.[field] ?? null;
  const restDuration = 'http_req_duration{scenario:rest}';
  const restFailures = 'http_req_failed{scenario:rest}';
  const report = {
    profile: selectedProfile,
    runId,
    distribution,
    p50Ms: metric(restDuration, 'med'),
    p95Ms: metric(restDuration, 'p(95)'),
    p99Ms: metric(restDuration, 'p(99)'),
    maxMs: metric(restDuration, 'max'),
    errorRate: metric(restFailures, 'rate'),
    timeoutRate: metric('load_timeout_rate', 'rate'),
    acceptedCommands: metric('load_accepted_commands', 'count'),
    acceptedCommandsPerSecond: metric('load_accepted_commands', 'rate'),
    duplicateEffectRate: metric('load_duplicate_effect_rate', 'rate'),
    acceptedVisibilityFailureRate: metric('load_accepted_visibility_failure_rate', 'rate'),
  };
  const markdown = `## k6 ${selectedProfile} load profile\n\n| p50 | p95 | p99 | max | error rate | timeouts | accepted |\n| ---: | ---: | ---: | ---: | ---: | ---: | ---: |\n| ${report.p50Ms} ms | ${report.p95Ms} ms | ${report.p99Ms} ms | ${report.maxMs} ms | ${report.errorRate} | ${report.timeoutRate} | ${report.acceptedCommands} |\n`;
  return {
    '/results/k6-summary.json': JSON.stringify({ report, metrics: data.metrics }, null, 2),
    '/results/k6-summary.md': markdown,
    stdout: markdown,
  };
}
