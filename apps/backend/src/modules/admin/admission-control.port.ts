import { ConflictException, ServiceUnavailableException } from '@nestjs/common';

/** DI token общего durable control plane для Admin и Gateway. */
export const ADMISSION_CONTROL_PORT = Symbol('ADMISSION_CONTROL_PORT');

/** Тип адресата operational control. */
export type AdmissionControlType = 'GLOBAL' | 'USER' | 'ACCOUNT' | 'INSTRUMENT';

/** Состояние control plane; `ALLOW` является явной компенсацией ограничения. */
export type AdmissionControlState = 'ALLOW' | 'FROZEN' | 'PAUSED' | 'OPEN';

/**
 * Команда применения control после authorization/dual control.
 *
 * `commandId` обеспечивает административную идемпотентность, `effectiveAt`
 * позволяет заранее опубликовать версию policy, а `compensationFor` связывает
 * resume/unfreeze с исходным ограничением без удаления history.
 */
export type AdmissionControlChange = Readonly<{
  commandId: string;
  type: AdmissionControlType;
  targetId: string;
  state: AdmissionControlState;
  effectiveAt: Date;
  actorId: string;
  reasonCode: string;
  compensationFor?: string;
}>;

/** Контекст place/cancel admission, построенный из authenticated command. */
export type AdmissionContext = Readonly<{
  userId: string;
  accountId: string;
  instrumentId: string;
}>;

/** Безопасная ошибка отказа admission без внутренних control metadata. */
export class AdmissionRejectedError extends ConflictException {
  constructor(readonly rejectionCode: string) {
    super({ code: rejectionCode, message: 'Command admission is temporarily unavailable' });
  }
}

/**
 * Безопасный fail-closed ответ при недоступности durable control plane.
 *
 * Gateway не имеет права принимать команду, если не может доказать отсутствие
 * freeze, pause или открытого circuit breaker. Исключение намеренно не включает
 * исходную ошибку PostgreSQL, SQL или сетевой адрес и поэтому безопасно для
 * публичного HTTP response.
 *
 * @example
 * При timeout PostgreSQL клиент получает HTTP 503 и код
 * `ADMISSION_CONTROL_UNAVAILABLE`, а подробности остаются только во внутреннем
 * operational log.
 */
export class AdmissionControlUnavailableError extends ServiceUnavailableException {
  constructor() {
    super({
      code: 'ADMISSION_CONTROL_UNAVAILABLE',
      message: 'Command admission is temporarily unavailable',
    });
  }
}

/**
 * Durable port operational controls, общий для административной и command boundary.
 *
 * Admin записывает ограничения только через этот интерфейс, а Gateway читает
 * тот же source of truth перед созданием idempotency/command records. Поэтому
 * restart процесса не создаёт окна, в котором freeze или pause забыты.
 */
export interface AdmissionControlPort {
  /**
   * Идемпотентно применяет новую version control и сохраняет immutable history.
   * Повтор того же command с тем же содержимым ничего не меняет; переиспользование
   * command ID для другого transition отклоняется.
   *
   * @example `apply({ type: 'ACCOUNT', state: 'FROZEN', ... })` начинает
   * блокировать place/cancel после наступления `effectiveAt`.
   */
  apply(change: AdmissionControlChange): Promise<void>;
  /**
   * Отклоняет command до durable acceptance при активном freeze/pause/breaker.
   * Проверка выполняется для global, user, account и instrument scopes. Ошибка
   * хранилища трактуется fail-closed и не разрешает принять команду.
   */
  assertAllowed(context: AdmissionContext, at?: Date): Promise<void>;
  /**
   * Возвращает текущие controls для dashboard/recovery diagnostics.
   * Метод не возвращает historical payload или credentials и не заменяет
   * отдельный immutable audit API.
   */
  list(): Promise<readonly AdmissionControlChange[]>;
  /**
   * Read-only probe подтверждает доступность durable control plane.
   * Probe не создаёт transition и предназначен для bounded readiness check.
   */
  checkReady(): Promise<void>;
}
