import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';
import { HealthService } from './health.service';
import { HEALTH_DEPENDENCIES } from './health.tokens';

/** Собирает health endpoints, проверки зависимостей и HTTP-наблюдаемость. */
@Module({
  controllers: [HealthController],
  providers: [HealthService, { provide: HEALTH_DEPENDENCIES, useValue: [] }],
})
export class HealthModule {}
