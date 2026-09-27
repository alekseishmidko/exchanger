import { ConfigService } from '@nestjs/config';
import { Account, Asset, Ledger } from '../ledger';
import { MetricsService } from '../observability';
import { createId, Decimal } from '../shared-kernel';
import { RealtimeExecutionService } from './application/realtime-execution.service';
import type { RealtimeMarketHub } from './application/realtime-market-hub';
import { createReferenceQuote } from './domain/reference-quote';
import { normalizeExternalInstrument } from './domain/external-instrument';
import { MemoryQuoteStore } from './infrastructure/memory-quote.store';
import { MemoryRealtimeCatalog } from './infrastructure/memory-realtime-catalog';
import { MemoryRealtimeExecutionRepository } from './infrastructure/memory-realtime-execution.repository';

describe('RealtimeExecutionService', () => {
  it('settles EXACT_LAST against liquidity and makes retries financially idempotent', async () => {
    const catalog = new MemoryRealtimeCatalog();
    const quotes = new MemoryQuoteStore();
    const repository = new MemoryRealtimeExecutionRepository();
    const ledger = new Ledger();
    const metrics = new MetricsService();
    const publishExecution = jest.fn(() => Promise.resolve());
    const hub = { publishExecution } as unknown as RealtimeMarketHub;
    const config = new ConfigService({
      REALTIME_EXECUTION_ENABLED: 'true',
      REALTIME_LIQUIDITY_ACCOUNT_ID: 'liquidity',
      REALTIME_EXECUTION_FEE_RATE: '0',
    });
    const service = new RealtimeExecutionService(
      config,
      repository,
      catalog,
      quotes,
      ledger,
      hub,
      metrics,
    );
    const instrument = normalizeExternalInstrument(
      {
        providerSymbol: 'BTC/USD',
        displaySymbol: 'BTC/USD',
        assetClass: 'CRYPTO',
        exchange: 'Coinbase',
        micCode: null,
        baseAssetId: 'BTC',
        quoteAssetId: 'USD',
      },
      new Date(),
    );
    await catalog.publishSnapshot('CRYPTO', [instrument], 0.5);
    await catalog.setPriceEnabled(instrument.id, true);
    await catalog.setTradeEnabled(instrument.id, true);
    await repository.setPaused(false);

    const btc = createId<'AssetId'>('BTC');
    const usd = createId<'AssetId'>('USD');
    const user = createId<'AccountId'>('account-1');
    const liquidity = createId<'AccountId'>('liquidity');
    ledger.registerAsset(new Asset(btc, 'BTC', 8));
    ledger.registerAsset(new Asset(usd, 'USD', 2));
    ledger.registerAccount(new Account(user, 'user-1'));
    ledger.registerAccount(new Account(liquidity, 'system'));
    for (const account of [user, liquidity]) {
      ledger.openBalance(account, btc);
      ledger.openBalance(account, usd);
    }
    ledger.credit(createId<'OperationId'>('seed-user-usd'), user, usd, Decimal.from('1000'));
    ledger.credit(
      createId<'OperationId'>('seed-liquidity-btc'),
      liquidity,
      btc,
      Decimal.from('10'),
    );
    const now = new Date();
    const quote = createReferenceQuote(
      {
        instrumentId: instrument.id,
        price: '100',
        providerTimestamp: now,
        receivedAt: now,
      },
      1n,
      60_000,
    );
    const { sequence, ...draft } = quote;
    void sequence;
    const stored = await quotes.putLatest(draft);
    expect(stored).not.toBeNull();
    const command = {
      commandId: 'rt-command-1',
      orderId: 'rt-order-1',
      accountId: user,
      instrumentId: instrument.id,
      side: 'BUY' as const,
      quantity: '2',
      expectedQuoteId: stored!.quoteId,
    };
    const first = await service.execute({ keyId: 'key-1', userId: 'user-1' }, 'idem-1', command);
    const retry = await service.execute({ keyId: 'key-1', userId: 'user-1' }, 'idem-1', command);
    expect(retry).toEqual(first);
    expect(first).toMatchObject({ status: 'FILLED', price: '100', notional: '200' });
    expect(ledger.getBalance(user, usd).available.toString()).toBe('800');
    expect(ledger.getBalance(user, btc).available.toString()).toBe('2');
    expect(publishExecution).toHaveBeenCalledTimes(1);
    await expect(
      service.execute({ keyId: 'key-1', userId: 'user-1' }, 'idem-1', {
        ...command,
        quantity: '3',
      }),
    ).rejects.toMatchObject({ response: { code: 'IDEMPOTENCY_KEY_REUSED' } });
    metrics.onModuleDestroy();
  });
});
