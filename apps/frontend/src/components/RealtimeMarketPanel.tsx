import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { io, type Socket } from 'socket.io-client';
import {
  initialRealtimeSelection,
  parseRealtimeCatalog,
  parseRealtimeQuote,
  parseRealtimeQuoteSnapshots,
  quoteFreshness,
  realtimeCatalogPath,
  type RealtimeAssetClass,
  type RealtimeInstrument,
  type RealtimeQuote,
} from '../lib/realtime-market';

type Envelope = Readonly<{ data?: unknown }>;
type ConnectionState = 'DISCONNECTED' | 'CONNECTING' | 'CONNECTED';
type CatalogState = 'IDLE' | 'LOADING' | 'READY' | 'FAILED';

export function RealtimeMarketPanel(
  props: Readonly<{ baseUrl: string; apiKey: string; adminApiKey: string }>,
) {
  const [instruments, setInstruments] = useState<readonly RealtimeInstrument[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<readonly string[]>([]);
  const [quotes, setQuotes] = useState<ReadonlyMap<string, RealtimeQuote>>(new Map());
  const [query, setQuery] = useState('BTC/USD');
  const [assetClass, setAssetClass] = useState<'' | RealtimeAssetClass>('CRYPTO');
  const [autoStream, setAutoStream] = useState(true);
  const [catalogState, setCatalogState] = useState<CatalogState>('IDLE');
  const [connection, setConnection] = useState<ConnectionState>('DISCONNECTED');
  const [providerState, setProviderState] = useState('UNKNOWN');
  const [lastCatalogSyncAt, setLastCatalogSyncAt] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  const [clock, setClock] = useState(Date.now());
  const socket = useRef<Socket | undefined>(undefined);

  const apiUrl = useCallback(
    (path: string) => `${props.baseUrl.replace(/\/+$/, '')}${path}`,
    [props.baseUrl],
  );

  const requestJson = useCallback(
    async (path: string, apiKey: string, init?: RequestInit): Promise<unknown> => {
      const response = await fetch(apiUrl(path), {
        ...init,
        credentials: 'include',
        headers: {
          accept: 'application/json',
          ...(apiKey ? { 'x-api-key': apiKey } : {}),
          ...init?.headers,
        },
      });
      const body: unknown = await response.json().catch(() => null);
      if (!response.ok) throw new Error(`Realtime API ${response.status}`);
      return body;
    },
    [apiUrl],
  );

  const loadStatus = useCallback(async () => {
    if (!props.apiKey) return;
    try {
      const body = await requestJson('/api/v1/realtime/market-status', props.apiKey);
      if (isRecord(body)) {
        if (typeof body['state'] === 'string') setProviderState(body['state']);
        setLastCatalogSyncAt(
          typeof body['lastCatalogSyncAt'] === 'string' ? body['lastCatalogSyncAt'] : null,
        );
      }
    } catch {
      setProviderState('UNAVAILABLE');
    }
  }, [props.apiKey, requestJson]);

  const loadCatalog = useCallback(
    async (cursor: string | null, append = false) => {
      if (!props.apiKey) {
        setMessage('Укажите trader API key в настройках консоли.');
        return;
      }
      setCatalogState('LOADING');
      setMessage('');
      try {
        const path = realtimeCatalogPath({
          query,
          assetClass,
          cursor,
          limit: 100,
        });
        const page = parseRealtimeCatalog(await requestJson(path, props.apiKey));
        setInstruments((current) =>
          append ? uniqueInstruments([...current, ...page.items]) : page.items,
        );
        setNextCursor(page.nextCursor);
        if (!append) setSelectedIds(initialRealtimeSelection(page.items));
        setCatalogState('READY');
        if (page.items.length === 0)
          setMessage('Каталог пуст. Включите Twelve Data и дождитесь catalog sync.');
      } catch (error) {
        setCatalogState('FAILED');
        setMessage(error instanceof Error ? error.message : 'Не удалось загрузить каталог');
      }
    },
    [assetClass, props.apiKey, query, requestJson],
  );

  const loadQuotes = useCallback(async () => {
    if (!props.apiKey || selectedIds.length === 0) return;
    try {
      const params = new URLSearchParams({ instrumentIds: selectedIds.join(',') });
      const snapshots = parseRealtimeQuoteSnapshots(
        await requestJson(`/api/v1/realtime/quotes?${params.toString()}`, props.apiKey),
      );
      setQuotes((current) => {
        const next = new Map(current);
        for (const snapshot of snapshots) {
          if (snapshot.quote) next.set(snapshot.instrumentId, snapshot.quote);
          else next.delete(snapshot.instrumentId);
        }
        return next;
      });
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Не удалось загрузить цены');
    }
  }, [props.apiKey, requestJson, selectedIds]);

  const disconnect = useCallback(() => {
    socket.current?.disconnect();
    socket.current = undefined;
    setConnection('DISCONNECTED');
  }, []);

  const connect = useCallback(() => {
    if (!props.apiKey || selectedIds.length === 0) return;
    socket.current?.disconnect();
    setConnection('CONNECTING');
    setMessage('');
    const origin = props.baseUrl.replace(/\/+$/, '') || window.location.origin;
    const client = io(`${origin}/realtime-market-data`, {
      transports: ['websocket'],
      auth: { apiKey: props.apiKey },
      reconnection: true,
      reconnectionDelay: 1_000,
      reconnectionDelayMax: 10_000,
    });
    socket.current = client;
    client.on('connect', () => {
      setConnection('CONNECTED');
      client.emit('realtime.subscribe', {
        requestId: crypto.randomUUID(),
        instrumentIds: selectedIds,
      });
    });
    client.on('disconnect', () => setConnection('DISCONNECTED'));
    client.on('reconnect_attempt', () => setConnection('CONNECTING'));
    client.on('connect_error', () => {
      setConnection('DISCONNECTED');
      setMessage('WebSocket временно недоступен; выполняется автоматический reconnect.');
    });
    client.on('realtime.quote', (envelope: Envelope) => {
      const quote = parseRealtimeQuote(envelope.data);
      if (!quote) return;
      setQuotes((current) => new Map(current).set(quote.instrumentId, quote));
    });
    client.on('realtime.status', (envelope: Envelope) => {
      if (isRecord(envelope.data) && typeof envelope.data['state'] === 'string')
        setProviderState(envelope.data['state']);
    });
    client.on('realtime.error', () => setMessage('Realtime subscription rejected'));
  }, [props.apiKey, props.baseUrl, selectedIds]);

  useEffect(() => {
    const timer = window.setInterval(() => setClock(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    void loadStatus();
    const timer = window.setInterval(() => void loadStatus(), 10_000);
    if (props.apiKey) void loadCatalog(null, false);
    return () => window.clearInterval(timer);
  }, [props.apiKey, loadCatalog, loadStatus]);

  useEffect(() => {
    void loadQuotes();
    const timer = window.setInterval(() => void loadQuotes(), 5_000);
    return () => window.clearInterval(timer);
  }, [loadQuotes]);

  useEffect(() => {
    if (!autoStream || !props.apiKey || selectedIds.length === 0) {
      disconnect();
      return;
    }
    connect();
    return disconnect;
  }, [autoStream, connect, disconnect, props.apiKey, selectedIds.length]);

  async function enablePrice(instrument: RealtimeInstrument): Promise<void> {
    if (!props.adminApiKey) {
      setMessage('Укажите admin API key, чтобы включить price feed.');
      return;
    }
    setMessage('');
    try {
      const body = await requestJson(
        `/api/v1/admin/realtime/instruments/${encodeURIComponent(instrument.id)}/price-enable`,
        props.adminApiKey,
        {
          method: 'POST',
          headers: { 'idempotency-key': `ui-price-enable-${Date.now()}` },
        },
      );
      const updated = parseRealtimeCatalog({ items: [body], nextCursor: null }).items[0];
      if (!updated) throw new Error('Instrument response missing');
      setInstruments((current) => current.map((item) => (item.id === updated.id ? updated : item)));
      setSelectedIds((current) =>
        current.includes(updated.id) || current.length >= 20 ? current : [...current, updated.id],
      );
      setMessage('Price feed включён. Ingest подхватит инструмент при ближайшем reconnect.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Не удалось включить price feed');
    }
  }

  function toggleInstrument(instrument: RealtimeInstrument): void {
    if (!instrument.priceEnabled) return;
    setSelectedIds((current) => {
      if (current.includes(instrument.id)) return current.filter((id) => id !== instrument.id);
      if (current.length >= 20) {
        setMessage('На одно WebSocket-соединение разрешено максимум 20 инструментов.');
        return current;
      }
      return [...current, instrument.id];
    });
  }

  const freshCount = useMemo(
    () => selectedIds.filter((id) => quoteFreshness(quotes.get(id), clock) === 'FRESH').length,
    [clock, quotes, selectedIds],
  );
  const selectedInstruments = useMemo(
    () => selectedIds.map((id) => instruments.find((item) => item.id === id)).filter(isDefined),
    [instruments, selectedIds],
  );

  return (
    <section className="panel realtime-panel" id="realtime-market">
      <div className="panel-title-row">
        <div>
          <p className="eyebrow">Reference market data</p>
          <h2>Twelve Data — live terminal</h2>
          <p className="muted">
            Browser получает каталог и цены только из локального backend cache.
          </p>
        </div>
        <div className="realtime-badges">
          <span className={`quote-state ${providerState.toLowerCase()}`}>{providerState}</span>
          <span className={`quote-state ${connection.toLowerCase()}`}>{connection}</span>
          <span className="quote-state fresh">{freshCount} fresh</span>
        </div>
      </div>

      <div className="realtime-toolbar">
        <label>
          Поиск пары
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="BTC/USD"
          />
        </label>
        <label>
          Класс активов
          <select
            value={assetClass}
            onChange={(event) => setAssetClass(event.target.value as '' | RealtimeAssetClass)}
          >
            <option value="">Все</option>
            <option value="CRYPTO">Crypto</option>
            <option value="FOREX">Forex</option>
            <option value="STOCK">Stocks</option>
            <option value="COMMODITY">Commodities</option>
          </select>
        </label>
        <button disabled={catalogState === 'LOADING'} onClick={() => void loadCatalog(null, false)}>
          {catalogState === 'LOADING' ? 'Загрузка…' : 'Загрузить каталог'}
        </button>
        <button
          disabled={!nextCursor || catalogState === 'LOADING'}
          onClick={() => void loadCatalog(nextCursor, true)}
        >
          Следующая страница
        </button>
        <button
          disabled={selectedIds.length === 0 || connection === 'CONNECTING'}
          onClick={() => {
            setAutoStream(true);
            connect();
          }}
        >
          Переподключить {selectedIds.length} цен
        </button>
        <button
          onClick={() => {
            setAutoStream(false);
            disconnect();
          }}
        >
          Отключить
        </button>
      </div>

      <div className="realtime-summary">
        <span>Инструментов: {instruments.length}</span>
        <span>Выбрано: {selectedIds.length}/20</span>
        <span>
          Catalog sync:{' '}
          {lastCatalogSyncAt ? new Date(lastCatalogSyncAt).toLocaleString() : 'ещё не выполнен'}
        </span>
        <label className="auto-stream-toggle">
          <input
            type="checkbox"
            checked={autoStream}
            onChange={(event) => setAutoStream(event.target.checked)}
          />
          Автоматический live stream
        </label>
      </div>
      {message && <p className="simulation-error">{message}</p>}

      <div className="live-board" aria-live="polite">
        {selectedInstruments.map((instrument) => {
          const quote = quotes.get(instrument.id);
          const freshness = quoteFreshness(quote, clock);
          return (
            <article className={`live-board-card ${freshness.toLowerCase()}`} key={instrument.id}>
              <div>
                <strong>{instrument.displaySymbol}</strong>
                <span>{instrument.exchange ?? 'aggregate'}</span>
              </div>
              <b>{quote?.price ?? '—'}</b>
              <footer>
                <span className={`quote-state ${freshness.toLowerCase()}`}>{freshness}</span>
                <time>{quote ? relativeAge(quote.receivedAt, clock) : 'нет котировки'}</time>
              </footer>
            </article>
          );
        })}
        {selectedInstruments.length === 0 && (
          <p className="realtime-empty">
            Найдите BTC/USD, нажмите «Включить цену» и отметьте пару для live-табло.
          </p>
        )}
      </div>

      <div className="realtime-table-wrap">
        <table className="realtime-table">
          <thead>
            <tr>
              <th>Stream</th>
              <th>Пара</th>
              <th>Площадка</th>
              <th>Класс</th>
              <th>Цена</th>
              <th>Freshness</th>
              <th>Provider time</th>
              <th>Source</th>
              <th>Управление</th>
            </tr>
          </thead>
          <tbody>
            {instruments.map((instrument) => {
              const quote = quotes.get(instrument.id);
              const freshness = quoteFreshness(quote, clock);
              return (
                <tr key={instrument.id}>
                  <td>
                    <input
                      aria-label={`Подписка ${instrument.displaySymbol} ${instrument.exchange ?? ''}`}
                      type="checkbox"
                      checked={selectedIds.includes(instrument.id)}
                      disabled={!instrument.priceEnabled}
                      onChange={() => toggleInstrument(instrument)}
                    />
                  </td>
                  <td>
                    <strong>{instrument.displaySymbol}</strong>
                    <small>{instrument.id}</small>
                  </td>
                  <td>{instrument.exchange ?? 'aggregate'}</td>
                  <td>{instrument.assetClass}</td>
                  <td className="terminal-price">{quote?.price ?? '—'}</td>
                  <td>
                    <span className={`quote-state ${freshness.toLowerCase()}`}>{freshness}</span>
                  </td>
                  <td>{quote ? new Date(quote.providerTimestamp).toLocaleTimeString() : '—'}</td>
                  <td>{quote?.source ?? instrument.source}</td>
                  <td>
                    {instrument.priceEnabled ? (
                      <span className="feed-enabled">price enabled</span>
                    ) : (
                      <button
                        disabled={!props.adminApiKey}
                        onClick={() => void enablePrice(instrument)}
                      >
                        Включить цену
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {instruments.length === 0 && catalogState !== 'LOADING' && (
          <p className="realtime-empty">Инструменты не найдены.</p>
        )}
      </div>
    </section>
  );
}

function uniqueInstruments(values: readonly RealtimeInstrument[]): readonly RealtimeInstrument[] {
  return [...new Map(values.map((value) => [value.id, value])).values()];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined;
}

function relativeAge(receivedAt: string, clock: number): string {
  const age = Math.max(0, Math.floor((clock - Date.parse(receivedAt)) / 1_000));
  return age === 0 ? 'только что' : `${age} сек. назад`;
}
