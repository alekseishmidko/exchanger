import { Controller, Get, HttpCode, ServiceUnavailableException } from '@nestjs/common';
import { HealthService, LivenessResponse, ReadinessResponse } from './health.service';

/** Публикует технические health-контракты для оркестратора и мониторинга. */
@Controller('health')
export class HealthController {
  constructor(private readonly healthService: HealthService) {}

  /** Отвечает о живости процесса без проверки базы данных или брокера. */
  @Get(['', 'live'])
  getLiveness(): LivenessResponse {
    return this.healthService.getLiveness();
  }

  /** Возвращает 503, если хотя бы одна критичная зависимость недоступна. */
  @Get('ready')
  @HttpCode(200)
  async getReadiness(): Promise<ReadinessResponse> {
    const result = await this.healthService.getReadiness();
    if (result.status === 'unavailable') {
      throw new ServiceUnavailableException({
        status: result.status,
        checks: result.checks,
      });
    }
    return result;
  }
}
