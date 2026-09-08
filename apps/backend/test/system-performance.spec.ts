import { MarketDataHub } from '../src/modules/market-data/market-data';
import { ProjectionStore } from '../src/modules/projections/projection';
import { Decimal } from '../src/modules/shared-kernel';
import { MatchingEngine } from '../src/modules/trading/matching-engine/matching-engine';

/**
 * Pilot profile для локальной проверки latency и WebSocket-style fan-out.
 *
 * Порог намеренно является regression guard, а не production SLA: benchmark не
 * включает сеть и PostgreSQL. Итоговые percentile вычисляются из latency каждой
 * команды, а fan-out проверяет доставку burst всем подписчикам без перестановки.
 */
describe('Pilot system profile', () => {
  it('records matching p50/p95/p99 and projection consumer lag', () => {
    const engine = new MatchingEngine();
    const latencies: number[] = [];
    for (let index = 0; index < 2000; index += 1) {
      const startedAt = performance.now();
      engine.apply({
        type: 'PLACE',
        orderId: `pilot-${index}`,
        userId: `user-${index}`,
        side: 'SELL',
        orderType: 'LIMIT',
        quantity: Decimal.from('1'),
        price: Decimal.from('100'),
        timeInForce: 'GTC',
      });
      latencies.push(performance.now() - startedAt);
    }
    const sorted = [...latencies].sort((left, right) => left - right);
    const percentile = (value: number): number =>
      sorted[Math.ceil(sorted.length * value) - 1] ?? Number.POSITIVE_INFINITY;
    expect(percentile(0.5)).toBeLessThan(10);
    expect(percentile(0.95)).toBeLessThan(25);
    expect(percentile(0.99)).toBeLessThan(100);
    const projection = new ProjectionStore();
    projection.observeSourceSequence(10);
    expect(projection.getMetrics()).toMatchObject({
      appliedSequence: 0,
      sourceSequence: 10,
      lag: 10,
    });
  });

  it('fans out an ordered burst to Pilot subscribers', () => {
    const hub = new MarketDataHub(600, 100);
    hub.publishSnapshot({
      channel: 'book',
      instrumentId: 'BTC-USD',
      sequence: 1,
      bids: [],
      asks: [],
    });
    const deliveries = Array.from({ length: 500 }, () => 0);
    deliveries.forEach((_count, index) =>
      hub.subscribePublic(`client-${index}`, 'BTC-USD', 'trades', () => {
        deliveries[index] = (deliveries[index] ?? 0) + 1;
      }),
    );
    for (let sequence = 2; sequence <= 101; sequence += 1) {
      hub.publishTick({
        channel: 'trades',
        instrumentId: 'BTC-USD',
        sequence,
        price: '100',
        quantity: '1',
      });
    }
    expect(deliveries.every((count) => count === 100)).toBe(true);
    expect(hub.getSubscriberCount()).toBe(500);
  });
});
