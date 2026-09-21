/**
 * Файл содержит REST boundary команд клиента: place, cancel и order query.
 *
 * Контроллер выполняет transport orchestration: authentication уже выполнен
 * guard-ом, затем идут idempotency, rate limit, authorization, validation,
 * admission control и вызов `TradingCommandPort`. Здесь запрещены прямые
 * обращения к matching engine, ledger или PostgreSQL repositories.
 */
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  Inject,
  NotFoundException,
  Optional,
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
import { ADMISSION_CONTROL_PORT, AdmissionControlPort } from '../../admin/admission-control';
import {
  GatewayCancelOrderCommand,
  GatewayPlaceOrderCommand,
  TRADING_COMMAND_PORT,
  TradingCommandPort,
} from '../types/gateway.types';
import { ApiKeyGuard, ApiKeyPrincipal, assertObjectAccess } from '../auth/gateway.auth';
import { IDEMPOTENCY_STORE_PORT, IdempotencyStorePort } from '../ports/gateway.idempotency.port';
import { RateLimitService } from '../application/gateway.rate-limit';
import {
  cancelOrderDtoSchema,
  placeOrderDtoSchema,
  ZodValidationPipe,
} from '../validation/gateway.validation';
import {
  LOG_EVENTS,
  NOOP_OPERATIONAL_LOGGER,
  OperationalLogger,
  StructuredLogger,
  MetricsService,
  TelemetryService,
  TRACE_SPANS,
} from '../../observability';
import {
  CancelOrderRequestDto,
  GatewayCommandResponseDto,
  GatewayOrderPageResponseDto,
  PlaceOrderRequestDto,
} from '../dto/gateway.dto';

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
  private readonly logger: OperationalLogger;

  /**
   * Собирает command transport boundary из application ports и observability.
   *
   * Контроллер не получает matching engine или ledger напрямую. После guard он
   * проверяет idempotency/rate/object access, строит публичную command-модель и
   * вызывает только `TradingCommandPort`. Span и metrics используют bounded тип
   * команды; финансовый payload не записывается в telemetry.
   *
   * @param trading Разрешённый application port place/cancel сценариев.
   * @param idempotency Хранилище результата повторной HTTP-команды.
   * @param rateLimit Ограничитель нагрузки на API key boundary.
   * @param metrics Метрики command acceptance/rejection.
   * @param telemetry Adapter admission span текущего HTTP trace.
   * @param logger Необязательный operational logger с no-op fallback.
   */
  constructor(
    @Inject(TRADING_COMMAND_PORT)
    private readonly trading: TradingCommandPort,
    @Inject(IDEMPOTENCY_STORE_PORT) private readonly idempotency: IdempotencyStorePort,
    private readonly rateLimit: RateLimitService,
    private readonly metrics: MetricsService,
    private readonly telemetry: TelemetryService,
    @Inject(ADMISSION_CONTROL_PORT) private readonly admission: AdmissionControlPort,
    @Optional() @Inject(StructuredLogger) logger?: StructuredLogger,
  ) {
    this.logger = logger ?? NOOP_OPERATIONAL_LOGGER;
  }

  /**
   * Валидирует, авторизует и направляет place command в trading core.
   * Повтор с тем же API key и `Idempotency-Key` возвращает сохранённый результат
   * без второго business effect; несовместимый payload отклоняет store.
   */
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
    await this.admission.assertAllowed({
      userId: command.userId,
      accountId: command.accountId,
      instrumentId: command.instrumentId,
    });
    return this.telemetry.span(TRACE_SPANS.COMMAND_ADMISSION, { 'command.type': 'place' }, () =>
      this.idempotency.execute(`${request.principal.keyId}:${key}`, command, async () => {
        try {
          const result = await this.trading.placeOrder(command);
          this.metrics.observeCommand('place', 'accepted');
          this.logger.info('gateway', LOG_EVENTS.GATEWAY_COMMAND_ACCEPTED, {
            commandId: command.commandId,
            metadata: { commandType: 'PLACE_ORDER', instrumentId: command.instrumentId },
          });
          return result;
        } catch (error) {
          this.metrics.observeCommand('place', 'rejected', this.metricReason(error));
          this.logger.warn('gateway', LOG_EVENTS.GATEWAY_COMMAND_REJECTED, {
            commandId: command.commandId,
            metadata: { commandType: 'PLACE_ORDER', errorType: this.errorType(error) },
          });
          throw error;
        }
      }),
    );
  }

  /**
   * Валидирует, авторизует и направляет cancel command в trading core.
   * Path и body обязаны адресовать одну заявку, после чего используется та же
   * admission/idempotency цепочка, что и для размещения заявки.
   */
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
    await this.admission.assertAllowed({
      userId: command.userId,
      accountId: command.accountId,
      instrumentId: command.instrumentId,
    });
    return this.telemetry.span(TRACE_SPANS.COMMAND_ADMISSION, { 'command.type': 'cancel' }, () =>
      this.idempotency.execute(`${request.principal.keyId}:${key}`, command, async () => {
        try {
          const result = await this.trading.cancelOrder(command);
          this.metrics.observeCommand('cancel', 'accepted');
          this.logger.info('gateway', LOG_EVENTS.GATEWAY_COMMAND_ACCEPTED, {
            commandId: command.commandId,
            metadata: { commandType: 'CANCEL_ORDER', orderId: command.orderId },
          });
          return result;
        } catch (error) {
          this.metrics.observeCommand('cancel', 'rejected', this.metricReason(error));
          this.logger.warn('gateway', LOG_EVENTS.GATEWAY_COMMAND_REJECTED, {
            commandId: command.commandId,
            metadata: { commandType: 'CANCEL_ORDER', errorType: this.errorType(error) },
          });
          throw error;
        }
      }),
    );
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
  @Get('orders/:orderId')
  @ApiOperation({ summary: 'Получить заявку по публичному orderId' })
  @ApiParam({
    name: 'orderId',
    example: 'order-1',
    description: 'Публичный identifier заявки из place/cancel command API.',
  })
  @ApiOkResponse({ type: GatewayCommandResponseDto })
  @ApiBadRequestResponse({ description: 'Некорректный формат orderId.' })
  @ApiTooManyRequestsResponse({ description: 'Превышен лимит запросов API-ключа.' })
  async getOrder(
    @Req() request: GatewayRequest,
    @Param('orderId') orderId: string,
  ): Promise<GatewayCommandResponseDto> {
    this.rateLimit.check(request.principal.keyId);
    if (!/^[A-Za-z0-9._:-]{1,128}$/.test(orderId)) {
      throw new BadRequestException({
        code: 'ORDER_ID_INVALID',
        message: 'Order ID is invalid',
      });
    }
    const result = await this.trading.getOrder(request.principal.userId, orderId);
    if (!result) {
      throw new NotFoundException({
        code: 'ORDER_NOT_FOUND',
        message: 'Order was not found',
      });
    }
    return result;
  }

  /** Возвращает ограниченную страницу заявок без обхода authorization boundary. */
  @Get('orders')
  @ApiOperation({ summary: 'Получить страницу заявок доступного аккаунта' })
  @ApiQuery({ name: 'limit', required: false, example: 50, schema: { minimum: 1, maximum: 100 } })
  @ApiQuery({ name: 'cursor', required: false, example: '50' })
  @ApiOkResponse({ type: GatewayOrderPageResponseDto })
  @ApiBadRequestResponse({ description: 'Некорректный limit или cursor.' })
  @ApiTooManyRequestsResponse({ description: 'Превышен лимит запросов API-ключа.' })
  async listOrders(
    @Req() request: GatewayRequest,
    @Query('limit') limitValue?: string,
    @Query('cursor') cursor?: string,
  ): Promise<Readonly<{ items: readonly unknown[]; nextCursor: string | null }>> {
    this.rateLimit.check(request.principal.keyId);
    const limit = Number(limitValue ?? 50);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100 || (cursor && !/^\d+$/.test(cursor))) {
      throw new BadRequestException({
        code: 'PAGINATION_INVALID',
        message: 'Pagination parameters are invalid',
      });
    }
    return this.trading.listOrders(request.principal.userId, limit, cursor);
  }

  /** Возвращает только класс ошибки, не message/stack с потенциальным payload. */
  private errorType(error: unknown): string {
    return error instanceof Error ? error.name : 'UnknownError';
  }

  /** Сводит произвольные exception classes к bounded metric reason. */
  private metricReason(error: unknown): string {
    if (error instanceof BadRequestException) return 'validation';
    return 'unknown';
  }
}
