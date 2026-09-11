import { ConfigService } from '@nestjs/config';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { KNOWN_LOG_EVENTS, LOG_EVENTS, MODULE_LOG_EVENT_POLICY, LogEventName } from './log-events';
import { LoggingContext } from './logging-context';
import { StructuredLogRecord, StructuredLogger } from './structured-logger';

/** Создаёт logger с контролируемым in-memory sink без stdout I/O. */
function createLogger(overrides: Record<string, unknown> = {}): Readonly<{
  logger: StructuredLogger;
  context: LoggingContext;
  records: StructuredLogRecord[];
}> {
  const records: StructuredLogRecord[] = [];
  const context = new LoggingContext();
  const config = new ConfigService({
    NODE_ENV: 'test',
    SERVICE_NAME: 'exchange-test',
    BUILD_VERSION: 'test-build',
    ...overrides,
  });
  return {
    logger: new StructuredLogger(context, config, (record) => records.push(record)),
    context,
    records,
  };
}

describe('StructuredLogger contract', () => {
  it('keeps a success and failure event for every critical module', () => {
    const { logger, records } = createLogger({ LOG_SAMPLE_LIMIT: 1000 });
    for (const policy of Object.values(MODULE_LOG_EVENT_POLICY)) {
      expect(KNOWN_LOG_EVENTS.has(policy.success)).toBe(true);
      expect(KNOWN_LOG_EVENTS.has(policy.failure)).toBe(true);
      expect(policy.success).not.toBe(policy.failure);
      logger.info('contract-test', policy.success);
      logger.warn('contract-test', policy.failure);
    }
    expect(records).toHaveLength(Object.keys(MODULE_LOG_EVENT_POLICY).length * 2);
  });

  it('references both policy events at every instrumented module boundary', () => {
    const sources: Readonly<Record<keyof typeof MODULE_LOG_EVENT_POLICY, string>> = {
      http: 'src/modules/observability/http-logging.interceptor.ts',
      websocket: 'src/modules/market-data/market-data.gateway.ts',
      health: 'src/modules/health/health.service.ts',
      gateway: 'src/modules/gateway/gateway.controller.ts',
      sequencer: 'src/modules/trading/sequencer/sequencer.ts',
      matching: 'src/modules/trading/matching-engine/matching-engine.ts',
      settlement: 'src/modules/trading/settlement/settlement.ts',
      ledger: 'src/modules/ledger/ledger-application.service.ts',
      'event-log': 'src/modules/trading/event-log/event-log.ts',
      projections: 'src/modules/projections/projection.ts',
      instruments: 'src/modules/trading/instruments/instrument-catalog.service.ts',
      admin: 'src/modules/admin/admin.service.ts',
      audit: 'src/modules/audit/audit-log.ts',
    };
    for (const [module, sourcePath] of Object.entries(sources) as Array<
      [keyof typeof MODULE_LOG_EVENT_POLICY, string]
    >) {
      const source = readFileSync(resolve(process.cwd(), sourcePath), 'utf8');
      const policy = MODULE_LOG_EVENT_POLICY[module];
      for (const event of [policy.success, policy.failure]) {
        const constantName = Object.entries(LOG_EVENTS).find(([, value]) => value === event)?.[0];
        expect(constantName).toBeDefined();
        expect(source).toContain(`LOG_EVENTS.${constantName}`);
      }
    }
  });

  it('documents every stable production event name', () => {
    const documentation = readFileSync(
      resolve(process.cwd(), '../../docs/observability/logging.md'),
      'utf8',
    );
    for (const event of KNOWN_LOG_EVENTS) expect(documentation).toContain(event);
  });

  it('emits every mandatory field and propagates correlation/causation context', () => {
    const { logger, context, records } = createLogger();
    context.run(
      { correlationId: 'corr-1', causationId: 'event-parent', commandId: 'command-1' },
      () => logger.info('ledger', LOG_EVENTS.LEDGER_COMMAND_APPLIED, { durationMs: 1.25 }),
    );

    expect(records[0]?.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(records[0]).toEqual({
      timestamp: records[0]?.timestamp,
      level: 'info',
      service: 'exchange-test',
      module: 'ledger',
      event: LOG_EVENTS.LEDGER_COMMAND_APPLIED,
      environment: 'test',
      correlationId: 'corr-1',
      causationId: 'event-parent',
      commandId: 'command-1',
      eventId: null,
      outcome: 'success',
      durationMs: 1.25,
      metadata: {},
    });
  });

  it('redacts sensitive keys, financial values and canary secrets recursively', () => {
    const { logger, records } = createLogger();
    logger.warn('gateway', LOG_EVENTS.GATEWAY_COMMAND_REJECTED, {
      metadata: {
        authorization: 'Bearer canary-token',
        nested: {
          apiKey: 'ex_abcdefghijklmnopqrstuvwxyz012345',
          accountId: 'account-private',
          amount: '1000000.00',
          neutral: 'api_key=secret-canary',
          safeCode: 'AUTH_REJECTED',
        },
      },
    });
    const serialized = JSON.stringify(records);
    for (const secret of [
      'canary-token',
      'abcdefghijklmnopqrstuvwxyz012345',
      'account-private',
      '1000000.00',
      'secret-canary',
    ]) {
      expect(serialized).not.toContain(secret);
    }
    expect(serialized).toContain('AUTH_REJECTED');
  });

  it('rejects unknown events and keeps security events outside sampling', () => {
    const { logger, records } = createLogger({ LOG_SAMPLE_LIMIT: 1, LOG_SAMPLE_WINDOW_MS: 60_000 });
    logger.info('http', LOG_EVENTS.HTTP_COMPLETED);
    logger.info('http', LOG_EVENTS.HTTP_COMPLETED);
    logger.warn('http', LOG_EVENTS.HTTP_REJECTED);
    logger.warn('http', LOG_EVENTS.HTTP_REJECTED);

    expect(records.filter(({ event }) => event === LOG_EVENTS.HTTP_COMPLETED)).toHaveLength(1);
    expect(records.filter(({ event }) => event === LOG_EVENTS.HTTP_REJECTED)).toHaveLength(2);
    expect(() => logger.info('unknown', 'unknown.production.event' as LogEventName)).toThrow(
      'Unknown production log event',
    );
  });

  it('exposes stack only for an explicitly protected internal event', () => {
    const external = createLogger();
    external.logger.failure('event-log', LOG_EVENTS.EVENT_LOG_TIMEOUT, {
      error: new Error('database password=canary'),
    });
    expect(external.records[0]).not.toHaveProperty('stack');

    const internal = createLogger();
    internal.logger.failure('event-log', LOG_EVENTS.EVENT_LOG_TIMEOUT, {
      error: new Error('safe-internal-error'),
      internal: true,
    });
    expect(internal.records[0]?.stack).toContain('safe-internal-error');
  });
});
