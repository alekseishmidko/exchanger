import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { CorrelationIdInterceptor } from './correlation-id.interceptor';
import { HealthController } from './health.controller';
import { HealthService } from './health.service';
import { HEALTH_DEPENDENCIES } from './health.tokens';

/** Собирает health endpoints, проверки зависимостей и HTTP-наблюдаемость. */
@Module({
  controllers: [HealthController],
  providers: [
    HealthService,
    { provide: HEALTH_DEPENDENCIES, useValue: [] },
    { provide: APP_INTERCEPTOR, useClass: CorrelationIdInterceptor },
  ],
})
export class HealthModule {}
