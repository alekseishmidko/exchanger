import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';

/**
 * Adaptive password KDF на базе scrypt с уникальной солью и deployment pepper.
 * Формат содержит параметры для безопасного повышения cost; pepper берётся только
 * из secret/env и никогда не сериализуется. Сравнение выполняется timing-safe.
 */
@Injectable()
export class PasswordHasher {
  constructor(private readonly config: ConfigService) {}

  /** Создаёт salt и PHC-подобную строку без plaintext password/pepper. */
  async hash(password: string): Promise<string> {
    const salt = randomBytes(16);
    const cost = Number(this.config.get('AUTH_SCRYPT_COST', '16384'));
    const blockSize = 8;
    const parallelization = 1;
    const derived = await this.derive(`${password}\u0000${this.pepper()}`, salt, 32, {
      N: cost,
      r: blockSize,
      p: parallelization,
      maxmem: 64 * 1024 * 1024,
    });
    return `scrypt$${cost}$${blockSize}$${parallelization}$${salt.toString('base64url')}$${derived.toString('base64url')}`;
  }

  /** Проверяет password, не сообщая вызывающему детали несовпадения. */
  async verify(password: string, encoded: string): Promise<boolean> {
    const [algorithm, costValue, blockValue, parallelValue, saltValue, digestValue] =
      encoded.split('$');
    if (
      algorithm !== 'scrypt' ||
      !costValue ||
      !blockValue ||
      !parallelValue ||
      !saltValue ||
      !digestValue
    )
      return false;
    try {
      const expected = Buffer.from(digestValue, 'base64url');
      const actual = await this.derive(
        `${password}\u0000${this.pepper()}`,
        Buffer.from(saltValue, 'base64url'),
        expected.length,
        {
          N: Number(costValue),
          r: Number(blockValue),
          p: Number(parallelValue),
          maxmem: 64 * 1024 * 1024,
        },
      );
      return actual.length === expected.length && timingSafeEqual(actual, expected);
    } catch {
      return false;
    }
  }

  private pepper(): string {
    return this.config.getOrThrow<string>('AUTH_PASSWORD_PEPPER');
  }

  private derive(
    value: string,
    salt: Buffer,
    length: number,
    options: { N: number; r: number; p: number; maxmem: number },
  ): Promise<Buffer> {
    return new Promise((resolve, reject) =>
      scryptCallback(value, salt, length, options, (error, derived) =>
        error ? reject(error) : resolve(derived),
      ),
    );
  }
}
