import { Controller, Get, Inject, Query, Req, UseGuards } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiSecurity,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { ApiKeyGuard, ApiKeyPrincipal } from '../gateway';
import { BalanceView, OrderView, ProjectionMetrics, ProjectionPage, TradeView } from './projection';
import { PROJECTION_STORE_PORT, ProjectionStorePort } from './projection.port';
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
  /**
   * Создаёт query transport adapter поверх versioned projection port.
   *
   * В каждый query передаётся userId только из проверенного principal. Controller
   * не получает repository/client, поэтому не может снять ownership filter или
   * выполнить произвольный запрос к read-model таблицам.
   *
   * @param projections Порт owner-isolated read models и lag metrics.
   */
  constructor(@Inject(PROJECTION_STORE_PORT) private readonly projections: ProjectionStorePort) {}

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
  async getOrders(
    @Req() request: ProjectionRequest,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ): Promise<ProjectionPage<OrderView>> {
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
  async getTrades(
    @Req() request: ProjectionRequest,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ): Promise<ProjectionPage<TradeView>> {
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
  async getBalances(
    @Req() request: ProjectionRequest,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ): Promise<ProjectionPage<BalanceView>> {
    return this.projections.getBalances(request.principal.userId, Number(limit ?? 50), cursor);
  }

  /** Возвращает lag metrics для эксплуатации projection consumer. */
  @Get('metrics')
  @ApiOperation({ summary: 'Получить lag и версию projection consumer' })
  @ApiOkResponse({ type: ProjectionMetricsResponseDto })
  async getMetrics(): Promise<ProjectionMetrics> {
    return this.projections.getMetrics();
  }
}
