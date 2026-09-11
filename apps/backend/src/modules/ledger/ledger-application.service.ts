import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { AuditActor, AuditLog } from '../audit';
import { Decimal, createId } from '../shared-kernel';
import { Account, Asset } from './asset-account';
import { Ledger } from './ledger';
import { LOG_EVENTS, StructuredLogger } from '../observability';

/** Описание asset при открытии нулевого баланса нового аккаунта. */
export type OpenBalanceDefinition = Readonly<{ assetId: string; code: string; scale: number }>;

/** Публичный snapshot ledger-аккаунта, не содержащий domain methods. */
export type AccountSnapshot = Readonly<{ accountId: string; ownerId: string }>;

/** Публичный snapshot точного available/reserved баланса. */
export type BalanceSnapshot = Readonly<{
  accountId: string;
  assetId: string;
  available: string;
  reserved: string;
}>;

/** Метаданные application-команды, достаточные для трассировки write-операции. */
export type LedgerCommandAudit = Readonly<{
  commandId: string;
  actorId: string;
  action: string;
  targetId: string;
}>;

/**
 * Application boundary между REST API и domain aggregate `Ledger`.
 *
 * Сервис принимает простые validated values, создаёт typed IDs/Decimal и только
 * затем вызывает domain methods. Контроллер никогда не получает сам `Ledger`,
 * поэтому провести debit или изменить Balance без авторизованной команды нельзя.
 */
@Injectable()
export class LedgerApplicationService {
  private readonly ledger = new Ledger();
  private readonly accounts = new Map<string, AccountSnapshot>();
  private readonly accountAssets = new Map<string, Set<string>>();
  private readonly assets = new Map<string, OpenBalanceDefinition>();
  private readonly commandAudit: LedgerCommandAudit[] = [];

  constructor(
    private readonly audit: AuditLog,
    @Optional() @Inject(StructuredLogger) private readonly logger?: StructuredLogger,
  ) {}

  /**
   * Регистрирует аккаунт и набор нулевых балансов одной application-командой.
   * Все конфликты проверяются до мутации domain state.
   */
  createAccount(
    commandId: string,
    accountId: string,
    ownerId: string,
    balances: readonly OpenBalanceDefinition[],
    actorId: string,
  ): AccountSnapshot {
    if (this.accounts.has(accountId)) {
      throw new ConflictException({
        code: 'ACCOUNT_ALREADY_EXISTS',
        message: 'Account already exists',
      });
    }
    if (
      balances.length === 0 ||
      new Set(balances.map(({ assetId }) => assetId)).size !== balances.length
    ) {
      throw new BadRequestException({
        code: 'BALANCE_DEFINITION_INVALID',
        message: 'At least one unique balance asset is required',
      });
    }
    for (const definition of balances) {
      const existing = this.assets.get(definition.assetId);
      if (existing && (existing.code !== definition.code || existing.scale !== definition.scale)) {
        throw new ConflictException({
          code: 'ASSET_DEFINITION_CONFLICT',
          message: 'Asset definition conflicts with the catalog',
        });
      }
    }

    for (const definition of balances) {
      if (!this.assets.has(definition.assetId)) {
        this.ledger.registerAsset(
          new Asset(createId<'AssetId'>(definition.assetId), definition.code, definition.scale),
        );
        this.assets.set(definition.assetId, definition);
      }
    }
    this.ledger.registerAccount(new Account(createId<'AccountId'>(accountId), ownerId));
    for (const { assetId } of balances) {
      this.ledger.openBalance(createId<'AccountId'>(accountId), createId<'AssetId'>(assetId));
    }
    const snapshot = { accountId, ownerId } as const;
    this.accounts.set(accountId, snapshot);
    this.accountAssets.set(accountId, new Set(balances.map(({ assetId }) => assetId)));
    this.commandAudit.push({ commandId, actorId, action: 'CREATE_ACCOUNT', targetId: accountId });
    this.logger?.info('ledger', LOG_EVENTS.LEDGER_COMMAND_APPLIED, {
      commandId,
      metadata: { action: 'CREATE_ACCOUNT', balanceCount: balances.length },
    });
    return snapshot;
  }

