#!/usr/bin/env node
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_BASE_URL = 'https://api.twelvedata.com';
const DEFAULT_SYMBOL = 'BTC/USD';

/** Выполняет ровно один read-only /quote request и возвращает отчёт без secret/price. */
export async function runTwelveDataLiveSmoke({
  apiKey,
  baseUrl = DEFAULT_BASE_URL,
  symbol = DEFAULT_SYMBOL,
  timeoutMs = 5_000,
  fetchImpl = fetch,
  now = () => new Date(),
}) {
  const normalizedKey = typeof apiKey === 'string' ? apiKey.trim() : '';
  if (normalizedKey.length < 8) throw new Error('TWELVE_DATA_API_KEY_MISSING');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000)
    throw new Error('TWELVE_DATA_LIVE_TIMEOUT_INVALID');
  if (!/^[A-Za-z0-9._-]{1,32}(?:\/[A-Za-z0-9._-]{1,32})?$/u.test(symbol))
    throw new Error('TWELVE_DATA_LIVE_SYMBOL_INVALID');

  const url = new URL('/quote', baseUrl);
  if (url.protocol !== 'https:' || url.origin !== DEFAULT_BASE_URL)
    throw new Error('TWELVE_DATA_LIVE_BASE_URL_INVALID');
  url.searchParams.set('symbol', symbol);
  url.searchParams.set('format', 'JSON');

  let response;
  try {
    response = await fetchImpl(url, {
      method: 'GET',
      headers: { accept: 'application/json', authorization: `apikey ${normalizedKey}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw new Error('TWELVE_DATA_LIVE_NETWORK_ERROR');
  }
  if (!response.ok)
    throw new Error(
      response.status === 429
        ? 'TWELVE_DATA_LIVE_RATE_LIMITED'
        : `TWELVE_DATA_LIVE_HTTP_${response.status}`,
    );

  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new Error('TWELVE_DATA_LIVE_INVALID_JSON');
  }
  if (!isQuotePayload(payload)) throw new Error('TWELVE_DATA_LIVE_INVALID_QUOTE');

  const providerTimestamp = new Date(Number(payload.timestamp) * 1_000);
  if (Number.isNaN(providerTimestamp.getTime()))
    throw new Error('TWELVE_DATA_LIVE_INVALID_TIMESTAMP');
  const report = {
    provider: 'TwelveData',
    endpoint: '/quote',
    symbol,
    status: 'passed',
    providerTimestamp: providerTimestamp.toISOString(),
    receivedAt: now().toISOString(),
    credits: {
      used: boundedCreditHeader(response.headers.get('api-credits-used')),
      left: boundedCreditHeader(response.headers.get('api-credits-left')),
    },
  };
  if (JSON.stringify(report).includes(normalizedKey)) throw new Error('TWELVE_DATA_SECRET_LEAK');
  return report;
}

function isQuotePayload(value) {
  if (typeof value !== 'object' || value === null) return false;
  const price = value.close;
  const timestamp = value.timestamp;
  return (
    (typeof price === 'string' || typeof price === 'number') &&
    Number.isFinite(Number(price)) &&
    Number(price) > 0 &&
    (typeof timestamp === 'string' || typeof timestamp === 'number') &&
    /^\d+$/u.test(String(timestamp)) &&
    Number(timestamp) > 0
  );
}

function boundedCreditHeader(value) {
  return value !== null && /^\d{1,12}$/u.test(value) ? value : null;
}

async function main() {
  const reportDirectory = resolve(
    process.env['TWELVE_DATA_SMOKE_REPORT_DIR'] ?? 'artifacts/twelve-data-smoke',
  );
  await mkdir(reportDirectory, { recursive: true });
  try {
    const report = await runTwelveDataLiveSmoke({
      apiKey: process.env['TWELVE_DATA_API_KEY'],
      symbol: process.env['TWELVE_DATA_SMOKE_SYMBOL'] ?? DEFAULT_SYMBOL,
      timeoutMs: Number(process.env['TWELVE_DATA_REQUEST_TIMEOUT_MS'] ?? 5_000),
    });
    await writeFile(resolve(reportDirectory, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, {
      mode: 0o600,
    });
    process.stdout.write(
      `Twelve Data live smoke passed: ${report.endpoint} ${report.symbol}; report=${reportDirectory}/report.json\n`,
    );
  } catch (error) {
    const code = error instanceof Error ? error.message : 'TWELVE_DATA_LIVE_UNKNOWN_ERROR';
    const failure = { provider: 'TwelveData', status: 'failed', code };
    await writeFile(
      resolve(reportDirectory, 'report.json'),
      `${JSON.stringify(failure, null, 2)}\n`,
      { mode: 0o600 },
    );
    process.stderr.write(`Twelve Data live smoke failed: ${code}\n`);
    process.exitCode = 1;
  }
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) await main();
