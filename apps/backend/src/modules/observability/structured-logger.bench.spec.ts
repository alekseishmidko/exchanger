import { ConfigService } from '@nestjs/config';
import { LOG_EVENTS } from './log-events';
import { LoggingContext } from './logging-context';
import { StructuredLogger } from './structured-logger';

describe('StructuredLogger hot-path budget', () => {
  /**
   * Фиксирует CPU/allocation overhead 10 000 boundary events без stdout I/O.
   * Порог намеренно широкий для CI-машин; regression здесь означает алгоритм с
   * неограниченным накоплением либо заметно нелинейной сериализацией metadata.
   */
  it('stays within the reference CPU and allocation budget', () => {
    let writes = 0;
    let serializedBytes = 0;
    const logger = new StructuredLogger(
      new LoggingContext(),
      new ConfigService({
        NODE_ENV: 'test',
        SERVICE_NAME: 'bench',
        LOG_SAMPLE_LIMIT: 20_000,
      }),
      (record) => {
        writes += 1;
        serializedBytes += Buffer.byteLength(JSON.stringify(record));
      },
    );
    const beforeHeap = process.memoryUsage().heapUsed;
    const startedAt = process.hrtime.bigint();
    for (let index = 0; index < 10_000; index += 1) {
      logger.info('matching', LOG_EVENTS.MATCHING_ORDER_PROCESSED, {
        metadata: { emittedEvents: 2, sequence: index },
      });
    }
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
    const allocationBytes = Math.max(0, process.memoryUsage().heapUsed - beforeHeap);

    expect(writes).toBe(10_000);
    expect(serializedBytes).toBeGreaterThan(0);
    expect(durationMs).toBeLessThan(1_000);
    expect(allocationBytes).toBeLessThan(64 * 1024 * 1024);
  });
});
