import { ConfigService } from '@nestjs/config';
import { PasswordHasher } from './password-hasher';

/** KDF regression: versioned pepper работает, а attacker-controlled параметры bounded. */
describe('PasswordHasher', () => {
  const hasher = new PasswordHasher(
    new ConfigService({
      AUTH_PASSWORD_PEPPER: 'password-pepper-that-is-long-enough-2026',
      AUTH_PASSWORD_PEPPER_VERSION: 'v2',
      AUTH_PASSWORD_PEPPER_SET: JSON.stringify({
        v1: 'previous-password-pepper-that-is-long-enough',
        v2: 'password-pepper-that-is-long-enough-2026',
      }),
      AUTH_SCRYPT_COST: '16384',
    }),
  );

  it('stores pepper version and verifies without serializing pepper', async () => {
    const encoded = await hasher.hash('correct-horse-2026');
    expect(encoded).toMatch(/^scrypt\$v2\$16384\$/);
    expect(encoded).not.toContain('password-pepper');
    expect(hasher.needsRehash(encoded)).toBe(false);
    await expect(hasher.verify('correct-horse-2026', encoded)).resolves.toBe(true);
  });

  it('marks legacy or previous pepper hashes for CAS rehash after successful login', () => {
    expect(
      hasher.needsRehash(
        'scrypt$v1$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      ),
    ).toBe(true);
    expect(hasher.needsRehash('scrypt$16384$8$1$salt$digest')).toBe(true);
  });

  it('rejects hostile encoded cost and digest sizes before scrypt', async () => {
    await expect(hasher.verify('correct-horse-2026', 'scrypt$v2$1048576$8$1$AA$AA')).resolves.toBe(
      false,
    );
  });
});
