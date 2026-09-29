import assert from 'node:assert/strict';
import test from 'node:test';
import { runTwelveDataLiveSmoke } from './run-twelve-data-live-smoke.mjs';

test('uses one allow-listed request with header authentication and a secret-free report', async () => {
  const calls = [];
  const report = await runTwelveDataLiveSmoke({
    apiKey: 'provider-secret',
    symbol: 'BTC/USD',
    now: () => new Date('2026-09-29T00:00:01.000Z'),
    fetchImpl: (url, init) => {
      calls.push({ url: String(url), init });
      return Promise.resolve(
        new Response(JSON.stringify({ close: '65000.25', timestamp: 1_800_000_000 }), {
          status: 200,
          headers: { 'api-credits-used': '1', 'api-credits-left': '99' },
        }),
      );
    },
  });

  assert.equal(calls.length, 1);
  const request = new URL(calls[0].url);
  assert.equal(request.origin + request.pathname, 'https://api.twelvedata.com/quote');
  assert.equal(request.searchParams.get('symbol'), 'BTC/USD');
  assert.equal(request.searchParams.has('apikey'), false);
  assert.equal(new Headers(calls[0].init.headers).get('authorization'), 'apikey provider-secret');
  assert.equal(JSON.stringify(report).includes('provider-secret'), false);
  assert.deepEqual(report.credits, { used: '1', left: '99' });
});

test('maps provider and network failures to bounded errors without leaking the key', async () => {
  const secret = 'provider-secret';
  await assert.rejects(
    runTwelveDataLiveSmoke({
      apiKey: secret,
      fetchImpl: () => Promise.reject(new Error(`request failed with ${secret}`)),
    }),
    (error) => error instanceof Error && error.message === 'TWELVE_DATA_LIVE_NETWORK_ERROR',
  );
  await assert.rejects(
    runTwelveDataLiveSmoke({
      apiKey: secret,
      fetchImpl: () => Promise.resolve(new Response('', { status: 429 })),
    }),
    (error) => error instanceof Error && error.message === 'TWELVE_DATA_LIVE_RATE_LIMITED',
  );
});

test('rejects malformed quotes and non-allowlisted targets', async () => {
  await assert.rejects(
    runTwelveDataLiveSmoke({
      apiKey: 'provider-secret',
      fetchImpl: () => Promise.resolve(Response.json({ status: 'error' })),
    }),
    /TWELVE_DATA_LIVE_INVALID_QUOTE/u,
  );
  await assert.rejects(
    runTwelveDataLiveSmoke({
      apiKey: 'provider-secret',
      baseUrl: 'https://example.test',
      fetchImpl: () => {
        throw new Error('must not be called');
      },
    }),
    /TWELVE_DATA_LIVE_BASE_URL_INVALID/u,
  );
});
