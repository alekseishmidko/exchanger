import { AsyncLocalStorage } from 'node:async_hooks';
import { Injectable } from '@nestjs/common';

/** Контекст причинной цепочки, автоматически добавляемый к каждой записи. */
export type LoggingContextValue = Readonly<{
  correlationId: string;
  causationId?: string;
  commandId?: string;
  eventId?: string;
}>;

/**
 * Переносит correlation/causation metadata через асинхронные application calls.
 *
 * AsyncLocalStorage отделяет параллельные HTTP/consumer потоки. Код модуля может
 * вызвать logger без ручного проброса correlationId: adapter возьмёт его из
 * текущего context. Для background consumer используется `run`, где eventId
 * становится causationId следующего результата.
 */
@Injectable()
export class LoggingContext {
  private readonly storage = new AsyncLocalStorage<LoggingContextValue>();

  /**
   * Выполняет callback в неизменяемом контексте конкретного потока.
   *
   * Вложенные Promise/callback наследуют значение, а параллельный запрос получает
   * отдельное хранилище. Копирование объекта не позволяет вызывающему коду менять
   * уже активный context после запуска операции.
   *
   * @param value Correlation и optional causation/command/event identifiers.
   * @param callback Синхронная либо возвращающая Promise application operation.
   * @returns Исходный результат callback без преобразования.
   */
  run<T>(value: LoggingContextValue, callback: () => T): T {
    return this.storage.run({ ...value }, callback);
  }

  /**
   * Возвращает metadata текущего потока либо пустое значение вне boundary.
   * Это позволяет startup/background логам использовать тот же logger без
   * искусственного correlationId.
   */
  current(): Partial<LoggingContextValue> {
    return this.storage.getStore() ?? {};
  }
}
