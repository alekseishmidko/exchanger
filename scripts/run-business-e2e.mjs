import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const requireFromBackend = createRequire(resolve('apps/backend/package.json'));
const { io } = requireFromBackend('socket.io-client');

const baseUrl = (process.env['BUSINESS_E2E_BASE_URL'] ?? 'http://localhost:5001').replace(
  /\/+$/,
  '',
);
const websocketUrl = (
  process.env['BUSINESS_E2E_WS_URL'] ?? `${baseUrl.replace(/^http/, 'ws')}/market-data`
).replace(/\/+$/, '');
const adminKey = process.env['BUSINESS_E2E_ADMIN_KEY'] ?? 'dev-admin-key';
let approvalAdminKey = process.env['BUSINESS_E2E_SECOND_ADMIN_KEY'] ?? adminKey;
const configuredBuyerKey = process.env['BUSINESS_E2E_BUYER_KEY'];
const configuredSellerKey = process.env['BUSINESS_E2E_SELLER_KEY'];
const reportDirectory = resolve(process.env['BUSINESS_E2E_REPORT_DIR'] ?? 'artifacts/business-e2e');
const requestTimeoutMs = Number(process.env['BUSINESS_E2E_REQUEST_TIMEOUT_MS'] ?? 5000);
const startupTimeoutMs = Number(process.env['BUSINESS_E2E_STARTUP_TIMEOUT_MS'] ?? 60000);
const runId = (process.env['BUSINESS_E2E_RUN_ID'] ?? randomUUID().replaceAll('-', '').slice(0, 12))
  .replace(/[^A-Za-z0-9_-]/g, '')
  .toLowerCase();
const buildSha = await gitSha();
const startedAt = new Date();
const timeline = [];
const failures = [];
const websocketTranscript = [];

/** Пауза между bounded polling attempts без busy-loop. */
function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

/** Добавляет machine-readable событие timeline без секретов и request payload. */
function mark(event, metadata = {}) {
  timeline.push({ at: new Date().toISOString(), event, metadata });
}

/** Условие proof-check; failure сохраняется в report и stderr. */
function check(condition, message, metadata = {}) {
  if (condition) {
    mark(`check.passed:${message}`, metadata);
    return;
  }
  failures.push({ message, metadata });
  mark(`check.failed:${message}`, metadata);
  process.stderr.write(`✗ ${message}\n`);
}

/** Бросает ошибку для hard dependency шага, без которого сценарий продолжить нельзя. */
function assert(condition, message) {
  if (!condition) throw new Error(message);
}

/** HTTP helper public/admin API без сохранения secret headers в artifacts. */
async function http(method, path, { apiKey = adminKey, idempotencyKey, body, expected } = {}) {
  const started = performance.now();
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    signal: AbortSignal.timeout(requestTimeoutMs),
    headers: {
      accept: 'application/json',
      ...(apiKey ? { 'x-api-key': apiKey } : {}),
      ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}),
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const responseBody = await response.json().catch(() => null);
  mark('http', {
    method,
    path,
    status: response.status,
    durationMs: Math.round(performance.now() - started),
  });
  if (expected && !expected.includes(response.status)) {
    throw new Error(`${method} ${path}: ожидался HTTP ${expected.join('/')}, получен ${response.status}`);
  }
  return { status: response.status, body: responseBody };
}

/** Получает raw text artifact, например Prometheus exposition. */
async function textHttp(path) {
  const response = await fetch(`${baseUrl}${path}`, {
    signal: AbortSignal.timeout(requestTimeoutMs),
    headers: { accept: 'text/plain' },
  });
  return response.text();
}

/** Ожидает business readiness до запуска доказательного flow. */
async function waitForReadiness() {
  const deadline = Date.now() + startupTimeoutMs;
  let last = 'not-started';
  while (Date.now() < deadline) {
    try {
      const ready = await http('GET', '/health/ready', { apiKey: '', expected: [200, 503] });
      last = `HTTP ${ready.status}`;
      if (ready.status === 200 && ready.body?.status === 'ok') return;
    } catch (error) {
      last = error instanceof Error ? error.message : 'NETWORK_ERROR';
    }
    await delay(1000);
  }
  throw new Error(`readiness не стала ok за ${startupTimeoutMs} ms; последнее состояние: ${last}`);
}

