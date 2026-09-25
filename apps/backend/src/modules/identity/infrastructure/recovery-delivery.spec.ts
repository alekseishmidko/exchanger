import { ConfigService } from '@nestjs/config';
import { HttpsRecoveryDelivery } from './recovery-delivery';

/** Recovery handoff имеет bounded retry и не повторяет необратимый provider reject. */
describe('HttpsRecoveryDelivery', () => {
  const deliverySigningMaterial = Array.from(
    { length: 4 },
    (_unused, index) => `fixture-part-${index}`,
  ).join(':');
  const config = new ConfigService({
    AUTH_RECOVERY_DELIVERY_SECRET: deliverySigningMaterial,
    AUTH_RECOVERY_DELIVERY_URL: 'https://delivery.example.test/recovery',
    AUTH_RECOVERY_DELIVERY_TIMEOUT_MS: '100',
    AUTH_RECOVERY_DELIVERY_MAX_ATTEMPTS: '2',
    AUTH_RECOVERY_DELIVERY_BACKOFF_MS: '1',
  });
  const input = {
    kind: 'PASSWORD_RESET' as const,
    email: 'user@example.test',
    token: 'one-time-token',
    expiresAt: '2026-09-25T01:00:00.000Z',
  };

  afterEach(() => jest.restoreAllMocks());

  it('retries a transient failure within the configured budget', async () => {
    const fetchMock = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce({ ok: false, status: 503 } as Response)
      .mockResolvedValueOnce({ ok: true, status: 202 } as Response);
    await expect(new HttpsRecoveryDelivery(config).deliver(input)).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not retry a permanent provider rejection', async () => {
    const fetchMock = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue({ ok: false, status: 400 } as Response);
    await expect(new HttpsRecoveryDelivery(config).deliver(input)).rejects.toThrow(
      'AUTH_RECOVERY_DELIVERY_PERMANENT_FAILURE',
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
