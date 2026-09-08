import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/** Полный набор decimal trading rules, передаваемый административной командой. */
export class AdminInstrumentRulesDto {
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

  @ApiProperty({ example: '10' })
  maxOrderQuantity!: string;

  @ApiProperty({ example: 100 })
  maxOpenOrders!: number;

  @ApiProperty({ example: '1000000' })
  maxNotional!: string;
}

/**
 * Команда создания инструмента либо добавления следующей версии правил.
 *
 * Для `CREATE` обязательны base/quote assets. Для `ADD_RULES` они запрещены,
 * чтобы новая версия не могла незаметно изменить identity торговой пары.
 */
export class ConfigureInstrumentRequestDto {
  @ApiProperty({ example: 'admin-command-1' })
  commandId!: string;

  @ApiProperty({ enum: ['CREATE', 'ADD_RULES'], example: 'CREATE' })
  mode!: 'CREATE' | 'ADD_RULES';

  @ApiProperty({ example: 'BTC-USD' })
  instrumentId!: string;

  @ApiPropertyOptional({ example: 'BTC' })
  baseAssetId?: string;

  @ApiPropertyOptional({ example: 'USD' })
  quoteAssetId?: string;

  @ApiProperty({ type: AdminInstrumentRulesDto })
  rules!: AdminInstrumentRulesDto;
}

/** Команда контролируемого изменения lifecycle торгового инструмента. */
export class InstrumentStatusRequestDto {
  @ApiProperty({ example: 'admin-command-2' })
  commandId!: string;

  @ApiProperty({ enum: ['ACTIVE', 'PAUSED'], example: 'ACTIVE' })
  status!: 'ACTIVE' | 'PAUSED';
}

/** Команда freeze/unfreeze пользователя либо ledger-аккаунта. */
export class FreezeRequestDto {
  @ApiProperty({ example: 'admin-command-3' })
  commandId!: string;

  @ApiProperty({ enum: ['USER', 'ACCOUNT'], example: 'ACCOUNT' })
  targetType!: 'USER' | 'ACCOUNT';

  @ApiProperty({ example: 'account-1' })
  targetId!: string;

  @ApiProperty({ enum: ['FREEZE', 'UNFREEZE'], example: 'FREEZE' })
  action!: 'FREEZE' | 'UNFREEZE';
}

/** Команда emergency stop/resume для инструмента или глобального target `*`. */
export class CircuitBreakerRequestDto {
  @ApiProperty({ example: 'admin-command-4' })
  commandId!: string;

  @ApiProperty({ example: 'BTC-USD', description: 'Instrument ID либо * для всей торговли.' })
  targetId!: string;

  @ApiProperty({ enum: ['STOP', 'RESUME'], example: 'STOP' })
  action!: 'STOP' | 'RESUME';
}

/** Новая immutable версия maker/taker fee policy. */
export class FeePolicyRequestDto {
  @ApiProperty({ example: 'admin-command-5' })
  commandId!: string;

  @ApiProperty({ example: 'fee-v2' })
  version!: string;

  @ApiProperty({ example: '2026-02-01T00:00:00.000Z', format: 'date-time' })
  effectiveAt!: string;

  @ApiProperty({ example: '0.001' })
  makerRate!: string;

  @ApiProperty({ example: '0.002' })
  takerRate!: string;
}

/** Новая immutable версия лимитов admission policy. */
export class RiskPolicyRequestDto {
  @ApiProperty({ example: 'admin-command-6' })
  commandId!: string;

  @ApiProperty({ example: 'risk-v2' })
  version!: string;

  @ApiProperty({ example: '2026-02-01T00:00:00.000Z', format: 'date-time' })
  effectiveAt!: string;

  @ApiProperty({ example: '100000' })
  maxOrderNotional!: string;

  @ApiProperty({ example: 100 })
  maxOpenOrders!: number;
}

/** Публичный результат административной команды и состояния dual control. */
export class AdminCommandResponseDto {
  @ApiProperty({ example: 'admin-command-1' })
  commandId!: string;

  @ApiProperty({ example: 'CONFIGURE_INSTRUMENT' })
  actionType!: string;

  @ApiProperty({ example: 'BTC-USD' })
  targetId!: string;

  @ApiProperty({ enum: ['PENDING_APPROVAL', 'APPLIED'] })
  status!: 'PENDING_APPROVAL' | 'APPLIED';

  @ApiProperty({ type: [String], example: ['admin-1', 'admin-2'] })
  approvedBy!: string[];
}

/** Безопасная операционная сводка reconciliation без содержимого audit records. */
export class ReconciliationResponseDto {
  @ApiProperty() auditIntegrity!: boolean;
  @ApiProperty() pendingApprovals!: number;
  @ApiProperty() frozenUsers!: number;
  @ApiProperty() frozenAccounts!: number;
  @ApiProperty({ type: [String] }) readonly stoppedTargets!: readonly string[];
  @ApiProperty({ type: [Object] }) readonly instrumentStatuses!: readonly {
    instrumentId: string;
    status: string;
  }[];
  @ApiProperty({ type: [String] }) readonly feePolicyVersions!: readonly string[];
  @ApiProperty({ type: [String] }) readonly riskPolicyVersions!: readonly string[];
}
