import { ConflictException, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { GatewayCommandResult } from './gateway.types';

/**
 * Неизменяемая запись результата команды, сохранённая по ключу идемпотентности.
 *
 * `fingerprint` связывает ключ с содержимым запроса. Поэтому один и тот же ключ
 * можно повторить только с тем же запросом: это защищает от ошибочного повторного
 * использования ключа для другой заявки. `result` сохраняется после успешного
 * выполнения операции и возвращается при последующих повторах.
 *
 * Пример записи:
 * ```ts
 * {
 *   fingerprint: 'sha256:…',
 *   result: { commandId: 'cmd-1', orderId: 'order-1', status: 'ACCEPTED' }
 * }
 * ```
 */
type IdempotencyRecord = Readonly<{ fingerprint: string; result: GatewayCommandResult }>;

/**
 * In-memory хранилище идемпотентности для command API.
 *
 * Интерфейс класса намеренно скрывает структуру хранилища от controller:
 * controller передаёт ключ, исходный запрос и функцию бизнес-операции, а класс
 * решает, нужно ли выполнять функцию. В production этот boundary должен быть
 * заменён на транзакционное PostgreSQL/Redis-хранилище с уникальным индексом по
 * `(consumer, idempotency_key)` и TTL, не меняя вызывающий код.
 *
 * Алгоритм работы:
 * 1. Для запроса строится SHA-256 fingerprint на основе его JSON-представления.
 * 2. Если ключ ещё не встречался, выполняется `operation`.
 * 3. После успешного результата ключ и результат сохраняются атомарно в рамках
 *    текущего reference storage.
 * 4. При повторе с тем же fingerprint возвращается сохранённый результат без
 *    повторного вызова trading core.
 * 5. При повторе того же ключа с другим payload выбрасывается HTTP 409.
 *
 * Пример успешного retry:
 * ```ts
 * const first = await store.execute('idem-1', request, sendToTradingCore);
 * const retry = await store.execute('idem-1', request, sendToTradingCore);
 * // first === retry; sendToTradingCore вызван только один раз.
 * ```
 *
 * Пример конфликта:
 * ```ts
 * await store.execute('idem-1', { orderId: 'order-1' }, operation);
 * await store.execute('idem-1', { orderId: 'order-2' }, operation);
 * // ConflictException с кодом IDEMPOTENCY_KEY_REUSED.
 * ```
 */
@Injectable()
export class IdempotencyStore {
  /**
   * Локальный индекс `idempotency key → результат`.
   *
   * Важное ограничение: `Map` теряется при перезапуске процесса и не обеспечивает
   * межрепличную согласованность. Поэтому это только development/reference
   * реализация; production должен предоставить durable shared store.
   */
  private readonly records = new Map<string, IdempotencyRecord>();

  /**
   * Выполняет команду не более одного раза для согласованного payload.
   *
   * @param key Уникальный ключ из HTTP-заголовка `Idempotency-Key`.
   * @param request Нормализованная команда, используемая для вычисления fingerprint.
   * @param operation Асинхронная отправка команды в trading core.
   * @returns Исходный или ранее сохранённый безопасный результат команды.
   * @throws ConflictException Если ключ уже связан с другим запросом.
   *
   * Если `operation` завершается ошибкой, запись не создаётся. Клиент может
   * повторить запрос с тем же ключом: операция будет запущена снова, что позволяет
   * безопасно переживать timeout до момента успешной фиксации результата.
   */
  execute(
    key: string,
    request: unknown,
    operation: () => Promise<GatewayCommandResult>,
  ): Promise<GatewayCommandResult> {
    const fingerprint = createHash('sha256').update(JSON.stringify(request)).digest('hex');
    const previous = this.records.get(key);
    if (previous) {
      if (previous.fingerprint !== fingerprint)
        throw new ConflictException({
          code: 'IDEMPOTENCY_KEY_REUSED',
          message: 'Idempotency key was reused with another request',
        });
      return Promise.resolve(previous.result);
    }
    return operation().then((result) => {
      this.records.set(key, { fingerprint, result });
      return result;
    });
  }
}
