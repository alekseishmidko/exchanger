import { Controller, Get, Query, Req, UseGuards } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiSecurity,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { ApiKeyGuard, ApiKeyPrincipal } from '../gateway/gateway.auth';
import {
  BalanceView,
  OrderView,
  ProjectionMetrics,
  ProjectionPage,
  ProjectionStore,
  TradeView,
} from './projection';
import {
  BalanceProjectionPageDto,
  OrderProjectionPageDto,
  ProjectionMetricsResponseDto,
  TradeProjectionPageDto,
} from './projections.dto';

/** Request после успешной проверки API key. */
type ProjectionRequest = { principal: ApiKeyPrincipal };

/** Публикует read-only query API с фильтрацией данных по владельцу. */
@Controller('api/v1/projections')
@UseGuards(ApiKeyGuard)
@ApiTags('Projections')
@ApiSecurity('ApiKeyAuth')
@ApiUnauthorizedResponse({ description: 'API-ключ отсутствует или недействителен.' })
export class ProjectionsController {
  constructor(private readonly projections: ProjectionStore) {}

  /** Возвращает историю заявок только текущего пользователя. */
  @Get('orders')
  @ApiOperation({ summary: 'Получить историю заявок текущего пользователя' })
  @ApiQuery({
    name: 'limit',
    required: false,
    schema: { type: 'integer', minimum: 1, maximum: 100 },
  })
  @ApiQuery({ name: 'cursor', required: false, schema: { type: 'string', pattern: '^\\d+$' } })
  @ApiOkResponse({ type: OrderProjectionPageDto })
  @ApiBadRequestResponse({ description: 'Некорректные параметры pagination.' })
  getOrders(
    @Req() request: ProjectionRequest,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ): ProjectionPage<OrderView> {
    return this.projections.getOrders(request.principal.userId, Number(limit ?? 50), cursor);
  }

  /** Возвращает сделки, в которых текущий пользователь является участником. */
  @Get('trades')
  @ApiOperation({ summary: 'Получить историю сделок текущего пользователя' })
  @ApiQuery({
    name: 'limit',
    required: false,
    schema: { type: 'integer', minimum: 1, maximum: 100 },
  })
  @ApiQuery({ name: 'cursor', required: false, schema: { type: 'string', pattern: '^\\d+$' } })
  @ApiOkResponse({ type: TradeProjectionPageDto })
  @ApiBadRequestResponse({ description: 'Некорректные параметры pagination.' })
  getTrades(
    @Req() request: ProjectionRequest,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ): ProjectionPage<TradeView> {
    return this.projections.getTrades(request.principal.userId, Number(limit ?? 50), cursor);
  }

  /** Возвращает балансы account owner без возможности указать чужой accountId. */
  @Get('balances')
  @ApiOperation({ summary: 'Получить balance projections текущего пользователя' })
  @ApiQuery({
    name: 'limit',
    required: false,
    schema: { type: 'integer', minimum: 1, maximum: 100 },
  })
  @ApiQuery({ name: 'cursor', required: false, schema: { type: 'string', pattern: '^\\d+$' } })
  @ApiOkResponse({ type: BalanceProjectionPageDto })
  @ApiBadRequestResponse({ description: 'Некорректные параметры pagination.' })
  getBalances(
    @Req() request: ProjectionRequest,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ): ProjectionPage<BalanceView> {
    return this.projections.getBalances(request.principal.userId, Number(limit ?? 50), cursor);
  }

  /** Возвращает lag metrics для эксплуатации projection consumer. */
  @Get('metrics')
  @ApiOperation({ summary: 'Получить lag и версию projection consumer' })
  @ApiOkResponse({ type: ProjectionMetricsResponseDto })
  getMetrics(): ProjectionMetrics {
    return this.projections.getMetrics();
  }
}
