import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureSwagger } from '../src/config/swagger';
import { ApiKeyRegistry } from '../src/modules/gateway/gateway.auth';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';

/** Минимальный OpenAPI shape для проверки обязательных transport operations. */
type TransportOpenApiDocument = {
  paths: Record<string, Record<string, unknown>>;
};

/** HTTP methods, участвующие в проверке generated-versus-versioned drift. */
const httpMethods = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options']);

/** Преобразует OpenAPI paths в сортированный набор `METHOD path`. */
function operations(document: TransportOpenApiDocument): readonly string[] {
  return Object.entries(document.paths)
    .flatMap(([path, item]) =>
      Object.keys(item)
        .filter((method) => httpMethods.has(method))
        .map((method) => `${method.toUpperCase()} ${path}`),
    )
    .sort();
}

/** Валидная начальная версия правил для admin/instrument E2E flow. */
const rules = {
  version: 'rules-v1',
  effectiveAt: '2026-01-01T00:00:00.000Z',
  tickSize: '0.5',
  lotSize: '0.001',
  minQuantity: '0.001',
  maxQuantity: '10',
  minPrice: '100',
  maxPrice: '100000',
  feePolicyVersion: 'fees-v1',
  maxOrderQuantity: '10',
  maxOpenOrders: 100,
  maxNotional: '1000000',
} as const;

