import { context, Span, SpanStatusCode } from '@opentelemetry/api';

/**
 * Ограниченный каталог имён span критического торгового пути.
 *
 * Значения используются как стабильный эксплуатационный контракт: по ним
 * строятся Tempo-запросы и histogram `exchange_stage_duration_seconds`.
 * Произвольные имена здесь запрещены, иначе command/order ID мог бы случайно
 * попасть в имя span и создать неограниченное количество telemetry dimensions.
 */
export const TRACE_SPANS = {
  HTTP_REQUEST: 'http.request',
  WEBSOCKET_MESSAGE: 'websocket.message',
  COMMAND_ADMISSION: 'trading.command.admission',
  SEQUENCER_WAIT: 'trading.sequencer.wait',
  MATCHING_APPLY: 'trading.matching.apply',
  SETTLEMENT_APPLY: 'trading.settlement.apply',
  LEDGER_COMMIT: 'ledger.commit',
  EVENT_APPEND: 'event_log.append',
  EVENT_CONSUME: 'event_log.consume',
  PROJECTION_APPLY: 'projection.apply',
} as const;

/**
 * Имя span, выведенное из `TRACE_SPANS` на этапе компиляции.
 * Добавление нового значения требует теста, документации и latency budget.
 */
export type TraceSpanName = (typeof TRACE_SPANS)[keyof typeof TRACE_SPANS];

/**
 * Минимальный W3C-контекст, переносимый через HTTP, WebSocket и durable envelope.
 *
 * `traceparent` связывает родительский и дочерний span, `tracestate` переносит
 * vendor-specific sampling state. Пользовательский baggage намеренно отсутствует:
 * через этот тип нельзя передать PII, API key или доменные идентификаторы.
 *
 * @example `{ traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01' }`
 */
export type TraceCarrier = Readonly<{
  traceparent?: string | undefined;
  tracestate?: string | undefined;
}>;

/**
 * Набор bounded span attributes.
 * Ключи описывают тип операции или результата, а не конкретный объект; например,
 * допустим `command.type=place`, но запрещён `commandId=command-123`.
 */
export type TraceAttributes = Readonly<Record<string, string | number | boolean>>;

/**
 * Минимальный tracing port для domain-классов без зависимости от NestJS SDK.
 *
 * Domain-модуль получает этот интерфейс через constructor injection. Поэтому он
 * не знает об OTLP, Tempo и глобальном provider и остаётся детерминированным в
 * unit-тесте. Production adapter реализует интерфейс через OpenTelemetry SDK.
 */
export interface TelemetryPort {
  /**
   * Создаёт дочерний span вокруг синхронной или асинхронной операции.
   * Исключение отмечает span как error и повторно пробрасывается вызывающему коду.
   *
   * @param name Стабильное имя из `TRACE_SPANS`.
   * @param attributes Низкокардинальные признаки операции.
   * @param operation Бизнес-функция, которая должна быть вызвана ровно один раз.
   * @returns Исходный результат функции, включая её Promise-тип.
   */
  span<T>(name: TraceSpanName, attributes: TraceAttributes, operation: () => T): T;
  /**
   * Сериализует активный span перед записью command/event envelope.
   * Вне активного trace возвращает пустой объект, что является корректным режимом.
   */
  carrier(): TraceCarrier;
  /**
   * Продолжает trace после сетевой или durable asynchronous boundary.
   * Некорректный carrier должен приводить к новому root span, а не к отказу
   * бизнес-команды. Метод optional для простых unit-test adapters.
   */
  continueSpan?<T>(
    name: TraceSpanName,
    carrier: TraceCarrier,
    attributes: TraceAttributes,
    operation: () => T,
  ): T;
}

/**
 * No-op tracing port сохраняет чистоту unit-тестов и делает telemetry отказоустойчивой.
 *
 * Operation вызывается ровно один раз. Поэтому отсутствие SDK/exporter никогда не
 * меняет бизнес-семантику и не требует отдельной ветки в matching или ledger.
 */
export const NOOP_TELEMETRY: TelemetryPort = {
  span: <T>(_name: TraceSpanName, _attributes: TraceAttributes, operation: () => T): T =>
    operation(),
  carrier: () => ({}),
};

/**
 * Завершает span после async operation, сохраняя resolved тип Promise.
 * Rejection записывается как exception и не преобразуется в успешный результат.
 */
export function finishSpan<T>(span: Span, value: Promise<T>): Promise<T>;
/** Завершает span после sync operation и возвращает то же значение без копирования. */
export function finishSpan<T>(span: Span, value: T): T;
/**
 * Общая реализация overloads для sync/async результатов.
 *
 * @param span Уже созданный OpenTelemetry span.
 * @param value Результат наблюдаемой операции или Promise этого результата.
 * @returns Исходное значение; для Promise завершение span откладывается до settle.
 */
export function finishSpan(span: Span, value: unknown): unknown {
  if (value instanceof Promise) {
    return value.then(
      (result: unknown) => {
        span.setStatus({ code: SpanStatusCode.OK });
        span.end();
        return result;
      },
      (error: unknown) => {
        span.recordException(error instanceof Error ? error : String(error));
        span.setStatus({ code: SpanStatusCode.ERROR });
        span.end();
        throw error;
      },
    );
  }
  span.setStatus({ code: SpanStatusCode.OK });
  span.end();
  return value;
}

/**
 * Выполняет callback в переданном OpenTelemetry context.
 * Все дочерние spans, structured logs и exemplars внутри callback автоматически
 * используют активный trace без ручной передачи `traceId` по каждому методу.
 */
export function inTraceContext<T>(
  activeContext: ReturnType<typeof context.active>,
  operation: () => T,
): T {
  return context.with(activeContext, operation);
}
