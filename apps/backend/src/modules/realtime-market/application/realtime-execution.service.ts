import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { RealtimeExecution, RealtimeOrderCommand } from '@exchange/contracts';
import { createHash } from 'node:crypto';
import { LEDGER_PORT, type LedgerPort } from '../../ledger';
import { MetricsService } from '../../observability';
import { createId, Decimal } from '../../shared-kernel';
import { ExactLastExecutionPricePolicy } from '../domain/execution-price.policy';
import { QUOTE_STORE_PORT, type QuoteStorePort } from '../ports/quote-store.port';
import { REALTIME_CATALOG_PORT, type RealtimeCatalogPort } from '../ports/realtime-catalog.port';
import {
  REALTIME_EXECUTION_REPOSITORY,
  type RealtimeExecutionRepositoryPort,
} from '../ports/realtime-execution.port';
import { RealtimeMarketHub } from './realtime-market-hub';

@Injectable()
export class RealtimeExecutionService {
  private readonly policy = new ExactLastExecutionPricePolicy();

  constructor(
    private readonly config: ConfigService,
    @Inject(REALTIME_EXECUTION_REPOSITORY)
    private readonly repository: RealtimeExecutionRepositoryPort,
    @Inject(REALTIME_CATALOG_PORT) private readonly catalog: RealtimeCatalogPort,
    @Inject(QUOTE_STORE_PORT) private readonly quotes: QuoteStorePort,
    @Inject(LEDGER_PORT) private readonly ledger: LedgerPort,
    private readonly hub: RealtimeMarketHub,
    private readonly metrics: MetricsService,
  ) {}

  async execute(
    principal: Readonly<{ keyId: string; userId: string }>,
    key: string,
    command: RealtimeOrderCommand,
  ): Promise<RealtimeExecution> {
    const replay = await this.repository.findReplay(principal.keyId, key, command);
    if (replay) return replay;
    if (!['true', '1'].includes(this.config.get('REALTIME_EXECUTION_ENABLED', 'false')))
      throw new Error('REALTIME_EXECUTION_DISABLED');
    if (await this.repository.isPaused()) throw new Error('REALTIME_EXECUTION_PAUSED');
    const instrument = await this.catalog.get(command.instrumentId);
    if (
      !instrument ||
      instrument.status !== 'ACTIVE' ||
      !instrument.priceEnabled ||
      !instrument.tradeEnabled
    )
      throw new Error('REALTIME_INSTRUMENT_NOT_TRADABLE');
    const accountId = createId<'AccountId'>(command.accountId);
    if ((await this.ledger.getAccountOwner(accountId)) !== principal.userId)
      throw new Error('REALTIME_ACCOUNT_FORBIDDEN');
    const quote = await this.quotes.getLatest(command.instrumentId);
    const priced = this.policy.resolve(quote, command.expectedQuoteId, new Date());
    const quantity = Decimal.from(command.quantity);
    if (quantity.isZero() || quantity.isNegative()) throw new Error('REALTIME_QUANTITY_INVALID');
    const price = Decimal.from(priced.price);
    const notional = quantity.multiply(price);
    const feeRate = Decimal.from(this.config.get('REALTIME_EXECUTION_FEE_RATE', '0'));
    const fee = notional.multiply(feeRate).round(18);
    const createdAt = new Date().toISOString();
    const result: RealtimeExecution = {
      commandId: command.commandId,
      orderId: command.orderId,
      executionId: `rt-exec:${createHash('sha256').update(command.orderId).digest('hex').slice(0, 24)}`,
      accountId: command.accountId,
      instrumentId: command.instrumentId,
      side: command.side,
      quantity: quantity.toString(),
      price: price.toString(),
      notional: notional.toString(),
      fee: fee.toString(),
      quoteId: priced.quote.quoteId,
      priceSource: 'TwelveData',
      priceType: 'LAST',
      providerTimestamp: priced.quote.providerTimestamp,
      receivedAt: priced.quote.receivedAt,
      status: 'FILLED',
      createdAt,
    };
    const liquidityId = this.config.getOrThrow<string>('REALTIME_LIQUIDITY_ACCOUNT_ID');
    await this.ensureLiquidity(
      command,
      instrument.baseAssetId,
      instrument.quoteAssetId,
      notional,
      fee,
      liquidityId,
    );
    const committed = await this.repository.commit(
      principal.keyId,
      key,
      command,
      {
        ownerId: principal.userId,
        command,
        instrument,
        quote: priced.quote,
        result,
        liquidityAccountId: liquidityId,
      },
      () =>
        this.settle(
          command,
          instrument.baseAssetId,
          instrument.quoteAssetId,
          notional,
          fee,
          liquidityId,
        ),
    );
    await this.hub.publishExecution(principal.userId, committed).catch(() => undefined);
    this.metrics.observeRealtimeExecution('filled');
    return committed;
  }