/** Выпускает одноразовый trader API key публичным admin endpoint. */
async function issueTrader(userId, label) {
  const commandId = `issue-${label}-${runId}`;
  const issued = await http('POST', '/api/v1/auth/api-keys', {
    apiKey: adminKey,
    idempotencyKey: commandId,
    expected: [201],
    body: { commandId, userId, role: 'trader', label },
  });
  assert(typeof issued.body?.apiKey === 'string', `api key для ${label} не выпущен`);
  return issued.body.apiKey;
}

/**
 * Возвращает trader identity для black-box flow.
 *
 * В development profile ключ можно выпустить через публичный auth endpoint.
 * В staging/RPO proof ключи должны быть preconfigured через `GATEWAY_API_KEYS`,
 * иначе после SIGKILL in-memory registry забудет issued secret и проверка
 * restart превратится в ложный `401`, не связанный с торговым runtime.
 */
async function traderIdentity(kind) {
  const userId = `${kind}-${runId}`;
  const configured = kind === 'buyer' ? configuredBuyerKey : configuredSellerKey;
  return {
    userId,
    accountId: userId,
    apiKey: configured ?? (await issueTrader(userId, userId)),
  };
}

/** Выпускает второго admin-а для dual-control, если окружение передало только один default key. */
async function ensureApprovalAdmin() {
  if (approvalAdminKey !== adminKey) return;
  const commandId = `issue-approval-admin-${runId}`;
  const issued = await http('POST', '/api/v1/auth/api-keys', {
    apiKey: adminKey,
    idempotencyKey: commandId,
    expected: [201],
    body: {
      commandId,
      userId: `approval-admin-${runId}`,
      role: 'admin',
      label: `approval-admin-${runId}`,
    },
  });
  assert(typeof issued.body?.apiKey === 'string', 'second admin key не выпущен');
  approvalAdminKey = issued.body.apiKey;
}

/** Выполняет dual-control команду: request admin-1, approve admin-2. */
async function dualControl(path, body, idempotencyKey) {
  const requested = await http('POST', path, {
    apiKey: adminKey,
    idempotencyKey,
    expected: [201, 409],
    body,
  });
  if (requested.status === 409) return requested;
  if (requested.body?.status === 'PENDING_APPROVAL') {
    await http('POST', `/api/v1/admin/approvals/${body.commandId}`, {
      apiKey: approvalAdminKey,
      idempotencyKey: `${idempotencyKey}-approval`,
      expected: [201],
    });
  }
  return requested;
}

/** Создаёт BTC-USD, если catalog ещё пуст для текущего process/runtime. */
async function ensureInstrument() {
  const existing = await http('GET', '/api/v1/instruments/BTC-USD', {
    apiKey: adminKey,
    expected: [200, 404],
  });
  if (existing.status === 200) {
    if (existing.body?.status !== 'ACTIVE') {
      const commandId = `activate-existing-${runId}`;
      await dualControl(
        '/api/v1/admin/instruments/BTC-USD/status',
        { commandId, status: 'ACTIVE' },
        commandId,
      );
    }
    return;
  }
  const createCommandId = `instrument-create-${runId}`;
  await dualControl(
    '/api/v1/admin/instruments',
    {
      commandId: createCommandId,
      mode: 'CREATE',
      instrumentId: 'BTC-USD',
      baseAssetId: 'BTC',
      quoteAssetId: 'USD',
      rules: {
        version: `rules-${runId}`,
        effectiveAt: '2026-01-01T00:00:00.000Z',
        tickSize: '0.5',
        lotSize: '0.001',
        minQuantity: '0.001',
        maxQuantity: '100',
        minPrice: '1',
        maxPrice: '1000000',
        feePolicyVersion: `fees-${runId}`,
        maxOrderQuantity: '100',
        maxOpenOrders: 1000,
        maxNotional: '100000000',
      },
    },
    createCommandId,
  );
  const activateCommandId = `instrument-activate-${runId}`;
  await dualControl(
    '/api/v1/admin/instruments/BTC-USD/status',
    { commandId: activateCommandId, status: 'ACTIVE' },
    activateCommandId,
  );
}

