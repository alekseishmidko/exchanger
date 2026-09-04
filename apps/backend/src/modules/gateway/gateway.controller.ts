import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  Inject,
  Post,
  Query,
  Req,
  UseGuards,
  UsePipes,
} from '@nestjs/common';
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
export class GatewayController {
  constructor(
    @Inject('TRADING_COMMAND_PORT')
    private readonly trading: TradingCommandPort,
    private readonly idempotency: IdempotencyStore,
    private readonly rateLimit: RateLimitService,
  ) {}

  /** Валидирует, авторизует и направляет place command в trading core. */
  @Post('orders')
  @UsePipes(new ZodValidationPipe(placeOrderDtoSchema))
  async placeOrder(
    @Req() request: GatewayRequest,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() body: z.infer<typeof placeOrderDtoSchema>,
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
  @UsePipes(new ZodValidationPipe(cancelOrderDtoSchema))
  async cancelOrder(
    @Req() request: GatewayRequest,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() body: z.infer<typeof cancelOrderDtoSchema>,
  ): Promise<unknown> {
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
