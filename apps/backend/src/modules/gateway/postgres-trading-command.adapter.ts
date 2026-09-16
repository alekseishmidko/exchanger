import { ConflictException, Inject } from '@nestjs/common';
import type { QueryResultRow } from 'pg';
import { POSTGRES_TRANSACTION, PostgresTransactionManager } from '../../infrastructure/postgres';
import { sha256 } from '../../infrastructure/postgres/postgres-json';
import {
  GatewayCancelOrderCommand,
  GatewayCommandResult,
  GatewayPlaceOrderCommand,
  TradingCommandPort,
} from './gateway.types';
import type { PartitionLease, SequencerStorePort } from '../trading/sequencer';

type CommandRow = QueryResultRow & {
  payload_hash: string;
  public_result: GatewayCommandResult | null;
  status: string;
};

/**
 * Durable PostgreSQL adapter command admission.
 *
 * Команда, монотонные transitions и outbox event создаются в transaction,
 * открытой idempotency adapter. Если adapter вызван напрямую, менеджер сам
 * открывает transaction. HTTP получает результат только после внешнего commit.
 * Поэтому timeout/exception до commit никогда не становится ложным success.
 */
export class PostgresTradingCommandAdapter implements TradingCommandPort {
  private readonly leases = new Map<string, PartitionLease>();

  /**
   * Создаёт command adapter поверх shared transaction manager.
   * @param transactions Общая ACID boundary command/idempotency/outbox.
   */
  constructor(
    @Inject(POSTGRES_TRANSACTION) private readonly transactions: PostgresTransactionManager,
    private readonly sequencer?: SequencerStorePort,
    private readonly ownerId = 'standalone-adapter',
    private readonly leaseTtlMs = 15_000,
  ) {}

  /** Durably принимает place command и создаёт `OrderAccepted` outbox event. */
  placeOrder(command: GatewayPlaceOrderCommand): Promise<GatewayCommandResult> {
    return this.persist(command, 'PLACE_ORDER', command.clientOrderId, 'ACCEPTED', 'OrderAccepted');
  }

  /** Durably принимает cancel command и создаёт `OrderCancelled` outbox event. */
  cancelOrder(command: GatewayCancelOrderCommand): Promise<GatewayCommandResult> {
    return this.persist(
      command,
      'CANCEL_ORDER',
      command.orderId,
      'CANCEL_ACCEPTED',
      'OrderCancelled',
    );
  }

  /**
   * Возвращает committed public results в стабильном порядке.
   * @param limit Bounded размер страницы.
   * @param cursor Числовое смещение, не раскрывающее внутренний primary key.
   */
  async listOrders(
    userId: string,
    limit: number,
    cursor?: string,
  ): Promise<Readonly<{ items: readonly GatewayCommandResult[]; nextCursor: string | null }>> {
    return this.transactions.run(async (client) => {
      const start = Number(cursor ?? 0);
      const rows = await client.query<{ public_result: GatewayCommandResult }>(
        `SELECT public_result
           FROM command_journal
          WHERE status = 'APPLIED' AND owner_id = $3
          ORDER BY accepted_at, command_id
          OFFSET $1 LIMIT $2`,
        [start, limit + 1, userId],
      );
      const hasNext = rows.rows.length > limit;
      const items = rows.rows.slice(0, limit).map((row) => row.public_result);
      return { items, nextCursor: hasNext ? String(start + items.length) : null };
    });
  }