/** Создаёт аккаунт и открывает USD/BTC balances через public trader boundary. */
async function createAccount(apiKey, userId, accountId) {
  const created = await http('POST', '/api/v1/accounts', {
    apiKey,
    idempotencyKey: `account-${accountId}`,
    expected: [201, 409],
    body: {
      commandId: `account-${accountId}`,
      accountId,
      ownerId: userId,
      balances: [
        { assetId: 'USD', code: 'USD', scale: 2 },
        { assetId: 'BTC', code: 'BTC', scale: 8 },
      ],
    },
  });
  if (created.status === 409) {
    const existing = await http('GET', `/api/v1/accounts/${accountId}`, {
      apiKey,
      expected: [200],
    });
    assert(
      existing.body?.ownerId === userId,
      `account ${accountId} существует, но принадлежит другому owner`,
    );
  }
}

/** Funding выполняется только authorizer admin-командой, а не прямой ledger mutation. */
async function fund(accountId, assetId, amount) {
  const commandId = `fund-${accountId}-${assetId}-${runId}`;
  return http('POST', `/api/v1/accounts/${accountId}/balances/${assetId}/commands`, {
    apiKey: adminKey,
    idempotencyKey: commandId,
    expected: [201],
    body: { commandId, action: 'CREDIT', amount },
  });
}

/** Подключает Socket.IO client и сохраняет transcript всех server envelopes. */
async function connectSocket(label, apiKey) {
  const socket = io(websocketUrl, {
    autoConnect: false,
    transports: ['websocket'],
    reconnection: false,
    ...(apiKey ? { auth: { apiKey } } : {}),
  });
  for (const eventName of ['market.ack', 'market.data', 'market.error', 'heartbeat.ack']) {
    socket.on(eventName, (payload) => {
      websocketTranscript.push({ at: new Date().toISOString(), label, eventName, payload });
    });
  }
  await new Promise((resolveConnect, rejectConnect) => {
    const timeout = setTimeout(() => rejectConnect(new Error(`WS ${label} timeout`)), 3000);
    socket.once('connect', () => {
      clearTimeout(timeout);
      resolveConnect();
    });
    socket.once('connect_error', (error) => {
      clearTimeout(timeout);
      rejectConnect(error);
    });
    socket.connect();
  });
  return socket;
}

/** Подписывает public/private каналы с публичным protocol payload. */
function subscribe(socket, payload) {
  socket.emit('market.subscribe', payload);
}

/** Place order через REST command API. */
async function place(apiKey, order) {
  return http('POST', '/api/v1/orders', {
    apiKey,
    idempotencyKey: order.commandId,
    expected: [201],
    body: {
      commandId: order.commandId,
      orderId: order.orderId,
      accountId: order.accountId,
      instrumentId: 'BTC-USD',
      clientOrderId: order.orderId,
      side: order.side,
      orderType: 'LIMIT',
      quantity: order.quantity,
      limitPrice: order.price,
      timeInForce: 'GTC',
    },
  });
}

/** Public query helpers. */
async function orders(apiKey) {
  return (await http('GET', '/api/v1/projections/orders?limit=100', { apiKey, expected: [200] }))
    .body?.items ?? [];
}
async function trades(apiKey) {
  return (await http('GET', '/api/v1/projections/trades?limit=100', { apiKey, expected: [200] }))
    .body?.items ?? [];
}
async function balances(apiKey) {
  return (
    await http('GET', '/api/v1/projections/balances?limit=100', { apiKey, expected: [200] })
  ).body?.items ?? [];
}

/** Polling assertion для eventually-consistent projections. */
async function waitUntil(name, predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await predicate();
    if (last?.ok) return last.value;
    await delay(250);
  }
  throw new Error(`${name}: условие не выполнено; последнее состояние ${JSON.stringify(last)}`);
}

