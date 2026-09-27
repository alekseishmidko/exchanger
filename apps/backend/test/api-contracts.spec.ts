import SwaggerParser from '@apidevtools/swagger-parser';
import { Parser } from '@asyncapi/parser';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  heartbeatSchema,
  marketDataMessageSchema,
  resyncSchema,
  subscriptionSchema,
} from '../src/modules/market-data/validation/market-data.validation';
import {
  realtimeExecutionSchema,
  realtimeOrderCommandSchema,
  realtimeQuoteSnapshotSchema,
  realtimeSubscriptionSchema,
  referenceQuoteSchema,
} from '@exchange/contracts';

/** Возвращает абсолютный путь к версионируемому API-контракту из backend test root. */
function contractPath(...segments: string[]): string {
  return resolve(process.cwd(), '../../docs', ...segments);
}

describe('Versioned API contracts', () => {
  it('validates every committed OpenAPI document against the OpenAPI schema', async () => {
    await expect(
      SwaggerParser.validate(contractPath('openapi', 'gateway.yaml')),
    ).resolves.toBeDefined();
    await expect(
      SwaggerParser.validate(contractPath('openapi', 'application.yaml')),
    ).resolves.toBeDefined();
  });

  it('validates AsyncAPI and rejects every parser error diagnostic', async () => {
    for (const file of ['market-data.yaml', 'realtime-market-data.yaml']) {
      const source = await readFile(contractPath('asyncapi', file), 'utf8');
      const parser = new Parser();
      const { document, diagnostics } = await parser.parse(source);
      const errors = diagnostics.filter(({ severity }) => Number(severity) === 0);
      expect(errors.map(({ message, path }) => ({ message, path }))).toEqual([]);
      expect(document).toBeDefined();
    }
  });

  it('keeps realtime subscription and quote contracts strict', () => {
    expect(
      realtimeSubscriptionSchema.safeParse({
        requestId: 'rt-1',
        instrumentIds: ['td:crypto:coinbase:BTC-USD'],
      }).success,
    ).toBe(true);
    expect(
      referenceQuoteSchema.safeParse({
        instrumentId: 'td:crypto:coinbase:BTC-USD',
        quoteId: 'q:1',
        price: '60000.5',
        priceType: 'LAST',
        providerTimestamp: '2026-09-28T00:00:00.000Z',
        receivedAt: '2026-09-28T00:00:00.100Z',
        expiresAt: '2026-09-28T00:00:05.100Z',
        sequence: '1',
        status: 'FRESH',
        source: 'TwelveData',
      }).success,
    ).toBe(true);
  });

  it('keeps realtime execution and unavailable quote wire contracts strict', () => {
    expect(
      realtimeQuoteSnapshotSchema.safeParse({
        instrumentId: 'td:forex:aggregate:EUR-USD',
        status: 'UNAVAILABLE',
        quote: null,
      }).success,
    ).toBe(true);
    const command = {
      commandId: 'command-1',
      orderId: 'order-1',
      accountId: 'account-1',
      instrumentId: 'td:forex:aggregate:EUR-USD',
      side: 'BUY',
      quantity: '1',
      expectedQuoteId: 'quote-1',
    };
    expect(realtimeOrderCommandSchema.safeParse(command).success).toBe(true);
    expect(
      realtimeExecutionSchema.safeParse({
        ...command,
        executionId: 'execution-1',
        price: '1.1',
        notional: '1.1',
        fee: '0',
        quoteId: command.expectedQuoteId,
        priceSource: 'TwelveData',
        priceType: 'LAST',
        providerTimestamp: '2026-09-28T00:00:00.000Z',
        receivedAt: '2026-09-28T00:00:00.100Z',
        status: 'FILLED',
        createdAt: '2026-09-28T00:00:00.200Z',
      }).success,
    ).toBe(false);
    const { expectedQuoteId, ...executionBase } = command;
    expect(
      realtimeExecutionSchema.safeParse({
        ...executionBase,
        executionId: 'execution-1',
        price: '1.1',
        notional: '1.1',
        fee: '0',
        quoteId: expectedQuoteId,
        priceSource: 'TwelveData',
        priceType: 'LAST',
        providerTimestamp: '2026-09-28T00:00:00.000Z',
        receivedAt: '2026-09-28T00:00:00.100Z',
        status: 'FILLED',
        createdAt: '2026-09-28T00:00:00.200Z',
      }).success,
    ).toBe(true);
  });

  it('keeps v1 client commands and public messages runtime-compatible', () => {
    expect(
      subscriptionSchema.safeParse({
        requestId: 'compat-subscribe-v1',
        channel: 'book',
        instrumentId: 'BTC-USD',
      }).success,
    ).toBe(true);
    expect(
      subscriptionSchema.safeParse({
        requestId: 'compat-private-v1',
        channel: 'user',
        userId: 'user-1',
      }).success,
    ).toBe(true);
    expect(
      resyncSchema.safeParse({
        requestId: 'compat-resync-v1',
        instrumentId: 'BTC-USD',
        lastSequence: 41,
      }).success,
    ).toBe(true);
    expect(heartbeatSchema.safeParse({ requestId: 'compat-heartbeat-v1' }).success).toBe(true);
    expect(
      marketDataMessageSchema.safeParse({
        channel: 'book_update',
        instrumentId: 'BTC-USD',
        sequence: 42,
        bids: [{ price: '60000', quantity: '1' }],
        asks: [],
      }).success,
    ).toBe(true);
  });
});
