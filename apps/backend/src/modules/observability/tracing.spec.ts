import { ConfigService } from '@nestjs/config';
import { ReadableSpan, SpanExporter } from '@opentelemetry/sdk-trace-base';
import { MetricsService } from './metrics';
import { ResilientSpanExporter, TelemetryService } from './tracing';
import { TRACE_SPANS } from './telemetry.types';
import { LoggingContext } from './logging-context';
import { StructuredLogRecord, StructuredLogger } from './structured-logger';
import { LOG_EVENTS } from './log-events';
import { HealthService } from '../health/health.service';

describe('OpenTelemetry flow and exporter isolation', () => {
  let metrics: MetricsService;
  let telemetry: TelemetryService;

  beforeEach(() => {
    metrics = new MetricsService();
    telemetry = new TelemetryService(
      new ConfigService({
        OTEL_TRACES_ENABLED: 'false',
        OTEL_DIAGNOSTIC_SPAN_LIMIT: 100,
        OTEL_BSP_MAX_QUEUE_SIZE: 32,
        OTEL_BSP_MAX_EXPORT_BATCH_SIZE: 16,
        OTEL_BSP_SCHEDULE_DELAY: 10,
        OTEL_BSP_EXPORT_TIMEOUT: 50,
      }),
      metrics,
    );
  });

  afterEach(async () => {
    await telemetry?.onModuleDestroy();
    metrics?.onModuleDestroy();
  });

  it('keeps one trace through the complete command flow and durable carrier', async () => {
    await telemetry.span(TRACE_SPANS.COMMAND_ADMISSION, { 'command.type': 'place' }, async () => {
      telemetry.span(TRACE_SPANS.SEQUENCER_WAIT, {}, () =>
        telemetry.span(TRACE_SPANS.MATCHING_APPLY, {}, () => undefined),
      );
      await telemetry.span(TRACE_SPANS.SETTLEMENT_APPLY, {}, async () => {
        telemetry.span(TRACE_SPANS.LEDGER_COMMIT, {}, () => undefined);
        await telemetry.span(TRACE_SPANS.EVENT_APPEND, {}, async () => Promise.resolve());
      });
      const carrier = telemetry.carrier();
      telemetry.continueSpan(TRACE_SPANS.EVENT_CONSUME, carrier, {}, () => {
        telemetry.span(TRACE_SPANS.PROJECTION_APPLY, {}, () => undefined);
      });
    });

    const spans = telemetry.completedSpans();
    expect(new Set(spans.map(({ traceId }) => traceId))).toHaveProperty('size', 1);
    expect(new Set(spans.map(({ name }) => name))).toEqual(
      new Set([
        TRACE_SPANS.COMMAND_ADMISSION,
        TRACE_SPANS.SEQUENCER_WAIT,
        TRACE_SPANS.MATCHING_APPLY,
        TRACE_SPANS.SETTLEMENT_APPLY,
        TRACE_SPANS.LEDGER_COMMIT,
        TRACE_SPANS.EVENT_APPEND,
        TRACE_SPANS.EVENT_CONSUME,
        TRACE_SPANS.PROJECTION_APPLY,
      ]),
    );
    expect(
      spans
        .filter(({ name }) => name !== TRACE_SPANS.COMMAND_ADMISSION)
        .every(({ parentSpanId }) => parentSpanId),
    ).toBe(true);
  });

  it('does not throw into business flow when exporter fails and increments metric', async () => {
    const failing: SpanExporter = {
      export: (_spans: ReadableSpan[], callback) => callback({ code: 1, error: new Error('down') }),
      shutdown: () => Promise.resolve(),
    };
    const exporter = new ResilientSpanExporter(failing, metrics);

    expect(() => exporter.export([], () => undefined)).not.toThrow();
    expect(await metrics.render()).toContain(
      'exchange_telemetry_export_failures_total{signal="traces",reason="export_error",service="exchange-backend"} 1',
    );
    await expect(
      new HealthService([{ name: 'postgres', check: () => Promise.resolve() }]).getReadiness(),
    ).resolves.toEqual({ status: 'ok', checks: { postgres: 'ok' } });
  });

  it('adds active traceId and spanId to structured logs', () => {
    const records: StructuredLogRecord[] = [];
    const logger = new StructuredLogger(
      new LoggingContext(),
      new ConfigService({ NODE_ENV: 'test', SERVICE_NAME: 'exchange-backend' }),
      (record) => records.push(record),
    );

    telemetry.span(TRACE_SPANS.LEDGER_COMMIT, {}, () =>
      logger.info('ledger', LOG_EVENTS.LEDGER_COMMAND_APPLIED),
    );

    const span = telemetry.completedSpans().at(-1);
    expect(records[0]).toEqual(
      expect.objectContaining({ traceId: span?.traceId, spanId: span?.spanId }),
    );
  });

  it('bounds diagnostic ingestion volume and records dropped non-critical spans', async () => {
    for (let index = 0; index < 1_000; index += 1) {
      telemetry.span(TRACE_SPANS.MATCHING_APPLY, { 'command.type': 'place' }, () => index);
    }
    const encoded = Buffer.byteLength(JSON.stringify(telemetry.completedSpans()), 'utf8');
    const exposition = await metrics.render();

    expect(telemetry.completedSpans()).toHaveLength(100);
    expect(encoded).toBeLessThan(64 * 1024);
    expect(Buffer.byteLength(exposition, 'utf8')).toBeLessThan(256 * 1024);
    expect(exposition).toContain(
      'exchange_telemetry_dropped_total{signal="traces",reason="queue_full",service="exchange-backend"} 900',
    );
  });
});