/** Проверяет одну сделку: sell resting order, buy crossing order. */
async function runFillScenario({ name, buyer, seller, sellQuantity, buyQuantity, sellPrice, buyPrice }) {
  const sellOrderId = `${name}-sell-${runId}`;
  const buyOrderId = `${name}-buy-${runId}`;
  const sell = await place(seller.apiKey, {
    commandId: `${sellOrderId}-cmd`,
    orderId: sellOrderId,
    accountId: seller.accountId,
    side: 'SELL',
    quantity: sellQuantity,
    price: sellPrice,
  });
  check(
    sell.body?.durableStatus === 'ACCEPTED' && ['PENDING', 'APPLIED'].includes(sell.body?.executionStatus),
    `${name}: sell command получил durable acceptance`,
    { sellOrderId, response: safeCommandResult(sell.body) },
  );

  const buy = await place(buyer.apiKey, {
    commandId: `${buyOrderId}-cmd`,
    orderId: buyOrderId,
    accountId: buyer.accountId,
    side: 'BUY',
    quantity: buyQuantity,
    price: buyPrice,
  });
  check(
    buy.body?.durableStatus === 'ACCEPTED' && ['PENDING', 'APPLIED'].includes(buy.body?.executionStatus),
    `${name}: buy command получил durable acceptance`,
    { buyOrderId, response: safeCommandResult(buy.body) },
  );

  const buyerTrades = await waitUntil(`${name}: buyer trade history`, async () => {
    const rows = await trades(buyer.apiKey);
    const related = rows.filter((trade) => trade.makerOrderId === sellOrderId || trade.takerOrderId === buyOrderId);
    return { ok: related.length > 0, value: related };
  }).catch((error) => {
    failures.push({ message: error.message, metadata: { name } });
    return [];
  });
  const sellerTrades = await trades(seller.apiKey).catch(() => []);
  const trade = buyerTrades[0];
  check(Boolean(trade), `${name}: TradeExecuted виден покупателю`);
  if (trade) {
    check(trade.price === sellPrice, `${name}: TradeExecuted использует passive maker price`, {
      expected: sellPrice,
      actual: trade.price,
      trade,
    });
    check(
      trade.makerOrderId === sellOrderId && trade.takerOrderId === buyOrderId,
      `${name}: maker/taker стороны корректны`,
      { trade },
    );
    check(
      sellerTrades.some((row) => row.tradeId === trade.tradeId),
      `${name}: trade history согласована у обеих сторон`,
      { tradeId: trade.tradeId },
    );
  }

  const [buyerOrders, sellerOrders] = await Promise.all([orders(buyer.apiKey), orders(seller.apiKey)]);
  const buyerOrder = buyerOrders.find((order) => order.orderId === buyOrderId);
  const sellerOrder = sellerOrders.find((order) => order.orderId === sellOrderId);
  check(Boolean(buyerOrder), `${name}: buyer order history содержит заявку`, { buyOrderId });
  check(Boolean(sellerOrder), `${name}: seller order history содержит заявку`, { sellOrderId });
  if (buyerOrder && sellerOrder) {
    check(
      ['FILLED', 'PARTIALLY_FILLED', 'OPEN'].includes(buyerOrder.status) &&
        ['FILLED', 'PARTIALLY_FILLED', 'OPEN'].includes(sellerOrder.status),
      `${name}: order lifecycle перешёл дальше accepted/open`,
      { buyerStatus: buyerOrder.status, sellerStatus: sellerOrder.status },
    );
  }
  return { sellOrderId, buyOrderId, trade };
}

/** Убирает credential material из command result metadata. */
function safeCommandResult(body) {
  if (!body || typeof body !== 'object') return body;
  const { commandId, orderId, status, durableStatus, executionStatus, orderStatus, rejectionCode } = body;
  return { commandId, orderId, status, durableStatus, executionStatus, orderStatus, rejectionCode };
}

/** Выполняет optional SIGKILL proof, если оператор явно передал команду. */
async function runSigkillProof(buyer, orderId) {
  const command = process.env['BUSINESS_E2E_SIGKILL_COMMAND'];
  if (!command) {
    failures.push({
      message: 'SIGKILL/restart proof не выполнен: BUSINESS_E2E_SIGKILL_COMMAND не задан',
      metadata: { required: true },
    });
    return;
  }
  await shell(command);
  await waitForReadiness();
  const result = await http('GET', `/api/v1/orders/${orderId}`, {
    apiKey: buyer.apiKey,
    expected: [200],
  });
  check(Boolean(result.body?.commandId), 'после SIGKILL прежний idempotent result доступен', {
    orderId,
    result: safeCommandResult(result.body),
  });
}

