import { ColumnDef } from '@tanstack/react-table';
import { Suspense, lazy, useMemo, useState } from 'react';
import { DataTable } from './components/DataTable';
import { SimulationPanel } from './components/SimulationPanel';
import {
  ApiClientConfig,
  RequestLogEntry,
  callApi,
  makeIdempotencyKey,
  parseJsonBody,
  prettyJson,
} from './lib/api';

const LatencyChart = lazy(() =>
  import('./components/LatencyChart').then((module) => ({ default: module.LatencyChart })),
);

type GatewayOrder = Readonly<{
  commandId: string;
  orderId: string;
  status: string;
}>;

type Page<T> = Readonly<{
  items?: T[];
  nextCursor?: string | null;
}>;

type FlowStatus = 'idle' | 'running' | 'success' | 'failure';

type FlowStep = Readonly<{
  key: string;
  title: string;
  description: string;
  endpoint: string;
  expected: string;
  status: FlowStatus;
  durationMs?: number;
  statusCode?: RequestLogEntry['status'];
}>;

const initialFlowSteps: FlowStep[] = [
  {
    key: 'health',
    title: '1. Проверка доступности',
    description: 'Клиент убеждается, что backend готов безопасно принимать команды.',
    endpoint: 'GET /health/ready',
    expected: '200 READY',
    status: 'idle',
  },
  {
    key: 'auth',
    title: '2. Идентификация клиента',
    description: 'API key превращается в principal: userId, role и ownership boundary.',
    endpoint: 'GET /api/v1/machine-auth/me',
    expected: 'trader principal',
    status: 'idle',
  },
  {
    key: 'catalog',
    title: '3. Выбор инструмента',
    description: 'Пользователь видит каталог и immutable trading rules.',
    endpoint: 'GET /api/v1/instruments',
    expected: 'BTC-USD available',
    status: 'idle',
  },
  {
    key: 'account',
    title: '4. Подготовка аккаунта',
    description: 'Создаётся или переиспользуется ledger account с нулевыми asset-балансами.',
    endpoint: 'POST /api/v1/accounts',
    expected: '201 created или 409 exists',
    status: 'idle',
  },
  {
    key: 'credit-usd',
    title: '5. Funding USD',
    description:
      'Admin-only команда начисляет USD перед покупкой, не смешивая create-account и движение денег.',
    endpoint: 'POST /api/v1/accounts/:accountId/balances/USD/commands',
    expected: '201 credited',
    status: 'idle',
  },
  {
    key: 'credit-btc',
    title: '6. Funding BTC',
    description: 'Admin-only команда начисляет BTC для проверки обоих assets в ledger snapshot.',
    endpoint: 'POST /api/v1/accounts/:accountId/balances/BTC/commands',
    expected: '201 credited',
    status: 'idle',
  },
  {
    key: 'place',
    title: '7. Размещение заявки',
    description: 'Gateway валидирует DTO, idempotency и отправляет команду в trading port.',
    endpoint: 'POST /api/v1/orders',
    expected: 'ACCEPTED',
    status: 'idle',
  },
  {
    key: 'lookup',
    title: '8. Подтверждение заявки',
    description: 'Клиент получает public result по orderId без offset pagination race.',
    endpoint: 'GET /api/v1/orders/:orderId',
    expected: 'same orderId',
    status: 'idle',
  },
  {
    key: 'history',
    title: '9. История пользователя',
    description: 'Query boundary возвращает owner-isolated историю заявок.',
    endpoint: 'GET /api/v1/projections/orders',
    expected: 'page response',
    status: 'idle',
  },
  {
    key: 'cancel',
    title: '10. Отмена заявки',
    description: 'Пользователь отправляет cancel с новым idempotency key.',
    endpoint: 'POST /api/v1/orders/:orderId/cancel',
    expected: 'CANCEL_ACCEPTED',
    status: 'idle',
  },
  {
    key: 'balances',
    title: '11. Проверка балансов',
    description: 'Клиент видит available/reserved snapshot через ledger boundary.',
    endpoint: 'GET /api/v1/accounts/:accountId/balances',
    expected: 'balance page',
    status: 'idle',
  },
];

