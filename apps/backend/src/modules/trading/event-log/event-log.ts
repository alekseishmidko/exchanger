/** Минимальное immutable событие для durable event log adapter. */
export type LogEvent = Readonly<{ eventId: string; eventType: string; payload: unknown }>;

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

  /** Добавляет событие с контролируемой timeout-ошибкой. */
  async append(event: LogEvent): Promise<void> {
    await Promise.resolve();
    if (this.failuresBeforeSuccess > 0) {
      this.failuresBeforeSuccess -= 1;
      throw new EventLogTimeout();
    }
    this.events.push(event);
  }

  /** Настраивает число временных отказов для retry тестов. */
  failNext(count: number): void {
    this.failuresBeforeSuccess = Math.max(0, count);
  }

  /** Обрабатывает события после committed offset с retry и DLQ. */
  async consume(handler: (event: LogEvent) => Promise<void>, maxRetries = 3): Promise<void> {
    while (this.offset < this.events.length) {
      const event = this.events[this.offset];
      if (!event) break;
      let handled = false;
      for (let attempt = 0; attempt < maxRetries && !handled; attempt += 1) {
        try {
          await handler(event);
          handled = true;
        } catch {
          if (attempt === maxRetries - 1) this.deadLetters.push(event);
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
}
