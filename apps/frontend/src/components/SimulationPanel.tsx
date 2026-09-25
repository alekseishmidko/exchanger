import { useEffect, useState } from 'react';

type SimulationStatus = Readonly<{
  phase: string;
  running: boolean;
  runId: string | null;
  startedAt: string | null;
  usersReady: number;
  usersTotal: number;
  marketsReady: number;
  ordersSubmitted: number;
  ordersAccepted: number;
  ordersFilled: number;
  ordersRejected: number;
  rounds: number;
  lastRoundAt: string | null;
  prices: Readonly<Record<string, string>>;
  recentErrors: readonly Readonly<{ at: string; scope: string; message: string }>[];
}>;

const emptyStatus: SimulationStatus = {
  phase: 'loading',
  running: false,
  runId: null,
  startedAt: null,
  usersReady: 0,
  usersTotal: 0,
  marketsReady: 0,
  ordersSubmitted: 0,
  ordersAccepted: 0,
  ordersFilled: 0,
  ordersRejected: 0,
  rounds: 0,
  lastRoundAt: null,
  prices: {},
  recentErrors: [],
};

/** Управляет отдельным synthetic-trading worker через development proxy. */
export function SimulationPanel() {
  const [status, setStatus] = useState<SimulationStatus>(emptyStatus);
  const [users, setUsers] = useState(1_000);
  const [seed, setSeed] = useState(42);
  const [ordersPerRound, setOrdersPerRound] = useState(100);
  const [intervalMs, setIntervalMs] = useState(1_000);
  const [requestError, setRequestError] = useState('');

  useEffect(() => {
    let active = true;
    const refresh = async () => {
      try {
        const next = await requestStatus('/simulation/status');
        if (active) {
          setStatus(next);
          setRequestError('');
        }
      } catch (error) {
        if (active)
          setRequestError(error instanceof Error ? error.message : 'Simulation unavailable');
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 1_000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, []);

  async function start() {
    try {
      setRequestError('');
      setStatus(
        await requestStatus('/simulation/start', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ users, seed, ordersPerRound, intervalMs }),
        }),
      );
    } catch (error) {
      setRequestError(error instanceof Error ? error.message : 'Failed to start simulation');
    }
  }

  async function stop() {
    try {
      setStatus(await requestStatus('/simulation/stop', { method: 'POST' }));
    } catch (error) {
      setRequestError(error instanceof Error ? error.message : 'Failed to stop simulation');
    }
  }

  return (
    <section className="panel simulation-panel" id="simulation">
      <div className="panel-title-row">
        <div>
          <p className="eyebrow">Synthetic market</p>
          <h2>Симуляция 1000 пользователей</h2>
          <p className="muted">
            Worker выпускает trader credentials, создаёт и финансирует аккаунты, затем генерирует
            парные BUY/SELL заявки по шести рынкам через публичный API.
          </p>
        </div>
        <span className={`simulation-phase ${status.phase}`}>{status.phase}</span>
      </div>

      <div className="simulation-controls">
        <label>
          Пользователи
          <input
            type="number"
            min="12"
            max="10000"
            value={users}
            onChange={(event) => setUsers(Number(event.target.value))}
          />
        </label>
        <label>
          Seed
          <input
            type="number"
            min="0"
            value={seed}
            onChange={(event) => setSeed(Number(event.target.value))}
          />
        </label>
        <label>
          Заявок за раунд
          <input
            type="number"
            min="2"
            max="2000"
            value={ordersPerRound}
            onChange={(event) => setOrdersPerRound(Number(event.target.value))}
          />
        </label>
        <label>
          Интервал, ms
          <input
            type="number"
            min="100"
            value={intervalMs}
            onChange={(event) => setIntervalMs(Number(event.target.value))}
          />
        </label>
        <button disabled={status.running} onClick={start}>
          Запустить торги
        </button>
        <button className="danger" disabled={!status.running} onClick={stop}>
          Остановить
        </button>
      </div>

      {requestError ? <p className="simulation-error">{requestError}</p> : null}

      <div className="simulation-metrics">
        <Metric label="Пользователи" value={`${status.usersReady}/${status.usersTotal || users}`} />
        <Metric label="Рынки" value={`${status.marketsReady}/6`} />
        <Metric label="Раунды" value={String(status.rounds)} />
        <Metric label="Отправлено" value={String(status.ordersSubmitted)} />
        <Metric label="Принято" value={String(status.ordersAccepted)} />
        <Metric label="Исполнено" value={String(status.ordersFilled)} />
        <Metric label="Отклонено" value={String(status.ordersRejected)} />
      </div>

      <div className="simulation-details">
        <div>
          <h3>Псевдослучайные цены</h3>
          <div className="price-grid">
            {Object.entries(status.prices).map(([instrument, price]) => (
              <div className="price-card" key={instrument}>
                <strong>{instrument}</strong>
                <span>{price}</span>
              </div>
            ))}
          </div>
        </div>
        <div>
          <h3>Последние ошибки</h3>
          {status.recentErrors.length === 0 ? (
            <p className="muted">Ошибок нет.</p>
          ) : (
            <ul className="simulation-errors">
              {status.recentErrors.map((error) => (
                <li key={`${error.at}-${error.scope}`}>
                  <strong>{error.scope}</strong>: {error.message}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </section>
  );
}

function Metric({ label, value }: Readonly<{ label: string; value: string }>) {
  return (
    <div className="metric-card">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

async function requestStatus(path: string, init?: RequestInit): Promise<SimulationStatus> {
  const response = await fetch(path, init);
  const body = (await response.json()) as SimulationStatus & { message?: string };
  if (!response.ok) throw new Error(body.message ?? `Simulation HTTP ${response.status}`);
  return body;
}
