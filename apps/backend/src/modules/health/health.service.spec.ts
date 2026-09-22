import { HealthService } from './application/health.service';
import { ConfigService } from '@nestjs/config';

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

  /** Observability outage виден в checks, но не закрывает business readiness. */
  it('keeps readiness available when a non-critical exporter fails', async () => {
    const service = new HealthService([
      { name: 'postgresql', critical: true, check: () => Promise.resolve() },
      {
        name: 'observability',
        critical: false,
        check: () => Promise.reject(new Error('collector unavailable')),
      },
    ]);
    await expect(service.getReadiness()).resolves.toEqual({
      status: 'ok',
      checks: { postgresql: 'ok', observability: 'failed' },
    });
  });

  /** Hung dependency ограничивается deadline и не удерживает readiness бесконечно. */
  it('bounds a critical dependency probe with timeout', async () => {
    const service = new HealthService(
      [{ name: 'partition-lease', check: () => new Promise(() => undefined) }],
      undefined,
      new ConfigService({ DEPENDENCY_PROBE_TIMEOUT_MS: '5' }),
    );
    await expect(service.getReadiness()).resolves.toEqual({
      status: 'unavailable',
      checks: { 'partition-lease': 'failed' },
    });
  });
});
