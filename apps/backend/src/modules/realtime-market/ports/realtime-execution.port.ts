import type {
  RealtimeExecution,
  RealtimeInstrument,
  RealtimeOrderCommand,
  ReferenceQuote,
} from '@exchange/contracts';

export const REALTIME_EXECUTION_REPOSITORY = Symbol('REALTIME_EXECUTION_REPOSITORY');

export type PreparedRealtimeExecution = Readonly<{
  ownerId: string;
  command: RealtimeOrderCommand;
  instrument: RealtimeInstrument;
  quote: ReferenceQuote;
  result: RealtimeExecution;
  liquidityAccountId: string;
}>;

export interface RealtimeExecutionRepositoryPort {
  findReplay(identity: string, key: string, request: unknown): Promise<RealtimeExecution | null>;
  commit(
    identity: string,
    key: string,
    request: unknown,
    prepared: PreparedRealtimeExecution,
    settle: () => Promise<void>,
  ): Promise<RealtimeExecution>;
  list(
    ownerId: string,
    limit: number,
    cursor: number,
  ): Promise<
    Readonly<{
      items: readonly RealtimeExecution[];
      nextCursor: string | null;
    }>
  >;
  get(ownerId: string, orderId: string): Promise<RealtimeExecution | null>;
  setPaused(paused: boolean): Promise<void>;
  isPaused(): Promise<boolean>;
  reconcile(): Promise<
    Readonly<{
      commands: number;
      quoteSnapshots: number;
      executions: number;
      pendingOutbox: number;
      consistent: boolean;
    }>
  >;
}
