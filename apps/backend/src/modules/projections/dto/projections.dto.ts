import { ApiProperty } from '@nestjs/swagger';

/** Read-model заявки, построенная только из упорядоченных domain events. */
export class OrderViewResponseDto {
  @ApiProperty({ example: 'order-1' }) orderId!: string;
  @ApiProperty({ example: 'user-1' }) userId!: string;
  @ApiProperty({ example: 'account-1' }) accountId!: string;
  @ApiProperty({ example: 'BTC-USD' }) instrumentId!: string;
  @ApiProperty({ enum: ['ACCEPTED', 'REJECTED', 'CANCELLED'] })
  status!: 'ACCEPTED' | 'REJECTED' | 'CANCELLED';
  @ApiProperty({ example: '0.25' }) remainingQuantity!: string;
  @ApiProperty({ example: 42 }) updatedAtSequence!: number;
}

/** Read-model сделки; price и quantity сохраняют точность decimal strings. */
export class TradeViewResponseDto {
  @ApiProperty({ example: 'trade-1' }) tradeId!: string;
  @ApiProperty({ example: 'BTC-USD' }) instrumentId!: string;
  @ApiProperty({ type: [String], example: ['maker-user', 'taker-user'] })
  readonly userIds!: readonly string[];
  @ApiProperty({ example: 'maker-order-1' }) makerOrderId!: string;
  @ApiProperty({ example: 'taker-order-1' }) takerOrderId!: string;
  @ApiProperty({ example: '0.25' }) quantity!: string;
  @ApiProperty({ example: '60000.5' }) price!: string;
  @ApiProperty({ example: 43 }) sequence!: number;
}

/** Read-model баланса из SettlementApplied, изолированная по owner principal. */
export class BalanceViewResponseDto {
  @ApiProperty({ example: 'account-1' }) accountId!: string;
  @ApiProperty({ example: 'USD' }) assetId!: string;
  @ApiProperty({ example: '100.25' }) available!: string;
  @ApiProperty({ example: '20' }) reserved!: string;
  @ApiProperty({ example: 44 }) sequence!: number;
}

/** Cursor-страница истории заявок. */
export class OrderProjectionPageDto {
  @ApiProperty({ type: [OrderViewResponseDto] }) readonly items!: readonly OrderViewResponseDto[];
  @ApiProperty({ nullable: true, example: '50' }) nextCursor!: string | null;
}

/** Cursor-страница истории сделок. */
export class TradeProjectionPageDto {
  @ApiProperty({ type: [TradeViewResponseDto] }) readonly items!: readonly TradeViewResponseDto[];
  @ApiProperty({ nullable: true, example: '50' }) nextCursor!: string | null;
}

/** Cursor-страница проекций баланса. */
export class BalanceProjectionPageDto {
  @ApiProperty({ type: [BalanceViewResponseDto] })
  readonly items!: readonly BalanceViewResponseDto[];
  @ApiProperty({ nullable: true, example: '50' }) nextCursor!: string | null;
}

/** Метрики версии, high watermark и отставания projection consumer. */
export class ProjectionMetricsResponseDto {
  @ApiProperty({ example: 1 }) schemaVersion!: number;
  @ApiProperty({ example: 100 }) appliedSequence!: number;
  @ApiProperty({ example: 103 }) sourceSequence!: number;
  @ApiProperty({ example: 3 }) lag!: number;
}
