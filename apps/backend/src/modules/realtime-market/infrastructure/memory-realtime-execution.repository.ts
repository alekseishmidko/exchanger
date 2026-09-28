import { ConflictException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { RealtimeExecution } from '@exchange/contracts';
import type {
  PreparedRealtimeExecution,
  RealtimeExecutionRepositoryPort,
} from '../ports/realtime-execution.port';

type RecordValue = Readonly<{ hash: string; result: RealtimeExecution }>;

export class MemoryRealtimeExecutionRepository implements RealtimeExecutionRepositoryPort {
  private readonly idempotency = new Map<string, RecordValue>();
  private readonly executions = new Map<string, RealtimeExecution>();
  private readonly owners = new Map<string, string>();
  private readonly commandIds = new Set<string>();
  private paused = false;

  findReplay(identity: string, key: string, request: unknown): Promise<RealtimeExecution | null> {
    const previous = this.idempotency.get(`${identity}:${key}`);
    if (!previous) return Promise.resolve(null);
    if (previous.hash !== this.hash(request)) throw this.conflict();
    return Promise.resolve({ ...previous.result });
  }

  async commit(
    identity: string,
    key: string,
    request: unknown,
    prepared: PreparedRealtimeExecution,
    settle: () => Promise<void>,
  ): Promise<RealtimeExecution> {
    const replay = await this.findReplay(identity, key, request);
    if (replay) return replay;
    if (this.paused) throw new Error('REALTIME_EXECUTION_PAUSED');
    if (
      this.executions.has(prepared.command.orderId) ||
      this.commandIds.has(prepared.command.commandId)
    )
      throw new Error('REALTIME_ORDER_ID_CONFLICT');
    await settle();
    this.executions.set(prepared.result.orderId, { ...prepared.result });
    this.owners.set(prepared.result.orderId, prepared.ownerId);
    this.commandIds.add(prepared.command.commandId);
    this.idempotency.set(`${identity}:${key}`, {
      hash: this.hash(request),
      result: { ...prepared.result },
    });
    return { ...prepared.result };
  }

  list(ownerId: string, limit: number, cursor: number) {
    const all = [...this.executions.values()]
      .filter((value) => this.owners.get(value.orderId) === ownerId || ownerId === '*')
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    const items = all.slice(cursor, cursor + limit).map((value) => ({ ...value }));
    return Promise.resolve({
      items,
      nextCursor: cursor + items.length < all.length ? String(cursor + items.length) : null,
    });
  }

  get(ownerId: string, orderId: string): Promise<RealtimeExecution | null> {
    const value = this.executions.get(orderId);
    return Promise.resolve(value && this.owners.get(orderId) === ownerId ? { ...value } : null);
  }

  setPaused(paused: boolean): Promise<void> {
    this.paused = paused;
    return Promise.resolve();
  }
  isPaused(): Promise<boolean> {
    return Promise.resolve(this.paused);
  }
  reconcile() {
    const count = this.executions.size;
    return Promise.resolve({
      commands: count,
      quoteSnapshots: count,
      executions: count,
      pendingOutbox: 0,
      consistent: true,
    });
  }

  private hash(value: unknown): string {
    return createHash('sha256').update(JSON.stringify(value)).digest('hex');
  }
  private conflict(): ConflictException {
    return new ConflictException({
      code: 'IDEMPOTENCY_KEY_REUSED',
      message: 'Idempotency key was reused with another request',
    });
  }
}
