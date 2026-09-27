import {
  BadRequestException,
  Controller,
  Get,
  Inject,
  NotFoundException,
  Param,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiOkResponse,
  ApiOperation,
  ApiSecurity,
  ApiTags,
} from '@nestjs/swagger';
import { realtimeAssetClassSchema } from '@exchange/contracts';
import { ApiKeyGuard, type ApiKeyPrincipal, assertAuthorizedAction } from '../../auth';
import { REALTIME_CATALOG_PORT, type RealtimeCatalogPort } from '../ports/realtime-catalog.port';
import {
  RealtimeInstrumentPageResponseDto,
  RealtimeInstrumentResponseDto,
  RealtimeMarketStatusResponseDto,
  RealtimeQuotePageResponseDto,
} from '../dto/realtime-market.dto';
import { RealtimeMarketStatusService } from '../application/realtime-market-status.service';
import { QUOTE_STORE_PORT, type QuoteStorePort } from '../ports/quote-store.port';
import type { RealtimeQuoteSnapshot } from '@exchange/contracts';

@Controller('api/v1/realtime')
@UseGuards(ApiKeyGuard)
@ApiTags('Realtime Market')
@ApiSecurity('ApiKeyAuth')
export class RealtimeMarketController {
  constructor(
    @Inject(REALTIME_CATALOG_PORT) private readonly catalog: RealtimeCatalogPort,
    @Inject(QUOTE_STORE_PORT) private readonly quotes: QuoteStorePort,
    private readonly status: RealtimeMarketStatusService,
  ) {}

  @Get('instruments')
  @ApiOperation({ summary: 'Локальный каталог инструментов Twelve Data' })
  @ApiOkResponse({ type: RealtimeInstrumentPageResponseDto })
  @ApiBadRequestResponse({ description: 'Некорректные filters или pagination.' })
  async list(
    @Req() request: { principal: ApiKeyPrincipal },
    @Query('limit') rawLimit?: string,
    @Query('cursor') rawCursor?: string,
    @Query('assetClass') rawAssetClass?: string,
    @Query('exchange') exchange?: string,
    @Query('status') rawStatus?: string,
    @Query('query') query?: string,
  ): Promise<RealtimeInstrumentPageResponseDto> {
    assertAuthorizedAction(request.principal, 'trading.read');
    const limit = Number(rawLimit ?? 50);
    const cursor = Number(rawCursor ?? 0);
    const parsedClass = rawAssetClass
      ? realtimeAssetClassSchema.safeParse(rawAssetClass.toUpperCase())
      : undefined;
    const status = rawStatus?.toUpperCase();
    if (
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 100 ||
      !Number.isInteger(cursor) ||
      cursor < 0 ||
      parsedClass?.success === false ||
      (status !== undefined && status !== 'ACTIVE' && status !== 'INACTIVE') ||
      (exchange?.length ?? 0) > 128 ||
      (query?.length ?? 0) > 64
    )
      throw new BadRequestException({
        code: 'REALTIME_CATALOG_QUERY_INVALID',
        message: 'Realtime catalog query is invalid',
      });
    return this.catalog.list({
      limit,
      cursor,
      ...(parsedClass?.success ? { assetClass: parsedClass.data } : {}),
      ...(exchange ? { exchange } : {}),
      ...(status ? { status } : {}),
      ...(query ? { query } : {}),
    });
  }

  @Get('quotes')
  @ApiOperation({ summary: 'Последние локально кешированные Twelve Data котировки' })
  @ApiOkResponse({ type: RealtimeQuotePageResponseDto })
  async quoteSnapshots(
    @Req() request: { principal: ApiKeyPrincipal },
    @Query('instrumentIds') rawInstrumentIds?: string,
  ): Promise<Readonly<{ items: readonly RealtimeQuoteSnapshot[] }>> {
    assertAuthorizedAction(request.principal, 'trading.read');
    const instrumentIds = [...new Set((rawInstrumentIds ?? '').split(',').filter(Boolean))];
    if (
      instrumentIds.length === 0 ||
      instrumentIds.length > 100 ||
      instrumentIds.some((value) => value.length > 128)
    )
      throw new BadRequestException({
        code: 'REALTIME_QUOTE_QUERY_INVALID',
        message: 'instrumentIds must contain between 1 and 100 local IDs',
      });
    const items = await Promise.all(
      instrumentIds.map(async (instrumentId): Promise<RealtimeQuoteSnapshot> => {
        const instrument = await this.catalog.get(instrumentId);
        if (!instrument || instrument.status !== 'ACTIVE' || !instrument.priceEnabled)
          return { instrumentId, status: 'UNAVAILABLE', quote: null };
        const quote = await this.quotes.getLatest(instrumentId);
        return quote
          ? { instrumentId, status: quote.status, quote }
          : { instrumentId, status: 'UNAVAILABLE', quote: null };
      }),
    );
    return { items };
  }

  @Get('instruments/:instrumentId')
  @ApiOkResponse({ type: RealtimeInstrumentResponseDto })
  async get(
    @Req() request: { principal: ApiKeyPrincipal },
    @Param('instrumentId') id: string,
  ): Promise<RealtimeInstrumentResponseDto> {
    assertAuthorizedAction(request.principal, 'trading.read');
    const instrument = await this.catalog.get(id);
    if (!instrument)
      throw new NotFoundException({
        code: 'REALTIME_INSTRUMENT_NOT_FOUND',
        message: 'Realtime instrument was not found',
      });
    return instrument;
  }

  @Get('market-status')
  @ApiOkResponse({ type: RealtimeMarketStatusResponseDto })
  statusSnapshot(@Req() request: { principal: ApiKeyPrincipal }): RealtimeMarketStatusResponseDto {
    assertAuthorizedAction(request.principal, 'trading.read');
    return this.status.snapshot();
  }
}
