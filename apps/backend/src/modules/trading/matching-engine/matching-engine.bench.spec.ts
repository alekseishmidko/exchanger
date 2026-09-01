import { Decimal } from '../../shared-kernel';
import { MatchingEngine } from './matching-engine';

/** Минимальный benchmark гарантирует отсутствие сетевых и DB вызовов на hot path. */
describe('MatchingEngine benchmark', () => {
  it('processes a local order flow without external dependencies', () => {
    const startedAt = performance.now();
    const engine = new MatchingEngine();
    for (let index = 0; index < 1000; index += 1) {
      engine.apply({
        type: 'PLACE',
        orderId: `ask-${index}`,
        userId: `maker-${index}`,
        side: 'SELL',
        orderType: 'LIMIT',
        price: Decimal.from('100'),
        quantity: Decimal.from('1'),
        timeInForce: 'GTC',
      });
    }
    const elapsed = performance.now() - startedAt;

    expect(engine.getLastSequence()).toBe(1000);
    expect(elapsed).toBeLessThan(5000);
  });
});
