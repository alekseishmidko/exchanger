import { Test } from '@nestjs/testing';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { ApiKeyRegistry } from '../src/modules/gateway/gateway.auth';
import {
  GatewayCancelOrderCommand,
  GatewayCommandResult,
  GatewayPlaceOrderCommand,
  TradingCommandPort,
} from '../src/modules/gateway/gateway.types';
import { ProjectionStore } from '../src/modules/projections/projection';
import { Decimal } from '../src/modules/shared-kernel';
import { MatchingEngine } from '../src/modules/trading/matching-engine/matching-engine';

/**
 * Test application adapter, связывающий HTTP port с настоящим domain engine и
 * projection consumer. Он нужен для проверки границ, а не для production DI:
 * production заменит его sequencer/event-log adapter с тем же интерфейсом.
 */
class ProjectingTradingPort implements TradingCommandPort {
  private readonly engine = new MatchingEngine();
  private readonly results = new Map<string, GatewayCommandResult>();
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
    this.results.set(result.orderId, result);
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
    this.results.set(result.orderId, result);
    return result;
  }

  /** Возвращает bounded reference page для Gateway query endpoint. */
  listOrders(limit: number, cursor?: string) {
    const values = [...this.results.values()];
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
      .useValue(new ApiKeyRegistry([{ keyId: 'flow-key', role: 'trader', userId: 'user-1' }]))
      .overrideProvider(ProjectionStore)
      .useValue(projections)
      .overrideProvider('TRADING_COMMAND_PORT')
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
    const command = {
      commandId: 'flow-place-1',
      orderId: 'order-flow-1',
      accountId: 'user-1',
      instrumentId: 'BTC-USD',
      clientOrderId: 'order-flow-1',
      side: 'BUY',
      orderType: 'LIMIT',
      quantity: '1',
      limitPrice: '100',
      timeInForce: 'GTC',
    };
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
