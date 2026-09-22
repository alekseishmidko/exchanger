import type { AccountId, AssetId, Decimal, OperationId } from '../../shared-kernel';
import type { Account, Asset } from '../domain/asset-account';
import type { Balance } from '../domain/balance';
import type { OperationResult } from '../domain/ledger';

/**
 * Стабильный DI-токен transactional ledger boundary.
 *
 * Application service внедряет этот token и не знает, находится состояние в
 * памяти или PostgreSQL. Замена adapter не меняет денежных команд и инвариантов.
 */
export const LEDGER_PORT = Symbol('LEDGER_PORT');

/**
 * Порт денежных операций ledger.
 *
 * Контракт выражает бизнес-операции, а не SQL CRUD. Production adapter обязан
 * фиксировать balance mutation, сбалансированный posting set и operationId в
 * одной PostgreSQL-транзакции. Повтор operationId возвращает прежний результат;
 * частично committed debit без соответствующего credit невозможен.
 *
 * @example `ledger.reserve(operationId, accountId, assetId, Decimal.from('10'))`.
 */
export interface LedgerPort {
  /**
   * Регистрирует immutable описание asset.
   * @param asset Проверенный asset с кодом и decimal scale.
   */
  registerAsset(asset: Asset): void | Promise<void>;
  /**
   * Регистрирует account с проверенным owner.
   * @param account Account, прошедший application authorization.
   */
  registerAccount(account: Account): void | Promise<void>;
  /** Возвращает immutable owner binding либо `null`, если account отсутствует. */
  getAccountOwner(accountId: AccountId): string | null | Promise<string | null>;
  /**
   * Создаёт нулевой balance для пары account/asset.
   * @param accountId Typed account ID.
   * @param assetId Typed asset ID.
   */
  openBalance(accountId: AccountId, assetId: AssetId): void | Promise<void>;
  /** Возвращает assets открытых балансов в детерминированном порядке. */
  listBalanceAssetIds(accountId: AccountId): readonly AssetId[] | Promise<readonly AssetId[]>;
  /**
   * Возвращает immutable balance snapshot.
   * @returns Точные available/reserved decimal values без floating point.
   */
  getBalance(accountId: AccountId, assetId: AssetId): Balance | Promise<Balance>;
  /**
   * Идемпотентно зачисляет available средства.
   * Повтор `id` возвращает исходный posting result без второго начисления.
   */
  credit(
    id: OperationId,
    account: AccountId,
    asset: AssetId,
    amount: Decimal,
  ): OperationResult | Promise<OperationResult>;
  /**
   * Идемпотентно списывает available средства.
   * Операция отклоняется до мутации, если available станет отрицательным.
   */
  debit(
    id: OperationId,
    account: AccountId,
    asset: AssetId,
    amount: Decimal,
  ): OperationResult | Promise<OperationResult>;
  /**
   * Атомарно переносит available в reserved.
   * Суммарный balance не меняется, а reserved не превышает total.
   */
  reserve(
    id: OperationId,
    account: AccountId,
    asset: AssetId,
    amount: Decimal,
  ): OperationResult | Promise<OperationResult>;
  /**
   * Атомарно возвращает reserved в available.
   * Исходная reservation не удаляется и остаётся доступна audit/reconciliation.
   */
  release(
    id: OperationId,
    account: AccountId,
    asset: AssetId,
    amount: Decimal,
  ): OperationResult | Promise<OperationResult>;
  /**
   * Атомарно переводит reserved источника в available получателя.
   *
   * @param id Идемпотентный operation ID posting set.
   * @param debit Счёт, с которого уменьшается reserved.
   * @param credit Счёт, на котором увеличивается available.
   * @param asset Переводимый asset.
   * @param amount Положительная точная decimal-сумма.
   * @returns Ссылки на полный сбалансированный posting set.
   */
  settleReservedTransfer(
    id: OperationId,
    debit: AccountId,
    credit: AccountId,
    asset: AssetId,
    amount: Decimal,
  ): OperationResult | Promise<OperationResult>;
  /** Создаёт обратный posting effect, не удаляя исходную operation. */
  compensate(
    compensationId: OperationId,
    originalOperationId: OperationId,
  ): OperationResult | Promise<OperationResult>;
}
