import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { runTwelveDataLiveWebSocketSmoke } from './run-twelve-data-live-websocket-smoke.mjs';

test('waits for one subscription acknowledgement and one tick without reporting price/key', async () => {
  class SuccessfulSocket extends EventEmitter {
    constructor(url) {
      super();
      this.url = String(url);
      queueMicrotask(() => this.emit('open'));
    }
    send(raw) {
      const request = JSON.parse(raw);
      assert.deepEqual(request, { action: 'subscribe', params: { symbols: 'BTC/USD' } });
      queueMicrotask(() => {
        this.emit(
          'message',
          Buffer.from(
            JSON.stringify({
              event: 'subscribe-status',
              status: 'ok',
              success: [{ symbol: 'BTC/USD' }],
              fails: null,
            }),
          ),
        );
        this.emit(
          'message',
          Buffer.from(
            JSON.stringify({
              event: 'price',
              symbol: 'BTC/USD',
              price: '65000.25',
              timestamp: 1_800_000_000,
            }),
          ),
        );
      });
    }
    close() {}
  }

  const report = await runTwelveDataLiveWebSocketSmoke({
    apiKey: 'provider-secret',
    WebSocketImpl: SuccessfulSocket,
    now: () => new Date('2026-09-29T00:00:01.000Z'),
  });
  assert.equal(report.status, 'passed');
  assert.equal(report.providerTimestamp, '2027-01-15T08:00:00.000Z');
  assert.equal(JSON.stringify(report).includes('65000.25'), false);
  assert.equal(JSON.stringify(report).includes('provider-secret'), false);
});

test('fails closed on a partial subscription with a bounded secret-free error', async () => {
  class RejectedSocket extends EventEmitter {
    constructor() {
      super();
      queueMicrotask(() => this.emit('open'));
    }
    send() {
      queueMicrotask(() =>
        this.emit(
          'message',
          Buffer.from(
            JSON.stringify({
              event: 'subscribe-status',
              status: 'warning',
              success: [],
              fails: [{ symbol: 'BTC/USD' }],
            }),
          ),
        ),
      );
    }
    close() {}
  }

  await assert.rejects(
    runTwelveDataLiveWebSocketSmoke({
      apiKey: 'provider-secret',
      WebSocketImpl: RejectedSocket,
    }),
    (error) =>
      error instanceof Error && error.message === 'TWELVE_DATA_WS_SMOKE_SUBSCRIPTION_REJECTED',
  );
});