  /** Возвращает account snapshot для последующей object-level authorization. */
  getAccount(accountId: string): AccountSnapshot {
    const account = this.accounts.get(accountId);
    if (!account) {
      throw new NotFoundException({ code: 'ACCOUNT_NOT_FOUND', message: 'Account was not found' });
    }
    return account;
  }

  /** Возвращает все балансы аккаунта в детерминированном порядке assetId. */
  getBalances(accountId: string): readonly BalanceSnapshot[] {
    this.getAccount(accountId);
    return [...(this.accountAssets.get(accountId) ?? [])]
      .sort()
      .map((assetId) => this.getBalance(accountId, assetId));
  }

  /** Преобразует immutable Balance value object в decimal-string snapshot. */
  getBalance(accountId: string, assetId: string): BalanceSnapshot {
    this.getAccount(accountId);
    if (!this.accountAssets.get(accountId)?.has(assetId)) {
      throw new NotFoundException({ code: 'BALANCE_NOT_FOUND', message: 'Balance was not found' });
    }
    const balance = this.ledger.getBalance(
      createId<'AccountId'>(accountId),
      createId<'AssetId'>(assetId),
    );
    return {
      accountId,
      assetId,
      available: balance.available.toString(),
      reserved: balance.reserved.toString(),
    };
  }

  /**
   * Выполняет одну allow-listed balance-команду и записывает admin audit event.
   * Повтор operationId безопасен за счёт idempotency record внутри Ledger.
   */
  changeBalance(
    commandId: string,
    accountId: string,
    assetId: string,
    action: 'CREDIT' | 'DEBIT' | 'RESERVE' | 'RELEASE',
    amount: string,
    actor: AuditActor,
  ): BalanceSnapshot {
    const typedAccountId = createId<'AccountId'>(accountId);
    const typedAssetId = createId<'AssetId'>(assetId);
    const operationId = createId<'OperationId'>(commandId);
    const decimal = Decimal.from(amount);
    this.getBalance(accountId, assetId);
    try {
      if (action === 'CREDIT')
        this.ledger.credit(operationId, typedAccountId, typedAssetId, decimal);
      if (action === 'DEBIT') this.ledger.debit(operationId, typedAccountId, typedAssetId, decimal);
      if (action === 'RESERVE')
        this.ledger.reserve(operationId, typedAccountId, typedAssetId, decimal);
      if (action === 'RELEASE')
        this.ledger.release(operationId, typedAccountId, typedAssetId, decimal);
    } catch {
      this.logger?.warn('ledger', LOG_EVENTS.LEDGER_COMMAND_REJECTED, {
        commandId,
        metadata: { action, reason: 'INVARIANT_VIOLATION' },
      });
      throw new BadRequestException({
        code: 'BALANCE_COMMAND_REJECTED',
        message: 'Balance command violates ledger invariants',
      });
    }
    this.audit.append(
      actor,
      'ACTION_APPLIED',
      `LEDGER_${action}`,
      commandId,
      `${accountId}:${assetId}`,
      {
        amount,
      },
    );
    this.commandAudit.push({
      commandId,
      actorId: actor.actorId,
      action,
      targetId: `${accountId}:${assetId}`,
    });
    this.logger?.info('ledger', LOG_EVENTS.LEDGER_COMMAND_APPLIED, {
      commandId,
      metadata: { action, assetId },
    });
    return this.getBalance(accountId, assetId);
  }

  /** Возвращает копию метаданных команд для тестов полноты аудита. */
  getCommandAudit(): readonly LedgerCommandAudit[] {
    return [...this.commandAudit];
  }
}
