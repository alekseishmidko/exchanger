/**
 * Политика ограничения label values.
 *
 * Методы сводят потенциально бесконечные значения к allow-list bucket-ам, чтобы
 * пользовательские IDs, exception messages и raw resource names не создавали
 * cardinality explosion в Prometheus.
 */
export class MetricsLabelPolicy {
  /** Заменяет ID-подобные сегменты route и ограничивает неизвестные шаблоны. */
  normalizeRoute(route: string): string {
    const path = route.split('?')[0] ?? '/unknown';
    return path
      .replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/gi, ':id')
      .replace(/\/[A-Za-z0-9_-]{24,}(?=\/|$)/g, '/:id')
      .slice(0, 128);
  }

  /** Сводит причины к фиксированному каталогу, предотвращая cardinality explosion. */
  boundedReason(reason: string): string {
    const allowed = new Set([
      'none',
      'validation',
      'authorization',
      'rate_limit',
      'timeout',
      'dependency',
      'invariant',
      'queue_full',
      'export_error',
      'unknown',
    ]);
    return allowed.has(reason) ? reason : 'unknown';
  }

  /** Разрешает только заранее известные low-cardinality resource names. */
  boundedComponent(value: string): string {
    const allowed = new Set([
      'orders',
      'balances',
      'trades',
      'projection',
      'settlement',
      'event-log',
      'postgres',
      'postgres-pool',
      'event-loop',
      'runtime',
      'market-data',
      'trading',
    ]);
    return allowed.has(value) ? value : 'unknown';
  }

  /** Ограничивает instrument label фиксированным allow-list и other bucket. */
  boundedInstrument(value: string): string {
    return ['BTC-USD', 'ETH-USD'].includes(value) ? value : 'other';
  }
}
