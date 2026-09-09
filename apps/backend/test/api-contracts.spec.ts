import SwaggerParser from '@apidevtools/swagger-parser';
import { Parser } from '@asyncapi/parser';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  heartbeatSchema,
  marketDataMessageSchema,
  resyncSchema,
  subscriptionSchema,
} from '../src/modules/market-data/market-data.validation';

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
    const source = await readFile(contractPath('asyncapi', 'market-data.yaml'), 'utf8');
    const parser = new Parser();
    const { document, diagnostics } = await parser.parse(source);
    // AsyncAPI Parser использует совместимое с Language Server Protocol значение 0 для error.
    const errors = diagnostics.filter(({ severity }) => Number(severity) === 0);

    expect(errors.map(({ message, path }) => ({ message, path }))).toEqual([]);
    expect(document).toBeDefined();
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
