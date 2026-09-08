import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  HttpException,
  Param,
  Post,
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
  ApiSecurity,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { z } from 'zod';
import { AuditActor } from '../audit';
import { ApiKeyGuard, ApiKeyPrincipal, assertAdministrativeAccess } from '../gateway/gateway.auth';
import { IdempotencyStore } from '../gateway/gateway.idempotency';
import { RateLimitService } from '../gateway/gateway.rate-limit';
import { ZodValidationPipe } from '../gateway/gateway.validation';
import { Decimal, createId } from '../shared-kernel';
import { Instrument, InstrumentRules } from '../trading/instruments';
import {
  AdminCommandResponseDto,
  CircuitBreakerRequestDto,
  ConfigureInstrumentRequestDto,
  FeePolicyRequestDto,
  FreezeRequestDto,
  InstrumentStatusRequestDto,
  ReconciliationResponseDto,
  RiskPolicyRequestDto,
} from './admin.dto';
import { AdminCommand, AdminResult, AdminService } from './admin.service';
import {
  circuitBreakerSchema,
  configureInstrumentSchema,
  feePolicySchema,
  freezeSchema,
  instrumentStatusSchema,
  riskPolicySchema,
} from './admin.validation';

/** HTTP request после успешного ApiKeyGuard. */
type AdminRequest = { principal: ApiKeyPrincipal };

/**
 * Авторизованный REST adapter административного application service.
 *
 * Каждый write требует API key и Idempotency-Key. Actor строится исключительно
 * из principal, поэтому клиент не может подменить автора audit record через
 * payload. Критические команды возвращают `PENDING_APPROVAL` и применяются лишь
 * после отдельного запроса второго admin API key.
 */
@Controller('api/v1/admin')
@UseGuards(ApiKeyGuard)
@ApiTags('Admin')
@ApiSecurity('ApiKeyAuth')
@ApiUnauthorizedResponse({ description: 'API-ключ отсутствует или недействителен.' })
@ApiForbiddenResponse({ description: 'Требуется административная роль.' })
@ApiBadRequestResponse({ description: 'DTO или административная domain policy отклонили команду.' })
@ApiConflictResponse({ description: 'Idempotency-Key использован с другим payload.' })
export class AdminController {
  constructor(
    private readonly admin: AdminService,
    private readonly idempotency: IdempotencyStore,
    private readonly rateLimit: RateLimitService,
  ) {}

  /** Создаёт инструмент или добавляет будущую immutable версию правил. */
  @Post('instruments')
  @ApiOperation({ summary: 'Запросить изменение конфигурации инструмента' })
  @ApiBody({ type: ConfigureInstrumentRequestDto })
  @ApiCreatedResponse({ type: AdminCommandResponseDto })
  @ApiBadRequestResponse({ description: 'DTO или trading rules некорректны.' })
  @ApiConflictResponse({ description: 'Idempotency-Key использован с другим payload.' })
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  configureInstrument(
    @Req() request: AdminRequest,
    @Headers('idempotency-key') key: string | undefined,
    @Body(new ZodValidationPipe(configureInstrumentSchema))
    body: z.infer<typeof configureInstrumentSchema>,
  ): Promise<AdminResult> {
    assertAdministrativeAccess(request.principal);
    let command: AdminCommand;
    try {
      const rules = this.toRules(body.rules);
      command =
        body.mode === 'CREATE'
          ? {
              commandId: body.commandId,
              type: 'CONFIGURE_INSTRUMENT',
              targetId: body.instrumentId,
              instrument: new Instrument(
                body.instrumentId,
                createId<'AssetId'>(body.baseAssetId ?? ''),
                createId<'AssetId'>(body.quoteAssetId ?? ''),
                rules,
              ),
            }
          : {
              commandId: body.commandId,
              type: 'CONFIGURE_INSTRUMENT',
              targetId: body.instrumentId,
              rules,
            };
    } catch {
      throw new BadRequestException({
        code: 'INSTRUMENT_CONFIGURATION_INVALID',
        message: 'Instrument configuration is invalid',
      });
    }
    return this.execute(request.principal, key, body, () =>
      this.admin.request(command, this.actor(request.principal)),
    );
  }

