import { Inject, Injectable, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AUDIT_LOG_PORT, AuditLogPort, PostgresAuditLog } from '../modules/audit';
import { IDEMPOTENCY_STORE_PORT, IdempotencyStorePort } from '../modules/gateway';
import {
  PostgresIdempotencyStore,
  PostgresTradingCommandAdapter,
  TRADING_COMMAND_PORT,
  TradingCommandPort,
} from '../modules/gateway';
import { LEDGER_PORT, LedgerPort, PostgresLedgerAdapter } from '../modules/ledger';
import {
  EVENT_LOG_PORT,
  EventLogPort,
  PostgresEventLogAdapter,
} from '../modules/trading/event-log';
import { assertRuntimeComposition, RuntimeAdapterConfiguration } from './runtime-adapters';
import {
  SEQUENCER_STORE_PORT,
  SequencerStorePort,
  PostgresSequencerStore,
} from '../modules/trading/sequencer';
import {
  PROJECTION_STORE_PORT,
  PostgresProjectionStore,
  ProjectionStorePort,
} from '../modules/projections';
import {
  ADMISSION_CONTROL_PORT,
  AdmissionControlPort,
  PostgresAdmissionControl,
} from '../modules/admin/admission-control';

/**
 * Fail-fast предохранитель текущего composition root.
 *
 * Сервис запускается до `listen()` и сравнивает env с фактическими экземплярами
 * DI graph. Если deployment объявил PostgreSQL/outbox, но provider остался
 * reference memory или неизвестным классом, процесс падает вместо запуска с
 * ложной гарантией durability.
 */
@Injectable()
export class RuntimeSafetyService implements OnApplicationBootstrap {
  /**
   * Создаёт startup-предохранитель поверх уже проверенной NestJS-конфигурации.
   *
   * Используется `getOrThrow`, поскольку отсутствие любого adapter setting
   * означает неполную конфигурацию critical write path и не имеет безопасного
   * runtime fallback.
   *
   * @param config Типизированный доступ к значениям после `validateEnvironment`.
   * @param command Фактический command adapter.
   * @param ledger Фактический ledger adapter.
   * @param eventLog Фактический event-log adapter.
   * @param idempotency Фактический shared idempotency adapter.
   * @param audit Фактический immutable audit adapter.
   * @param sequencer Фактическое durable хранилище lease, sequence и snapshots.
   * @param projection Фактический transactional projection store.
   * @param admission Фактический durable operational control plane.
   */
  constructor(
    private readonly config: ConfigService,
    @Inject(TRADING_COMMAND_PORT) private readonly command: TradingCommandPort,
    @Inject(LEDGER_PORT) private readonly ledger: LedgerPort,
    @Inject(EVENT_LOG_PORT) private readonly eventLog: EventLogPort,
    @Inject(IDEMPOTENCY_STORE_PORT) private readonly idempotency: IdempotencyStorePort,
    @Inject(AUDIT_LOG_PORT) private readonly audit: AuditLogPort,
    @Inject(SEQUENCER_STORE_PORT) private readonly sequencer: SequencerStorePort,
    @Inject(PROJECTION_STORE_PORT) private readonly projection: ProjectionStorePort,
    @Inject(ADMISSION_CONTROL_PORT) private readonly admission: AdmissionControlPort,
  ) {}

  /**
   * Сверяет declared и фактические adapters до открытия admission endpoints.
   *
   * Например, если deployment указывает `LEDGER_STORE_ADAPTER=postgres`, а
   * composition root всё ещё содержит memory-ledger, метод выбрасывает ошибку.
   * NestJS прерывает `app.init()`, и клиент не может получить ложный `accepted`.
   *
   * @throws Error Если хотя бы один critical adapter не соответствует env.
   */
  onApplicationBootstrap(): void {
    const configured: RuntimeAdapterConfiguration = {
      RUNTIME_PROFILE: this.config.getOrThrow('RUNTIME_PROFILE'),
      COMMAND_STORE_ADAPTER: this.config.getOrThrow('COMMAND_STORE_ADAPTER'),
      LEDGER_STORE_ADAPTER: this.config.getOrThrow('LEDGER_STORE_ADAPTER'),
      EVENT_LOG_ADAPTER: this.config.getOrThrow('EVENT_LOG_ADAPTER'),
      IDEMPOTENCY_STORE_ADAPTER: this.config.getOrThrow('IDEMPOTENCY_STORE_ADAPTER'),
      AUDIT_STORE_ADAPTER: this.config.getOrThrow('AUDIT_STORE_ADAPTER'),
      SEQUENCER_STORE_ADAPTER: this.config.getOrThrow('SEQUENCER_STORE_ADAPTER'),
      PROJECTION_STORE_ADAPTER: this.config.getOrThrow('PROJECTION_STORE_ADAPTER'),
      ADMISSION_CONTROL_ADAPTER: this.config.getOrThrow('ADMISSION_CONTROL_ADAPTER'),
    };
    assertRuntimeComposition(configured, {
      COMMAND_STORE_ADAPTER:
        this.command instanceof PostgresTradingCommandAdapter ? 'postgres' : 'memory',
      LEDGER_STORE_ADAPTER: this.ledger instanceof PostgresLedgerAdapter ? 'postgres' : 'memory',
      EVENT_LOG_ADAPTER:
        this.eventLog instanceof PostgresEventLogAdapter ? 'postgres-outbox' : 'memory',
      IDEMPOTENCY_STORE_ADAPTER:
        this.idempotency instanceof PostgresIdempotencyStore ? 'postgres' : 'memory',
      AUDIT_STORE_ADAPTER: this.audit instanceof PostgresAuditLog ? 'postgres' : 'memory',
      SEQUENCER_STORE_ADAPTER:
        this.sequencer instanceof PostgresSequencerStore ? 'postgres' : 'memory',
      PROJECTION_STORE_ADAPTER:
        this.projection instanceof PostgresProjectionStore ? 'postgres' : 'memory',
      ADMISSION_CONTROL_ADAPTER:
        this.admission instanceof PostgresAdmissionControl ? 'postgres' : 'memory',
    });
  }
}
