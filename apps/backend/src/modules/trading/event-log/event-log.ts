import { createHash } from 'node:crypto';
import {
  LOG_EVENTS,
  LoggingContext,
  NOOP_OPERATIONAL_LOGGER,
  OperationalLogger,
  NOOP_TELEMETRY,
  TelemetryPort,
  TraceCarrier,
  TRACE_SPANS,
} from '../../observability';

/**
 * Минимальное immutable событие для durable event log adapter.
 *
 * `trace` хранит только W3C carrier и позволяет consumer продолжить trace после
 * чтения журнала. В carrier отсутствуют payload и business IDs, поэтому tracing
 * metadata не раскрывает внутреннее состояние и не участвует в идемпотентности.
 */
export type LogEvent = Readonly<{
  eventId: string;
  eventType: string;
  payload: unknown;
  correlationId?: string;
  causationId?: string;
  trace?: TraceCarrier;
}>;

/**
 * Переносимый архив append-only журнала.
 *
 * `checksum` вычисляется от версии, времени, offset и полного массива событий.
 * Restore отклоняет архив при любом изменении этих полей. Payload архива остаётся
 * JSON-совместимым и может храниться в object storage с retention/object lock.
 */
export type EventLogArchive = Readonly<{
  formatVersion: 1;
  createdAt: string;
  committedOffset: number;
  events: readonly LogEvent[];
  checksum: string;
}>;

/** Ошибка временной недоступности event log. */
export class EventLogTimeout extends Error {
  constructor() {
    super('EVENT_LOG_TIMEOUT');
    this.name = 'EventLogTimeout';
  }
}

/** Append-only log с offset, retry и dead-letter semantics для adapters. */
export class EventLog {
  private readonly events: LogEvent[] = [];
  private readonly deadLetters: LogEvent[] = [];
  private offset = 0;
  private failuresBeforeSuccess = 0;

  /**
   * Создаёт append/consume boundary с заменяемыми operational adapters.
   *
   * Logger и context отвечают за диагностику причинной цепочки, telemetry — за
   * producer/consumer spans. Их no-op/optional значения позволяют replay-тестам
   * использовать журнал без NestJS и сети, сохраняя ту же бизнес-семантику.
   *
   * @param logger Стабильные append/retry/DLQ/recovery log events.
   * @param context AsyncLocalStorage-контекст downstream consumer handler.
   * @param telemetry Port для переноса trace через durable asynchronous boundary.
   */
  constructor(
    private readonly logger: OperationalLogger = NOOP_OPERATIONAL_LOGGER,
    private readonly context?: LoggingContext,
    private readonly telemetry: TelemetryPort = NOOP_TELEMETRY,
  ) {}

  /**
   * Добавляет событие с контролируемой timeout-ошибкой.
   *
   * Если producer не передал carrier, активный span сериализуется перед append.
   * Событие попадает в массив только после проверки simulated dependency failure;
   * при timeout вызывающий код получает ошибку и может безопасно повторить append.
   *
   * @param event Immutable envelope с уникальным eventId и безопасной metadata.
   */
  async append(event: LogEvent): Promise<void> {
    return this.telemetry.span(
      TRACE_SPANS.EVENT_APPEND,
      { 'event.type': event.eventType },
      async () => {
        await Promise.resolve();
        if (this.failuresBeforeSuccess > 0) {
          this.failuresBeforeSuccess -= 1;
          this.logger.warn('event-log', LOG_EVENTS.EVENT_LOG_TIMEOUT, {
            eventId: event.eventId,
            correlationId: event.correlationId,
            causationId: event.causationId,
            outcome: 'retry',
            metadata: { eventType: event.eventType },
          });
          throw new EventLogTimeout();
        }
        const stored = event.trace ? event : { ...event, trace: this.telemetry.carrier() };
        this.events.push(stored);
        this.logger.info('event-log', LOG_EVENTS.EVENT_LOG_APPENDED, {
          eventId: event.eventId,
          correlationId: event.correlationId,
          causationId: event.causationId,
          metadata: { eventType: event.eventType, offset: this.events.length - 1 },
        });
      },
    );
  }

  /** Настраивает число временных отказов для retry тестов. */
  failNext(count: number): void {
    this.failuresBeforeSuccess = Math.max(0, count);
  }