const defaultPlaceOrder = {
  commandId: 'manual-place-1',
  orderId: 'manual-order-1',
  accountId: 'dev-user',
  instrumentId: 'BTC-USD',
  clientOrderId: 'manual-order-1',
  side: 'BUY',
  orderType: 'LIMIT',
  quantity: '1',
  limitPrice: '100',
  timeInForce: 'GTC',
};

const defaultCreateAccount = {
  commandId: 'manual-account-1',
  accountId: 'dev-user',
  ownerId: 'dev-user',
  balances: [
    { assetId: 'USD', code: 'USD', scale: 2 },
    { assetId: 'BTC', code: 'BTC', scale: 8 },
  ],
};

/**
 * Главный экран тестовой консоли.
 *
 * Компонент хранит только transient UI state: API key, формы, последние ответы
 * и журнал запросов. Business state остаётся в backend. Каждая write-команда
 * требует idempotency key, поэтому оператор может явно проверить retry semantics.
 */
export function App() {
  const [baseUrl, setBaseUrl] = useState(localStorage.getItem('exchange.baseUrl') ?? '');
  const [apiKey, setApiKey] = useState(import.meta.env.VITE_DEV_API_KEY ?? '');
  const [adminApiKey, setAdminApiKey] = useState(import.meta.env.VITE_DEV_ADMIN_API_KEY ?? '');
  const [idempotencyKey, setIdempotencyKey] = useState(makeIdempotencyKey('manual'));
  const [placeBody, setPlaceBody] = useState(prettyJson(defaultPlaceOrder));
  const [cancelOrderId, setCancelOrderId] = useState('manual-order-1');
  const [lookupOrderId, setLookupOrderId] = useState('manual-order-1');
  const [accountId, setAccountId] = useState('dev-user');
  const [assetId, setAssetId] = useState('USD');
  const [accountBody, setAccountBody] = useState(prettyJson(defaultCreateAccount));
  const [adminBody, setAdminBody] = useState(
    prettyJson({
      commandId: 'manual-freeze-1',
      targetType: 'ACCOUNT',
      targetId: 'dev-user',
      action: 'FREEZE',
    }),
  );
  const [lastResponse, setLastResponse] = useState<unknown>(null);
  const [orders, setOrders] = useState<GatewayOrder[]>([]);
  const [projectionRows, setProjectionRows] = useState<Record<string, unknown>[]>([]);
  const [instrumentRows, setInstrumentRows] = useState<Record<string, unknown>[]>([]);
  const [balanceRows, setBalanceRows] = useState<Record<string, unknown>[]>([]);
  const [logs, setLogs] = useState<RequestLogEntry[]>([]);
  const [flowSteps, setFlowSteps] = useState<FlowStep[]>(initialFlowSteps);
  const [flowRunId, setFlowRunId] = useState('не запускался');
  const [flowBusy, setFlowBusy] = useState(false);
  const [showDiagnostics, setShowDiagnostics] = useState(false);

  const config: ApiClientConfig = useMemo(() => ({ baseUrl, apiKey }), [baseUrl, apiKey]);
  const adminConfig: ApiClientConfig = useMemo(
    () => ({ baseUrl, apiKey: adminApiKey }),
    [baseUrl, adminApiKey],
  );

  const requestColumns = useMemo<ColumnDef<RequestLogEntry>[]>(
    () => [
      {
        header: 'Time',
        accessorKey: 'timestamp',
        cell: ({ getValue }) => String(getValue()).slice(11, 19),
      },
      { header: 'Method', accessorKey: 'method' },
      { header: 'Path', accessorKey: 'path' },
      { header: 'Status', accessorKey: 'status' },
      { header: 'ms', accessorKey: 'durationMs' },
    ],
    [],
  );

  const genericColumns = useMemo<ColumnDef<Record<string, unknown>>[]>(
    () => [
      {
        header: 'ID / Type',
        cell: ({ row }) =>
          pickFirst(row.original, [
            'id',
            'orderId',
            'tradeId',
            'accountId',
            'eventType',
            'commandId',
          ]),
      },
      {
        header: 'Status',
        cell: ({ row }) => pickFirst(row.original, ['status', 'state', 'outcome']),
      },
      {
        header: 'Details',
        cell: ({ row }) => <code>{prettyJson(row.original).slice(0, 180)}</code>,
      },
    ],
    [],
  );

  const orderColumns = useMemo<ColumnDef<GatewayOrder>[]>(
    () => [
      { header: 'Command', accessorKey: 'commandId' },
      { header: 'Order', accessorKey: 'orderId' },
      { header: 'Status', accessorKey: 'status' },
    ],
    [],
  );

  /** Выполняет запрос, обновляет журнал и сохраняет response для inspection. */
  async function run(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
    idem: boolean | string = false,
  ) {
    return runWithConfig(config, method, path, body, idem);
  }

  /** Выполняет admin-only запрос отдельным ключом, чтобы trader flow не падал на funding/control шагах. */
  async function runAdmin(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
    idem: boolean | string = false,
  ) {
    return runWithConfig(adminConfig, method, path, body, idem);
  }

  /** Общий transport helper для trader/admin запросов с единым журналом UI. */
  async function runWithConfig(
    selectedConfig: ApiClientConfig,
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
    idem: boolean | string = false,
  ) {
    const key = typeof idem === 'string' ? idem : idem ? idempotencyKey : undefined;
    const entry = await callApi(selectedConfig, method, path, body, key);
    setLogs((current) => [entry, ...current].slice(0, 40));
    setLastResponse(entry.responseBody);
    return entry;
  }

  /** Сохраняет только несекретный URL; reusable credentials остаются только в памяти tab. */
  function persistSettings() {
    localStorage.setItem('exchange.baseUrl', baseUrl);
  }

  async function placeOrder() {
    const body = parseJsonBody(placeBody);
    const entry = await run('POST', '/api/v1/orders', body, true);
    const result = entry.responseBody;
    if (entry.ok && isGatewayOrder(result)) {
      setOrders((current) => [result, ...current]);
      setLookupOrderId(result.orderId);
      setCancelOrderId(result.orderId);
    }
  }

  async function cancelOrder() {
    const body = {
      commandId: `cancel-${cancelOrderId}-${Date.now()}`,
      orderId: cancelOrderId,
      accountId,
      instrumentId: 'BTC-USD',
    };
    const entry = await run('POST', `/api/v1/orders/${cancelOrderId}/cancel`, body, true);
    const result = entry.responseBody;
    if (entry.ok && isGatewayOrder(result)) setOrders((current) => [result, ...current]);
  }

  async function loadOrders() {
    const entry = await run('GET', '/api/v1/orders?limit=50');
    const page = entry.responseBody as Page<GatewayOrder>;
    if (Array.isArray(page.items)) setOrders(page.items);
  }

  async function lookupOrder() {
    const entry = await run('GET', `/api/v1/orders/${lookupOrderId}`);
    const result = entry.responseBody;
    if (entry.ok && isGatewayOrder(result)) setOrders((current) => [result, ...current]);
  }

  async function loadInstruments() {
    const entry = await run('GET', '/api/v1/instruments?limit=100');
    const page = entry.responseBody as Page<Record<string, unknown>>;
    if (Array.isArray(page.items)) setInstrumentRows(page.items);
  }

  async function loadProjection(kind: 'orders' | 'trades' | 'balances') {
    const entry = await run('GET', `/api/v1/projections/${kind}?limit=50`);
    const page = entry.responseBody as Page<Record<string, unknown>>;
    if (Array.isArray(page.items)) setProjectionRows(page.items);
  }

  async function loadBalances() {
    const entry = await run('GET', `/api/v1/accounts/${accountId}/balances`);
    const page = entry.responseBody as Page<Record<string, unknown>>;
    if (Array.isArray(page.items)) setBalanceRows(page.items);
  }

  /** Выполняет admin-only credit-команду для быстрого наполнения dev-аккаунта. */
  async function creditBalance(asset: string, amount: string) {
    const commandId = `manual-credit-${asset.toLowerCase()}-${Date.now().toString(36)}`;
    const entry = await runAdmin(
      'POST',
      `/api/v1/accounts/${accountId}/balances/${asset}/commands`,
      { commandId, action: 'CREDIT', amount },
      commandId,
    );
    if (entry.ok) await loadBalances();
  }

  /**
   * Выполняет полный пользовательский путь одной кнопкой.
   *
   * Сценарий deliberately идёт через публичные HTTP endpoints, а не вызывает
   * helper-функции напрямую. Так UI показывает ровно тот flow, который проходит
   * внешний клиент: readiness → auth → catalog → account → place → lookup →
   * history → cancel → balances. Каждый write получает собственный idempotency
   * key, а уже существующий account не считается ошибкой повторного прогона.
   */
  async function runUserFlow() {
    const runId = Date.now().toString(36);
    const orderId = `flow-order-${runId}`;
    const commandId = `flow-place-${runId}`;
    const currentAccountId = accountId || 'dev-user';
    setFlowRunId(runId);
    setFlowBusy(true);
    setFlowSteps(resetFlowSteps());
    try {
      await executeFlowStep('health', () => run('GET', '/health/ready'));
      await executeFlowStep('auth', () => run('GET', '/api/v1/machine-auth/me'));
      const catalog = await executeFlowStep('catalog', () =>
        run('GET', '/api/v1/instruments?limit=20'),
      );
      const catalogPage = catalog.responseBody as Page<Record<string, unknown>>;
      if (Array.isArray(catalogPage.items)) setInstrumentRows(catalogPage.items);

      await executeFlowStep(
        'account',
        () =>
          run(
            'POST',
            '/api/v1/accounts',
            {
              commandId: `flow-account-${runId}`,
              accountId: currentAccountId,
              ownerId: currentAccountId,
              balances: [
                { assetId: 'USD', code: 'USD', scale: 2 },
                { assetId: 'BTC', code: 'BTC', scale: 8 },
              ],
            },
            `flow-account-${runId}`,
          ),
        [201, 409],
      );

      await executeFlowStep(
        'credit-usd',
        () =>
          runAdmin(
            'POST',
            `/api/v1/accounts/${currentAccountId}/balances/USD/commands`,
            { commandId: `flow-credit-usd-${runId}`, action: 'CREDIT', amount: '100000' },
            `flow-credit-usd-${runId}`,
          ),
        [201],
      );

      await executeFlowStep(
        'credit-btc',
        () =>
          runAdmin(
            'POST',
            `/api/v1/accounts/${currentAccountId}/balances/BTC/commands`,
            { commandId: `flow-credit-btc-${runId}`, action: 'CREDIT', amount: '10' },
            `flow-credit-btc-${runId}`,
          ),
        [201],
      );

      const placed = await executeFlowStep(
        'place',
        () =>
          run(
            'POST',
            '/api/v1/orders',
            {
              commandId,
              orderId,
              accountId: currentAccountId,
              instrumentId: 'BTC-USD',
              clientOrderId: orderId,
              side: 'BUY',
              orderType: 'LIMIT',
              quantity: '1',
              limitPrice: '100',
              timeInForce: 'GTC',
            },
            `flow-place-${runId}`,
          ),
        [201],
      );
      const placedResult = placed.responseBody;
      if (isGatewayOrder(placedResult)) {
        setOrders((current) => [placedResult, ...current]);
        setLookupOrderId(placedResult.orderId);
        setCancelOrderId(placedResult.orderId);
      }

      await executeFlowStep('lookup', () => run('GET', `/api/v1/orders/${orderId}`));
      const history = await executeFlowStep('history', () =>
        run('GET', '/api/v1/projections/orders?limit=20'),
      );
      const historyPage = history.responseBody as Page<Record<string, unknown>>;
      if (Array.isArray(historyPage.items)) setProjectionRows(historyPage.items);

      const cancelled = await executeFlowStep(
        'cancel',
        () =>
          run(
            'POST',
            `/api/v1/orders/${orderId}/cancel`,
            {
              commandId: `flow-cancel-${runId}`,
              orderId,
              accountId: currentAccountId,
              instrumentId: 'BTC-USD',
            },
            `flow-cancel-${runId}`,
          ),
        [201],
      );
      const cancelledResult = cancelled.responseBody;
      if (isGatewayOrder(cancelledResult)) {
        setOrders((current) => [cancelledResult, ...current]);
      }

      const balances = await executeFlowStep('balances', () =>
        run('GET', `/api/v1/accounts/${currentAccountId}/balances`),
      );
      const balancePage = balances.responseBody as Page<Record<string, unknown>>;
      if (Array.isArray(balancePage.items)) setBalanceRows(balancePage.items);
    } finally {
      setFlowBusy(false);
    }
  }

  /** Выполняет один шаг flow и обновляет timeline-карточку. */
  async function executeFlowStep(
    key: string,
    action: () => Promise<RequestLogEntry>,
    acceptedStatuses: readonly number[] = [200],
  ): Promise<RequestLogEntry> {
    updateFlowStep(key, { status: 'running' });
    const entry = await action();
    const success =
      typeof entry.status === 'number' ? acceptedStatuses.includes(entry.status) : false;
    updateFlowStep(key, {
      status: success ? 'success' : 'failure',
      durationMs: entry.durationMs,
      statusCode: entry.status,
    });
    if (!success) throw new Error(`Flow step ${key} failed with status ${entry.status}`);
    return entry;
  }

  /** Частично обновляет один шаг timeline без пересоздания описания flow. */
  function updateFlowStep(key: string, patch: Partial<FlowStep>) {
    setFlowSteps((current) =>
      current.map((step) => (step.key === key ? ({ ...step, ...patch } as FlowStep) : step)),
    );
  }

  return (
    <main>
      <header className="hero">
        <div>
          <p className="eyebrow">Exchange manual QA</p>
          <h1>Тестовая консоль биржи</h1>
          <p className="hero-text">
            Ручной frontend для проверки Gateway, projections, instruments, ledger, admin, health и
            observability endpoints без curl/Postman.
          </p>
        </div>
        <div className="status-actions">
          <button
            onClick={() =>
              document.getElementById('simulation')?.scrollIntoView({ behavior: 'smooth' })
            }
          >
            Симуляция рынка
          </button>
          <button onClick={() => run('GET', '/health/live')}>Liveness</button>
          <button onClick={() => run('GET', '/health/ready')}>Readiness</button>
          <button onClick={() => run('GET', '/api/v1/machine-auth/me')}>Auth me</button>
          <button onClick={() => runAdmin('GET', '/api/v1/admin/reconciliation')}>
            Reconciliation
          </button>
        </div>
      </header>

      <SimulationPanel />

      <section className="panel config-panel">
        <label>
          Backend base URL
          <input
            value={baseUrl}
            onChange={(event) => setBaseUrl(event.target.value)}
            placeholder="empty = Vite proxy"
          />
        </label>
        <label>
          API key
          <input
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
            placeholder="dev-key"
          />
        </label>
        <label>
          Admin API key
          <input
            value={adminApiKey}
            onChange={(event) => setAdminApiKey(event.target.value)}
            placeholder="dev-admin-key"
          />
        </label>
        <label>
          Idempotency-Key
          <input
            value={idempotencyKey}
            onChange={(event) => setIdempotencyKey(event.target.value)}
          />
        </label>
        <button onClick={() => setIdempotencyKey(makeIdempotencyKey('manual'))}>Новый key</button>
        <button onClick={persistSettings}>Сохранить</button>
        <button onClick={() => setShowDiagnostics((value) => !value)}>
          {showDiagnostics ? 'Скрыть диагностику' : 'Показать диагностику'}
        </button>
      </section>

      <section className="panel flow-panel">
        <div className="panel-title-row">
          <div>
            <h2>User flow: внешний клиент → биржа → история</h2>
            <p className="muted">
              Последовательность показывает бизнес-путь пользователя и подсвечивает, на каком
              transport boundary произошёл сбой. Run ID: <code>{flowRunId}</code>
            </p>
          </div>
          <div className="row">
            <button disabled={flowBusy} onClick={runUserFlow}>
              {flowBusy ? 'Flow выполняется…' : 'Прогнать полный flow'}
            </button>
            <button disabled={flowBusy} onClick={() => setFlowSteps(resetFlowSteps())}>
              Сбросить timeline
            </button>
          </div>
        </div>
        <div className="flow-timeline">
          {flowSteps.map((step) => (
            <article className={`flow-card ${step.status}`} key={step.key}>
              <div className="flow-card-header">
                <span className="flow-status-dot" />
                <strong>{step.title}</strong>
              </div>
              <p>{step.description}</p>
              <dl>
                <div>
                  <dt>Endpoint</dt>
                  <dd>{step.endpoint}</dd>
                </div>
                <div>
                  <dt>Ожидание</dt>
                  <dd>{step.expected}</dd>
                </div>
                <div>
                  <dt>Результат</dt>
                  <dd>
                    {step.statusCode ?? '—'}
                    {step.durationMs !== undefined ? ` · ${step.durationMs} ms` : ''}
                  </dd>
                </div>
              </dl>
            </article>
          ))}
        </div>
      </section>

      <div className="grid two">
        <section className="panel">
          <h2>Gateway commands</h2>
          <textarea value={placeBody} onChange={(event) => setPlaceBody(event.target.value)} />
          <div className="row">
            <button onClick={placeOrder}>Place order</button>
            <button onClick={loadOrders}>List orders</button>
          </div>
          <div className="row">
            <input
              value={lookupOrderId}
              onChange={(event) => setLookupOrderId(event.target.value)}
              placeholder="orderId"
            />
            <button onClick={lookupOrder}>Lookup</button>
          </div>
          <div className="row">
            <input
              value={cancelOrderId}
              onChange={(event) => setCancelOrderId(event.target.value)}
              placeholder="orderId"
            />
            <button className="danger" onClick={cancelOrder}>
              Cancel
            </button>
          </div>
        </section>

        <section className="panel">
          <h2>Ledger / accounts</h2>
          <p className="muted">
            Create account принимает только asset definitions: assetId/code/scale. Начальные
            available/reserved меняются отдельными admin-only balance commands.
          </p>
          <textarea value={accountBody} onChange={(event) => setAccountBody(event.target.value)} />
          <div className="row">
            <button
              onClick={() => run('POST', '/api/v1/accounts', parseJsonBody(accountBody), true)}
            >
              Create account
            </button>
            <button onClick={loadBalances}>Load balances</button>
            <button onClick={() => creditBalance('USD', '100000')}>Credit USD</button>
            <button onClick={() => creditBalance('BTC', '10')}>Credit BTC</button>
          </div>
          <div className="row">
            <input
              value={accountId}
              onChange={(event) => setAccountId(event.target.value)}
              placeholder="accountId"
            />
            <input
              value={assetId}
              onChange={(event) => setAssetId(event.target.value)}
              placeholder="assetId"
            />
            <button onClick={() => run('GET', `/api/v1/accounts/${accountId}/balances/${assetId}`)}>
              Balance
            </button>
          </div>
        </section>
      </div>

      <div className="grid two">
        <section className="panel">
          <h2>Catalog / projections</h2>
          <div className="button-grid">
            <button onClick={loadInstruments}>Instruments</button>
            <button onClick={() => loadProjection('orders')}>Projection orders</button>
            <button onClick={() => loadProjection('trades')}>Projection trades</button>
            <button onClick={() => loadProjection('balances')}>Projection balances</button>
            <button onClick={() => run('GET', '/api/v1/projections/metrics')}>
              Projection metrics
            </button>
            <button onClick={() => run('GET', '/internal/metrics')}>OpenMetrics</button>
          </div>
        </section>

        <section className="panel">
          <h2>Admin quick command</h2>
          <p className="muted">
            Используй dev-admin-key. По умолчанию freeze account; approval можно отправить отдельной
            кнопкой.
          </p>
          <textarea value={adminBody} onChange={(event) => setAdminBody(event.target.value)} />
          <div className="row">
            <button
              onClick={() =>
                runAdmin('POST', '/api/v1/admin/freezes', parseJsonBody(adminBody), true)
              }
            >
              Freeze/unfreeze
            </button>
            <button onClick={() => runAdmin('GET', '/api/v1/admin/audit-events?limit=50')}>
              Audit events
            </button>
          </div>
          <div className="row">
            <input
              value={lookupOrderId}
              onChange={(event) => setLookupOrderId(event.target.value)}
              placeholder="commandId for approval"
            />
            <button
              onClick={() =>
                runAdmin(
                  'POST',
                  `/api/v1/admin/approvals/${lookupOrderId}`,
                  { commandId: `approve-${lookupOrderId}` },
                  true,
                )
              }
            >
              Approve
            </button>
          </div>
        </section>
      </div>

      <DataTable title="Gateway orders" rows={orders} columns={orderColumns} />

      {showDiagnostics ? (
        <>
          <div className="grid two">
            <DataTable title="Balances" rows={balanceRows} columns={genericColumns} />
            <DataTable title="Instruments" rows={instrumentRows} columns={genericColumns} />
            <DataTable title="Projection rows" rows={projectionRows} columns={genericColumns} />
            <Suspense fallback={<section className="panel">Загружаю график…</section>}>
              <LatencyChart entries={logs} />
            </Suspense>
          </div>

          <div className="grid two">
            <section className="panel">
              <div className="panel-title-row">
                <h2>Last response</h2>
                <span className="muted">bounded preview</span>
              </div>
              <pre>{prettyJson(lastResponse)}</pre>
            </section>
            <DataTable title="HTTP request log" rows={logs} columns={requestColumns} />
          </div>
        </>
      ) : null}
    </main>
  );
}

/** Проверяет, что произвольный response похож на публичный Gateway order result. */
function isGatewayOrder(value: unknown): value is GatewayOrder {
  return (
    typeof value === 'object' &&
    value !== null &&
    'commandId' in value &&
    'orderId' in value &&
    'status' in value
  );
}

/** Возвращает первое найденное поле для компактной generic table. */
function pickFirst(row: Record<string, unknown>, keys: readonly string[]): string {
  for (const key of keys) {
    const value = row[key];
    if (value !== undefined && value !== null) return String(value);
  }
  return '—';
}

/** Возвращает flow timeline в исходное состояние без потери описаний шагов. */
function resetFlowSteps(): FlowStep[] {
  return initialFlowSteps.map(({ durationMs: _durationMs, statusCode: _statusCode, ...step }) => ({
    ...step,
    status: 'idle',
  }));
}
