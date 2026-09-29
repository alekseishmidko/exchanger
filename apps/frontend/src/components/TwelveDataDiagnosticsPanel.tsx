import { useMemo, useState } from 'react';
import { callApi, prettyJson, type RequestLogEntry } from '../lib/api';

const endpoints = [
  '/quote',
  '/price',
  '/time_series',
  '/eod',
  '/exchange_rate',
  '/cryptocurrencies',
  '/forex_pairs',
  '/stocks',
  '/commodities',
  '/symbol_search',
  '/technical_indicators',
] as const;

type Transport = 'REST' | 'WEBSOCKET';

export function TwelveDataDiagnosticsPanel(
  props: Readonly<{ baseUrl: string; adminApiKey: string }>,
) {
  const [transport, setTransport] = useState<Transport>('REST');
  const [endpoint, setEndpoint] = useState<(typeof endpoints)[number]>('/quote');
  const [symbol, setSymbol] = useState('BTC/USD');
  const [exchange, setExchange] = useState('');
  const [interval, setIntervalValue] = useState('1min');
  const [outputsize, setOutputsize] = useState(10);
  const [page, setPage] = useState(1);
  const [result, setResult] = useState<RequestLogEntry | null>(null);
  const [busy, setBusy] = useState(false);

  const needsSymbol = useMemo(
    () =>
      transport === 'WEBSOCKET' ||
      ['/quote', '/price', '/time_series', '/eod', '/exchange_rate', '/symbol_search'].includes(
        endpoint,
      ),
    [endpoint, transport],
  );

  async function inspect(): Promise<void> {
    if (!props.adminApiKey) return;
    setBusy(true);
    try {
      const body = {
        transport,
        ...(transport === 'REST' ? { endpoint } : {}),
        ...(symbol.trim() ? { symbol: symbol.trim() } : {}),
        ...(exchange.trim() ? { exchange: exchange.trim() } : {}),
        ...(transport === 'REST' && endpoint === '/time_series' ? { interval } : {}),
        ...(transport === 'REST' ? { outputsize, page } : {}),
      };
      setResult(
        await callApi(
          { baseUrl: props.baseUrl, apiKey: props.adminApiKey },
          'POST',
          '/api/v1/admin/realtime/provider-inspect',
          body,
        ),
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel provider-diagnostics" id="twelve-data-diagnostics">
      <div className="panel-title-row">
        <div>
          <p className="eyebrow">Upstream diagnostics</p>
          <h2>Twelve Data API inspector</h2>
          <p className="muted">
            Показывает исходный bounded-ответ провайдера. API key остаётся только в backend.
          </p>
        </div>
        <span className={`quote-state ${result?.ok ? 'fresh' : 'unavailable'}`}>
          {result ? `${result.status}` : 'not run'}
        </span>
      </div>

      <div className="provider-diagnostics-form">
        <label>
          Transport
          <select
            value={transport}
            onChange={(event) => setTransport(event.target.value as Transport)}
          >
            <option value="REST">REST</option>
            <option value="WEBSOCKET">WebSocket price stream</option>
          </select>
        </label>
        <label>
          Endpoint
          {transport === 'WEBSOCKET' ? (
            <input value="/v1/quotes/price" disabled />
          ) : (
            <select
              value={endpoint}
              onChange={(event) => setEndpoint(event.target.value as (typeof endpoints)[number])}
            >
              {endpoints.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
          )}
        </label>
        <label>
          Symbol {needsSymbol ? '*' : ''}
          <input
            value={symbol}
            onChange={(event) => setSymbol(event.target.value)}
            placeholder="BTC/USD"
          />
        </label>
        <label>
          Exchange
          <input
            value={exchange}
            onChange={(event) => setExchange(event.target.value)}
            placeholder="Binance"
          />
        </label>
        <label>
          Interval
          {transport === 'WEBSOCKET' ? (
            <input value="не применяется для WS" disabled />
          ) : (
            <select
              disabled={endpoint !== '/time_series'}
              value={interval}
              onChange={(event) => setIntervalValue(event.target.value)}
            >
              {['1min', '5min', '15min', '30min', '45min', '1h', '2h', '4h', '8h', '1day'].map(
                (value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ),
              )}
            </select>
          )}
        </label>
        <label>
          Output size
          <input
            disabled={transport !== 'REST'}
            type="number"
            min={1}
            max={100}
            value={outputsize}
            onChange={(event) => setOutputsize(Number(event.target.value))}
          />
        </label>
        <label>
          Page
          <input
            disabled={transport !== 'REST'}
            type="number"
            min={1}
            max={1000}
            value={page}
            onChange={(event) => setPage(Number(event.target.value))}
          />
        </label>
        <button
          disabled={busy || !props.adminApiKey || (needsSymbol && !symbol.trim())}
          onClick={inspect}
        >
          {busy ? 'Ожидание upstream…' : 'Выполнить запрос'}
        </button>
      </div>

      {!props.adminApiKey && (
        <p className="simulation-error">Для инспектора нужен Admin API key.</p>
      )}
      <div className="provider-response-meta">
        <span>Backend status: {result?.status ?? '—'}</span>
        <span>Duration: {result ? `${result.durationMs} ms` : '—'}</span>
      </div>
      <pre className="provider-response">
        {result ? prettyJson(result.responseBody) : 'Ответ Twelve Data появится здесь.'}
      </pre>
    </section>
  );
}
