import { HealthService } from './health.service';

describe('HealthService', () => {
  it('does not call dependencies for liveness', () => {
    const check = jest.fn<Promise<void>, []>();
    const service = new HealthService([{ name: 'database', check }]);

    expect(service.getLiveness()).toEqual({ status: 'ok' });
    expect(check).not.toHaveBeenCalled();
  });

  it('reports unavailable when a critical dependency fails', async () => {
    const service = new HealthService([
      { name: 'database', check: () => Promise.resolve() },
      {
        name: 'event-log',
        check: () => Promise.reject(new Error('connection refused')),
      },
    ]);

    await expect(service.getReadiness()).resolves.toEqual({
      status: 'unavailable',
      checks: { database: 'ok', 'event-log': 'failed' },
    });
  });
});