/** Shell command только из явного env interlock для staging SIGKILL proof. */
function shell(command) {
  return new Promise((resolveShell, rejectShell) => {
    const child = spawn(command, [], { shell: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (chunk) => (output += String(chunk)));
    child.stderr.on('data', (chunk) => (output += String(chunk)));
    child.once('close', (code) => {
      mark('shell', { command: 'BUSINESS_E2E_SIGKILL_COMMAND', exitCode: code });
      if (code === 0) resolveShell(output);
      else rejectShell(new Error(`SIGKILL command failed with code ${code}`));
    });
  });
}

/** Собирает финальную reconciliation и public/private isolation proofs. */
async function finalChecks(buyer, seller) {
  const [buyerBalances, sellerBalances, reconciliation, metrics] = await Promise.all([
    balances(buyer.apiKey).catch(() => []),
    balances(seller.apiKey).catch(() => []),
    http('GET', '/api/v1/admin/reconciliation', { apiKey: adminKey, expected: [200] }).catch(
      (error) => ({ body: { error: error.message } }),
    ),
    textHttp('/internal/metrics').catch((error) => `metrics collection failed: ${error.message}`),
  ]);
  check(Array.isArray(buyerBalances), 'buyer balance projection доступна');
  check(Array.isArray(sellerBalances), 'seller balance projection доступна');
  check(reconciliation.body?.auditIntegrity === true, 'audit chain integrity подтверждена reconciliation', {
    reconciliation: reconciliation.body,
  });
  const buyerPrivateLeak = websocketTranscript.some(
    (entry) =>
      entry.label === 'buyer-private' &&
      JSON.stringify(entry.payload).includes(seller.userId) &&
      entry.eventName === 'market.data',
  );
  const sellerPrivateLeak = websocketTranscript.some(
    (entry) =>
      entry.label === 'seller-private' &&
      JSON.stringify(entry.payload).includes(buyer.userId) &&
      entry.eventName === 'market.data',
  );
  check(!buyerPrivateLeak, 'private events buyer не содержат seller stream');
  check(!sellerPrivateLeak, 'private events seller не содержат buyer stream');
  check(
    websocketTranscript.some((entry) => entry.eventName === 'market.data'),
    'WebSocket transcript содержит market.data events',
  );
  return { buyerBalances, sellerBalances, reconciliation: reconciliation.body, metrics };
}

/** Выполняет optional artifact collection command без попадания secret env в report. */
async function optionalCommandArtifact(envName, fallback) {
  const command = process.env[envName];
  if (!command) return fallback;
  try {
    return await shell(command);
  } catch (error) {
    return `${envName} failed: ${error instanceof Error ? error.message : 'unknown error'}`;
  }
}

async function gitSha() {
  return new Promise((resolveSha) => {
    const child = spawn('git', ['rev-parse', 'HEAD'], { stdio: ['ignore', 'pipe', 'ignore'] });
    let output = '';
    child.stdout.on('data', (chunk) => (output += String(chunk)));
    child.once('close', (code) => resolveSha(code === 0 ? output.trim() : 'unknown'));
  });
}

async function writeReports(extra = {}) {
  const finishedAt = new Date();
  const status = failures.length === 0 ? 'passed' : 'failed';
  const report = {
    schemaVersion: 1,
    pipeline: 'black-box-business-e2e',
    status,
    runId,
    buildSha,
    topology: process.env['BUSINESS_E2E_TOPOLOGY'] ?? 'external-running-environment',
    baseUrl,
    websocketUrl,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    timeline,
    failures,
    ...extra,
  };
  await mkdir(reportDirectory, { recursive: true });
  const logs = await optionalCommandArtifact(
    'BUSINESS_E2E_LOG_COMMAND',
    'BUSINESS_E2E_LOG_COMMAND not configured; pass docker/kubectl logs command in staging.\n',
  );
  const traces = await optionalCommandArtifact(
    'BUSINESS_E2E_TRACE_COMMAND',
    JSON.stringify(
      {
        status: 'not_configured',
        message: 'BUSINESS_E2E_TRACE_COMMAND not configured; pass Tempo/OTel export command in staging.',
      },
      null,
      2,
    ),
  );
  const metrics = typeof extra.metrics === 'string' ? extra.metrics : 'metrics not collected\n';
  const summaryRows = failures.length
    ? failures.map((failure) => `| ❌ | ${failure.message} |`).join('\n')
    : '| ✅ | все business invariants доказаны |';
  await Promise.all([
    writeFile(resolve(reportDirectory, 'report.json'), `${JSON.stringify(report, null, 2)}\n`),
    writeFile(
      resolve(reportDirectory, 'websocket-transcript.json'),
      `${JSON.stringify(websocketTranscript, null, 2)}\n`,
    ),
    writeFile(resolve(reportDirectory, 'timeline.json'), `${JSON.stringify(timeline, null, 2)}\n`),
    writeFile(resolve(reportDirectory, 'logs.txt'), logs),
    writeFile(resolve(reportDirectory, 'traces.json'), traces.endsWith('\n') ? traces : `${traces}\n`),
    writeFile(resolve(reportDirectory, 'metrics.prom'), metrics.endsWith('\n') ? metrics : `${metrics}\n`),
    writeFile(
      resolve(reportDirectory, 'summary.md'),
      `# Black-box business E2E\n\n**Status:** ${status === 'passed' ? '✅ passed' : '❌ failed'}  \n**Run:** ${runId}  \n**Build:** ${buildSha}  \n**Artifacts:** \`${reportDirectory}\`\n\n| Status | Check |\n| --- | --- |\n${summaryRows}\n`,
    ),
  ]);
  return report;
}

async function main() {
  const sockets = [];
  let extra = {};
  try {
    await waitForReadiness();
    await ensureApprovalAdmin();
    await ensureInstrument();

    const buyer = await traderIdentity('buyer');
    const seller = await traderIdentity('seller');

    await createAccount(buyer.apiKey, buyer.userId, buyer.accountId);
    await createAccount(seller.apiKey, seller.userId, seller.accountId);
    await Promise.all([
      fund(buyer.accountId, 'USD', '100000'),
      fund(seller.accountId, 'BTC', '10'),
    ]);

    const publicSocket = await connectSocket('public', undefined);
    const buyerSocket = await connectSocket('buyer-private', buyer.apiKey);
    const sellerSocket = await connectSocket('seller-private', seller.apiKey);
    sockets.push(publicSocket, buyerSocket, sellerSocket);
    subscribe(publicSocket, { requestId: `book-${runId}`, channel: 'book', instrumentId: 'BTC-USD' });
    subscribe(publicSocket, {
      requestId: `trades-${runId}`,
      channel: 'trades',
      instrumentId: 'BTC-USD',
    });
    subscribe(publicSocket, {
      requestId: `ticker-${runId}`,
      channel: 'ticker',
      instrumentId: 'BTC-USD',
    });
    subscribe(buyerSocket, { requestId: `buyer-${runId}`, channel: 'user', userId: buyer.userId });
    subscribe(sellerSocket, {
      requestId: `seller-${runId}`,
      channel: 'user',
      userId: seller.userId,
    });
    await delay(300);

    const exact = await runFillScenario({
      name: 'exact',
      buyer,
      seller,
      sellQuantity: '1',
      buyQuantity: '1',
      sellPrice: '100',
      buyPrice: '120',
    });
    await runFillScenario({
      name: 'partial',
      buyer,
      seller,
      sellQuantity: '2',
      buyQuantity: '1',
      sellPrice: '110',
      buyPrice: '120',
    });
    await runFillScenario({
      name: 'multi-a',
      buyer,
      seller,
      sellQuantity: '1',
      buyQuantity: '1',
      sellPrice: '90',
      buyPrice: '100',
    });
    await runFillScenario({
      name: 'multi-b',
      buyer,
      seller,
      sellQuantity: '1',
      buyQuantity: '1',
      sellPrice: '95',
      buyPrice: '100',
    });

    const retry = await place(buyer.apiKey, {
      commandId: `${exact.buyOrderId}-cmd`,
      orderId: exact.buyOrderId,
      accountId: buyer.accountId,
      side: 'BUY',
      quantity: '1',
      price: '120',
    });
    check(retry.status === 201, 'повтор place не создаёт второй business effect', {
      result: safeCommandResult(retry.body),
    });

    await runSigkillProof(buyer, exact.buyOrderId);
    extra = await finalChecks(buyer, seller);
  } catch (error) {
    failures.push({
      message: error instanceof Error ? error.message : 'unknown business e2e error',
      metadata: { phase: 'main' },
    });
  } finally {
    for (const socket of sockets) socket.disconnect();
  }

  const report = await writeReports(extra);
  process.stdout.write(
    `Business E2E ${report.status}. Failures: ${failures.length}. Reports: ${reportDirectory}\n`,
  );
  if (report.status === 'failed') process.exitCode = 1;
}

await main();
