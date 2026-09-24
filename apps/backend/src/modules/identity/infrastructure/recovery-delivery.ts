import { ConfigService } from '@nestjs/config';
import { createHmac } from 'node:crypto';
import type { RecoveryDelivery } from '../ports/identity.ports';

/** Component fake delivery для тестов; token существует только в памяти процесса. */
export class MemoryRecoveryDelivery implements RecoveryDelivery {
  private readonly deliveries: Array<
    Readonly<{
      kind: 'EMAIL_VERIFY' | 'PASSWORD_RESET';
      email: string;
      token: string;
      expiresAt: string;
    }>
  > = [];
  deliver(
    input: Readonly<{
      kind: 'EMAIL_VERIFY' | 'PASSWORD_RESET';
      email: string;
      token: string;
      expiresAt: string;
    }>,
  ): Promise<void> {
    this.deliveries.push(input);
    return Promise.resolve();
  }
  /** Test helper; production composition никогда не экспортирует этот adapter. */
  takeLast():
    | Readonly<{
        kind: 'EMAIL_VERIFY' | 'PASSWORD_RESET';
        email: string;
        token: string;
        expiresAt: string;
      }>
    | undefined {
    return this.deliveries.pop();
  }
}

/**
 * HTTPS handoff одноразового token из auth-service в доверенный email provider.
 * Payload подписан HMAC, имеет bounded timeout и не записывается в local storage.
 */
export class HttpsRecoveryDelivery implements RecoveryDelivery {
  constructor(private readonly config: ConfigService) {}
  async deliver(
    input: Readonly<{
      kind: 'EMAIL_VERIFY' | 'PASSWORD_RESET';
      email: string;
      token: string;
      expiresAt: string;
    }>,
  ): Promise<void> {
    const body = JSON.stringify(input);
    const signature = createHmac(
      'sha256',
      this.config.getOrThrow<string>('AUTH_RECOVERY_DELIVERY_SECRET'),
    )
      .update(body)
      .digest('base64url');
    const attempts = Number(this.config.get('AUTH_RECOVERY_DELIVERY_MAX_ATTEMPTS', '3'));
    const timeout = Number(this.config.get('AUTH_RECOVERY_DELIVERY_TIMEOUT_MS', '2000'));
    const backoff = Number(this.config.get('AUTH_RECOVERY_DELIVERY_BACKOFF_MS', '100'));
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        const response = await fetch(this.config.getOrThrow<string>('AUTH_RECOVERY_DELIVERY_URL'), {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-auth-signature': signature },
          body,
          signal: AbortSignal.timeout(timeout),
        });
        if (response.ok) return;
        if (response.status < 500) throw new Error('AUTH_RECOVERY_DELIVERY_PERMANENT_FAILURE');
        if (attempt === attempts) throw new Error('AUTH_RECOVERY_DELIVERY_FAILED');
      } catch (error) {
        if (
          attempt === attempts ||
          (error instanceof Error && error.message === 'AUTH_RECOVERY_DELIVERY_PERMANENT_FAILURE')
        )
          throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, backoff * attempt));
    }
    throw new Error('AUTH_RECOVERY_DELIVERY_FAILED');
  }
}
