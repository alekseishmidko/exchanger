import { BadRequestException, Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiSecurity,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { ApiKeyGuard } from '../../gateway/gateway.auth';
import { InstrumentCatalogService, InstrumentSnapshot } from './instrument-catalog.service';
import { InstrumentPageResponseDto, InstrumentResponseDto } from './instruments.dto';

/**
 * Read-only REST adapter каталога инструментов.
 *
 * Lifecycle и правила изменяются исключительно через AdminController. Этот
 * controller только читает detached snapshots, применяет bounded pagination и
 * преобразует все Decimal в строки публичного контракта.
 */
@Controller('api/v1/instruments')
@UseGuards(ApiKeyGuard)
@ApiTags('Instruments')
@ApiSecurity('ApiKeyAuth')
@ApiUnauthorizedResponse({ description: 'API-ключ отсутствует или недействителен.' })
export class InstrumentsController {
  constructor(private readonly catalog: InstrumentCatalogService) {}

  /** Возвращает стабильную страницу торговых пар, отсортированных по ID. */
  @Get()
  @ApiOperation({ summary: 'Получить каталог торговых инструментов' })
  @ApiQuery({
    name: 'limit',
    required: false,
    schema: { type: 'integer', minimum: 1, maximum: 100 },
  })
  @ApiQuery({ name: 'cursor', required: false, schema: { type: 'string', pattern: '^\\d+$' } })
  @ApiOkResponse({ type: InstrumentPageResponseDto })
  @ApiBadRequestResponse({ description: 'Некорректные параметры pagination.' })
  list(
    @Query('limit') rawLimit?: string,
    @Query('cursor') cursor?: string,
  ): InstrumentPageResponseDto {
    const limit = Number(rawLimit ?? 50);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100 || (cursor && !/^\d+$/.test(cursor))) {
      throw new BadRequestException({
        code: 'PAGINATION_INVALID',
        message: 'Pagination parameters are invalid',
      });
    }
    const start = cursor ? Number(cursor) : 0;
    const all = this.catalog.list();
    const items = all.slice(start, start + limit).map((instrument) => this.toResponse(instrument));
    return {
      items,
      nextCursor: start + items.length < all.length ? String(start + items.length) : null,
    };
  }

  /** Возвращает одну пару вместе со всей immutable историей правил. */
  @Get(':instrumentId')
  @ApiOperation({ summary: 'Получить инструмент и версии его правил' })
  @ApiParam({ name: 'instrumentId', example: 'BTC-USD' })
  @ApiOkResponse({ type: InstrumentResponseDto })
  @ApiNotFoundResponse({ description: 'Инструмент не найден.' })
  get(@Param('instrumentId') instrumentId: string): InstrumentResponseDto {
    return this.toResponse(this.catalog.get(instrumentId));
  }

  /** Маппит domain-derived snapshot в версионированный transport DTO. */
  private toResponse(instrument: InstrumentSnapshot): InstrumentResponseDto {
    return {
      id: instrument.id,
      baseAssetId: instrument.baseAssetId,
      quoteAssetId: instrument.quoteAssetId,
      status: instrument.status,
      rules: instrument.rules.map((rules) => ({
        version: rules.version,
        effectiveAt: rules.effectiveAt.toISOString(),
        tickSize: rules.tickSize.toString(),
        lotSize: rules.lotSize.toString(),
        minQuantity: rules.minQuantity.toString(),
        maxQuantity: rules.maxQuantity.toString(),
        minPrice: rules.priceBand.min.toString(),
        maxPrice: rules.priceBand.max.toString(),
        feePolicyVersion: rules.feePolicyVersion,
        limits: {
          maxOrderQuantity: rules.limits.maxOrderQuantity.toString(),
          maxOpenOrders: rules.limits.maxOpenOrders,
          maxNotional: rules.limits.maxNotional.toString(),
        },
      })),
    };
  }
}
