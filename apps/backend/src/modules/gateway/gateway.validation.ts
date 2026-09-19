import { BadRequestException, PipeTransform, Injectable } from '@nestjs/common';
import { z, ZodType } from 'zod';

/**
 * Публичный идентификатор HTTP command API.
 *
 * Gateway использует тот же безопасный subset, что и contract layer: ASCII,
 * максимум 128 символов, без пробелов, control characters и Unicode-confusable
 * символов. Например, `order-1` допускается, а `order\u0000` и `оrder-1` с
 * кириллической буквой отклоняются одинаковой безопасной ошибкой 400.
 */
const publicIdentifierSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9._:-]+$/);

/**
 * Runtime-схема DTO размещения заявки.
 *
 * Схема является allow-list: лишние поля отбрасываются Zod, идентификаторы и
 * строки ограничиваются 128 символами, а quantity/price принимаются только как
 * decimal string. Например, `"1.25"` допустимо, а `1.25` и `"1e-3"` нет.
 * Дополнительное правило связывает `orderType` и `limitPrice`.
 */
export const placeOrderDtoSchema = z
  .object({
    commandId: publicIdentifierSchema,
    orderId: publicIdentifierSchema,
    accountId: publicIdentifierSchema,
    instrumentId: publicIdentifierSchema,
    clientOrderId: publicIdentifierSchema,
    side: z.enum(['BUY', 'SELL']),
    orderType: z.enum(['LIMIT', 'MARKET']),
    quantity: z.string().regex(/^(0|[1-9]\d*)(\.\d+)?$/),
    limitPrice: z
      .string()
      .regex(/^(0|[1-9]\d*)(\.\d+)?$/)
      .nullable()
      .optional(),
    timeInForce: z.enum(['GTC', 'IOC', 'FOK']),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.orderType === 'LIMIT' && !value.limitPrice)
      context.addIssue({
        code: 'custom',
        path: ['limitPrice'],
        message: 'LIMIT price is required',
      });
    if (value.orderType === 'MARKET' && value.limitPrice)
      context.addIssue({
        code: 'custom',
        path: ['limitPrice'],
        message: 'MARKET price is forbidden',
      });
  });

/**
 * Runtime-схема DTO отмены заявки.
 *
 * Она оставляет только необходимые для routing поля и не позволяет передать
 * внутренние параметры matching engine напрямую.
 */
export const cancelOrderDtoSchema = z
  .object({
    commandId: publicIdentifierSchema,
    orderId: publicIdentifierSchema,
    accountId: publicIdentifierSchema,
    instrumentId: publicIdentifierSchema,
  })
  .strict();

/**
 * Nest pipe, превращающий неизвестный JSON body в типизированный DTO.
 *
 * Controller применяет pipe до выполнения business mapping. При ошибке Zod
 * внутренний список полей не отправляется клиенту: наружу выходит только
 * `REQUEST_MALFORMED`, что предотвращает утечку структуры domain-кода.
 */
@Injectable()
export class ZodValidationPipe<T> implements PipeTransform<unknown, T> {
  constructor(private readonly schema: ZodType<T>) {}

  /** Возвращает validated DTO либо безопасную HTTP 400 ошибку клиента. */
  transform(value: unknown): T {
    const result = this.schema.safeParse(value);
    if (!result.success)
      throw new BadRequestException({
        code: 'REQUEST_MALFORMED',
        message: 'Request payload is invalid',
      });
    return result.data;
  }
}
