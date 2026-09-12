import { MetricsService, METRIC_LABEL_POLICY } from './metrics';

describe('Metrics contract and cardinality guards', () => {
  let metrics: MetricsService;

  beforeEach(() => {
    metrics = new MetricsService();
  });

  afterEach(() => metrics?.onModuleDestroy());

  it('registers stable names, types, units and only allow-listed labels', async () => {
    metrics.observeHttp('GET', '/health/live', 200, 12);
    metrics.observeCommand('place', 'accepted');
    metrics.setLag('projection', 'orders', 4);
    const definitions = await metrics.registry.getMetricsAsJSON();
    const custom = definitions.filter(({ name }) => name in METRIC_LABEL_POLICY);

    expect(custom.map(({ name }) => name).sort()).toEqual(Object.keys(METRIC_LABEL_POLICY).sort());
    for (const definition of custom) {
      const allowed = METRIC_LABEL_POLICY[definition.name as keyof typeof METRIC_LABEL_POLICY];
      for (const value of definition.values) {
        expect(
          Object.keys(value.labels)
            .filter((label) => label !== 'service' && label !== 'le')
            .sort(),
        ).toEqual([...allowed].sort());
      }
    }
    expect(
      definitions.find(({ name }) => name === 'exchange_http_request_duration_seconds')?.type,
    ).toBe('histogram');
  });

  it('does not create a series for each unique path ID or unknown reason', async () => {
    for (let index = 0; index < 500; index += 1) {
      const id = `${index.toString(16).padStart(8, '0')}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`;
      metrics.observeHttp('GET', `/api/v1/orders/${id}`, 500, 1);
      metrics.observeCommand('place', 'rejected', `unique-${index}`);
    }
    const definitions = await metrics.registry.getMetricsAsJSON();
    const requests = definitions.find(({ name }) => name === 'exchange_http_requests_total');
    const commands = definitions.find(({ name }) => name === 'exchange_command_total');

    expect(requests?.values).toHaveLength(1);
    expect(requests?.values[0]?.labels['route']).toBe('/api/v1/orders/:id');
    expect(commands?.values).toHaveLength(1);
    expect(commands?.values[0]?.labels['reason']).toBe('unknown');
  });
});
