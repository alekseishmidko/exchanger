import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { GatewayOrderType, GatewaySide, GatewayTimeInForce } from './gateway.types';

/**
 * Документирует внешний запрос размещения заявки.
 *
 * Класс используется Swagger только как описание wire-контракта. Фактическую
 * проверку выполняет `placeOrderDtoSchema`: это не позволяет документации и
 * runtime-валидации незаметно подменять друг друга.
 *
 * @example
 * ```json
 * {"commandId":"cmd-1","orderId":"order-1","accountId":"account-1","instrumentId":"BTC-USD","clientOrderId":"client-1","side":"BUY","orderType":"LIMIT","quantity":"0.25","limitPrice":"60000.00","timeInForce":"GTC"}
 * ```
 */
export class PlaceOrderRequestDto {
  @ApiProperty({ example: 'cmd-1', maxLength: 128 })
  commandId!: string;

  @ApiProperty({ example: 'order-1', maxLength: 128 })
  orderId!: string;

  @ApiProperty({ example: 'account-1', maxLength: 128 })
  accountId!: string;

  @ApiProperty({ example: 'BTC-USD', maxLength: 128 })
  instrumentId!: string;

  @ApiProperty({ example: 'client-order-1', maxLength: 128 })
  clientOrderId!: string;

  @ApiProperty({ enum: ['BUY', 'SELL'], example: 'BUY' })
  side!: GatewaySide;

  @ApiProperty({ enum: ['LIMIT', 'MARKET'], example: 'LIMIT' })
  orderType!: GatewayOrderType;

  @ApiProperty({ example: '0.25', pattern: '^(0|[1-9]\\d*)(\\.\\d+)?$' })
  quantity!: string;

  @ApiPropertyOptional({
    example: '60000.00',
    nullable: true,
    description: 'Обязательно для LIMIT и запрещено для MARKET.',
    pattern: '^(0|[1-9]\\d*)(\\.\\d+)?$',
  })
  limitPrice?: string | null;

  @ApiProperty({ enum: ['GTC', 'IOC', 'FOK'], example: 'GTC' })
  timeInForce!: GatewayTimeInForce;
}

/** Описывает тело команды отмены; владельца accountId дополнительно проверяет guard. */
export class CancelOrderRequestDto {
  @ApiProperty({ example: 'cmd-cancel-1', maxLength: 128 })
  commandId!: string;

  @ApiProperty({ example: 'order-1', maxLength: 128 })
  orderId!: string;

  @ApiProperty({ example: 'account-1', maxLength: 128 })
  accountId!: string;

  @ApiProperty({ example: 'BTC-USD', maxLength: 128 })
  instrumentId!: string;
}

/** Безопасный ответ command API без внутренних данных ledger и matching engine. */
export class GatewayCommandResponseDto {
  @ApiProperty({ example: 'cmd-1' })
  commandId!: string;

  @ApiProperty({ example: 'order-1' })
  orderId!: string;

  @ApiProperty({ enum: ['ACCEPTED', 'CANCEL_ACCEPTED'], example: 'ACCEPTED' })
  status!: 'ACCEPTED' | 'CANCEL_ACCEPTED';
}

/** Страница истории заявок с непрозрачным курсором следующей страницы. */
export class GatewayOrderPageResponseDto {
  @ApiProperty({ type: [GatewayCommandResponseDto] })
  items!: GatewayCommandResponseDto[];

  @ApiProperty({ nullable: true, example: '50' })
  nextCursor!: string | null;
}
