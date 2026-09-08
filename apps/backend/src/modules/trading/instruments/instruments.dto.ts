import { ApiProperty } from '@nestjs/swagger';

/** Версионированные лимиты инструмента в публичном REST-контракте. */
export class InstrumentLimitsResponseDto {
  @ApiProperty({ example: '10', description: 'Точное decimal-значение строкой.' })
  maxOrderQuantity!: string;

  @ApiProperty({ example: 100 })
  maxOpenOrders!: number;

  @ApiProperty({ example: '1000000' })
  maxNotional!: string;
}

/** Неизменяемая версия торговых правил, выбранная по effectiveAt. */
export class InstrumentRulesResponseDto {
  @ApiProperty({ example: 'rules-v1' })
  version!: string;

  @ApiProperty({ example: '2026-01-01T00:00:00.000Z', format: 'date-time' })
  effectiveAt!: string;

  @ApiProperty({ example: '0.5' })
  tickSize!: string;

  @ApiProperty({ example: '0.001' })
  lotSize!: string;

  @ApiProperty({ example: '0.001' })
  minQuantity!: string;

  @ApiProperty({ example: '10' })
  maxQuantity!: string;

  @ApiProperty({ example: '100' })
  minPrice!: string;

  @ApiProperty({ example: '100000' })
  maxPrice!: string;

  @ApiProperty({ example: 'fees-v1' })
  feePolicyVersion!: string;

  @ApiProperty({ type: InstrumentLimitsResponseDto })
  limits!: InstrumentLimitsResponseDto;
}

/** Публичное представление торговой пары без методов domain aggregate. */
export class InstrumentResponseDto {
  @ApiProperty({ example: 'BTC-USD' })
  id!: string;

  @ApiProperty({ example: 'BTC' })
  baseAssetId!: string;

  @ApiProperty({ example: 'USD' })
  quoteAssetId!: string;

  @ApiProperty({ enum: ['ACTIVE', 'PAUSED'], example: 'ACTIVE' })
  status!: 'ACTIVE' | 'PAUSED';

  @ApiProperty({ type: [InstrumentRulesResponseDto] })
  rules!: InstrumentRulesResponseDto[];
}

/** Ограниченная страница каталога; cursor — индекс следующего snapshot. */
export class InstrumentPageResponseDto {
  @ApiProperty({ type: [InstrumentResponseDto] })
  items!: InstrumentResponseDto[];

  @ApiProperty({ nullable: true, example: '50' })
  nextCursor!: string | null;
}
