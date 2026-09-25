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
    return `scrypt$${this.pepperVersion()}$${cost}$${blockSize}$${parallelization}$${salt.toString('base64url')}$${derived.toString('base64url')}`;
  }

  /** Проверяет password, не сообщая вызывающему детали несовпадения. */
  async verify(password: string, encoded: string): Promise<boolean> {
    const parts = encoded.split('$');
    const versioned = parts.length === 7;
    const [
      algorithm,
      versionOrCost,
      costOrBlock,
      blockOrParallel,
      parallelOrSalt,
      saltOrDigest,
      digestTail,
    ] = parts;
    const version = versioned ? versionOrCost : this.pepperVersion();
    const costValue = versioned ? costOrBlock : versionOrCost;
    const blockValue = versioned ? blockOrParallel : costOrBlock;
    const parallelValue = versioned ? parallelOrSalt : blockOrParallel;
    const saltValue = versioned ? saltOrDigest : parallelOrSalt;
    const digestValue = versioned ? digestTail : saltOrDigest;
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
      const salt = Buffer.from(saltValue, 'base64url');
      const cost = Number(costValue);
      const blockSize = Number(blockValue);
      const parallelization = Number(parallelValue);
      if (
        !Number.isInteger(cost) ||
        cost < 16384 ||
        cost > 32768 ||
        (cost & (cost - 1)) !== 0 ||
        blockSize !== 8 ||
        parallelization !== 1 ||
        salt.length !== 16 ||
        expected.length !== 32
      )
        return false;
      const actual = await this.derive(
        `${password}\u0000${this.pepper(version)}`,
        salt,
        expected.length,
        {
          N: cost,
          r: blockSize,
          p: parallelization,
          maxmem: 64 * 1024 * 1024,
        },
      );
      return actual.length === expected.length && timingSafeEqual(actual, expected);
    } catch {
      return false;
    }
  }

  /** Требует opportunistic CAS-rehash при старом pepper/cost/legacy формате. */
  needsRehash(encoded: string): boolean {
    const parts = encoded.split('$');
    return (
      parts.length !== 7 ||
      parts[0] !== 'scrypt' ||
      parts[1] !== this.pepperVersion() ||
      Number(parts[2]) !== Number(this.config.get('AUTH_SCRYPT_COST', '16384'))
    );
  }

  private pepper(version = this.pepperVersion()): string {
    const configured = this.config.get<string>('AUTH_PASSWORD_PEPPER_SET');
    if (configured) {
      const peppers = JSON.parse(configured) as Record<string, string>;
      const selected = peppers[version];
      if (!selected) throw new Error('AUTH_PASSWORD_PEPPER_VERSION_UNKNOWN');
      return selected;
    }
    return this.config.getOrThrow<string>('AUTH_PASSWORD_PEPPER');
  }

  /** Возвращает active version, включаемую в новый encoded hash. */
  private pepperVersion(): string {
    return this.config.get('AUTH_PASSWORD_PEPPER_VERSION', 'v1');
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
