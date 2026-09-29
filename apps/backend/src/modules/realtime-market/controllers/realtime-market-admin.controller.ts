import {
  BadGatewayException,
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiAcceptedResponse,
  ApiBody,
  ApiHeader,
  ApiOkResponse,
  ApiOperation,
  ApiSecurity,
  ApiTags,
} from '@nestjs/swagger';
import { ApiKeyGuard, type ApiKeyPrincipal, assertAuthorizedAction } from '../../auth';
import { AUDIT_LOG_PORT, type AuditActor, type AuditLogPort } from '../../audit';
import type { RealtimeInstrument } from '@exchange/contracts';
import { RateLimitService } from '../../gateway/application/gateway.rate-limit';
import {
  IDEMPOTENCY_STORE_PORT,
  type IdempotencyStorePort,
} from '../../gateway/ports/gateway.idempotency.port';
import { ReferenceDataSyncService } from '../application/reference-data-sync.service';
import {
  TwelveDataDiagnosticsService,
  type TwelveDataDiagnosticResult,
} from '../application/twelve-data-diagnostics.service';
import { RealtimeInstrumentResponseDto } from '../dto/realtime-market.dto';
import { REALTIME_CATALOG_PORT, type RealtimeCatalogPort } from '../ports/realtime-catalog.port';
import {
  REALTIME_EXECUTION_REPOSITORY,
  type RealtimeExecutionRepositoryPort,
} from '../ports/realtime-execution.port';

/** Admin trigger не проксирует HTTP request в provider и запускает bounded sync job. */
@Controller('api/v1/admin/realtime')
@UseGuards(ApiKeyGuard)
@ApiTags('Realtime Market Admin')
@ApiSecurity('ApiKeyAuth')
export class RealtimeMarketAdminController {
  constructor(
    private readonly sync: ReferenceDataSyncService,
    private readonly diagnostics: TwelveDataDiagnosticsService,
    private readonly rateLimit: RateLimitService,
    @Inject(IDEMPOTENCY_STORE_PORT) private readonly idempotency: IdempotencyStorePort,
    @Inject(REALTIME_CATALOG_PORT) private readonly catalog: RealtimeCatalogPort,
    @Inject(REALTIME_EXECUTION_REPOSITORY)
    private readonly executions: RealtimeExecutionRepositoryPort,
    @Inject(AUDIT_LOG_PORT) private readonly audit: AuditLogPort,
  ) {}

