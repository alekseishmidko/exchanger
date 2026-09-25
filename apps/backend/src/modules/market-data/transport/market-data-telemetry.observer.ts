import { MetricsService, TelemetryService, TraceCarrier, TRACE_SPANS } from '../../observability';

/**
 * Наблюдатель WebSocket command flow.
 *
 * Изолирует RED metrics и trace continuation от transport handlers. Operation и
 * channel проходят bounded allow-list в `MetricsService`, поэтому requestId и
 * socketId не создают отдельные time series.
 */
export class MarketDataTelemetryObserver {
  constructor(
    private readonly metrics: MetricsService,
    private readonly telemetry: TelemetryService,
  ) {}

  /** Продолжает W3C trace команды и записывает success/failure duration. */
  observe<T>(operation: string, channel: string, carrier: TraceCarrier, handler: () => T): T {
    const startedAt = process.hrtime.bigint();
    try {
      const result = this.telemetry.continueSpan(
        TRACE_SPANS.WEBSOCKET_MESSAGE,
        carrier,
        { 'messaging.operation': operation, 'messaging.channel': channel },
        handler,
      );
      if (result instanceof Promise) {
        const pending = result as Promise<Awaited<T>>;
        return pending.then(
          (value) => {
            this.metrics.observeWebSocket(operation, channel, 'success', this.elapsed(startedAt));
            return value;
          },
          (error: unknown) => {
            this.metrics.observeWebSocket(operation, channel, 'failure', this.elapsed(startedAt));
            throw error;
          },
        ) as T;
      }
      this.metrics.observeWebSocket(operation, channel, 'success', this.elapsed(startedAt));
      return result;
    } catch (error) {
      this.metrics.observeWebSocket(operation, channel, 'failure', this.elapsed(startedAt));
      throw error;
    }
  }

  /** Переводит monotonic duration в миллисекунды. */
  private elapsed(startedAt: bigint): number {
    return Number(process.hrtime.bigint() - startedAt) / 1_000_000;
  }
}
