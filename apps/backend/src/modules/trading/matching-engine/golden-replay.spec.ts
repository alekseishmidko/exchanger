import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Decimal } from '../../shared-kernel';
import { MatchingCommand, MatchingEngine } from './matching-engine';

type GoldenFixture = Readonly<{
  commands: readonly Readonly<Record<string, string>>[];
  expected: readonly string[];
}>;

/** Проверяет, что опубликованный golden fixture воспроизводит event sequence. */
describe('MatchingEngine golden replay', () => {
  it('replays the canonical single-price fixture', () => {
    const fixture = JSON.parse(
      readFileSync(resolve(__dirname, 'golden-replay.json'), 'utf8'),
    ) as GoldenFixture;
    const commands: MatchingCommand[] = fixture.commands.map((command) => ({
      type: 'PLACE',
      orderId: command['orderId'] ?? '',
      userId: command['userId'] ?? '',
      side: command['side'] as 'BUY' | 'SELL',
      orderType: 'LIMIT',
      price: Decimal.from(command['price'] ?? '0'),
      quantity: Decimal.from(command['quantity'] ?? '0'),
      timeInForce: command['timeInForce'] as 'GTC' | 'IOC' | 'FOK',
    }));
    const engine = new MatchingEngine();
    const events = commands.flatMap((command) => engine.apply(command));

    expect(events.map(({ kind }) => kind)).toEqual(fixture.expected);
  });
});