  /** Запрашивает activate/pause; изменение применяется только после dual control. */
  @Post('instruments/:instrumentId/status')
  @ApiOperation({ summary: 'Запросить изменение lifecycle инструмента' })
  @ApiParam({ name: 'instrumentId', example: 'BTC-USD' })
  @ApiBody({ type: InstrumentStatusRequestDto })
  @ApiCreatedResponse({ type: AdminCommandResponseDto })
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  changeInstrumentStatus(
    @Req() request: AdminRequest,
    @Param('instrumentId') instrumentId: string,
    @Headers('idempotency-key') key: string | undefined,
    @Body(new ZodValidationPipe(instrumentStatusSchema))
    body: z.infer<typeof instrumentStatusSchema>,
  ): Promise<AdminResult> {
    const command: AdminCommand = {
      commandId: body.commandId,
      type: body.status === 'ACTIVE' ? 'ACTIVATE_INSTRUMENT' : 'PAUSE_INSTRUMENT',
      targetId: instrumentId,
    };
    return this.execute(request.principal, key, { instrumentId, ...body }, () =>
      this.admin.request(command, this.actor(request.principal)),
    );
  }

  /** Выполняет freeze/unfreeze через новую аудируемую command, а не изменение записи. */
  @Post('freezes')
  @ApiOperation({ summary: 'Заморозить или разморозить пользователя/аккаунт' })
  @ApiBody({ type: FreezeRequestDto })
  @ApiCreatedResponse({ type: AdminCommandResponseDto })
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  changeFreeze(
    @Req() request: AdminRequest,
    @Headers('idempotency-key') key: string | undefined,
    @Body(new ZodValidationPipe(freezeSchema)) body: z.infer<typeof freezeSchema>,
  ): Promise<AdminResult> {
    const type = `${body.action}_${body.targetType}` as AdminCommand['type'];
    return this.execute(request.principal, key, body, () =>
      this.admin.request(
        { commandId: body.commandId, type, targetId: body.targetId } as AdminCommand,
        this.actor(request.principal),
      ),
    );
  }

  /** Запрашивает emergency stop/resume с обязательным независимым approval. */
  @Post('circuit-breakers')
  @ApiOperation({ summary: 'Запросить emergency stop или resume' })
  @ApiBody({ type: CircuitBreakerRequestDto })
  @ApiCreatedResponse({ type: AdminCommandResponseDto })
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  changeCircuitBreaker(
    @Req() request: AdminRequest,
    @Headers('idempotency-key') key: string | undefined,
    @Body(new ZodValidationPipe(circuitBreakerSchema))
    body: z.infer<typeof circuitBreakerSchema>,
  ): Promise<AdminResult> {
    return this.execute(request.principal, key, body, () =>
      this.admin.request(
        {
          commandId: body.commandId,
          type: body.action === 'STOP' ? 'EMERGENCY_STOP' : 'RESUME_TRADING',
          targetId: body.targetId,
        },
        this.actor(request.principal),
      ),
    );
  }

  /** Регистрирует maker/taker fee policy как версию с effectiveAt. */
  @Post('fee-policies')
  @ApiOperation({ summary: 'Запросить новую версию fee policy' })
  @ApiBody({ type: FeePolicyRequestDto })
  @ApiCreatedResponse({ type: AdminCommandResponseDto })
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  changeFeePolicy(
    @Req() request: AdminRequest,
    @Headers('idempotency-key') key: string | undefined,
    @Body(new ZodValidationPipe(feePolicySchema)) body: z.infer<typeof feePolicySchema>,
  ): Promise<AdminResult> {
    return this.execute(request.principal, key, body, () =>
      this.admin.request(
        {
          commandId: body.commandId,
          type: 'CHANGE_FEE_POLICY',
          targetId: 'global',
          policy: {
            version: body.version,
            effectiveAt: new Date(body.effectiveAt),
            makerRate: Decimal.from(body.makerRate),
            takerRate: Decimal.from(body.takerRate),
          },
        },
        this.actor(request.principal),
      ),
    );
  }

