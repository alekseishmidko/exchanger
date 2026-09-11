import { Injectable, LoggerService, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { KNOWN_LOG_EVENTS, LOG_EVENTS, LogEventName, UNSAMPLED_LOG_EVENTS } from './log-events';
import { LoggingContext } from './logging-context';

/** Поддерживаемые уровни, совместимые с production log collectors. */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
/** Нормализованный исход критичного действия. */
export type LogOutcome = 'success' | 'rejected' | 'retry' | 'failure' | 'recovered';

/** Обязательная схема одной JSON log record. */
export type StructuredLogRecord = Readonly<{
  timestamp: string;
  level: LogLevel;
  service: string;
  module: string;
  event: LogEventName;
  environment: string;
  correlationId: string | null;
  causationId: string | null;
  commandId: string | null;
  eventId: string | null;
  outcome: LogOutcome;
  durationMs: number | null;
  metadata: Readonly<Record<string, unknown>>;
  stack?: string;
}>;

/** Безопасные optional поля, принимаемые единым adapter-ом. */
export type LogAttributes = Readonly<{
  correlationId?: string | undefined;
  causationId?: string | undefined;
  commandId?: string | undefined;
  eventId?: string | undefined;
  outcome?: LogOutcome;
  durationMs?: number;
  metadata?: Readonly<Record<string, unknown>>;
  error?: unknown;
  internal?: boolean;
}>;

/** Sink абстрагирует stdout от тестового in-memory collector. */
export type LogSink = (record: StructuredLogRecord) => void;

/** Минимальный port, который domain/application классы принимают без Nest dependency. */
export interface OperationalLogger {
  /** Фиксирует успешное изменение или завершение boundary. */
  info(module: string, event: LogEventName, attributes?: LogAttributes): void;
  /** Фиксирует ожидаемый отказ или retry. */
  warn(module: string, event: LogEventName, attributes?: LogAttributes): void;
  /** Фиксирует внутренний/dependency failure. */
  failure(module: string, event: LogEventName, attributes?: LogAttributes): void;
}

/** No-op fallback сохраняет возможность чистых unit-тестов domain classes. */
export const NOOP_OPERATIONAL_LOGGER: OperationalLogger = {
  info: () => undefined,
  warn: () => undefined,
  failure: () => undefined,
};

/** Ключи, значение которых всегда заменяется независимо от регистра. */
const sensitiveKeys =
  /^(authorization|cookie|set-cookie|api[-_]?key|password|secret|token|userId|accountId|amount|price|quantity)$/i;
/** Canary patterns защищают от секрета, ошибочно помещённого в обычное поле. */
const sensitiveValues =
  /(bearer\s+[a-z0-9._~+/-]+=*|\bex_[a-z0-9_-]{16,}|postgres(?:ql)?:\/\/[^\s]+|api[-_]?key\s*[:=]\s*\S+)/i;

/**
 * Единый operational logger приложения.
 *
 * Adapter формирует одну JSON record с обязательными полями, объединяет явные
 * attributes с AsyncLocalStorage context, рекурсивно редактирует metadata и
 * ограничивает повторяющиеся low-priority events. Audit/security events обходят
 * sampling. Logger никогда не принимает произвольное имя события.
 *
 * @example
 * `logger.info('ledger', LOG_EVENTS.LEDGER_COMMAND_APPLIED, { commandId: 'c-1' })`
 * создаёт JSON-запись с `outcome=success`, а `metadata.apiKey` станет
 * `[REDACTED]`.
 */
@Injectable()
export class StructuredLogger implements LoggerService, OperationalLogger {
  private readonly service: string;
  private readonly environment: string;
  private readonly buildVersion: string;
  private readonly sampleLimit: number;
  private readonly sampleWindowMs: number;
  private readonly sink: LogSink;
  private readonly buckets = new Map<string, { startedAt: number; count: number }>();

  constructor(
    private readonly context: LoggingContext,
    @Optional() config?: ConfigService,
    @Optional() sink?: LogSink,
  ) {
    this.service = config?.get<string>('SERVICE_NAME', 'exchange-backend') ?? 'exchange-backend';
    this.environment = config?.get<string>('NODE_ENV', 'test') ?? 'test';
    this.sink =
      sink ??
      (this.environment === 'test'
        ? () => undefined
        : (record) => process.stdout.write(`${JSON.stringify(record)}\n`));
    this.buildVersion = config?.get<string>('BUILD_VERSION', 'development') ?? 'development';
    this.sampleLimit = config?.get<number>('LOG_SAMPLE_LIMIT', 100) ?? 100;
    this.sampleWindowMs = config?.get<number>('LOG_SAMPLE_WINDOW_MS', 10_000) ?? 10_000;
  }

  /** Пишет success/info event. */
  info(module: string, event: LogEventName, attributes: LogAttributes = {}): void {
    this.emit('info', module, event, { outcome: 'success', ...attributes });
  }

  /** Пишет dependency/internal failure; stack разрешён лишь для internal event. */
  failure(module: string, event: LogEventName, attributes: LogAttributes = {}): void {
    this.emit('error', module, event, { outcome: 'failure', ...attributes });
  }

  /** Nest LoggerService compatibility для framework messages. */
  log(message: unknown, context?: string): void {
    this.info(context ?? 'framework', LOG_EVENTS.SYSTEM_FRAMEWORK, {
      metadata: { message: this.safeMessage(message) },
    });
  }

  /** Nest LoggerService compatibility для warning messages. */
  warn(message: unknown, context?: string): void;
  warn(module: string, event: LogEventName, attributes?: LogAttributes): void;
  warn(first: unknown, second?: string, third: LogAttributes = {}): void {
    if (second && KNOWN_LOG_EVENTS.has(second)) {
      this.emit('warn', String(first), second as LogEventName, { outcome: 'rejected', ...third });
      return;
    }
    this.emit('warn', second ?? 'framework', LOG_EVENTS.SYSTEM_FRAMEWORK, {
      outcome: 'rejected',
      metadata: { message: this.safeMessage(first) },
    });
  }

  /** Nest LoggerService compatibility; exception text проходит redaction. */
  error(message: unknown, trace?: string, context?: string): void {
    this.failure(context ?? 'framework', LOG_EVENTS.SYSTEM_FRAMEWORK, {
      metadata: { message: this.safeMessage(message) },
      error: trace,
      internal: false,
    });
  }

  /** Debug events подчиняются sampling так же, как обычный info. */
  debug(message: unknown, context?: string): void {
    this.emit('debug', context ?? 'framework', LOG_EVENTS.SYSTEM_FRAMEWORK, {
      outcome: 'success',
      metadata: { message: this.safeMessage(message) },
    });
  }

  /** Verbose framework output нормализуется как sampled debug. */
  verbose(message: unknown, context?: string): void {
    this.debug(message, context);
  }

  /** Возвращает build version для startup record без чтения process.env. */
  getBuildVersion(): string {
    return this.buildVersion;
  }

  /** Формирует, редактирует и передаёт record выбранному sink. */
  private emit(
    level: LogLevel,
    module: string,
    event: LogEventName,
    attributes: LogAttributes,
  ): void {
    if (!KNOWN_LOG_EVENTS.has(event)) throw new Error(`Unknown production log event: ${event}`);
    if (!this.shouldWrite(event, level)) return;
    const inherited = this.context.current();
    const error = attributes.error;
    const record: StructuredLogRecord = {
      timestamp: new Date().toISOString(),
      level,
      service: this.service,
      module,
      event,
      environment: this.environment,
      correlationId: attributes.correlationId ?? inherited.correlationId ?? null,
      causationId: attributes.causationId ?? inherited.causationId ?? null,
      commandId: attributes.commandId ?? inherited.commandId ?? null,
      eventId: attributes.eventId ?? inherited.eventId ?? null,
      outcome: attributes.outcome ?? (level === 'error' ? 'failure' : 'success'),
      durationMs: attributes.durationMs ?? null,
      metadata: this.redact(attributes.metadata ?? {}) as Readonly<Record<string, unknown>>,
      ...(attributes.internal && error instanceof Error
        ? { stack: this.redactString(error.stack ?? error.message) }
        : {}),
    };
    this.sink(record);
  }

  /** Token-window policy ограничивает log storm, сохраняя errors/audit/security. */
  private shouldWrite(event: LogEventName, level: LogLevel): boolean {
    if (level === 'error' || UNSAMPLED_LOG_EVENTS.has(event)) return true;
    const now = Date.now();
    const bucket = this.buckets.get(event);
    if (!bucket || now - bucket.startedAt >= this.sampleWindowMs) {
      this.buckets.set(event, { startedAt: now, count: 1 });
      return true;
    }
    bucket.count += 1;
    return bucket.count <= this.sampleLimit;
  }

  /** Рекурсивно удаляет запрещённые ключи и canary-like string values. */
  private redact(value: unknown, key = ''): unknown {
    if (sensitiveKeys.test(key)) return '[REDACTED]';
    if (typeof value === 'string') return this.redactString(value);
    if (Array.isArray(value)) return value.map((item) => this.redact(item));
    if (value && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([childKey, childValue]) => [
          childKey,
          this.redact(childValue, childKey),
        ]),
      );
    }
    return value;
  }

  /** Редактирует секретоподобные значения даже под нейтральным ключом. */
  private redactString(value: string): string {
    return sensitiveValues.test(value) ? '[REDACTED]' : value.slice(0, 2048);
  }

  /** Превращает framework message в bounded строку без сериализации payload. */
  private safeMessage(value: unknown): string {
    return this.redactString(typeof value === 'string' ? value : String(value));
  }
}
