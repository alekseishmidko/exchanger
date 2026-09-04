import { BadRequestException, PipeTransform, Injectable } from '@nestjs/common';
import { z, ZodType } from 'zod';

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
    commandId: z.string().min(1).max(128),
    orderId: z.string().min(1).max(128),
    accountId: z.string().min(1).max(128),
    instrumentId: z.string().min(1).max(128),
    clientOrderId: z.string().min(1).max(128),
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
export const cancelOrderDtoSchema = z.object({
  commandId: z.string().min(1).max(128),
  orderId: z.string().min(1).max(128),
  accountId: z.string().min(1).max(128),
  instrumentId: z.string().min(1).max(128),
});

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
