import { Controller, Get, Header } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { MetricsService } from './metrics';

/**
 * Internal Prometheus scrape boundary.
 *
 * Endpoint исключён из public OpenAPI и не содержит business payload. В staging
 * и production доступ к `/internal/metrics` ограничивается ingress/network policy;
 * пользовательский Gateway не должен proxy этот маршрут во внешний API.
 */
@Controller('internal')
@ApiExcludeController()
export class MetricsController {
  /**
   * Создаёт внутренний transport boundary поверх единого registry.
   *
   * Контроллер не вычисляет метрики самостоятельно: он получает уже
   * агрегированный snapshot от `MetricsService`. Благодаря этому scrape не
   * вызывает trading dependencies и не влияет на readiness приложения.
   *
   * @param metrics Сервис, владеющий OpenMetrics registry процесса.
   */
  constructor(private readonly metrics: MetricsService) {}

  /**
   * Возвращает текущий snapshot в OpenMetrics text exposition format.
   *
   * Ответ предназначен для Prometheus Collector, а не для пользовательского
   * API. Например, histogram возвращается сериями `_bucket`, `_sum` и `_count`,
   * из которых PromQL вычисляет p50/p95/p99 без доступа к исходным запросам.
   *
   * @returns Promise с текстовым представлением всех зарегистрированных метрик.
   */
  @Get('metrics')
  @Header('content-type', 'application/openmetrics-text; version=1.0.0; charset=utf-8')
  render(): Promise<string> {
    return this.metrics.render();
  }
}
