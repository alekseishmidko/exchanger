import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  Headers,
  HttpException,
  HttpCode,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
  ServiceUnavailableException,
  UseGuards,
} from '@nestjs/common';
import { ApiHeader, ApiOkResponse, ApiOperation, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { realtimeOrderCommandSchema, type RealtimeExecution } from '@exchange/contracts';
import { ApiKeyGuard, assertAuthorizedAction, type ApiKeyPrincipal } from '../../auth';
import { RateLimitService } from '../../gateway/application/gateway.rate-limit';
import { MetricsService } from '../../observability';
import { RealtimeExecutionService } from '../application/realtime-execution.service';
import {
  RealtimeExecutionPageResponseDto,
  RealtimeExecutionResponseDto,
} from '../dto/realtime-market.dto';

@Controller('api/v1/realtime/orders')
@UseGuards(ApiKeyGuard)
@ApiTags('Realtime Execution')
@ApiSecurity('ApiKeyAuth')
export class RealtimeExecutionController {
  constructor(
    private readonly execution: RealtimeExecutionService,
    private readonly rateLimit: RateLimitService,
    private readonly metrics: MetricsService,
  ) {}

  @Post()
  @HttpCode(200)
  @ApiOperation({ summary: 'Выполнить reference-price операцию по подтверждённой котировке' })
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiOkResponse({ type: RealtimeExecutionResponseDto })
  async execute(
    @Req() request: { principal: ApiKeyPrincipal },
    @Headers('idempotency-key') key: string | undefined,
    @Body() body: unknown,
  ): Promise<RealtimeExecution> {
    assertAuthorizedAction(request.principal, 'trading.write');
    this.rateLimit.check(request.principal.keyId);
    if (!key || key.length > 128 || !/^[A-Za-z0-9._:-]+$/.test(key))
      throw new BadRequestException({
        code: 'IDEMPOTENCY_KEY_REQUIRED',
        message: 'Valid Idempotency-Key is required',
      });
    const parsed = realtimeOrderCommandSchema.safeParse(body);
    if (!parsed.success)
      throw new BadRequestException({
        code: 'REALTIME_ORDER_INVALID',
        message: 'Realtime order is invalid',
      });
    try {
      return await this.execution.execute(request.principal, key, parsed.data);
    } catch (error) {
      throw this.mapError(error);
    }
  }

  @Get()
  @ApiOkResponse({ type: RealtimeExecutionPageResponseDto })
  async list(
    @Req() request: { principal: ApiKeyPrincipal },
    @Query('limit') rawLimit?: string,
    @Query('cursor') rawCursor?: string,
  ) {
    assertAuthorizedAction(request.principal, 'trading.read');
    const limit = Number(rawLimit ?? 50);
    const cursor = Number(rawCursor ?? 0);
    if (
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 100 ||
      !Number.isInteger(cursor) ||
      cursor < 0
    )
      throw new BadRequestException({
        code: 'PAGINATION_INVALID',
        message: 'Pagination is invalid',
      });
    return this.execution.list(request.principal.userId, limit, cursor);
  }

  @Get(':orderId')
  @ApiOkResponse({ type: RealtimeExecutionResponseDto })
  async get(
    @Req() request: { principal: ApiKeyPrincipal },
    @Param('orderId') orderId: string,
  ): Promise<RealtimeExecution> {
    assertAuthorizedAction(request.principal, 'trading.read');
    const value = await this.execution.get(request.principal.userId, orderId);
    if (!value)
      throw new NotFoundException({
        code: 'REALTIME_ORDER_NOT_FOUND',
        message: 'Order was not found',
      });
    return value;
  }

  private mapError(error: unknown): HttpException {
    if (error instanceof HttpException) return error;
    const code = error instanceof Error ? error.message : 'REALTIME_EXECUTION_FAILED';
    this.metrics.observeRealtimeExecution('rejected', this.metricReason(code));
    if (['QUOTE_STALE', 'QUOTE_CHANGED', 'REALTIME_EXECUTION_PAUSED'].includes(code))
      return new ConflictException({ code, message: 'Realtime execution was rejected' });
    if (
      [
        'REALTIME_PRICE_UNAVAILABLE',
        'LIQUIDITY_UNAVAILABLE',
        'REALTIME_EXECUTION_DISABLED',
      ].includes(code)
    )
      return new ServiceUnavailableException({
        code,
        message: 'Realtime execution is unavailable',
      });
    const status = ['REALTIME_ACCOUNT_FORBIDDEN'].includes(code) ? 403 : 400;
    return new HttpException({ code, message: 'Realtime execution was rejected' }, status);
  }

  private metricReason(code: string): string {
    const allowed = new Set([
      'QUOTE_STALE',
      'QUOTE_CHANGED',
      'REALTIME_EXECUTION_PAUSED',
      'REALTIME_PRICE_UNAVAILABLE',
      'LIQUIDITY_UNAVAILABLE',
      'REALTIME_FUNDS_UNAVAILABLE',
      'REALTIME_INSTRUMENT_NOT_TRADABLE',
    ]);
    return allowed.has(code) ? code : 'other';
  }
}
