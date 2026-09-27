import { ConflictException, Inject } from '@nestjs/common';
import { realtimeExecutionSchema, type RealtimeExecution } from '@exchange/contracts';
import type { Pool } from 'pg';
import {
  POSTGRES_POOL,
  POSTGRES_TRANSACTION,
  PostgresTransactionManager,
} from '../../../infrastructure/postgres';
import { sha256 } from '../../../infrastructure/postgres/postgres-json';
import type {
  PreparedRealtimeExecution,
  RealtimeExecutionRepositoryPort,
} from '../ports/realtime-execution.port';

type ExecutionRow = Readonly<{ public_result: unknown }>;

export class PostgresRealtimeExecutionRepository implements RealtimeExecutionRepositoryPort {
  constructor(
    @Inject(POSTGRES_POOL) private readonly pool: Pool,
    @Inject(POSTGRES_TRANSACTION) private readonly transactions: PostgresTransactionManager,
  ) {}

  async findReplay(
    identity: string,
    key: string,
    request: unknown,
  ): Promise<RealtimeExecution | null> {
    const result = await this.pool.query<ExecutionRow & { request_hash: string }>(
      `SELECT request_hash, public_result FROM realtime_commands
        WHERE identity_key=$1 AND idempotency_key_digest=$2`,
      [identity, sha256(key)],
    );
    const row = result.rows[0];
    if (!row) return null;
    if (row.request_hash !== sha256(request)) throw this.conflict();
    return realtimeExecutionSchema.parse(row.public_result);
  }

