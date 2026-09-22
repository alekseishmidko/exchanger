import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { AUDIT_LOG_PORT, AuditActor, AuditLogPort } from '../../audit';
import { LOG_EVENTS, StructuredLogger } from '../../observability';
import { Decimal, createId } from '../../shared-kernel';
import { Account, Asset } from '../domain/asset-account';
import { LEDGER_PORT, LedgerPort } from '../ports/ledger.port';

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
  private readonly commandAudit: LedgerCommandAudit[] = [];

  /**
   * Создаёт ledger application boundary на заменяемых infrastructure ports.
   *
   * `ledger` отвечает за денежные инварианты и идемпотентные posting sets,
   * `audit` — за неизменяемый административный след. Operational logger сообщает
   * outcome, но не получает суммы или полные финансовые payloads.
   *
   * @param ledger Transactional порт денежных операций.
   * @param audit Append-only порт business audit.
   * @param logger Необязательный redacting operational logger.
   */
  constructor(
    @Inject(LEDGER_PORT) private readonly ledger: LedgerPort,
    @Inject(AUDIT_LOG_PORT) private readonly audit: AuditLogPort,
    @Optional() @Inject(StructuredLogger) private readonly logger?: StructuredLogger,
  ) {}

  /**
   * Регистрирует аккаунт и набор нулевых балансов одной application-командой.
   * Все конфликты проверяются до мутации domain state.
   */
  async createAccount(
    commandId: string,
    accountId: string,
    ownerId: string,
    balances: readonly OpenBalanceDefinition[],
    actorId: string,
  ): Promise<AccountSnapshot> {
    if (await this.ledger.getAccountOwner(createId<'AccountId'>(accountId))) {
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
      try {
        await this.ledger.registerAsset(
          new Asset(createId<'AssetId'>(definition.assetId), definition.code, definition.scale),
        );
      } catch {
        throw new ConflictException({
          code: 'ASSET_DEFINITION_CONFLICT',
          message: 'Asset definition conflicts with the catalog',
        });
      }
    }
    await this.ledger.registerAccount(new Account(createId<'AccountId'>(accountId), ownerId));
    for (const { assetId } of balances) {
      await this.ledger.openBalance(createId<'AccountId'>(accountId), createId<'AssetId'>(assetId));
    }
    const snapshot = { accountId, ownerId } as const;
    this.commandAudit.push({ commandId, actorId, action: 'CREATE_ACCOUNT', targetId: accountId });
    this.logger?.info('ledger', LOG_EVENTS.LEDGER_COMMAND_APPLIED, {
      commandId,
      metadata: { action: 'CREATE_ACCOUNT', balanceCount: balances.length },
    });
    return snapshot;
  }

  /** Возвращает account snapshot для последующей object-level authorization. */
  async getAccount(accountId: string): Promise<AccountSnapshot> {
    const ownerId = await this.ledger.getAccountOwner(createId<'AccountId'>(accountId));
    if (!ownerId) {
      throw new NotFoundException({ code: 'ACCOUNT_NOT_FOUND', message: 'Account was not found' });
    }
    return { accountId, ownerId };
  }

  /** Возвращает все балансы аккаунта в детерминированном порядке assetId. */
  async getBalances(accountId: string): Promise<readonly BalanceSnapshot[]> {
    await this.getAccount(accountId);
    const assets = await this.ledger.listBalanceAssetIds(createId<'AccountId'>(accountId));
    return Promise.all(assets.map((assetId) => this.getBalance(accountId, assetId)));
  }

  /** Преобразует immutable Balance value object в decimal-string snapshot. */
  async getBalance(accountId: string, assetId: string): Promise<BalanceSnapshot> {
    await this.getAccount(accountId);
    let balance;
    try {
      balance = await this.ledger.getBalance(
        createId<'AccountId'>(accountId),
        createId<'AssetId'>(assetId),
      );
    } catch {
      throw new NotFoundException({ code: 'BALANCE_NOT_FOUND', message: 'Balance was not found' });
    }
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
  async changeBalance(
    commandId: string,
    accountId: string,
    assetId: string,
    action: 'CREDIT' | 'DEBIT' | 'RESERVE' | 'RELEASE',
    amount: string,
    actor: AuditActor,
  ): Promise<BalanceSnapshot> {
    const typedAccountId = createId<'AccountId'>(accountId);
    const typedAssetId = createId<'AssetId'>(assetId);
    const operationId = createId<'OperationId'>(commandId);
    const decimal = Decimal.from(amount);
    await this.getBalance(accountId, assetId);
    try {
      if (action === 'CREDIT')
        await this.ledger.credit(operationId, typedAccountId, typedAssetId, decimal);
      if (action === 'DEBIT')
        await this.ledger.debit(operationId, typedAccountId, typedAssetId, decimal);
      if (action === 'RESERVE')
        await this.ledger.reserve(operationId, typedAccountId, typedAssetId, decimal);
      if (action === 'RELEASE')
        await this.ledger.release(operationId, typedAccountId, typedAssetId, decimal);
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
    await this.audit.append(
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
