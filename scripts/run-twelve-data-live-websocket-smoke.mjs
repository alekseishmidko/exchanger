#!/usr/bin/env node
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_ENDPOINT = 'wss://ws.twelvedata.com/v1/quotes/price';
const DEFAULT_SYMBOL = 'BTC/USD';

/** Подписывается на один symbol, ждёт ACK и один tick, затем закрывает canary connection. */
export function runTwelveDataLiveWebSocketSmoke({
  apiKey,
  WebSocketImpl,
  endpoint = DEFAULT_ENDPOINT,
  symbol = DEFAULT_SYMBOL,
  timeoutMs = 15_000,
  now = () => new Date(),
}) {
  const normalizedKey = typeof apiKey === 'string' ? apiKey.trim() : '';
  if (normalizedKey.length < 8) return Promise.reject(new Error('TWELVE_DATA_API_KEY_MISSING'));
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000)
    return Promise.reject(new Error('TWELVE_DATA_WS_SMOKE_TIMEOUT_INVALID'));
  if (!/^[A-Za-z0-9._-]{1,32}(?:\/[A-Za-z0-9._-]{1,32})?$/u.test(symbol))
    return Promise.reject(new Error('TWELVE_DATA_LIVE_SYMBOL_INVALID'));
  const url = new URL(endpoint);
  if (url.protocol !== 'wss:' || url.origin !== 'wss://ws.twelvedata.com' || url.pathname !== '/v1/quotes/price')
    return Promise.reject(new Error('TWELVE_DATA_WS_ENDPOINT_INVALID'));
  url.searchParams.set('apikey', normalizedKey);

  return new Promise((resolvePromise, rejectPromise) => {
    const socket = new WebSocketImpl(url, { maxPayload: 64 * 1024, handshakeTimeout: 10_000 });
    let settled = false;
    let acknowledged = false;
    let tickTimestamp;
    const timer = setTimeout(() => fail('TWELVE_DATA_WS_SMOKE_TIMEOUT'), timeoutMs);
    timer.unref();

    function finish() {
      if (settled || !acknowledged || !tickTimestamp) return;
      settled = true;
      clearTimeout(timer);
      const report = {
        provider: 'TwelveData',
        endpoint: '/v1/quotes/price',
        symbol,
        status: 'passed',
        subscriptionStatus: 'ok',
        providerTimestamp: tickTimestamp,
        receivedAt: now().toISOString(),
      };
      socket.close();
      if (JSON.stringify(report).includes(normalizedKey)) {
        rejectPromise(new Error('TWELVE_DATA_SECRET_LEAK'));
        return;
      }
      resolvePromise(report);
    }

    function fail(code) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.close();
      rejectPromise(new Error(code));
    }

    socket.once('open', () => {
      socket.send(JSON.stringify({ action: 'subscribe', params: { symbols: symbol } }));
    });
    socket.on('error', () => fail('TWELVE_DATA_WS_SMOKE_CONNECTION_ERROR'));
    socket.once('close', () => fail('TWELVE_DATA_WS_SMOKE_CLOSED_EARLY'));
    socket.on('message', (raw) => {
      const text = messageText(raw);
      if (Buffer.byteLength(text) > 64 * 1024) {
        fail('TWELVE_DATA_WS_SMOKE_PAYLOAD_TOO_LARGE');
        return;
      }
      let value;
      try {
        value = JSON.parse(text);
      } catch {
        fail('TWELVE_DATA_WS_SMOKE_INVALID_JSON');
        return;
      }
      if (value?.event === 'subscribe-status') {
        const success = Array.isArray(value.success) ? value.success : [];
        const failures = Array.isArray(value.fails) ? value.fails : [];
        if (value.status !== 'ok' || success.length !== 1 || failures.length > 0) {
          fail('TWELVE_DATA_WS_SMOKE_SUBSCRIPTION_REJECTED');
          return;
        }
        acknowledged = true;
        finish();
        return;
      }
      if (value?.event !== 'price') return;
      if (value.symbol !== symbol || !Number.isFinite(Number(value.price)) || Number(value.price) <= 0) {
        fail('TWELVE_DATA_WS_SMOKE_INVALID_TICK');
        return;
      }
      const timestamp = Number(value.timestamp);
      if (!Number.isInteger(timestamp) || timestamp <= 0) {
        fail('TWELVE_DATA_WS_SMOKE_INVALID_TICK');
        return;
      }
      tickTimestamp = new Date(timestamp * 1_000).toISOString();
      finish();
    });
  });
}

function messageText(raw) {
  if (typeof raw === 'string') return raw;
  if (Buffer.isBuffer(raw)) return raw.toString('utf8');
  if (raw instanceof ArrayBuffer) return Buffer.from(raw).toString('utf8');
  return Buffer.concat(raw).toString('utf8');
}

async function main() {
  const reportDirectory = resolve(
    process.env['TWELVE_DATA_SMOKE_REPORT_DIR'] ?? 'artifacts/twelve-data-smoke',
  );
  await mkdir(reportDirectory, { recursive: true });
  try {
    const backendRequire = createRequire(resolve('apps/backend/package.json'));
    const WebSocketImpl = backendRequire('ws');
    const report = await runTwelveDataLiveWebSocketSmoke({
      apiKey: process.env['TWELVE_DATA_API_KEY'],
      symbol: process.env['TWELVE_DATA_SMOKE_SYMBOL'] ?? DEFAULT_SYMBOL,
      timeoutMs: Number(process.env['TWELVE_DATA_WS_SMOKE_TIMEOUT_MS'] ?? 15_000),
      WebSocketImpl,
    });
    await writeFile(
      resolve(reportDirectory, 'websocket-report.json'),
      `${JSON.stringify(report, null, 2)}\n`,
      { mode: 0o600 },
    );
    process.stdout.write(
      `Twelve Data WebSocket smoke passed: ${report.symbol}; report=${reportDirectory}/websocket-report.json\n`,
    );
  } catch (error) {
    const code = error instanceof Error ? error.message : 'TWELVE_DATA_WS_SMOKE_UNKNOWN_ERROR';
    await writeFile(
      resolve(reportDirectory, 'websocket-report.json'),
      `${JSON.stringify({ provider: 'TwelveData', status: 'failed', code }, null, 2)}\n`,
      { mode: 0o600 },
    );
    process.stderr.write(`Twelve Data WebSocket smoke failed: ${code}\n`);
    process.exitCode = 1;
  }
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) await main();
