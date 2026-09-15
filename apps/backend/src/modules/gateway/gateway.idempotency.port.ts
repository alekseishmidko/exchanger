/**
 * Стабильный DI-токен durable idempotency boundary.
 *
 * Controllers внедряют этот token вместо reference-класса, поэтому production
 * может подключить shared PostgreSQL repository без изменения HTTP-контракта.
 */
export const IDEMPOTENCY_STORE_PORT = Symbol('IDEMPOTENCY_STORE_PORT');

/**
 * Порт атомарной дедупликации внешних команд.
 *
 * Adapter связывает scope/key с fingerprint нормализованного request и прежним
 * публичным результатом. Одновременные повторы должны сериализоваться так, чтобы
 * `operation` создала не более одного business effect. Ошибка до commit не
 * сохраняется как success и допускает безопасный retry.
 *
 * @example `execute('api-key:idem-1', command, () => port.placeOrder(command))`.
 */
export interface IdempotencyStorePort {
  /**
   * Выполняет операцию либо возвращает ранее committed совместимый результат.
   *
   * @param key Scoped key, обычно `apiKeyId:Idempotency-Key`.
   * @param request Нормализованный payload для вычисления стабильного hash.
   * @param operation Business callback, который разрешено выполнить один раз.
   * @returns Новый либо ранее сохранённый public result.
   * @throws ConflictException Если тот же key связан с другим payload.
   */
  execute<T>(key: string, request: unknown, operation: () => Promise<T>): Promise<T>;
}
