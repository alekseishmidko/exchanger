import { ApiProperty } from '@nestjs/swagger';

/** Asset definition для открытия нулевого баланса. */
export class OpenBalanceRequestDto {
  @ApiProperty({ example: 'USD' }) assetId!: string;
  @ApiProperty({ example: 'USD', pattern: '^[A-Z0-9-]+$' }) code!: string;
  @ApiProperty({ example: 2, minimum: 0, maximum: 18 }) scale!: number;
}

/** Команда создания аккаунта; ownerId сверяется с authenticated principal. */
export class CreateAccountRequestDto {
  @ApiProperty({ example: 'account-1' }) commandId!: string;
  @ApiProperty({ example: 'account-1' }) accountId!: string;
  @ApiProperty({ example: 'user-1' }) ownerId!: string;
  @ApiProperty({ type: [OpenBalanceRequestDto] }) balances!: OpenBalanceRequestDto[];
}

/** Публичное описание аккаунта без внутренних ledger aggregates. */
export class AccountResponseDto {
  @ApiProperty({ example: 'account-1' }) accountId!: string;
  @ApiProperty({ example: 'user-1' }) ownerId!: string;
}

/** Точное состояние одного баланса; decimal values всегда являются строками. */
export class BalanceResponseDto {
  @ApiProperty({ example: 'account-1' }) accountId!: string;
  @ApiProperty({ example: 'USD' }) assetId!: string;
  @ApiProperty({ example: '100.25' }) available!: string;
  @ApiProperty({ example: '20' }) reserved!: string;
}

/** Список балансов одного авторизованного аккаунта. */
export class AccountBalancesResponseDto {
  @ApiProperty({ type: [BalanceResponseDto] }) items!: BalanceResponseDto[];
}

/** Авторизованная административная команда изменения balance state. */
export class ChangeBalanceRequestDto {
  @ApiProperty({ example: 'ledger-command-1' }) commandId!: string;
  @ApiProperty({ enum: ['CREDIT', 'DEBIT', 'RESERVE', 'RELEASE'], example: 'CREDIT' })
  action!: 'CREDIT' | 'DEBIT' | 'RESERVE' | 'RELEASE';
  @ApiProperty({ example: '100.25', description: 'Положительное decimal-значение строкой.' })
  amount!: string;
}