  /** Сохраняет command lifecycle и outbox как одну атомарную операцию. */
  private async persist(
    command: GatewayPlaceOrderCommand | GatewayCancelOrderCommand,
    commandType: 'PLACE_ORDER' | 'CANCEL_ORDER',
    orderId: string,
    resultStatus: GatewayCommandResult['status'],
    eventType: 'OrderAccepted' | 'OrderCancelled',
  ): Promise<GatewayCommandResult> {
    try {
      return await this.transactions.run(async (client) => {
        const { idempotencyKey, ...durablePayload } = command;
        const payloadHash = sha256(durablePayload);
        const duplicate = await client.query<CommandRow>(
          `SELECT payload_hash, public_result, status
           FROM command_journal WHERE command_id = $1 FOR UPDATE`,
          [command.commandId],
        );
        const previous = duplicate.rows[0];
        if (previous) {
          if (previous.payload_hash !== payloadHash || !previous.public_result) {
            throw new ConflictException({
              code: 'COMMAND_ID_REUSED',
              message: 'Command ID was reused with another payload or non-terminal command',
            });
          }
          return previous.public_result;
        }

        const sequence = String(await this.nextSequence(command.instrumentId));
        const result: GatewayCommandResult = {
          commandId: command.commandId,
          orderId,
          status: resultStatus,
        };
        const keyDigest = sha256(idempotencyKey);
        const correlationId = command.commandId;

        await client.query(
          `INSERT INTO command_journal
          (command_id, idempotency_key_digest, payload_hash, command_payload,
           owner_id, instrument_id, sequence, command_type, status, correlation_id)
         VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8, 'ACCEPTED', $9)`,
          [
            command.commandId,
            keyDigest,
            payloadHash,
            JSON.stringify(durablePayload),
            command.userId,
            command.instrumentId,
            sequence,
            commandType,
            correlationId,
          ],
        );
        await client.query(
          `UPDATE command_journal SET status = 'PROCESSING', processing_at = clock_timestamp()
          WHERE command_id = $1`,
          [command.commandId],
        );
        await client.query(
          `INSERT INTO outbox_events
          (event_id, aggregate_type, aggregate_id, event_type, payload, correlation_id, causation_id)
         VALUES ($1, 'order', $2, $3, $4::jsonb, $5, $6)`,
          [
            `event-${command.commandId}`,
            orderId,
            eventType,
            JSON.stringify({ ...durablePayload, sequence }),
            correlationId,
            command.commandId,
          ],
        );
        await client.query(
          `UPDATE command_journal
            SET status = 'APPLIED', public_result = $2::jsonb, completed_at = clock_timestamp()
          WHERE command_id = $1`,
          [command.commandId, JSON.stringify(result)],
        );
        return result;
      });
    } catch (error) {
      this.leases.delete(command.instrumentId);
      throw error;
    }
  }

  /**
   * Захватывает/продлевает lease и резервирует sequence с fencing check.
   * При transfer adapter проверяет snapshot/replay continuity и открывает
   * admission только после достижения durable high watermark.
   */
  private async nextSequence(instrumentId: string): Promise<number> {
    if (!this.sequencer) {
      const client = this.transactions.currentClient();
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [instrumentId]);
      const sequence = await client.query<{ value: string }>(
        `SELECT COALESCE(MAX(sequence), 0) + 1 AS value
           FROM command_journal WHERE instrument_id=$1`,
        [instrumentId],
      );
      return Number(sequence.rows[0]?.value ?? 1);
    }
    let lease = await this.sequencer.acquire(instrumentId, this.ownerId, this.leaseTtlMs);
    this.leases.set(instrumentId, lease);
    if (lease.recoveryRequired) {
      const plan = await this.sequencer.prepareRecovery(lease, 1);
      await this.sequencer.completeRecovery(lease, plan.highWatermark);
      lease = { ...lease, recoveryRequired: false };
      this.leases.set(instrumentId, lease);
    }
    return this.sequencer.reserveSequence(lease);
  }

  /**
   * Закрывает admission и освобождает все принадлежащие процессу leases.
   * NestJS ожидает Promise до завершения shutdown; наличие in-flight command
   * оставляет lease до expiry и сигнализирует ошибкой вместо потери принятой работы.
   */
  async onApplicationShutdown(): Promise<void> {
    if (!this.sequencer) return;
    for (const lease of this.leases.values()) {
      await this.sequencer.gracefulShutdown(lease);
    }
    this.leases.clear();
  }
}
