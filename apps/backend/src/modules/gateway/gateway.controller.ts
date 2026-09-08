import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  Inject,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBody,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiHeader,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiSecurity,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { z } from 'zod';
import { ApiKeyGuard, ApiKeyPrincipal, assertObjectAccess } from './gateway.auth';
import {
  GatewayCancelOrderCommand,
  GatewayPlaceOrderCommand,
  TradingCommandPort,
} from './gateway.types';
import { cancelOrderDtoSchema, placeOrderDtoSchema, ZodValidationPipe } from './gateway.validation';
import { IdempotencyStore } from './gateway.idempotency';
import { RateLimitService } from './gateway.rate-limit';
import {
  CancelOrderRequestDto,
  GatewayCommandResponseDto,
  GatewayOrderPageResponseDto,
  PlaceOrderRequestDto,
} from './gateway.dto';

/** Минимальная форма request после выполнения ApiKeyGuard. */
type GatewayRequest = { principal: ApiKeyPrincipal };

/**
 * REST adapter внешнего клиента.
 *
 * Для command path порядок одинаков: guard → idempotency header → rate limit →
 * object authorization → DTO mapping → trading port. Благодаря этому HTTP
 * endpoint не может передать в core неподтверждённую или повторную команду.
 */
@Controller('api/v1')
@UseGuards(ApiKeyGuard)
@ApiTags('Gateway')
@ApiSecurity('ApiKeyAuth')
@ApiUnauthorizedResponse({ description: 'API-ключ отсутствует или недействителен.' })
@ApiForbiddenResponse({ description: 'Ключ не даёт доступа к указанному аккаунту.' })
export class GatewayController {
  constructor(
    @Inject('TRADING_COMMAND_PORT')
    private readonly trading: TradingCommandPort,
    private readonly idempotency: IdempotencyStore,
    private readonly rateLimit: RateLimitService,
  ) {}

  /** Валидирует, авторизует и направляет place command в trading core. */
  @Post('orders')
  @ApiOperation({ summary: 'Разместить заявку' })
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    description: 'Уникальный ключ повтора длиной до 128 символов.',
  })
  @ApiBody({ type: PlaceOrderRequestDto })
  @ApiCreatedResponse({ type: GatewayCommandResponseDto })
  @ApiBadRequestResponse({ description: 'Некорректный body или Idempotency-Key.' })
  @ApiConflictResponse({ description: 'Ключ идемпотентности уже связан с другой командой.' })
  @ApiTooManyRequestsResponse({ description: 'Превышен лимит запросов API-ключа.' })
  async placeOrder(
    @Req() request: GatewayRequest,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body(new ZodValidationPipe(placeOrderDtoSchema))
    body: z.infer<typeof placeOrderDtoSchema>,
  ): Promise<unknown> {
    const key = this.requireIdempotencyKey(idempotencyKey);
    this.rateLimit.check(request.principal.keyId);
    assertObjectAccess(request.principal, body.accountId);
    const command: GatewayPlaceOrderCommand = {
      ...body,
      idempotencyKey: key,
      userId: request.principal.userId,
      limitPrice: body.limitPrice ?? null,
    };
    return this.idempotency.execute(key, command, () => this.trading.placeOrder(command));
  }

  /** Валидирует, авторизует и направляет cancel command в trading core. */
  @Post('orders/:orderId/cancel')
  @ApiOperation({ summary: 'Отменить активную заявку' })
  @ApiParam({ name: 'orderId', example: 'order-1' })
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiBody({ type: CancelOrderRequestDto })
  @ApiCreatedResponse({ type: GatewayCommandResponseDto })
  @ApiBadRequestResponse({ description: 'Некорректный body, path или Idempotency-Key.' })
  @ApiConflictResponse({ description: 'Ключ идемпотентности уже связан с другой командой.' })
  @ApiTooManyRequestsResponse({ description: 'Превышен лимит запросов API-ключа.' })
  async cancelOrder(
    @Req() request: GatewayRequest,
    @Param('orderId') orderId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body(new ZodValidationPipe(cancelOrderDtoSchema))
    body: z.infer<typeof cancelOrderDtoSchema>,
  ): Promise<unknown> {
    if (orderId !== body.orderId) {
      throw new BadRequestException({
        code: 'ORDER_ID_MISMATCH',
        message: 'Path and body orderId must match',
      });
    }
    const key = this.requireIdempotencyKey(idempotencyKey);
    this.rateLimit.check(request.principal.keyId);
    assertObjectAccess(request.principal, body.accountId);
    const command: GatewayCancelOrderCommand = {
      ...body,
      orderId: body.orderId,
      idempotencyKey: key,
      userId: request.principal.userId,
    };
    return this.idempotency.execute(key, command, () => this.trading.cancelOrder(command));
  }

  /** Проверяет формат обязательного Idempotency-Key до обращения к core. */
  private requireIdempotencyKey(value: string | undefined): string {
    if (!value || !/^[A-Za-z0-9._:-]{1,128}$/.test(value)) {
      throw new BadRequestException({
        code: 'IDEMPOTENCY_KEY_REQUIRED',
        message: 'Idempotency-Key header is required',
      });
    }
    return value;
  }

  /** Возвращает ограниченную страницу заявок без обхода authorization boundary. */
  @Get('orders')
  @ApiOperation({ summary: 'Получить страницу заявок доступного аккаунта' })
  @ApiQuery({ name: 'limit', required: false, example: 50, schema: { minimum: 1, maximum: 100 } })
  @ApiQuery({ name: 'cursor', required: false, example: '50' })
  @ApiOkResponse({ type: GatewayOrderPageResponseDto })
  @ApiBadRequestResponse({ description: 'Некорректный limit или cursor.' })
  @ApiTooManyRequestsResponse({ description: 'Превышен лимит запросов API-ключа.' })
  listOrders(
    @Req() request: GatewayRequest,
    @Query('limit') limitValue?: string,
    @Query('cursor') cursor?: string,
  ): Readonly<{ items: readonly unknown[]; nextCursor: string | null }> {
    this.rateLimit.check(request.principal.keyId);
    const limit = Number(limitValue ?? 50);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100 || (cursor && !/^\d+$/.test(cursor))) {
      throw new BadRequestException({
        code: 'PAGINATION_INVALID',
        message: 'Pagination parameters are invalid',
      });
    }
    return this.trading.listOrders(limit, cursor);
  }
}
