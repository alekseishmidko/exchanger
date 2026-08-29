import { Test, TestingModule } from '@nestjs/testing';
import { HealthController } from './health.controller';
import { HealthService } from './health.service';

describe('HealthController', () => {
  let controller: HealthController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [HealthController],
      providers: [
        {
          provide: HealthService,
          useValue: {
            getLiveness: () => ({ status: 'ok' }),
            getReadiness: () => Promise.resolve({ status: 'ok', checks: {} }),
          },
        },
      ],
    }).compile();

    controller = module.get<HealthController>(HealthController);
  });

  it('returns a healthy status', () => {
    expect(controller.getLiveness()).toEqual({ status: 'ok' });
  });

  it('does not expose dependency error details in readiness response', async () => {
    const service = {
      getLiveness: () => ({ status: 'ok' }),
      getReadiness: () =>
        Promise.resolve({
          status: 'unavailable',
          checks: { database: 'failed' },
        }),
    } as unknown as HealthService;
    const failingController = new HealthController(service);

    await expect(failingController.getReadiness()).rejects.toMatchObject({
      response: {
        status: 'unavailable',
        checks: { database: 'failed' },
      },
    });
    await expect(failingController.getReadiness()).rejects.not.toThrow('connection password');
  });
});
