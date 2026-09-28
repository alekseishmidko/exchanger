import { ApiProperty } from '@nestjs/swagger';

export class RealtimeInstrumentResponseDto {
  @ApiProperty({ example: 'td:crypto:coinbase:BTC-USD' }) id!: string;
  @ApiProperty({ example: 'BTC/USD' }) displaySymbol!: string;
  @ApiProperty({ example: 'BTC/USD' }) providerSymbol!: string;
  @ApiProperty({ enum: ['CRYPTO', 'FOREX', 'STOCK', 'COMMODITY'] }) assetClass!: string;
  @ApiProperty({ nullable: true, example: 'Coinbase' }) exchange!: string | null;
  @ApiProperty({ nullable: true, example: null }) micCode!: string | null;
  @ApiProperty({ example: 'BTC' }) baseAssetId!: string;
  @ApiProperty({ example: 'USD' }) quoteAssetId!: string;
  @ApiProperty() priceEnabled!: boolean;
  @ApiProperty() tradeEnabled!: boolean;
  @ApiProperty({ enum: ['ACTIVE', 'INACTIVE'] }) status!: string;
  @ApiProperty({ enum: ['TwelveData'] }) source!: 'TwelveData';
  @ApiProperty({ format: 'date-time' }) syncedAt!: string;
}

export class RealtimeInstrumentPageResponseDto {
  @ApiProperty({ type: [RealtimeInstrumentResponseDto] })
  items!: readonly RealtimeInstrumentResponseDto[];
  @ApiProperty({ nullable: true }) nextCursor!: string | null;
}

export class RealtimeMarketStatusResponseDto {
  @ApiProperty({ enum: ['DISABLED', 'FOLLOWER', 'CONNECTING', 'CONNECTED', 'DEGRADED'] })
  state!: string;
  @ApiProperty({ nullable: true, format: 'date-time' }) lastMessageAt!: string | null;
  @ApiProperty({ nullable: true, format: 'date-time' }) lastCatalogSyncAt!: string | null;
  @ApiProperty() reconnects!: number;
}

export class RealtimeQuoteSnapshotResponseDto {
  @ApiProperty() instrumentId!: string;
  @ApiProperty({ enum: ['FRESH', 'STALE', 'UNAVAILABLE'] }) status!: string;
  @ApiProperty({ nullable: true }) quote!: Record<string, unknown> | null;
}

export class RealtimeQuotePageResponseDto {
  @ApiProperty({ type: [RealtimeQuoteSnapshotResponseDto] })
  items!: readonly RealtimeQuoteSnapshotResponseDto[];
}

export class RealtimeExecutionResponseDto {
  @ApiProperty() commandId!: string;
  @ApiProperty() orderId!: string;
  @ApiProperty() executionId!: string;
  @ApiProperty() accountId!: string;
  @ApiProperty() instrumentId!: string;
  @ApiProperty({ enum: ['BUY', 'SELL'] }) side!: string;
  @ApiProperty() quantity!: string;
  @ApiProperty() price!: string;
  @ApiProperty() notional!: string;
  @ApiProperty() fee!: string;
  @ApiProperty() quoteId!: string;
  @ApiProperty({ enum: ['TwelveData'] }) priceSource!: string;
  @ApiProperty({ enum: ['LAST'] }) priceType!: string;
  @ApiProperty({ format: 'date-time' }) providerTimestamp!: string;
  @ApiProperty({ format: 'date-time' }) receivedAt!: string;
  @ApiProperty({ enum: ['FILLED'] }) status!: string;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
}

export class RealtimeExecutionPageResponseDto {
  @ApiProperty({ type: [RealtimeExecutionResponseDto] })
  items!: readonly RealtimeExecutionResponseDto[];
  @ApiProperty({ nullable: true }) nextCursor!: string | null;
}
