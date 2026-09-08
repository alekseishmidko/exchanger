import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureSwagger } from '../src/config/swagger';
import { ApiKeyRegistry } from '../src/modules/gateway/gateway.auth';

/** Минимальный OpenAPI shape для проверки обязательных transport operations. */
type TransportOpenApiDocument = {
  paths: Record<string, Record<string, unknown>>;
};

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
});
