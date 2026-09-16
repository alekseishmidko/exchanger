import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Pool } from 'pg';
import {
  PostgresAtomicExecution,
  PostgresTransactionManager,
} from '../../../infrastructure/postgres';
import { PostgresAuditLog } from '../../audit';
import { PostgresIdempotencyStore } from '../../gateway/postgres-idempotency.store';
import { PostgresTradingCommandAdapter } from '../../gateway/postgres-trading-command.adapter';
import { Account, Asset, PostgresLedgerAdapter } from '../../ledger';
import { createId, Decimal } from '../../shared-kernel';
import { PostgresEventLogAdapter, PostgresOutboxPublisher } from '../../trading/event-log';
import { SettlementService } from '../../trading/settlement';
import { PostgresSequencerStore } from '../../trading/sequencer';
import { PostgresAdmissionControl } from '../../admin/postgres-admission-control';
import { PostgresProjectionStore } from '../../projections/postgres-projection.store';

const postgresUrl = process.env['POSTGRES_URL'];
const describePostgres = postgresUrl ? describe : describe.skip;

/**
 * Проверяет durable write path против настоящего PostgreSQL.
 *
 * Suite выполняется последовательно в одном файле, поскольку migration down/up
 * изменяет общую test database. Каждый тест получает чистые таблицы, но schema
 * остаётся той же, что используется production compose.
 */