  /**
   * Обрабатывает события после committed offset с retry и DLQ.
   *
   * Каждый вызов handler выполняется в consumer span, дочернем к producer trace.
   * Offset сдвигается после terminal результата: успешной обработки либо переноса
   * в DLQ после `maxRetries`, поэтому poison event не блокирует очередь навсегда.
   *
   * @param handler Идемпотентный consumer callback одного события.
   * @param maxRetries Максимальное число попыток до dead-letter policy.
   */
  async consume(handler: (event: LogEvent) => Promise<void>, maxRetries = 3): Promise<void> {
    while (this.offset < this.events.length) {
      const event = this.events[this.offset];
      if (!event) break;
      let handled = false;
      for (let attempt = 0; attempt < maxRetries && !handled; attempt += 1) {
        try {
          if (this.telemetry.continueSpan) {
            await this.telemetry.continueSpan(
              TRACE_SPANS.EVENT_CONSUME,
              event.trace ?? {},
              { 'event.type': event.eventType },
              () => this.handleInContext(event, handler),
            );
          } else {
            await this.handleInContext(event, handler);
          }
          handled = true;
          this.logger.info('event-log', LOG_EVENTS.EVENT_LOG_CONSUMED, {
            eventId: event.eventId,
            correlationId: event.correlationId,
            causationId: event.eventId,
            metadata: { eventType: event.eventType, attempt: attempt + 1 },
          });
        } catch {
          if (attempt === maxRetries - 1) {
            this.deadLetters.push(event);
            this.logger.failure('event-log', LOG_EVENTS.EVENT_LOG_DEAD_LETTERED, {
              eventId: event.eventId,
              correlationId: event.correlationId,
              causationId: event.eventId,
              metadata: { eventType: event.eventType, attempts: maxRetries },
            });
          } else {
            this.logger.warn('event-log', LOG_EVENTS.EVENT_LOG_TIMEOUT, {
              eventId: event.eventId,
              correlationId: event.correlationId,
              causationId: event.eventId,
              outcome: 'retry',
              metadata: { eventType: event.eventType, attempt: attempt + 1 },
            });
          }
        }
      }
      if (handled) this.offset += 1;
      else this.offset += 1;
    }
  }

  /** Возвращает committed consumer offset. */
  getOffset(): number {
    return this.offset;
  }

  /** Возвращает события, отправленные в dead-letter queue. */
  getDeadLetters(): readonly LogEvent[] {
    return [...this.deadLetters];
  }

  /** Возвращает append-only события для reconciliation/replay. */
  getEvents(): readonly LogEvent[] {
    return [...this.events];
  }

  /**
   * Создаёт полный архив журнала с checksum, не изменяя live log.
   *
   * @param createdAt Контролируемое время создания архива.
   * @returns Immutable archive, пригодный для сериализации в JSON.
   */
  createArchive(createdAt: Date = new Date()): EventLogArchive {
    const body = {
      formatVersion: 1 as const,
      createdAt: createdAt.toISOString(),
      committedOffset: this.offset,
      events: this.getEvents(),
    };
    return { ...body, checksum: EventLog.checksum(body) };
  }

  /**
   * Удаляет старые live events после успешного внешнего архивирования.
   *
   * Метод сохраняет только последние `maxEvents` и корректирует consumer offset.
   * Вызывать его до durable сохранения результата `createArchive` запрещено
   * операционным runbook, поскольку удалённые события восстановить будет неоткуда.
   */
  retainLatest(maxEvents: number): void {
    if (!Number.isInteger(maxEvents) || maxEvents < 0) throw new Error('Invalid retention limit');
    const removeCount = Math.max(0, this.events.length - maxEvents);
    if (removeCount === 0) return;
    this.events.splice(0, removeCount);
    this.offset = Math.max(0, this.offset - removeCount);
  }

  /**
   * Восстанавливает новый EventLog из проверенного архива.
   *
   * @throws Error Если format version, offset или checksum повреждены.
   */
  static restore(
    archive: EventLogArchive,
    logger: OperationalLogger = NOOP_OPERATIONAL_LOGGER,
    context?: LoggingContext,
  ): EventLog {
    const { checksum, ...body } = archive;
    if (
      archive.formatVersion !== 1 ||
      archive.committedOffset < 0 ||
      archive.committedOffset > archive.events.length ||
      checksum !== EventLog.checksum(body)
    ) {
      throw new Error('Invalid event log archive');
    }
    const log = new EventLog(logger, context);
    log.events.push(...archive.events);
    log.offset = archive.committedOffset;
    log.logger.info('event-log', LOG_EVENTS.EVENT_LOG_RECOVERED, {
      outcome: 'recovered',
      metadata: { eventCount: archive.events.length, committedOffset: archive.committedOffset },
    });
    return log;
  }

  private static checksum(value: object): string {
    const serialized = JSON.stringify(value, (_key: string, field: unknown): unknown =>
      typeof field === 'bigint' ? field.toString() : field,
    );
    return createHash('sha256').update(serialized).digest('hex');
  }

  /**
   * Восстанавливает AsyncLocalStorage context на consumer boundary.
   * Event ID становится причиной downstream records, а correlation ID сохраняет
   * исходный пользовательский flow после чтения из durable log.
   */
  private handleInContext(
    event: LogEvent,
    handler: (event: LogEvent) => Promise<void>,
  ): Promise<void> {
    if (!this.context) return handler(event);
    return this.context.run(
      {
        correlationId: event.correlationId ?? event.eventId,
        causationId: event.eventId,
        eventId: event.eventId,
      },
      () => handler(event),
    );
  }
}
