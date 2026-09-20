import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { memo, useMemo } from 'react';
import { RequestLogEntry } from '../lib/api';

type LatencyChartProps = Readonly<{
  entries: readonly RequestLogEntry[];
}>;

/**
 * График latency последних HTTP-запросов.
 *
 * Recharts выбран как готовое решение для быстрой визуальной диагностики:
 * оператор видит скачки времени ответа после place/cancel/admin команд без
 * подключения Prometheus/Grafana. Для production SLO источником истины остаются
 * backend metrics, этот график — только ручной стенд.
 */
function LatencyChartComponent({ entries }: LatencyChartProps) {
  const data = useMemo(
    () =>
      entries
        .slice(0, 20)
        .reverse()
        .map((entry, index) => ({
          name: `${index + 1}`,
          latency: entry.durationMs,
          status: entry.status,
          path: entry.path,
        })),
    [entries],
  );

  return (
    <section className="panel chart-panel">
      <div className="panel-title-row">
        <h2>Latency последних запросов</h2>
        <span className="muted">ms</span>
      </div>
      <div className="chart-box">
        <ResponsiveContainer width="100%" height={220}>
          <LineChart data={data}>
            <CartesianGrid strokeDasharray="3 3" stroke="#263244" />
            <XAxis dataKey="name" stroke="#94a3b8" />
            <YAxis stroke="#94a3b8" />
            <Tooltip
              contentStyle={{ background: '#0f172a', border: '1px solid #334155' }}
              labelStyle={{ color: '#e2e8f0' }}
            />
            <Line
              type="monotone"
              dataKey="latency"
              stroke="#38bdf8"
              strokeWidth={2}
              dot={{ r: 3 }}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </section>
  );
}

/**
 * Recharts заметно тяжелее обычного JSX, поэтому график не должен
 * перерисовываться из-за изменения форм или таблиц. Memo оставляет redraw только
 * на новые entries журнала запросов.
 */
export const LatencyChart = memo(LatencyChartComponent);
