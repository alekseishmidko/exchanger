import { useEffect, useMemo, useRef, useState } from 'react';
import { io, type Socket } from 'socket.io-client';

type Quote = Readonly<{
  instrumentId: string;
  price: string;
  source: 'TwelveData';
  providerTimestamp: string;
  receivedAt: string;
  expiresAt: string;
  status: 'FRESH' | 'STALE';
}>;

type Envelope = Readonly<{ data?: unknown }>;
type ConnectionState = 'DISCONNECTED' | 'CONNECTING' | 'CONNECTED';

export function RealtimeMarketPanel(props: Readonly<{ baseUrl: string; apiKey: string }>) {
  const [instrumentId, setInstrumentId] = useState('td:forex:aggregate:EUR-USD');
  const [connection, setConnection] = useState<ConnectionState>('DISCONNECTED');
  const [quote, setQuote] = useState<Quote | null>(null);
  const [providerState, setProviderState] = useState('UNKNOWN');
  const [clock, setClock] = useState(Date.now());
  const socket = useRef<Socket | undefined>(undefined);

  useEffect(() => {
    const timer = window.setInterval(() => setClock(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(
    () => () => {
      socket.current?.disconnect();
    },
    [],
  );

  const freshness = useMemo(() => {
    if (!quote) return 'UNAVAILABLE';
    return clock < Date.parse(quote.expiresAt) ? 'FRESH' : 'STALE';
  }, [clock, quote]);

  function connect() {
    socket.current?.disconnect();
    setConnection('CONNECTING');
    const origin = props.baseUrl.replace(/\/+$/, '') || window.location.origin;
    const client = io(`${origin}/realtime-market-data`, {
      transports: ['websocket'],
      auth: { apiKey: props.apiKey },
      reconnection: true,
    });
    socket.current = client;
    client.on('connect', () => {
      setConnection('CONNECTED');
      client.emit('realtime.subscribe', {
        requestId: crypto.randomUUID(),
        instrumentIds: [instrumentId],
      });
    });
    client.on('disconnect', () => setConnection('DISCONNECTED'));
    client.on('connect_error', () => setConnection('DISCONNECTED'));
    client.on('realtime.quote', (envelope: Envelope) => {
      if (isQuote(envelope.data)) setQuote(envelope.data);
    });
    client.on('realtime.status', (envelope: Envelope) => {
      if (isRecord(envelope.data) && typeof envelope.data['state'] === 'string')
        setProviderState(envelope.data['state']);
      if (isRecord(envelope.data) && envelope.data['status'] === 'UNAVAILABLE') setQuote(null);
    });
  }

  return (
    <section className="panel realtime-panel" id="realtime-market">
      <div className="panel-title-row">
        <div>
          <h2>Twelve Data realtime</h2>
          <p className="muted">Локальный cache stream; frontend не подключается к provider.</p>
        </div>
        <div className="realtime-badges">
          <span className={`quote-state ${connection.toLowerCase()}`}>{connection}</span>
          <span className={`quote-state ${freshness.toLowerCase()}`}>{freshness}</span>
        </div>
      </div>
      <div className="realtime-controls">
        <label>
          Local instrumentId
          <input value={instrumentId} onChange={(event) => setInstrumentId(event.target.value)} />
        </label>
        <button disabled={!props.apiKey || connection === 'CONNECTING'} onClick={connect}>
          Подключить stream
        </button>
        <button onClick={() => socket.current?.disconnect()}>Отключить</button>
      </div>
      <div className="realtime-quote-grid">
        <article className="price-card">
          <span>Price</span>
          <strong>{quote?.price ?? '—'}</strong>
        </article>
        <article className="price-card">
          <span>Source</span>
          <strong>{quote?.source ?? '—'}</strong>
        </article>
        <article className="price-card">
          <span>Provider update</span>
          <strong>{quote ? new Date(quote.providerTimestamp).toLocaleTimeString() : '—'}</strong>
        </article>
        <article className="price-card">
          <span>Local receive</span>
          <strong>{quote ? new Date(quote.receivedAt).toLocaleTimeString() : '—'}</strong>
        </article>
        <article className="price-card">
          <span>Provider state</span>
          <strong>{providerState}</strong>
        </article>
      </div>
      {!props.apiKey && <p className="simulation-error">Для WebSocket нужен trader API key.</p>}
    </section>
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isQuote(value: unknown): value is Quote {
  return (
    isRecord(value) &&
    typeof value['instrumentId'] === 'string' &&
    typeof value['price'] === 'string' &&
    value['source'] === 'TwelveData' &&
    typeof value['providerTimestamp'] === 'string' &&
    typeof value['receivedAt'] === 'string' &&
    typeof value['expiresAt'] === 'string'
  );
}