  @Post('provider-inspect')
  @HttpCode(200)
  @ApiOperation({ summary: 'Выполнить bounded admin-проверку ответа Twelve Data' })
  @ApiBody({
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['transport'],
      properties: {
        transport: { type: 'string', enum: ['REST', 'WEBSOCKET'] },
        endpoint: {
          type: 'string',
          enum: [
            '/quote',
            '/price',
            '/time_series',
            '/eod',
            '/exchange_rate',
            '/cryptocurrencies',
            '/forex_pairs',
            '/stocks',
            '/commodities',
            '/symbol_search',
            '/technical_indicators',
          ],
        },
        symbol: { type: 'string', minLength: 1, maxLength: 64 },
        exchange: { type: 'string', minLength: 1, maxLength: 128 },
        interval: {
          type: 'string',
          enum: ['1min', '5min', '15min', '30min', '45min', '1h', '2h', '4h', '8h', '1day'],
        },
        outputsize: { type: 'integer', minimum: 1, maximum: 100 },
        page: { type: 'integer', minimum: 1, maximum: 1000 },
      },
    },
  })
  @ApiOkResponse({ description: 'Sanitized provider response without credentials.' })
  async inspectProvider(
    @Req() request: { principal: ApiKeyPrincipal },
    @Body() body: unknown,
  ): Promise<TwelveDataDiagnosticResult> {
    assertAuthorizedAction(request.principal, 'admin.read');
    this.rateLimit.check(request.principal.keyId);
    try {
      const result = await this.diagnostics.inspect(body);
      await this.audit.append(
        this.actor(request.principal),
        'ACTION_REQUESTED',
        'TWELVE_DATA_PROVIDER_INSPECT',
        `${result.transport}:${result.endpoint}`,
        'TwelveData',
      );
      return result;
    } catch (error) {
      const code = error instanceof Error ? error.message : 'TWELVE_DATA_DIAGNOSTIC_FAILED';
      if (code.startsWith('TWELVE_DATA_DIAGNOSTIC_'))
        throw new BadRequestException({
          code,
          message: 'Twelve Data diagnostic request is invalid',
        });
      throw new BadGatewayException({ code, message: 'Twelve Data diagnostic request failed' });
    }
  }

  @Post('catalog-sync')
  @HttpCode(202)
  @ApiOperation({ summary: 'Запустить синхронизацию локального Twelve Data каталога' })
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiAcceptedResponse({ description: 'Catalog sync accepted.' })
  async trigger(
    @Req() request: { principal: ApiKeyPrincipal },
    @Headers('idempotency-key') key?: string,
  ): Promise<Readonly<{ status: 'ACCEPTED' }>> {
    assertAuthorizedAction(request.principal, 'admin.write');
    this.rateLimit.check(request.principal.keyId);
    if (!key || key.length > 128 || !/^[A-Za-z0-9._:-]+$/.test(key))
      throw new BadRequestException({
        code: 'IDEMPOTENCY_KEY_REQUIRED',
        message: 'Valid Idempotency-Key is required',
      });
    return this.idempotency.execute(
      `realtime-catalog:${request.principal.keyId}:${key}`,
      { action: 'CATALOG_SYNC' },
      async () => {
        await this.audit.append(
          this.actor(request.principal),
          'ACTION_REQUESTED',
          'REALTIME_CATALOG_SYNC',
          key,
          'TwelveData',
        );
        void this.sync.sync();
        return { status: 'ACCEPTED' as const };
      },
    );
  }

  @Post('instruments/:instrumentId/price-enable')
  @ApiOperation({ summary: 'Включить получение realtime-цен для инструмента' })
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiOkResponse({ type: RealtimeInstrumentResponseDto })
  enablePrice(
    @Req() request: { principal: ApiKeyPrincipal },
    @Param('instrumentId') instrumentId: string,
    @Headers('idempotency-key') key?: string,
  ): Promise<RealtimeInstrument> {
    return this.setPriceEnabled(request.principal, instrumentId, true, key);
  }

  @Post('instruments/:instrumentId/price-disable')
  @ApiOperation({ summary: 'Отключить получение realtime-цен для инструмента' })
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiOkResponse({ type: RealtimeInstrumentResponseDto })
  disablePrice(
    @Req() request: { principal: ApiKeyPrincipal },
    @Param('instrumentId') instrumentId: string,
    @Headers('idempotency-key') key?: string,
  ): Promise<RealtimeInstrument> {
    return this.setPriceEnabled(request.principal, instrumentId, false, key);
  }

  @Post('instruments/:instrumentId/trading-enable')
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiOkResponse({ type: RealtimeInstrumentResponseDto })
  enableTrading(
    @Req() request: { principal: ApiKeyPrincipal },
    @Param('instrumentId') instrumentId: string,
    @Headers('idempotency-key') key?: string,
  ): Promise<RealtimeInstrument> {
    return this.setTradeEnabled(request.principal, instrumentId, true, key);
  }

  @Post('instruments/:instrumentId/trading-disable')
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiOkResponse({ type: RealtimeInstrumentResponseDto })
  disableTrading(
    @Req() request: { principal: ApiKeyPrincipal },
    @Param('instrumentId') instrumentId: string,
    @Headers('idempotency-key') key?: string,
  ): Promise<RealtimeInstrument> {
    return this.setTradeEnabled(request.principal, instrumentId, false, key);
  }

  @Post('execution/pause')
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  pause(
    @Req() request: { principal: ApiKeyPrincipal },
    @Headers('idempotency-key') key?: string,
  ): Promise<Readonly<{ paused: true }>> {
    return this.setPaused(request.principal, true, key);
  }

  @Post('execution/resume')
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  resume(
    @Req() request: { principal: ApiKeyPrincipal },
    @Headers('idempotency-key') key?: string,
  ): Promise<Readonly<{ paused: false }>> {
    return this.setPaused(request.principal, false, key);
  }

  @Get('execution/reconciliation')
  reconciliation(@Req() request: { principal: ApiKeyPrincipal }) {
    assertAuthorizedAction(request.principal, 'admin.read');
    return this.executions.reconcile();
  }

  private setPriceEnabled(
    principal: ApiKeyPrincipal,
    instrumentId: string,
    enabled: boolean,
    key?: string,
  ): Promise<RealtimeInstrument> {
    assertAuthorizedAction(principal, 'admin.write');
    this.rateLimit.check(principal.keyId);
    this.assertIdempotencyKey(key);
    return this.idempotency.execute(
      `realtime-price:${principal.keyId}:${key}`,
      { action: enabled ? 'PRICE_ENABLE' : 'PRICE_DISABLE', instrumentId },
      async () => {
        const instrument = await this.catalog.setPriceEnabled(instrumentId, enabled);
        if (!instrument)
          throw new NotFoundException({
            code: 'REALTIME_INSTRUMENT_NOT_FOUND',
            message: 'Realtime instrument was not found or cannot be enabled',
          });
        await this.audit.append(
          this.actor(principal),
          'ACTION_APPLIED',
          enabled ? 'REALTIME_PRICE_ENABLE' : 'REALTIME_PRICE_DISABLE',
          key,
          instrumentId,
        );
        return instrument;
      },
    );
  }

  private setTradeEnabled(
    principal: ApiKeyPrincipal,
    instrumentId: string,
    enabled: boolean,
    key?: string,
  ): Promise<RealtimeInstrument> {
    assertAuthorizedAction(principal, 'admin.write');
    this.rateLimit.check(principal.keyId);
    this.assertIdempotencyKey(key);
    return this.idempotency.execute(
      `realtime-trading:${principal.keyId}:${key}`,
      { action: enabled ? 'TRADING_ENABLE' : 'TRADING_DISABLE', instrumentId },
      async () => {
        const instrument = await this.catalog.setTradeEnabled(instrumentId, enabled);
        if (!instrument)
          throw new NotFoundException({
            code: 'REALTIME_INSTRUMENT_NOT_FOUND',
            message: 'Realtime instrument was not found or cannot be enabled',
          });
        await this.audit.append(
          this.actor(principal),
          'ACTION_APPLIED',
          enabled ? 'REALTIME_TRADING_ENABLE' : 'REALTIME_TRADING_DISABLE',
          key,
          instrumentId,
        );
        return instrument;
      },
    );
  }

  private setPaused<T extends boolean>(
    principal: ApiKeyPrincipal,
    paused: T,
    key?: string,
  ): Promise<Readonly<{ paused: T }>> {
    assertAuthorizedAction(principal, 'admin.write');
    this.rateLimit.check(principal.keyId);
    this.assertIdempotencyKey(key);
    return this.idempotency.execute(
      `realtime-control:${principal.keyId}:${key}`,
      { action: paused ? 'EXECUTION_PAUSE' : 'EXECUTION_RESUME' },
      async () => {
        await this.executions.setPaused(paused);
        await this.audit.append(
          this.actor(principal),
          'ACTION_APPLIED',
          paused ? 'REALTIME_EXECUTION_PAUSE' : 'REALTIME_EXECUTION_RESUME',
          key,
          'realtime-execution',
        );
        return { paused };
      },
    );
  }

  private assertIdempotencyKey(key?: string): asserts key is string {
    if (!key || key.length > 128 || !/^[A-Za-z0-9._:-]+$/.test(key))
      throw new BadRequestException({
        code: 'IDEMPOTENCY_KEY_REQUIRED',
        message: 'Valid Idempotency-Key is required',
      });
  }

  private actor(principal: ApiKeyPrincipal): AuditActor {
    const roles = {
      admin: 'ADMIN',
      risk_manager: 'RISK_MANAGER',
      auditor: 'AUDITOR',
      support: 'SUPPORT',
      trader: 'USER',
    } as const;
    return { actorId: principal.userId, role: roles[principal.role] };
  }
}
