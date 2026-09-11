import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

/** Базовый URL уже запущенного black-box окружения без завершающего slash. */
const baseUrl = (process.env['API_FLOW_BASE_URL'] ?? 'http://localhost:5001').replace(/\/+$/, '');
/** API key читается только из process environment и никогда не попадает в отчёт. */
const apiKey = process.env['API_FLOW_API_KEY'] ?? 'dev-key';
/** Ограничивает один HTTP-вызов, чтобы зависшая зависимость завершала pipeline. */
const requestTimeoutMs = Number(process.env['API_FLOW_REQUEST_TIMEOUT_MS'] ?? 5000);
/** Ограничивает ожидание старта Compose/Nest перед выполнением business flows. */
const startupTimeoutMs = Number(process.env['API_FLOW_STARTUP_TIMEOUT_MS'] ?? 60000);
/** Каталог машиночитаемых результатов, исключённый из Git. */
const reportDirectory = resolve(process.env['API_FLOW_REPORT_DIR'] ?? 'artifacts/api-flows');
/** Уникальный suffix устраняет конфликты ресурсов между повторными запусками. */
const runId = randomUUID().replaceAll('-', '').slice(0, 12);
/** Накопленные результаты без request body, response body и credentials. */
const steps = [];
const startedAt = new Date();

/** Возвращает паузу для bounded readiness polling без busy loop. */
function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

/**
 * Ожидает настоящий readiness endpoint перед запуском зависимых сценариев.
 * Повторяются только network/503 ответы; секреты и response body не печатаются.
 *
 * @example Если Docker стартует 8 секунд, pipeline продолжится сразу после
 * первого ответа `200 {"status":"ok"}`.
 */
async function waitForReadiness() {
  const deadline = Date.now() + startupTimeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/health/ready`, {
        signal: AbortSignal.timeout(requestTimeoutMs),
      });
      if (response.status === 200) return;
    } catch {
      // Процесс может ещё не слушать порт; следующая попытка ограничена deadline.
    }
    await delay(1000);
  }
  throw new Error(`Приложение не стало ready за ${startupTimeoutMs} ms`);
}

/**
 * Выполняет один endpoint check и немедленно показывает его статус в терминале.
 * В отчёт попадают только имя, HTTP status, duration и безопасная ошибка — тела
 * запросов/ответов и credentials намеренно не сохраняются.
 */
async function runStep({
  group,
  name,
  method = 'GET',
  path,
  expectedStatus = 200,
  body,
  validate,
}) {
  const stepStartedAt = performance.now();
  let statusCode = null;
  try {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      signal: AbortSignal.timeout(requestTimeoutMs),
      headers: {
        accept: 'application/json',
        'x-api-key': apiKey,
        ...(body ? { 'content-type': 'application/json' } : {}),
        ...(body?.idempotencyKey ? { 'idempotency-key': body.idempotencyKey } : {}),
      },
      body: body ? JSON.stringify(body.payload) : undefined,
    });
    statusCode = response.status;
    const responseBody = await response.json().catch(() => null);
    if (response.status !== expectedStatus) {
      throw new Error(`ожидался HTTP ${expectedStatus}, получен HTTP ${response.status}`);
    }
    validate?.(responseBody);
    const result = {
      group,
      name,
      status: 'passed',
      statusCode,
      durationMs: Math.round(performance.now() - stepStartedAt),
    };
    steps.push(result);
    process.stdout.write(`✓ [${group}] ${name} (${result.durationMs} ms)\n`);
  } catch (error) {
    const result = {
      group,
      name,
      status: 'failed',
      statusCode,
      durationMs: Math.round(performance.now() - stepStartedAt),
      error: error instanceof Error ? error.message : 'неизвестная ошибка',
    };
    steps.push(result);
    process.stderr.write(`✗ [${group}] ${name}: ${result.error}\n`);
  }
}

/** Завершает step ошибкой, если публичный JSON-контракт нарушен. */
function assert(condition, message) {
  if (!condition) throw new Error(message);
}

/** Экранирует динамические значения перед формированием JUnit XML. */
function escapeXml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

/**
 * Сохраняет JSON для автоматической обработки, JUnit для CI-инструментов и
 * Markdown summary для GitHub Actions. Файлы создаются даже при failure.
 */
async function writeReports(finishedAt) {
  const failed = steps.filter((step) => step.status === 'failed');
  const durationMs = finishedAt.getTime() - startedAt.getTime();
  const report = {
    pipeline: 'development-api-flows',
    status: failed.length === 0 ? 'passed' : 'failed',
    baseUrl,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs,
    total: steps.length,
    passed: steps.length - failed.length,
    failed: failed.length,
    steps,
  };
  const testCases = steps
    .map((step) => {
      const failure =
        step.status === 'failed' ? `<failure message="${escapeXml(step.error)}" />` : '';
      return `<testcase classname="api.${escapeXml(step.group)}" name="${escapeXml(step.name)}" time="${step.durationMs / 1000}">${failure}</testcase>`;
    })
    .join('');
  const junit = `<?xml version="1.0" encoding="UTF-8"?><testsuite name="development-api-flows" tests="${steps.length}" failures="${failed.length}" time="${durationMs / 1000}">${testCases}</testsuite>`;
  const rows = steps
    .map(
      (step) =>
        `| ${step.status === 'passed' ? '✅' : '❌'} | ${step.group} | ${step.name} | ${step.statusCode ?? '—'} | ${step.durationMs} ms |`,
    )
    .join('\n');
  const summary = `## Development API flow pipeline\n\n**Status:** ${report.status === 'passed' ? '✅ passed' : '❌ failed'}  \n**Endpoint:** ${baseUrl}  \n**Result:** ${report.passed}/${report.total}\n\n| Status | Group | Check | HTTP | Duration |\n| --- | --- | --- | ---: | ---: |\n${rows}\n`;

  await mkdir(reportDirectory, { recursive: true });
  await Promise.all([
    writeFile(resolve(reportDirectory, 'report.json'), `${JSON.stringify(report, null, 2)}\n`),
    writeFile(resolve(reportDirectory, 'junit.xml'), junit),
    writeFile(resolve(reportDirectory, 'summary.md'), summary),
  ]);
  return report;
}

