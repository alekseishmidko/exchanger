import { Controller, Get, Query, Req, UseGuards } from '@nestjs/common';
import { ApiKeyGuard, ApiKeyPrincipal } from '../gateway/gateway.auth';
import { ProjectionStore } from './projection';

/** Request после успешной проверки API key. */
type ProjectionRequest = { principal: ApiKeyPrincipal };

/** Публикует read-only query API с фильтрацией данных по владельцу. */
@Controller('api/v1/projections')
@UseGuards(ApiKeyGuard)
export class ProjectionsController {
  constructor(private readonly projections: ProjectionStore) {}

  /** Возвращает историю заявок только текущего пользователя. */
  @Get('orders')
  getOrders(
    @Req() request: ProjectionRequest,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ) {
    return this.projections.getOrders(request.principal.userId, Number(limit ?? 50), cursor);
  }

  /** Возвращает сделки, в которых текущий пользователь является участником. */
  @Get('trades')
  getTrades(
    @Req() request: ProjectionRequest,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ) {
    return this.projections.getTrades(request.principal.userId, Number(limit ?? 50), cursor);
  }

  /** Возвращает балансы account owner без возможности указать чужой accountId. */
  @Get('balances')
  getBalances(
    @Req() request: ProjectionRequest,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ) {
    return this.projections.getBalances(request.principal.userId, Number(limit ?? 50), cursor);
  }

  /** Возвращает lag metrics для эксплуатации projection consumer. */
  @Get('metrics')
  getMetrics() {
    return this.projections.getMetrics();
  }
}