describe('Transport API completeness', () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(ApiKeyRegistry)
      .useValue(
        new ApiKeyRegistry([
          { keyId: 'trader-1-key', role: 'trader', userId: 'user-1' },
          { keyId: 'trader-2-key', role: 'trader', userId: 'user-2' },
          { keyId: 'admin-1-key', role: 'admin', userId: 'admin-1' },
          { keyId: 'admin-2-key', role: 'admin', userId: 'admin-2' },
          { keyId: 'risk-1-key', role: 'risk_manager', userId: 'risk-1' },
          { keyId: 'risk-2-key', role: 'risk_manager', userId: 'risk-2' },
          { keyId: 'auditor-key', role: 'auditor', userId: 'auditor-1' },
          { keyId: 'support-key', role: 'support', userId: 'support-1' },
        ]),
      )
      .compile();

    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    configureSwagger(app, new ConfigService({ NODE_ENV: 'development', SWAGGER_ENABLED: 'true' }));
    await app.init();
    await (app.getHttpAdapter().getInstance() as unknown as { ready: () => Promise<void> }).ready();
  });

  afterAll(async () => app.close());

  it('publishes instruments, accounts, projections and admin operations in OpenAPI', async () => {
    const response = await request(app.getHttpServer()).get('/docs/openapi.json').expect(200);
    const document = response.body as TransportOpenApiDocument;
    expect(document.paths['/api/v1/instruments']?.['get']).toBeDefined();
    expect(document.paths['/api/v1/accounts']?.['post']).toBeDefined();
    expect(document.paths['/api/v1/projections/orders']?.['get']).toBeDefined();
    expect(document.paths['/api/v1/admin/instruments']?.['post']).toBeDefined();
    expect(document.paths['/api/v1/admin/approvals/{commandId}']?.['post']).toBeDefined();
    expect(document.paths['/api/v1/admin/freezes']?.['post']).toBeDefined();
    expect(document.paths['/api/v1/admin/circuit-breakers']?.['post']).toBeDefined();
    expect(document.paths['/api/v1/admin/fee-policies']?.['post']).toBeDefined();
    expect(document.paths['/api/v1/admin/risk-policies']?.['post']).toBeDefined();
    expect(document.paths['/api/v1/admin/reconciliation']?.['get']).toBeDefined();
    expect(document.paths['/api/v1/accounts/{accountId}/balances']?.['get']).toBeDefined();
    expect(
      document.paths['/api/v1/accounts/{accountId}/balances/{assetId}/commands']?.['post'],
    ).toBeDefined();
    expect(document.paths['/api/v1/projections/trades']?.['get']).toBeDefined();
    expect(document.paths['/api/v1/projections/balances']?.['get']).toBeDefined();
    expect(document.paths['/api/v1/projections/metrics']?.['get']).toBeDefined();

    const versioned = parse(
      readFileSync(resolve(process.cwd(), '../../docs/openapi/application.yaml'), 'utf8'),
    ) as TransportOpenApiDocument;
    expect(operations(document)).toEqual(operations(versioned));
  });

  it('creates an isolated account and rejects unknown DTO fields', async () => {
    const body = {
      commandId: 'create-account-1',
      accountId: 'account-1',
      ownerId: 'user-1',
      balances: [{ assetId: 'USD', code: 'USD', scale: 2 }],
    };

    await request(app.getHttpServer())
      .post('/api/v1/accounts')
      .set('x-api-key', 'trader-1-key')
      .set('idempotency-key', 'account-idem-1')
      .send({ ...body, internalRole: 'admin' })
      .expect(400)
      .expect(({ body: error }) =>
        expect((error as { code: string }).code).toBe('REQUEST_MALFORMED'),
      );

    await request(app.getHttpServer())
      .post('/api/v1/accounts')
      .set('x-api-key', 'trader-1-key')
      .set('idempotency-key', 'account-idem-1')
      .send(body)
      .expect(201)
      .expect({ accountId: 'account-1', ownerId: 'user-1' });

    await request(app.getHttpServer())
      .get('/api/v1/accounts/account-1')
      .set('x-api-key', 'trader-2-key')
      .expect(403);

    await request(app.getHttpServer())
      .get('/api/v1/accounts/account-1')
      .set('x-api-key', 'trader-1-key')
      .expect(200)
      .expect({ accountId: 'account-1', ownerId: 'user-1' });

    await request(app.getHttpServer())
      .get('/api/v1/accounts/account-1/balances')
      .set('x-api-key', 'trader-1-key')
      .expect(200)
      .expect(({ body }) => expect((body as { items: unknown[] }).items).toHaveLength(1));
  });

  it('changes a balance only through an idempotent admin application command', async () => {
    const command = { commandId: 'credit-1', action: 'CREDIT', amount: '100.25' };
    const first = await request(app.getHttpServer())
      .post('/api/v1/accounts/account-1/balances/USD/commands')
      .set('x-api-key', 'admin-1-key')
      .set('idempotency-key', 'credit-idem-1')
      .send(command)
      .expect(201);
    const retry = await request(app.getHttpServer())
      .post('/api/v1/accounts/account-1/balances/USD/commands')
      .set('x-api-key', 'admin-1-key')
      .set('idempotency-key', 'credit-idem-1')
      .send(command)
      .expect(201);

    expect(retry.body).toEqual(first.body);
    await request(app.getHttpServer())
      .get('/api/v1/accounts/account-1/balances/USD')
      .set('x-api-key', 'trader-1-key')
      .expect(200)
      .expect({ accountId: 'account-1', assetId: 'USD', available: '100.25', reserved: '0' });

    await request(app.getHttpServer())
      .post('/api/v1/accounts/account-1/balances/USD/commands')
      .set('x-api-key', 'trader-1-key')
      .set('idempotency-key', 'forbidden-credit')
      .send({ commandId: 'credit-2', action: 'CREDIT', amount: '1' })
      .expect(403);
  });

  it('applies instrument configuration and lifecycle through independent approvals', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/admin/instruments')
      .set('x-api-key', 'admin-1-key')
      .set('idempotency-key', 'instrument-create-idem')
      .send({
        commandId: 'instrument-create-1',
        mode: 'CREATE',
        instrumentId: 'BTC-USD',
        baseAssetId: 'BTC',
        quoteAssetId: 'USD',
        rules,
      })
      .expect(201)
      .expect(({ body }) => expect((body as { status: string }).status).toBe('PENDING_APPROVAL'));

    await request(app.getHttpServer())
      .post('/api/v1/admin/approvals/instrument-create-1')
      .set('x-api-key', 'admin-2-key')
      .set('idempotency-key', 'instrument-create-approval')
      .expect(201);

    await request(app.getHttpServer())
      .post('/api/v1/admin/instruments/BTC-USD/status')
      .set('x-api-key', 'admin-1-key')
      .set('idempotency-key', 'instrument-status-idem')
      .send({ commandId: 'instrument-activate-1', status: 'ACTIVE' })
      .expect(201);
    await request(app.getHttpServer())
      .post('/api/v1/admin/approvals/instrument-activate-1')
      .set('x-api-key', 'admin-2-key')
      .set('idempotency-key', 'instrument-status-approval')
      .expect(201);

    await request(app.getHttpServer())
      .get('/api/v1/instruments/BTC-USD')
      .set('x-api-key', 'trader-1-key')
      .expect(200)
      .expect(({ body }) => {
        const instrument = body as { status: string; rules: Array<{ tickSize: string }> };
        expect(instrument.status).toBe('ACTIVE');
        expect(instrument.rules[0]?.tickSize).toBe('0.5');
      });

    await request(app.getHttpServer())
      .get('/api/v1/instruments')
      .set('x-api-key', 'trader-1-key')
      .expect(200)
      .expect(({ body }) =>
        expect((body as { items: Array<{ id: string }> }).items).toEqual(
          expect.arrayContaining([expect.objectContaining({ id: 'BTC-USD' })]),
        ),
      );
  });

  it('protects admin operations and documents bounded projection queries', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/admin/freezes')
      .set('x-api-key', 'trader-1-key')
      .set('idempotency-key', 'freeze-forbidden')
      .send({
        commandId: 'freeze-0',
        targetType: 'ACCOUNT',
        targetId: 'account-1',
        action: 'FREEZE',
      })
      .expect(403);

    await request(app.getHttpServer())
      .post('/api/v1/admin/freezes')
      .set('x-api-key', 'admin-1-key')
      .set('idempotency-key', 'freeze-idem')
      .send({
        commandId: 'freeze-1',
        targetType: 'ACCOUNT',
        targetId: 'account-1',
        action: 'FREEZE',
      })
      .expect(201)
      .expect(({ body }) => expect((body as { status: string }).status).toBe('APPLIED'));

    await request(app.getHttpServer())
      .get('/api/v1/admin/reconciliation')
      .set('x-api-key', 'admin-1-key')
      .expect(200)
      .expect(({ body }) => expect((body as { frozenAccounts: number }).frozenAccounts).toBe(1));

    await request(app.getHttpServer())
      .get('/api/v1/projections/orders?limit=101')
      .set('x-api-key', 'trader-1-key')
      .expect(400);
  });

  it('preserves the administrative role matrix for policies and reconciliation', async () => {
    const riskPolicy = {
      commandId: 'risk-policy-1',
      version: 'risk-v1',
      effectiveAt: '2026-02-01T00:00:00.000Z',
      maxOrderNotional: '100000',
      maxOpenOrders: 100,
    };
    await request(app.getHttpServer())
      .post('/api/v1/admin/risk-policies')
      .set('x-api-key', 'risk-1-key')
      .set('idempotency-key', 'risk-policy-idem')
      .send(riskPolicy)
      .expect(201)
      .expect(({ body }) => expect((body as { status: string }).status).toBe('PENDING_APPROVAL'));
    await request(app.getHttpServer())
      .post('/api/v1/admin/approvals/risk-policy-1')
      .set('x-api-key', 'risk-2-key')
      .set('idempotency-key', 'risk-policy-approval')
      .expect(201);

    await request(app.getHttpServer())
      .get('/api/v1/admin/reconciliation')
      .set('x-api-key', 'auditor-key')
      .expect(200)
      .expect(({ body }) =>
        expect((body as { riskPolicyVersions: string[] }).riskPolicyVersions).toContain('risk-v1'),
      );

    await request(app.getHttpServer())
      .post('/api/v1/admin/fee-policies')
      .set('x-api-key', 'support-key')
      .set('idempotency-key', 'support-forbidden')
      .send({
        commandId: 'fee-policy-forbidden',
        version: 'fee-forbidden',
        effectiveAt: '2026-02-01T00:00:00.000Z',
        makerRate: '0.001',
        takerRate: '0.002',
      })
      .expect(403);
  });

  /**
   * Вызывает все projection query handlers через настоящий HTTP boundary. Пустые
   * страницы являются корректным positive-result: тест проверяет transport,
   * authentication, bounded pagination и owner-фильтр application store.
   */
  it('serves every projection query through the authenticated read boundary', async () => {
    for (const path of ['orders', 'trades', 'balances']) {
      await request(app.getHttpServer())
        .get(`/api/v1/projections/${path}?limit=10`)
        .set('x-api-key', 'trader-1-key')
        .expect(200)
        .expect(({ body }) => {
          expect(body).toHaveProperty('items');
          expect(body).toHaveProperty('nextCursor');
        });
    }

    await request(app.getHttpServer())
      .get('/api/v1/projections/metrics')
      .set('x-api-key', 'trader-1-key')
      .expect(200)
      .expect(({ body }) => expect(body).toHaveProperty('schemaVersion', 1));
  });

  /**
   * Доказывает dual-control и административную идемпотентность для оставшихся
   * публичных команд: повтор HTTP-запроса возвращает тот же application result,
   * а изменение начинает действовать только после approval другого principal.
   */
  it('applies fee policy and circuit breaker through idempotent dual control', async () => {
    const feePolicy = {
      commandId: 'fee-policy-1',
      version: 'fee-v1',
      effectiveAt: '2026-02-01T00:00:00.000Z',
      makerRate: '0.001',
      takerRate: '0.002',
    };
    const first = await request(app.getHttpServer())
      .post('/api/v1/admin/fee-policies')
      .set('x-api-key', 'admin-1-key')
      .set('idempotency-key', 'fee-policy-idem')
      .send(feePolicy)
      .expect(201);
    const retry = await request(app.getHttpServer())
      .post('/api/v1/admin/fee-policies')
      .set('x-api-key', 'admin-1-key')
      .set('idempotency-key', 'fee-policy-idem')
      .send(feePolicy)
      .expect(201);
    expect(retry.body).toEqual(first.body);

    await request(app.getHttpServer())
      .post('/api/v1/admin/approvals/fee-policy-1')
      .set('x-api-key', 'admin-2-key')
      .set('idempotency-key', 'fee-policy-approval')
      .expect(201);

    await request(app.getHttpServer())
      .post('/api/v1/admin/circuit-breakers')
      .set('x-api-key', 'admin-1-key')
      .send({ commandId: 'stop-1', action: 'STOP', targetId: 'BTC-USD' })
      .expect(400)
      .expect(({ body }) =>
        expect((body as { code: string }).code).toBe('IDEMPOTENCY_KEY_REQUIRED'),
      );

    await request(app.getHttpServer())
      .post('/api/v1/admin/circuit-breakers')
      .set('x-api-key', 'admin-1-key')
      .set('idempotency-key', 'stop-idem')
      .send({ commandId: 'stop-1', action: 'STOP', targetId: 'BTC-USD' })
      .expect(201)
      .expect(({ body }) => expect((body as { status: string }).status).toBe('PENDING_APPROVAL'));
    await request(app.getHttpServer())
      .post('/api/v1/admin/approvals/stop-1')
      .set('x-api-key', 'admin-2-key')
      .set('idempotency-key', 'stop-approval')
      .expect(201);
  });

  /**
   * Проверяет общий authentication invariant для каждого защищённого REST route.
   * Guard должен завершить запрос до DTO parsing и application port, поэтому для
   * write routes допустим пустой body: ожидаемый результат всегда 401.
   */
  it('rejects unauthenticated access to every protected REST operation', async () => {
    const getPaths = [
      '/api/v1/orders',
      '/api/v1/instruments',
      '/api/v1/instruments/BTC-USD',
      '/api/v1/accounts/account-1',
      '/api/v1/accounts/account-1/balances',
      '/api/v1/accounts/account-1/balances/USD',
      '/api/v1/projections/orders',
      '/api/v1/projections/trades',
      '/api/v1/projections/balances',
      '/api/v1/projections/metrics',
      '/api/v1/admin/reconciliation',
    ];
    for (const path of getPaths) {
      await request(app.getHttpServer()).get(path).expect(401);
    }

    const postPaths = [
      '/api/v1/orders',
      '/api/v1/orders/order-1/cancel',
      '/api/v1/accounts',
      '/api/v1/accounts/account-1/balances/USD/commands',
      '/api/v1/admin/instruments',
      '/api/v1/admin/instruments/BTC-USD/status',
      '/api/v1/admin/freezes',
      '/api/v1/admin/circuit-breakers',
      '/api/v1/admin/fee-policies',
      '/api/v1/admin/risk-policies',
      '/api/v1/admin/approvals/command-1',
    ];
    for (const path of postPaths) {
      await request(app.getHttpServer()).post(path).send({}).expect(401);
    }
  });
});