/**
 * Запускает группы health → authentication → catalog/query → command flow.
 * Команды используют уникальные IDs и повтор PlaceOrder с тем же
 * Idempotency-Key, поэтому pipeline можно безопасно запускать многократно.
 */
async function main() {
  try {
    await waitForReadiness();
    let authenticatedSubjectId;
    await runStep({
      group: 'health',
      name: 'liveness',
      path: '/health/live',
      validate: (body) => assert(body?.status === 'ok', 'liveness status должен быть ok'),
    });
    await runStep({
      group: 'health',
      name: 'readiness',
      path: '/health/ready',
      validate: (body) => assert(body?.status === 'ok', 'readiness status должен быть ok'),
    });
    await runStep({
      group: 'documentation',
      name: 'OpenAPI document',
      path: '/docs/openapi.json',
      validate: (body) =>
        assert(Boolean(body?.paths?.['/api/v1/auth/me']), 'auth route отсутствует'),
    });
    await runStep({
      group: 'authentication',
      name: 'current principal',
      path: '/api/v1/auth/me',
      validate: (body) => {
        assert(
          body?.authenticated === true && typeof body?.subjectId === 'string',
          'identity invalid',
        );
        authenticatedSubjectId = body.subjectId;
      },
    });
    await runStep({ group: 'catalog', name: 'instrument catalog', path: '/api/v1/instruments' });
    await runStep({
      group: 'queries',
      name: 'projection metrics',
      path: '/api/v1/projections/metrics',
      validate: (body) => assert(Number.isInteger(body?.lag), 'projection lag отсутствует'),
    });

    const accountId = `smoke-account-${runId}`;
    await runStep({
      group: 'accounts',
      name: 'create account',
      method: 'POST',
      path: '/api/v1/accounts',
      expectedStatus: 201,
      body: {
        idempotencyKey: `smoke-account-idem-${runId}`,
        payload: {
          commandId: `smoke-account-command-${runId}`,
          accountId,
          ownerId: authenticatedSubjectId,
          balances: [{ assetId: 'USD', code: 'USD', scale: 2 }],
        },
      },
      validate: (body) => assert(body?.accountId === accountId, 'создан другой account'),
    });
    await runStep({
      group: 'accounts',
      name: 'read account',
      path: `/api/v1/accounts/${accountId}`,
      validate: (body) =>
        assert(body?.ownerId === authenticatedSubjectId, 'account ownership invalid'),
    });
    await runStep({
      group: 'accounts',
      name: 'read balances',
      path: `/api/v1/accounts/${accountId}/balances`,
      validate: (body) => assert(Array.isArray(body?.items), 'balance page invalid'),
    });

    const orderId = `smoke-order-${runId}`;
    const orderPayload = {
      commandId: `smoke-order-command-${runId}`,
      orderId,
      accountId: authenticatedSubjectId,
      instrumentId: 'BTC-USD',
      clientOrderId: orderId,
      side: 'BUY',
      orderType: 'LIMIT',
      quantity: '1',
      limitPrice: '100',
      timeInForce: 'GTC',
    };
    const orderBody = { idempotencyKey: `smoke-order-idem-${runId}`, payload: orderPayload };
    let firstOrderResult;
    await runStep({
      group: 'orders',
      name: 'place order',
      method: 'POST',
      path: '/api/v1/orders',
      expectedStatus: 201,
      body: orderBody,
      validate: (body) => {
        assert(body?.status === 'ACCEPTED', 'order не принят');
        firstOrderResult = body;
      },
    });
    await runStep({
      group: 'orders',
      name: 'idempotent place retry',
      method: 'POST',
      path: '/api/v1/orders',
      expectedStatus: 201,
      body: orderBody,
      validate: (body) =>
        assert(
          JSON.stringify(body) === JSON.stringify(firstOrderResult),
          'retry вернул результат, отличный от первого вызова',
        ),
    });
    await runStep({
      group: 'orders',
      name: 'order query',
      path: '/api/v1/orders?limit=100',
      validate: (body) =>
        assert(
          body?.items?.some((item) => item.orderId === orderId),
          'order отсутствует в query',
        ),
    });
    await runStep({
      group: 'orders',
      name: 'cancel order',
      method: 'POST',
      path: `/api/v1/orders/${orderId}/cancel`,
      expectedStatus: 201,
      body: {
        idempotencyKey: `smoke-cancel-idem-${runId}`,
        payload: {
          commandId: `smoke-cancel-command-${runId}`,
          orderId,
          accountId: authenticatedSubjectId,
          instrumentId: 'BTC-USD',
        },
      },
      validate: (body) => assert(body?.status === 'CANCEL_ACCEPTED', 'cancel не принят'),
    });
  } catch (error) {
    steps.push({
      group: 'startup',
      name: 'wait for readiness',
      status: 'failed',
      statusCode: null,
      durationMs: Date.now() - startedAt.getTime(),
      error: error instanceof Error ? error.message : 'неизвестная startup ошибка',
    });
  }

  const report = await writeReports(new Date());
  process.stdout.write(
    `\nPipeline: ${report.status}; ${report.passed}/${report.total} checks passed\n`,
  );
  process.stdout.write(`Reports: ${reportDirectory}\n`);
  if (report.status === 'failed') process.exitCode = 1;
}

await main();
