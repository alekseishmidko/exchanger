import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';
import { ALERT_NAMES, evaluateAlerts, NORMAL_SIGNALS } from './alert-policy';

/** Возвращает путь от backend package к repository root fixture. */
const repositoryFile = (path: string): string => resolve(__dirname, '../../../../..', path);

/** Безопасно сужает YAML unknown node до object map. */
const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Object expected');
  return value as Record<string, unknown>;
};

describe('Observability as code', () => {
  it('versions valid collector, Prometheus and Tempo configurations', () => {
    for (const file of [
      'deploy/observability/otel-collector.yaml',
      'deploy/observability/prometheus.yaml',
      'deploy/observability/tempo.yaml',
      'deploy/observability/alertmanager.yaml',
    ]) {
      expect(parse(readFileSync(repositoryFile(file), 'utf8'))).toEqual(expect.any(Object));
    }
  });

  it('requires owner, severity, runbook and diagnostic context on every alert', () => {
    const parsed: unknown = parse(
      readFileSync(repositoryFile('deploy/observability/alerts.yaml'), 'utf8'),
    ) as unknown;
    const document = parsed as { groups: Array<{ rules: Array<Record<string, unknown>> }> };
    const rules = document.groups.flatMap(({ rules }) => rules);

    expect(rules.map(({ alert }) => alert).sort()).toEqual([...ALERT_NAMES].sort());
    for (const rule of rules) {
      expect(rule['expr']).toEqual(expect.any(String));
      const labels = record(rule['labels']);
      const annotations = record(rule['annotations']);
      expect(typeof labels['owner']).toBe('string');
      expect(typeof labels['severity']).toBe('string');
      expect(annotations['runbook_url']).toEqual(expect.stringMatching(/^https:\/\//));
      expect(typeof annotations['diagnostic_context']).toBe('string');
    }
  });

  it('moves every synthetic alert from resolved to firing and back', () => {
    expect(Object.values(evaluateAlerts(NORMAL_SIGNALS))).not.toContain(true);
    const degraded = {
      ...NORMAL_SIGNALS,
      availabilityErrorRatio: 1,
      infrastructureRejectionRatio: 1,
      settlementInvariantFailures: 1,
      reconciliationDifferences: 1,
      marketDataSaturation: 1,
      marketDataGaps: 1,
      projectionLag: 10_000,
      backendUp: false,
      telemetryExportFailures: 100,
    };
    expect(Object.values(evaluateAlerts(degraded))).not.toContain(false);
    expect(Object.values(evaluateAlerts(NORMAL_SIGNALS))).not.toContain(true);
  });

  it('renders meaningful empty, normal and degraded dashboard states', () => {
    const dashboard = JSON.parse(
      readFileSync(
        repositoryFile('deploy/observability/grafana/dashboards/exchange-overview.json'),
        'utf8',
      ),
    ) as { panels: Array<Record<string, unknown>> };
    expect(dashboard.panels.length).toBeGreaterThanOrEqual(5);
    for (const panel of dashboard.panels) {
      const defaults = (panel['fieldConfig'] as { defaults?: Record<string, unknown> }).defaults;
      expect(defaults?.['noValue']).toEqual(expect.any(String));
    }
    expect(JSON.stringify(dashboard)).toContain('thresholds');
  });
});