  list(ownerId: string, limit: number, cursor: number) {
    return this.repository.list(ownerId, limit, cursor);
  }
  get(ownerId: string, orderId: string) {
    return this.repository.get(ownerId, orderId);
  }

  private async ensureLiquidity(
    command: RealtimeOrderCommand,
    base: string,
    quote: string,
    notional: Decimal,
    fee: Decimal,
    liquidity: string,
  ): Promise<void> {
    const user = createId<'AccountId'>(command.accountId);
    const system = createId<'AccountId'>(liquidity);
    const baseId = createId<'AssetId'>(base);
    const quoteId = createId<'AssetId'>(quote);
    const feeAccount = createId<'AccountId'>(this.config.get('REALTIME_FEE_ACCOUNT_ID', liquidity));
    const userDebit = command.side === 'BUY' ? notional.add(fee) : Decimal.from(command.quantity);
    const systemDebit = command.side === 'BUY' ? Decimal.from(command.quantity) : notional;
    const [userBase, userQuote, systemBase, systemQuote] = await Promise.all([
      this.ledger.getBalance(user, baseId),
      this.ledger.getBalance(user, quoteId),
      this.ledger.getBalance(system, baseId),
      this.ledger.getBalance(system, quoteId),
      ...(fee.isZero() ? [] : [this.ledger.getBalance(feeAccount, quoteId)]),
    ]);
    const userBalance = command.side === 'BUY' ? userQuote : userBase;
    const systemBalance = command.side === 'BUY' ? systemBase : systemQuote;
    if (userBalance.available.compare(userDebit) < 0) throw new Error('REALTIME_FUNDS_UNAVAILABLE');
    if (systemBalance.available.compare(systemDebit) < 0) {
      this.metrics.setRealtimeLiquidityAvailable(false);
      throw new Error('LIQUIDITY_UNAVAILABLE');
    }
    this.metrics.setRealtimeLiquidityAvailable(true);
  }

  private async settle(
    command: RealtimeOrderCommand,
    base: string,
    quote: string,
    notional: Decimal,
    fee: Decimal,
    liquidity: string,
  ): Promise<void> {
    const user = createId<'AccountId'>(command.accountId);
    const system = createId<'AccountId'>(liquidity);
    const feeAccount = createId<'AccountId'>(this.config.get('REALTIME_FEE_ACCOUNT_ID', liquidity));
    const baseId = createId<'AssetId'>(base);
    const quoteId = createId<'AssetId'>(quote);
    const quantity = Decimal.from(command.quantity);
    if (command.side === 'BUY') {
      await this.ledger.transferAvailable(
        createId<'OperationId'>(`rt:${command.orderId}:notional`),
        user,
        system,
        quoteId,
        notional.add(fee),
      );
      await this.ledger.transferAvailable(
        createId<'OperationId'>(`rt:${command.orderId}:asset`),
        system,
        user,
        baseId,
        quantity,
      );
    } else {
      await this.ledger.transferAvailable(
        createId<'OperationId'>(`rt:${command.orderId}:asset`),
        user,
        system,
        baseId,
        quantity,
      );
      await this.ledger.transferAvailable(
        createId<'OperationId'>(`rt:${command.orderId}:notional`),
        system,
        user,
        quoteId,
        notional.subtract(fee),
      );
    }
    if (!fee.isZero())
      await this.ledger.transferAvailable(
        createId<'OperationId'>(`rt:${command.orderId}:fee`),
        system,
        feeAccount,
        quoteId,
        fee,
      );
  }
}