  /** Регистрирует новую immutable risk policy через dual-control flow. */
  @Post('risk-policies')
  @ApiOperation({ summary: 'Запросить новую версию risk policy' })
  @ApiBody({ type: RiskPolicyRequestDto })
  @ApiCreatedResponse({ type: AdminCommandResponseDto })
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  changeRiskPolicy(
    @Req() request: AdminRequest,
    @Headers('idempotency-key') key: string | undefined,
    @Body(new ZodValidationPipe(riskPolicySchema)) body: z.infer<typeof riskPolicySchema>,
  ): Promise<AdminResult> {
    return this.execute(request.principal, key, body, () =>
      this.admin.request(
        {
          commandId: body.commandId,
          type: 'CHANGE_RISK_POLICY',
          targetId: 'global',
          policy: {
            version: body.version,
            effectiveAt: new Date(body.effectiveAt),
            maxOrderNotional: Decimal.from(body.maxOrderNotional),
            maxOpenOrders: body.maxOpenOrders,
          },
        },
        this.actor(request.principal),
      ),
    );
  }

  /** Подтверждает pending-команду identity второго администратора. */
  @Post('approvals/:commandId')
  @ApiOperation({ summary: 'Подтвердить критичную административную команду' })
  @ApiParam({ name: 'commandId', example: 'admin-command-1' })
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiCreatedResponse({ type: AdminCommandResponseDto })
  approve(
    @Req() request: AdminRequest,
    @Param('commandId') commandId: string,
    @Headers('idempotency-key') key: string | undefined,
  ): Promise<AdminResult> {
    return this.execute(request.principal, key, { commandId }, () =>
      this.admin.approve(commandId, this.actor(request.principal)),
    );
  }

  /** Возвращает операционную сводку после проверки роли и audit integrity. */
  @Get('reconciliation')
  @ApiOperation({ summary: 'Получить reconciliation status' })
  @ApiOkResponse({ type: ReconciliationResponseDto })
  getReconciliation(@Req() request: AdminRequest): ReconciliationResponseDto {
    assertAdministrativeAccess(request.principal);
    return this.admin.getDashboard(this.actor(request.principal));
  }

  /** Создаёт domain rules только после строгой runtime validation DTO. */
  private toRules(value: z.infer<typeof configureInstrumentSchema>['rules']): InstrumentRules {
    return {
      version: value.version,
      effectiveAt: new Date(value.effectiveAt),
      tickSize: Decimal.from(value.tickSize),
      lotSize: Decimal.from(value.lotSize),
      minQuantity: Decimal.from(value.minQuantity),
      maxQuantity: Decimal.from(value.maxQuantity),
      priceBand: { min: Decimal.from(value.minPrice), max: Decimal.from(value.maxPrice) },
      feePolicyVersion: value.feePolicyVersion,
      limits: {
        maxOrderQuantity: Decimal.from(value.maxOrderQuantity),
        maxOpenOrders: value.maxOpenOrders,
        maxNotional: Decimal.from(value.maxNotional),
      },
    };
  }

  /** Выполняет общую admission-последовательность всех admin write endpoints. */
  private execute<T>(
    principal: ApiKeyPrincipal,
    key: string | undefined,
    payload: unknown,
    operation: () => T,
  ): Promise<T> {
    assertAdministrativeAccess(principal);
    this.rateLimit.check(principal.keyId);
    const idempotencyKey = this.requireIdempotencyKey(key);
    return this.idempotency.execute(
      `${principal.keyId}:${idempotencyKey}`,
      { actorId: principal.userId, payload },
      async () => {
        try {
          return await Promise.resolve(operation());
        } catch (error) {
          if (error instanceof HttpException) throw error;
          throw new BadRequestException({
            code: 'ADMIN_COMMAND_REJECTED',
            message: 'Administrative command cannot be applied',
          });
        }
      },
    );
  }

  /** Валидирует transport idempotency key до вызова application service. */
  private requireIdempotencyKey(value: string | undefined): string {
    if (!value || !/^[A-Za-z0-9._:-]{1,128}$/.test(value)) {
      throw new BadRequestException({
        code: 'IDEMPOTENCY_KEY_REQUIRED',
        message: 'Idempotency-Key header is required',
      });
    }
    return value;
  }

  /** Преобразует authenticated principal в неизменяемого audit actor. */
  private actor(principal: ApiKeyPrincipal): AuditActor {
    const roles = {
      admin: 'ADMIN',
      risk_manager: 'RISK_MANAGER',
      auditor: 'AUDITOR',
      support: 'SUPPORT',
    } as const;
    if (principal.role === 'trader') {
      throw new BadRequestException({
        code: 'ADMIN_ACTOR_INVALID',
        message: 'Administrative actor is invalid',
      });
    }
    return { actorId: principal.userId, role: roles[principal.role] };
  }
}
