import { Test } from '@nestjs/testing';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { ApiKeyRegistry } from '../src/modules/gateway/gateway.auth';
import {
  GatewayCancelOrderCommand,
  GatewayCommandResult,
  GatewayPlaceOrderCommand,
  TRADING_COMMAND_PORT,
  TradingCommandPort,
} from '../src/modules/gateway/gateway.types';
import { ProjectionStore } from '../src/modules/projections/projection';
import { Decimal } from '../src/modules/shared-kernel';
import { MatchingEngine } from '../src/modules/trading/matching-engine/matching-engine';
import { flowApiKeyRegistry, placeOrderBody } from './builders/api-builders';

/**
 * Test application adapter, связывающий HTTP port с настоящим domain engine и
 * projection consumer. Он нужен для проверки границ, а не для production DI:
 * production заменит его sequencer/event-log adapter с тем же интерфейсом.
 */
class ProjectingTradingPort implements TradingCommandPort {
  private readonly engine = new MatchingEngine();
  private readonly results = new Map<
    string,
    Readonly<{ ownerId: string; result: GatewayCommandResult }>
  >();
  private projectionSequence = 0;

  constructor(private readonly projections: ProjectionStore) {}

  /** Применяет PLACE в matching domain и публикует принятую заявку в projection. */
  async placeOrder(command: GatewayPlaceOrderCommand): Promise<GatewayCommandResult> {
    await Promise.resolve();
    this.engine.apply({
      type: 'PLACE',
      orderId: command.clientOrderId,
      userId: command.userId,
      side: command.side,
      orderType: command.orderType,
      ...(command.limitPrice ? { price: Decimal.from(command.limitPrice) } : {}),
      quantity: Decimal.from(command.quantity),
      timeInForce: command.timeInForce,
    });
    this.projections.apply({
      eventId: `projection-${command.commandId}`,
      eventType: 'OrderAccepted',
      sequence: ++this.projectionSequence,
      payload: {
        orderId: command.clientOrderId,
        userId: command.userId,
        accountId: command.accountId,
        instrumentId: command.instrumentId,
        remainingQuantity: command.quantity,
      },
    });
    const result = {
      commandId: command.commandId,
      orderId: command.clientOrderId,
      status: 'ACCEPTED',
    } as const;
    this.results.set(result.orderId, { ownerId: command.userId, result });
    return result;
  }

  /** Применяет CANCEL и обновляет ту же read model последовательным событием. */
  async cancelOrder(command: GatewayCancelOrderCommand): Promise<GatewayCommandResult> {
    await Promise.resolve();
    this.engine.apply({ type: 'CANCEL', orderId: command.orderId });
    this.projections.apply({
      eventId: `projection-${command.commandId}`,
      eventType: 'OrderCancelled',
      sequence: ++this.projectionSequence,
      payload: {
        orderId: command.orderId,
        userId: command.userId,
        accountId: command.accountId,
        instrumentId: command.instrumentId,
        remainingQuantity: '0',
      },
    });
    const result = {
      commandId: command.commandId,
      orderId: command.orderId,
      status: 'CANCEL_ACCEPTED',
    } as const;
    this.results.set(result.orderId, { ownerId: command.userId, result });
    return result;
  }

  /** Возвращает один public result для Gateway lookup endpoint. */
  async getOrder(userId: string, orderId: string) {
    await Promise.resolve();
    const stored = this.results.get(orderId);
    if (!stored || stored.ownerId !== userId) return null;
    return stored.result;
  }

  /** Возвращает bounded reference page для Gateway query endpoint. */
  async listOrders(userId: string, limit: number, cursor?: string) {
    await Promise.resolve();
    const values = [...this.results.values()]
      .filter(({ ownerId }) => ownerId === userId)
      .map(({ result }) => result);
    const start = Number(cursor ?? 0);
    const items = values.slice(start, start + limit);
    return {
      items,
      nextCursor: start + items.length < values.length ? String(start + items.length) : null,
    };
  }
}

describe('HTTP command to domain and projection flow', () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    const projections = new ProjectionStore();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(ApiKeyRegistry)
      .useValue(flowApiKeyRegistry())
      .overrideProvider(ProjectionStore)
      .useValue(projections)
      .overrideProvider(TRADING_COMMAND_PORT)
      .useValue(new ProjectingTradingPort(projections))
      .compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.init();
    await (
      app.getHttpAdapter().getInstance() as unknown as { ready: () => PromiseLike<unknown> }
    ).ready();
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  it('passes controller → application port → domain → projection without duplicate effect', async () => {
    const command = placeOrderBody();
    for (let retry = 0; retry < 2; retry += 1) {
      await request(app.getHttpServer())
        .post('/api/v1/orders')
        .set('x-api-key', 'flow-key')
        .set('idempotency-key', 'flow-idempotency-1')
        .send(command)
        .expect(201);
    }

    await request(app.getHttpServer())
      .get('/api/v1/projections/orders')
      .set('x-api-key', 'flow-key')
      .expect(200)
      .expect(({ body }) => {
        const page = body as { items: Array<{ orderId: string; status: string }> };
        expect(page.items).toEqual([
          expect.objectContaining({ orderId: 'order-flow-1', status: 'ACCEPTED' }),
        ]);
      });
  });
});
