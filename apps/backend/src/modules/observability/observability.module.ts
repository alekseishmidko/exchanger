import { Global, Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { HttpLoggingInterceptor } from './http-logging.interceptor';
import { LoggingContext } from './logging-context';
import { StructuredLogger } from './structured-logger';
import { LifecycleReporter } from './lifecycle-reporter';

/**
 * Глобальный composition root operational logging.
 *
 * Один context/logger instance используется всеми application-модулями. HTTP
 * interceptor регистрируется глобально, а сами providers экспортируются для
 * WebSocket gateways, consumers и domain adapters.
 */
@Global()
@Module({
  providers: [
    LoggingContext,
    StructuredLogger,
    LifecycleReporter,
    { provide: APP_INTERCEPTOR, useClass: HttpLoggingInterceptor },
  ],
  exports: [LoggingContext, StructuredLogger],
})
export class ObservabilityModule {}