  commit(
    identity: string,
    key: string,
    request: unknown,
    prepared: PreparedRealtimeExecution,
    settle: () => Promise<void>,
  ): Promise<RealtimeExecution> {
    return this.transactions.run(async (client) => {
      const keyDigest = sha256(key);
      const requestHash = sha256(request);
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
        `${identity}:${keyDigest}`,
      ]);
      const previous = await client.query<ExecutionRow & { request_hash: string }>(
        `SELECT request_hash, public_result FROM realtime_commands
          WHERE identity_key=$1 AND idempotency_key_digest=$2`,
        [identity, keyDigest],
      );
      const row = previous.rows[0];
      if (row) {
        if (row.request_hash !== requestHash) throw this.conflict();
        return realtimeExecutionSchema.parse(row.public_result);
      }
      const collision = await client.query(
        'SELECT 1 FROM realtime_commands WHERE command_id=$1 OR order_id=$2 LIMIT 1',
        [prepared.command.commandId, prepared.command.orderId],
      );
      if (collision.rowCount) throw new Error('REALTIME_ORDER_ID_CONFLICT');
      const control = await client.query<{ paused: boolean }>(
        'SELECT paused FROM realtime_execution_controls WHERE id=true FOR UPDATE',
      );
      if (control.rows[0]?.paused !== false) throw new Error('REALTIME_EXECUTION_PAUSED');
      await settle();
      const { command, instrument, quote, result } = prepared;
      await client.query(
        `INSERT INTO realtime_commands
          (command_id,order_id,identity_key,idempotency_key_digest,request_hash,owner_id,
           account_id,instrument_id,side,quantity,expected_quote_id,status,public_result)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'FILLED',$12::jsonb)`,
        [
          command.commandId,
          command.orderId,
          identity,
          keyDigest,
          requestHash,
          prepared.ownerId,
          command.accountId,
          command.instrumentId,
          command.side,
          command.quantity,
          command.expectedQuoteId,
          JSON.stringify(result),
        ],
      );
      await client.query(
        `INSERT INTO realtime_execution_quotes
          (order_id,quote_id,instrument_id,provider,provider_symbol,exchange,price,price_type,
           provider_timestamp,received_at,evaluated_at,expires_at,checksum)
         VALUES ($1,$2,$3,'TwelveData',$4,$5,$6,'LAST',$7,$8,$9,$10,$11)`,
        [
          command.orderId,
          quote.quoteId,
          command.instrumentId,
          instrument.providerSymbol,
          instrument.exchange,
          quote.price,
          quote.providerTimestamp,
          quote.receivedAt,
          result.createdAt,
          quote.expiresAt,
          sha256(quote),
        ],
      );
      const operationIds = [
        `rt:${command.orderId}:asset`,
        `rt:${command.orderId}:notional`,
        ...(result.fee === '0' ? [] : [`rt:${command.orderId}:fee`]),
      ];
      await client.query(
        `INSERT INTO realtime_executions
          (execution_id,order_id,quote_id,side,quantity,price,notional,fee,user_account_id,
           liquidity_account_id,settlement_operation_ids)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::text[])`,
        [
          result.executionId,
          result.orderId,
          result.quoteId,
          result.side,
          result.quantity,
          result.price,
          result.notional,
          result.fee,
          result.accountId,
          prepared.liquidityAccountId,
          operationIds,
        ],
      );
      await client.query(
        `INSERT INTO outbox_events(event_id,aggregate_type,aggregate_id,event_type,payload)
         VALUES ($1,'REALTIME_ORDER',$2,'RealtimeExecutionFilled',$3::jsonb)`,
        [`event:${result.executionId}`, result.orderId, JSON.stringify(result)],
      );
      return result;
    });
  }

  async list(ownerId: string, limit: number, cursor: number) {
    const result = await this.pool.query<ExecutionRow>(
      `SELECT public_result FROM realtime_commands WHERE owner_id=$1
        ORDER BY created_at DESC, order_id LIMIT $2 OFFSET $3`,
      [ownerId, limit + 1, cursor],
    );
    const hasMore = result.rows.length > limit;
    const items = result.rows
      .slice(0, limit)
      .map(({ public_result }) => realtimeExecutionSchema.parse(public_result));
    return {
      items,
      nextCursor: hasMore ? String(cursor + items.length) : null,
    };
  }

  async get(ownerId: string, orderId: string): Promise<RealtimeExecution | null> {
    const result = await this.pool.query<ExecutionRow>(
      'SELECT public_result FROM realtime_commands WHERE owner_id=$1 AND order_id=$2',
      [ownerId, orderId],
    );
    return result.rows[0] ? realtimeExecutionSchema.parse(result.rows[0].public_result) : null;
  }

  async setPaused(paused: boolean): Promise<void> {
    await this.pool.query(
      'UPDATE realtime_execution_controls SET paused=$1, updated_at=clock_timestamp() WHERE id=true',
      [paused],
    );
  }
  async isPaused(): Promise<boolean> {
    const result = await this.pool.query<{ paused: boolean }>(
      'SELECT paused FROM realtime_execution_controls WHERE id=true',
    );
    return result.rows[0]?.paused ?? true;
  }
  async reconcile() {
    const result = await this.pool.query<{
      commands: string;
      quotes: string;
      executions: string;
      pending: string;
    }>(`SELECT
      (SELECT COUNT(*) FROM realtime_commands)::text commands,
      (SELECT COUNT(*) FROM realtime_execution_quotes)::text quotes,
      (SELECT COUNT(*) FROM realtime_executions)::text executions,
      (SELECT COUNT(*) FROM outbox_events WHERE event_type='RealtimeExecutionFilled' AND published_at IS NULL)::text pending`);
    const row = result.rows[0] ?? { commands: '0', quotes: '0', executions: '0', pending: '0' };
    const commands = Number(row.commands);
    const quoteSnapshots = Number(row.quotes);
    const executions = Number(row.executions);
    return {
      commands,
      quoteSnapshots,
      executions,
      pendingOutbox: Number(row.pending),
      consistent: commands === quoteSnapshots && commands === executions,
    };
  }

  private conflict(): ConflictException {
    return new ConflictException({
      code: 'IDEMPOTENCY_KEY_REUSED',
      message: 'Idempotency key was reused with another request',
    });
  }
}
