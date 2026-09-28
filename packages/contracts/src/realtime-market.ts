import { z } from 'zod';
import { decimalSchema, idSchema, timestampSchema } from './common';

/** Поддерживаемые классы внешних инструментов Twelve Data. */
export const realtimeAssetClassSchema = z.enum(['CRYPTO', 'FOREX', 'STOCK', 'COMMODITY']);
export type RealtimeAssetClass = z.infer<typeof realtimeAssetClassSchema>;

/** Состояние локально опубликованного внешнего инструмента. */
export const realtimeInstrumentStatusSchema = z.enum(['ACTIVE', 'INACTIVE']);

/** Нормализованный внешний инструмент без provider-specific payload. */
export const realtimeInstrumentSchema = z
  .object({
    id: idSchema,
    displaySymbol: z.string().min(1).max(64),
    providerSymbol: z.string().min(1).max(64),
    assetClass: realtimeAssetClassSchema,
    exchange: z.string().min(1).max(128).nullable(),
    micCode: z.string().min(1).max(16).nullable(),
    baseAssetId: idSchema,
    quoteAssetId: idSchema,
    priceEnabled: z.boolean(),
    tradeEnabled: z.boolean(),
    status: realtimeInstrumentStatusSchema,
    source: z.literal('TwelveData'),
    syncedAt: timestampSchema,
  })
  .strict();
export type RealtimeInstrument = z.infer<typeof realtimeInstrumentSchema>;

/** Последний нормализованный last-price tick. */
export const referenceQuoteSchema = z
  .object({
    instrumentId: idSchema,
    quoteId: idSchema,
    price: decimalSchema,
    priceType: z.literal('LAST'),
    providerTimestamp: timestampSchema,
    receivedAt: timestampSchema,
    expiresAt: timestampSchema,
    sequence: z.string().regex(/^[1-9]\d*$/),
    status: z.enum(['FRESH', 'STALE']),
    source: z.literal('TwelveData'),
  })
  .strict();
export type ReferenceQuote = z.infer<typeof referenceQuoteSchema>;

/** Стабильные публичные причины отказа будущего reference-price execution flow. */
export const realtimeMarketErrorCodeSchema = z.enum([
  'REALTIME_PRICE_UNAVAILABLE',
  'QUOTE_STALE',
  'QUOTE_CHANGED',
]);
export type RealtimeMarketErrorCode = z.infer<typeof realtimeMarketErrorCodeSchema>;

/** Запрос подписки клиента будущего realtime Socket.IO transport. */
export const realtimeSubscriptionSchema = z
  .object({ requestId: idSchema, instrumentIds: z.array(idSchema).min(1).max(100) })
  .strict();
export type RealtimeSubscription = z.infer<typeof realtimeSubscriptionSchema>;

export const realtimeQuoteSnapshotSchema = z
  .object({
    instrumentId: idSchema,
    status: z.enum(['FRESH', 'STALE', 'UNAVAILABLE']),
    quote: referenceQuoteSchema.nullable(),
  })
  .strict();
export type RealtimeQuoteSnapshot = z.infer<typeof realtimeQuoteSnapshotSchema>;

export const realtimeOrderCommandSchema = z
  .object({
    commandId: idSchema,
    orderId: idSchema,
    accountId: idSchema,
    instrumentId: idSchema,
    side: z.enum(['BUY', 'SELL']),
    quantity: decimalSchema,
    expectedQuoteId: idSchema,
  })
  .strict();
export type RealtimeOrderCommand = z.infer<typeof realtimeOrderCommandSchema>;

export const realtimeExecutionSchema = z
  .object({
    commandId: idSchema,
    orderId: idSchema,
    executionId: idSchema,
    accountId: idSchema,
    instrumentId: idSchema,
    side: z.enum(['BUY', 'SELL']),
    quantity: decimalSchema,
    price: decimalSchema,
    notional: decimalSchema,
    fee: decimalSchema,
    quoteId: idSchema,
    priceSource: z.literal('TwelveData'),
    priceType: z.literal('LAST'),
    providerTimestamp: timestampSchema,
    receivedAt: timestampSchema,
    status: z.literal('FILLED'),
    createdAt: timestampSchema,
  })
  .strict();
export type RealtimeExecution = z.infer<typeof realtimeExecutionSchema>;