describePostgres('PostgreSQL durable runtime', () => {
  let pool: Pool;
  let transactions: PostgresTransactionManager;
  const ledgerMigration = (name: string): string => resolve(__dirname, 'migrations', name);
  const runtimeMigration = (name: string): string =>
    resolve(__dirname, '../../../infrastructure/postgres/migrations', name);

  /** Поднимает обе migration в порядке production deployment. */
  beforeAll(async () => {
    pool = new Pool({ connectionString: postgresUrl, max: 10 });
    transactions = new PostgresTransactionManager(pool);
    await pool.query(
      await readFile(runtimeMigration('003_durable_control_plane_down.sql'), 'utf8'),
    );
    await pool.query(await readFile(runtimeMigration('002_durable_runtime_down.sql'), 'utf8'));
    await pool.query(await readFile(ledgerMigration('001_ledger_down.sql'), 'utf8'));
    await pool.query(await readFile(ledgerMigration('001_ledger_up.sql'), 'utf8'));
    await pool.query(await readFile(runtimeMigration('002_durable_runtime_up.sql'), 'utf8'));
    await pool.query(await readFile(runtimeMigration('003_durable_control_plane_up.sql'), 'utf8'));
  });

  /** Удаляет данные без удаления schema между независимыми сценариями. */
  beforeEach(async () => {
    await pool.query(`TRUNCATE
      projection_balances, projection_trades, projection_orders,
      projection_processed_events, projection_versions,
      admission_control_history, admission_controls,
      trading_snapshots, sequencer_partitions, partition_leases,
      dead_letter_events, processed_events, consumer_offsets, outbox_events,
      api_idempotency_records, command_status_history, command_journal,
      audit_records, reservations, ledger_operations, idempotency_records,
      postings, balances, accounts, assets RESTART IDENTITY CASCADE`);
    await pool.query(`INSERT INTO projection_versions
      (projection_name, version, schema_version, status, activated_at)
      VALUES ('query-api', 1, 1, 'ACTIVE', clock_timestamp())`);
  });

  /** Проверяет обратимую migration и закрывает pool после cleanup. */
  afterAll(async () => {
    await pool.query(
      await readFile(runtimeMigration('003_durable_control_plane_down.sql'), 'utf8'),
    );
    await pool.query('TRUNCATE audit_records, reservations, ledger_operations CASCADE');
    await pool.query(await readFile(runtimeMigration('002_durable_runtime_down.sql'), 'utf8'));
    await pool.query(await readFile(ledgerMigration('001_ledger_down.sql'), 'utf8'));
    await pool.end();
  });

  /** Additive migration down/up сохраняет существующие данные базовой ledger schema. */
  it('keeps pre-existing ledger data across a compatible migration cycle', async () => {
    await pool.query("INSERT INTO assets (id, code, scale) VALUES ('legacy-usd', 'LUSD', 2)");
    await pool.query(
      "INSERT INTO accounts (id, owner_id) VALUES ('legacy-account', 'legacy-owner')",
    );
    await pool.query(
      `INSERT INTO balances (account_id, asset_id, available, reserved)
       VALUES ('legacy-account', 'legacy-usd', 12.34, 0)`,
    );
    await pool.query(
      `INSERT INTO ledger_operations (operation_id, operation_type, result)
       VALUES ('forward-only-proof', 'TEST', '{}')`,
    );
    await expect(
      pool.query(await readFile(runtimeMigration('002_durable_runtime_down.sql'), 'utf8')),
    ).rejects.toThrow('forward-only data policy');
    await pool.query('TRUNCATE ledger_operations CASCADE');
    await pool.query(
      await readFile(runtimeMigration('003_durable_control_plane_down.sql'), 'utf8'),
    );
    await pool.query(await readFile(runtimeMigration('002_durable_runtime_down.sql'), 'utf8'));
    await pool.query(await readFile(runtimeMigration('002_durable_runtime_up.sql'), 'utf8'));
    await pool.query(await readFile(runtimeMigration('003_durable_control_plane_up.sql'), 'utf8'));
    expect(
      (
        await pool.query<{ available: string }>(
          "SELECT available::text FROM balances WHERE account_id='legacy-account' AND asset_id='legacy-usd'",
        )
      ).rows[0],
    ).toEqual({ available: '12.340000000000000000' });
  });

  /** SQL constraints отклоняют отрицательные balances и односторонние postings. */
  it('enforces balance and deferred double-entry constraints', async () => {
    await pool.query("INSERT INTO assets (id, code, scale) VALUES ('usd', 'USD', 2)");
    await pool.query("INSERT INTO accounts (id, owner_id) VALUES ('account-1', 'user-1')");
    await pool.query(
      "INSERT INTO balances (account_id, asset_id, available, reserved) VALUES ('account-1', 'usd', 10, 0)",
    );
    await expect(
      pool.query(
        "UPDATE balances SET available=-1 WHERE account_id='account-1' AND asset_id='usd'",
      ),
    ).rejects.toThrow();
    await expect(
      transactions.run(async (client) => {
        await client.query(
          "INSERT INTO postings VALUES ('one-sided', 'bad-op', 'account-1', 'usd', 'DEBIT', 1, now())",
        );
      }),
    ).rejects.toThrow('posting set is not balanced');
  });

  /** Database автоматически аудирует lifecycle и запрещает выход из terminal state. */
  it('enforces monotonic accepted, recovery and rejected command transitions', async () => {
    await pool.query(
      `INSERT INTO command_journal
        (command_id, idempotency_key_digest, payload_hash, command_payload,
         owner_id, instrument_id, sequence, command_type, status)
       VALUES ('recover-1', 'digest', 'hash', '{}', 'owner-1', 'BTC-USD', 1,
               'PLACE_ORDER', 'ACCEPTED')`,
    );
    await pool.query("UPDATE command_journal SET status='RECOVERY' WHERE command_id='recover-1'");
    await pool.query("UPDATE command_journal SET status='REJECTED' WHERE command_id='recover-1'");
    expect(
      (
        await pool.query<{ status: string }>(
          "SELECT status FROM command_status_history WHERE command_id='recover-1' ORDER BY transition_number",
        )
      ).rows.map(({ status }) => status),
    ).toEqual(['ACCEPTED', 'RECOVERY', 'REJECTED']);
    await expect(
      pool.query("UPDATE command_journal SET status='APPLIED' WHERE command_id='recover-1'"),
    ).rejects.toThrow('invalid command status transition');
  });

  /** Concurrent duplicates создают одну command/outbox запись и прежний result. */
  it('serializes duplicate command admission and survives adapter restart', async () => {
    const store = new PostgresIdempotencyStore(transactions);
    const trading = new PostgresTradingCommandAdapter(transactions);
    const command = {
      commandId: 'command-1',
      idempotencyKey: 'raw-secret-key',
      userId: 'user-1',
      accountId: 'account-1',
      instrumentId: 'BTC-USD',
      clientOrderId: 'order-1',
      side: 'BUY' as const,
      orderType: 'LIMIT' as const,
      quantity: '1',
      limitPrice: '100',
      timeInForce: 'GTC' as const,
    };
    const execute = () =>
      store.execute('api-key:raw-secret-key', command, () => trading.placeOrder(command));
    const [first, duplicate] = await Promise.all([execute(), execute()]);
    expect(duplicate).toEqual(first);

    const restartedStore = new PostgresIdempotencyStore(new PostgresTransactionManager(pool));
    expect(
      await restartedStore.execute('api-key:raw-secret-key', command, () =>
        Promise.reject(new Error('must not execute after restart')),
      ),
    ).toEqual(first);
    const counts = await pool.query(`SELECT
      (SELECT count(*)::int FROM command_journal) AS commands,
      (SELECT count(*)::int FROM outbox_events) AS events,
      (SELECT count(*)::int FROM api_idempotency_records) AS keys,
      (SELECT count(*)::int FROM command_status_history) AS transitions`);
    expect(counts.rows[0]).toEqual({ commands: 1, events: 1, keys: 1, transitions: 3 });
    const serialized = JSON.stringify(await pool.query('SELECT * FROM command_journal'));
    expect(serialized).not.toContain('raw-secret-key');
  });

  /** Lease transfer fencing, snapshot boundary и ordered replay переживают restart. */
  it('fences the old partition owner and restores snapshot plus ordered replay', async () => {
    const sequencer = new PostgresSequencerStore(transactions);
    const ownerOne = await sequencer.acquire('BTC-USD', 'worker-1', 30_000);
    const trading = new PostgresTradingCommandAdapter(transactions, sequencer, 'worker-1', 30_000);
    const command = (number: number) => ({
      commandId: `lease-command-${number}`,
      idempotencyKey: `lease-key-${number}`,
      userId: 'user-1',
      accountId: 'account-1',
      instrumentId: 'BTC-USD',
      clientOrderId: `lease-order-${number}`,
      side: 'BUY' as const,
      orderType: 'LIMIT' as const,
      quantity: '1',
      limitPrice: '100',
      timeInForce: 'GTC' as const,
    });
    await trading.placeOrder(command(1));
    await trading.placeOrder(command(2));
    const snapshot = await sequencer.saveSnapshot(ownerOne, 1, { book: 'snapshot-v1' });
    expect(snapshot.lastSequence).toBe(2);
    await trading.placeOrder(command(3));

    await expect(sequencer.acquire('BTC-USD', 'worker-2', 30_000)).rejects.toThrow(
      'PARTITION_ALREADY_OWNED',
    );
    await pool.query(
      "UPDATE partition_leases SET lease_until=clock_timestamp()-interval '1 second' WHERE instrument_id='BTC-USD'",
    );
    const ownerTwo = await sequencer.acquire('BTC-USD', 'worker-2', 30_000);
    expect(ownerTwo.fencingEpoch).toBe(ownerOne.fencingEpoch + 1);
    await expect(sequencer.reserveSequence(ownerOne)).rejects.toThrow('STALE_FENCING_TOKEN');
    const recovery = await sequencer.prepareRecovery(ownerTwo, 1);
    expect(recovery.snapshot?.payload).toEqual({ book: 'snapshot-v1' });
    expect(recovery.commands.map(({ sequence }) => sequence)).toEqual([3]);
    expect(recovery.highWatermark).toBe(3);
    await sequencer.completeRecovery(ownerTwo, 3);
    const secondTrading = new PostgresTradingCommandAdapter(
      transactions,
      sequencer,
      'worker-2',
      30_000,
    );
    await secondTrading.placeOrder(command(4));
    expect(
      (
        await pool.query<{ sequence: string }>(
          "SELECT sequence FROM command_journal WHERE command_id='lease-command-4'",
        )
      ).rows[0],
    ).toEqual({ sequence: '4' });
    await secondTrading.onApplicationShutdown();
    expect(
      (await pool.query('SELECT count(*)::int AS count FROM partition_leases')).rows[0],
    ).toEqual({ count: 0 });

    const ownerThree = await sequencer.acquire('BTC-USD', 'worker-3', 30_000);
    expect(ownerThree).toMatchObject({
      fencingEpoch: ownerTwo.fencingEpoch + 1,
      recoveryRequired: true,
    });
    await expect(sequencer.reserveSequence(ownerThree)).rejects.toThrow('PARTITION_NOT_READY');
    const secondRecovery = await sequencer.prepareRecovery(ownerThree, 1);
    expect(secondRecovery.highWatermark).toBe(4);
    await sequencer.completeRecovery(ownerThree, 4);
    expect(await sequencer.reserveSequence(ownerThree)).toBe(5);
  });

  /** Sequence reservation откатывается вместе с command journal и outbox failure. */
  it('rolls back a reserved sequence when durable command append fails', async () => {
    const sequencer = new PostgresSequencerStore(transactions);
    const trading = new PostgresTradingCommandAdapter(
      transactions,
      sequencer,
      'worker-rollback',
      30_000,
    );
    await pool.query(
      `INSERT INTO outbox_events
        (event_id,aggregate_type,aggregate_id,event_type,payload)
       VALUES ('event-sequence-rollback','test','test','Conflict','{}')`,
    );
    const command = {
      commandId: 'sequence-rollback',
      idempotencyKey: 'sequence-rollback-key',
      userId: 'user-1',
      accountId: 'account-1',
      instrumentId: 'ETH-USD',
      clientOrderId: 'sequence-rollback-order',
      side: 'BUY' as const,
      orderType: 'LIMIT' as const,
      quantity: '1',
      limitPrice: '100',
      timeInForce: 'GTC' as const,
    };
    await expect(trading.placeOrder(command)).rejects.toThrow();
    expect(
      (
        await pool.query(
          "SELECT count(*)::int AS count FROM sequencer_partitions WHERE instrument_id='ETH-USD'",
        )
      ).rows[0],
    ).toEqual({ count: 0 });
    expect(
      (
        await pool.query(
          "SELECT count(*)::int AS count FROM command_journal WHERE command_id='sequence-rollback'",
        )
      ).rows[0],
    ).toEqual({ count: 0 });
    await pool.query("DELETE FROM outbox_events WHERE event_id='event-sequence-rollback'");
    await trading.placeOrder(command);
    expect(
      (
        await pool.query<{ sequence: string }>(
          "SELECT sequence FROM command_journal WHERE command_id='sequence-rollback'",
        )
      ).rows[0],
    ).toEqual({ sequence: '1' });
  });

  /** Control plane восстанавливается новым adapter и блокирует admission до command append. */
  it('persists freeze, pause and circuit-breaker controls with compensation', async () => {
    const controls = new PostgresAdmissionControl(transactions);
    await controls.apply({
      commandId: 'freeze-account-1',
      type: 'ACCOUNT',
      targetId: 'account-1',
      state: 'FROZEN',
      effectiveAt: new Date('2026-09-16T00:00:00.000Z'),
      actorId: 'risk-1',
      reasonCode: 'FREEZE_ACCOUNT',
    });
    const restarted = new PostgresAdmissionControl(new PostgresTransactionManager(pool));
    await expect(
      restarted.assertAllowed(
        { userId: 'user-1', accountId: 'account-1', instrumentId: 'BTC-USD' },
        new Date('2026-09-16T00:00:01.000Z'),
      ),
    ).rejects.toMatchObject({ rejectionCode: 'ACCOUNT_FROZEN' });
    await restarted.apply({
      commandId: 'unfreeze-account-1',
      type: 'ACCOUNT',
      targetId: 'account-1',
      state: 'ALLOW',
      effectiveAt: new Date('2026-09-16T00:00:02.000Z'),
      actorId: 'risk-2',
      reasonCode: 'UNFREEZE_ACCOUNT',
      compensationFor: 'freeze-account-1',
    });
    await expect(
      restarted.assertAllowed(
        { userId: 'user-1', accountId: 'account-1', instrumentId: 'BTC-USD' },
        new Date('2026-09-16T00:00:03.000Z'),
      ),
    ).resolves.toBeUndefined();
    expect(
      (
        await pool.query(
          "SELECT compensation_for FROM admission_control_history WHERE command_id='unfreeze-account-1'",
        )
      ).rows[0],
    ).toEqual({ compensation_for: 'freeze-account-1' });
  });

  /** Projection mutation, processed event и offset commit-ятся вместе; rebuild переключается атомарно. */
  it('applies and rebuilds a versioned durable projection without exposing shadow rows', async () => {
    const projection = new PostgresProjectionStore(transactions);
    const events = [
      {
        eventId: 'projection-order-1',
        eventType: 'OrderAccepted' as const,
        sequence: 1,
        payload: {
          orderId: 'order-1',
          userId: 'user-1',
          accountId: 'account-1',
          instrumentId: 'BTC-USD',
          remainingQuantity: '1',
        },
      },
      {
        eventId: 'projection-trade-1',
        eventType: 'TradeExecuted' as const,
        sequence: 2,
        payload: {
          tradeId: 'trade-1',
          instrumentId: 'BTC-USD',
          makerUserId: 'user-1',
          takerUserId: 'user-2',
          makerOrderId: 'order-1',
          takerOrderId: 'order-2',
          quantity: '1',
          price: '100',
        },
      },
    ];
    await projection.apply(events[0]!);
    await projection.apply(events[0]!);
    await projection.apply(events[1]!);
    expect((await projection.getOrders('user-1')).items).toHaveLength(1);
    expect((await projection.getOrders('user-2')).items).toHaveLength(0);
    expect((await projection.getMetrics()).appliedSequence).toBe(2);
    await projection.rebuild(events);
    expect((await projection.getTrades('user-1')).items).toHaveLength(1);
    const versions = await pool.query<{ version: string; status: string }>(
      "SELECT version,status FROM projection_versions WHERE projection_name='query-api' ORDER BY version",
    );
    expect(versions.rows).toEqual([
      { version: '1', status: 'RETIRED' },
      { version: '2', status: 'ACTIVE' },
    ]);
  });

  /** Exception после SQL mutation откатывает command, outbox и idempotency row. */
  it('never leaves accepted state or success before transaction commit', async () => {
    const store = new PostgresIdempotencyStore(transactions);
    await expect(
      store.execute('api-key:rollback-key', { commandId: 'rollback-1' }, async () => {
        const client = transactions.currentClient();
        await client.query(
          `INSERT INTO outbox_events
            (event_id, aggregate_type, aggregate_id, event_type, payload)
           VALUES ('rollback-event', 'test', 'rollback', 'RollbackTest', '{}')`,
        );
        throw new Error('simulated crash before commit');
      }),
    ).rejects.toThrow('simulated crash before commit');
    expect((await pool.query('SELECT count(*)::int AS count FROM outbox_events')).rows[0]).toEqual({
      count: 0,
    });
    expect(
      (await pool.query('SELECT count(*)::int AS count FROM api_idempotency_records')).rows[0],
    ).toEqual({ count: 0 });
  });

  /** Ledger atomically сохраняет balance, reservation, operation и postings. */
  it('persists idempotent ledger operations and rejects insufficient funds', async () => {
    const ledger = new PostgresLedgerAdapter(transactions);
    const usd = createId<'AssetId'>('USD');
    const account = createId<'AccountId'>('account-1');
    await ledger.registerAsset(new Asset(usd, 'USD', 2));
    await ledger.registerAccount(new Account(account, 'user-1'));
    await ledger.openBalance(account, usd);
    await ledger.credit(createId<'OperationId'>('credit-1'), account, usd, Decimal.from('100'));
    const reserve = () =>
      ledger.reserve(createId<'OperationId'>('reserve-1'), account, usd, Decimal.from('40'));
    expect((await Promise.all([reserve(), reserve()]))[0]).toEqual(await reserve());
    await expect(
      ledger.debit(createId<'OperationId'>('too-large'), account, usd, Decimal.from('1000')),
    ).rejects.toThrow('invariant violation');
    expect((await ledger.getBalance(account, usd)).available.toString()).toBe('60');
    expect((await ledger.getBalance(account, usd)).reserved.toString()).toBe('40');
    expect(
      (await pool.query('SELECT count(*)::int AS count FROM ledger_operations')).rows[0],
    ).toEqual({ count: 2 });
    expect((await pool.query('SELECT count(*)::int AS count FROM postings')).rows[0]).toEqual({
      count: 4,
    });
    expect((await pool.query('SELECT status FROM reservations')).rows[0]).toEqual({
      status: 'ACTIVE',
    });

    await ledger.compensate(
      createId<'OperationId'>('reserve-1-compensation'),
      createId<'OperationId'>('reserve-1'),
    );
    expect(
      (
        await pool.query<{ compensation_for: string }>(
          "SELECT compensation_for FROM ledger_operations WHERE operation_id='reserve-1-compensation'",
        )
      ).rows[0],
    ).toEqual({ compensation_for: 'reserve-1' });
    expect(
      (
        await pool.query(
          "SELECT count(*)::int AS count FROM ledger_operations WHERE operation_id='reserve-1'",
        )
      ).rows[0],
    ).toEqual({ count: 1 });
  });

  /** Settlement фиксирует posting matrix и SettlementApplied outbox без окна dual write. */
  it('commits settlement ledger effects and event as one transaction', async () => {
    const ledger = new PostgresLedgerAdapter(transactions);
    const eventLog = new PostgresEventLogAdapter(transactions, 'settlement-test');
    const btc = createId<'AssetId'>('BTC');
    const usd = createId<'AssetId'>('USD');
    const buyer = createId<'AccountId'>('buyer');
    const seller = createId<'AccountId'>('seller');
    const fees = createId<'AccountId'>('fees-USD');
    await ledger.registerAsset(new Asset(btc, 'BTC', 8));
    await ledger.registerAsset(new Asset(usd, 'USD', 2));
    for (const [id, owner] of [
      [buyer, 'buyer-user'],
      [seller, 'seller-user'],
      [fees, 'system-fees'],
    ] as const) {
      await ledger.registerAccount(new Account(id, owner));
      await ledger.openBalance(id, btc);
      await ledger.openBalance(id, usd);
    }
    await ledger.credit(createId<'OperationId'>('fund-buyer'), buyer, usd, Decimal.from('1000'));
    await ledger.credit(createId<'OperationId'>('fund-seller'), seller, btc, Decimal.from('10'));
    await ledger.credit(
      createId<'OperationId'>('fund-seller-fee'),
      seller,
      usd,
      Decimal.from('10'),
    );
    const settlement = new SettlementService(
      ledger,
      eventLog,
      2,
      undefined,
      undefined,
      undefined,
      new PostgresAtomicExecution(transactions),
    );
    await settlement.reserveBeforePlace({
      orderId: 'buy-order',
      accountId: buyer,
      side: 'BUY',
      baseAssetId: btc,
      quoteAssetId: usd,
      quantity: Decimal.from('2'),
      price: Decimal.from('100'),
      feeRate: Decimal.from('0.01'),
    });
    await settlement.reserveBeforePlace({
      orderId: 'sell-order',
      accountId: seller,
      side: 'SELL',
      baseAssetId: btc,
      quoteAssetId: usd,
      quantity: Decimal.from('2'),
      price: Decimal.from('100'),
      feeRate: Decimal.from('0.01'),
    });
    const trade = {
      eventId: 'trade-event-1',
      tradeId: 'trade-1',
      makerOrderId: 'maker-1',
      takerOrderId: 'taker-1',
      makerAccountId: buyer,
      takerAccountId: seller,
      makerSide: 'BUY',
      quantity: Decimal.from('2'),
      price: Decimal.from('100'),
      makerFee: Decimal.from('2'),
      takerFee: Decimal.from('2'),
      feeAssetId: usd,
      quoteAssetId: usd,
      baseAssetId: btc,
    } as const;
    await settlement.appendTrade(trade);

    const durableAppend = eventLog.append.bind(eventLog);
    let failSettlementAppend = true;
    jest.spyOn(eventLog, 'append').mockImplementation(async (event) => {
      if (event.eventType === 'SettlementApplied' && failSettlementAppend) {
        failSettlementAppend = false;
        throw new Error('simulated outbox failure before commit');
      }
      await durableAppend(event);
    });

    await expect(settlement.settleTrade(trade)).rejects.toThrow(
      'simulated outbox failure before commit',
    );
    expect((await ledger.getBalance(buyer, btc)).available.toString()).toBe('0');
    expect(
      (
        await pool.query(
          "SELECT count(*)::int AS count FROM ledger_operations WHERE operation_type='SETTLE_RESERVED_TRANSFER'",
        )
      ).rows[0],
    ).toEqual({ count: 0 });

    const result = await settlement.settleTrade(trade);
    expect(result.postingIds).toHaveLength(8);
    expect(
      (
        await pool.query<{ event_type: string }>(
          "SELECT event_type FROM outbox_events WHERE event_type IN ('TradeExecuted', 'SettlementApplied') ORDER BY event_offset",
        )
      ).rows.map(({ event_type }) => event_type),
    ).toEqual(['TradeExecuted', 'SettlementApplied']);
    expect((await ledger.getBalance(buyer, btc)).available.toString()).toBe('2');
  });

  /** Не допускает частичного SELL reserve, если резерв комиссии отклонён. */
  it('rolls back all reserve operations when one reservation fails', async () => {
    const ledger = new PostgresLedgerAdapter(transactions);
    const eventLog = new PostgresEventLogAdapter(transactions, 'reserve-test');
    const btc = createId<'AssetId'>('BTC');
    const usd = createId<'AssetId'>('USD');
    const seller = createId<'AccountId'>('seller');
    await ledger.registerAsset(new Asset(btc, 'BTC', 8));
    await ledger.registerAsset(new Asset(usd, 'USD', 2));
    await ledger.registerAccount(new Account(seller, 'seller-user'));
    await ledger.openBalance(seller, btc);
    await ledger.openBalance(seller, usd);
    await ledger.credit(createId<'OperationId'>('fund-seller'), seller, btc, Decimal.from('2'));
    const settlement = new SettlementService(
      ledger,
      eventLog,
      2,
      undefined,
      undefined,
      undefined,
      new PostgresAtomicExecution(transactions),
    );

    await expect(
      settlement.reserveBeforePlace({
        orderId: 'sell-without-fee',
        accountId: seller,
        side: 'SELL',
        baseAssetId: btc,
        quoteAssetId: usd,
        quantity: Decimal.from('2'),
        price: Decimal.from('100'),
        feeRate: Decimal.from('0.01'),
      }),
    ).rejects.toThrow('invariant violation');
    expect((await ledger.getBalance(seller, btc)).available.toString()).toBe('2');
    expect((await ledger.getBalance(seller, btc)).reserved.toString()).toBe('0');
    expect((await pool.query('SELECT count(*)::int AS count FROM reservations')).rows[0]).toEqual({
      count: 0,
    });
  });

  /** Consumer commit, poison DLQ и publisher retry metadata остаются durable. */
  it('commits consumer offset after effect and quarantines poison events', async () => {
    const log = new PostgresEventLogAdapter(transactions, 'projection-test');
    await log.append({ eventId: 'ok-1', eventType: 'OrderAccepted', payload: { orderId: '1' } });
    await log.append({ eventId: 'poison-1', eventType: 'Poison', payload: { safe: true } });
    const handled: string[] = [];
    await log.consume((event) => {
      if (event.eventId === 'poison-1') return Promise.reject(new TypeError('poison payload'));
      handled.push(event.eventId);
      return Promise.resolve();
    }, 2);
    expect(handled).toEqual(['ok-1']);
    expect(await log.getOffset()).toBe(2);
    expect((await log.getDeadLetters()).map(({ eventId }) => eventId)).toEqual(['poison-1']);

    const replayEventId = await log.replayDeadLetter('poison-1', 'operator-1');
    expect(replayEventId).toBe('replay-projection-test-poison-1');
    expect(
      (
        await pool.query(
          "SELECT event_id, replayed_by FROM dead_letter_events WHERE event_id='poison-1'",
        )
      ).rows[0],
    ).toEqual({ event_id: 'poison-1', replayed_by: 'operator-1' });

    const publisher = new PostgresOutboxPublisher(transactions);
    expect(
      await publisher.publishBatch(() => Promise.reject(new TypeError('broker timeout')), 1),
    ).toBe(0);
    expect(
      (
        await pool.query(
          'SELECT attempts, last_error_code FROM outbox_events ORDER BY event_offset LIMIT 1',
        )
      ).rows[0],
    ).toEqual({ attempts: 1, last_error_code: 'TypeError' });
    await pool.query('UPDATE outbox_events SET next_attempt_at=clock_timestamp()');
    await publisher.publishBatch(() => Promise.resolve());
    expect(
      (
        await pool.query(
          'SELECT count(*)::int AS count FROM outbox_events WHERE published_at IS NOT NULL',
        )
      ).rows[0],
    ).toEqual({ count: 3 });
  });

  /** Audit chain обнаруживает tampering, а database запрещает UPDATE/DELETE. */
  it('stores immutable tamper-evident audit records', async () => {
    const audit = new PostgresAuditLog(transactions);
    await audit.append(
      { actorId: 'admin-1', role: 'ADMIN' },
      'ACTION_APPLIED',
      'FREEZE_ACCOUNT',
      'admin-command-1',
      'account-1',
    );
    expect(await audit.verifyIntegrity()).toBe(true);
    await expect(pool.query("UPDATE audit_records SET target_id='other'")).rejects.toThrow(
      'immutable rows cannot be updated',
    );
  });
});
