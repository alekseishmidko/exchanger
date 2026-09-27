import { Global, Module } from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';
import { HttpLoggingInterceptor } from './logging/http-logging.interceptor';
import { LoggingContext } from './logging/logging-context';
import { StructuredLogger } from './logging/structured-logger';
import { LifecycleReporter } from './logging/lifecycle-reporter';
import { MetricsController } from './metrics/metrics.controller';
import { MetricsService } from './metrics/metrics';
import { TelemetryService } from './tracing/tracing';
import { PublicErrorFilter } from './logging/public-error.filter';

/**
 * Глобальный composition root operational logging.
 *
 * Один context/logger instance используется всеми application-модулями. HTTP
 * interceptor регистрируется глобально, а сами providers экспортируются для
 * WebSocket gateways, consumers и domain adapters.
 */
@Global()
@Module({
  /** Публикует Prometheus-compatible metrics только через internal endpoint. */
  controllers: [MetricsController],
  providers: [
    /** Хранит correlation/causation identifiers в async execution context. */
    LoggingContext,
    /** Регистрирует bounded counters, gauges и latency histograms приложения. */
    MetricsService,
    /** Создаёт tracing spans и управляет lifecycle OTLP exporter. */
    TelemetryService,
    /** Формирует единый JSON log schema без утечки secrets. */
    StructuredLogger,
    /** Сообщает startup/shutdown и завершает telemetry pipeline корректно. */
    LifecycleReporter,
    /** Автоматически измеряет и логирует каждый HTTP request. */
    { provide: APP_INTERCEPTOR, useClass: HttpLoggingInterceptor },
    /** Преобразует внутренние исключения в стабильный безопасный public error contract. */
    { provide: APP_FILTER, useClass: PublicErrorFilter },
  ],
  /** Даёт non-HTTP consumers те же context, logs, metrics и tracing primitives. */
  exports: [LoggingContext, MetricsService, StructuredLogger, TelemetryService],
})
export class ObservabilityModule {}
