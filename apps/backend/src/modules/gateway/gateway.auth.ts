import {
  CanActivate,
  ConflictException,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { createHash, randomBytes, randomUUID } from 'node:crypto';

/**
 * Principal, полученный из API key после аутентификации.
 *
 * `keyId` используется только для rate limit и технической корреляции; сам секрет
 * API key в principal не сохраняется. `userId` применяется для object authorization,
 * а `admin` получает расширенный доступ согласно политике Gateway.
 */
export type ApiKeyRole = 'trader' | 'admin' | 'risk_manager' | 'auditor' | 'support';

/** Principal не хранит секрет API key и фиксирует роль на момент запроса. */
export type ApiKeyPrincipal = Readonly<{ keyId: string; role: ApiKeyRole; userId: string }>;

/** Безопасные metadata API key, доступные административному transport API. */
export type ApiKeyMetadata = Readonly<{
  keyId: string;
  userId: string;
  role: ApiKeyRole;
  label: string;
  status: 'ACTIVE' | 'REVOKED';
  createdAt: string;
  rotatedAt: string | null;
  revokedAt: string | null;
  lastUsedAt: string | null;
}>;

/** Результат issue/rotate, содержащий secret ровно в command response. */
export type IssuedApiKey = Readonly<{ apiKey: string; metadata: ApiKeyMetadata }>;

/** Внутренняя credential запись; digest никогда не попадает в публичный DTO. */
type ApiKeyCredential = Readonly<{ digest: string; metadata: ApiKeyMetadata }>;

/**
 * Registry API keys для development/reference deployment.
 *
 * На вход конструктор получает уже разобранные записи, а не секреты из request.
 * В production registry должен читать хешированные ключи из secret manager и
 * поддерживать rotation/revocation. In-memory `Map` используется только для
 * воспроизводимых локальных тестов.
 */
@Injectable()
export class ApiKeyRegistry {
  /** Индекс SHA-256 digest → public key ID; plaintext credentials не хранятся. */
  private readonly keyIdByDigest = new Map<string, string>();
  /** Registry metadata и текущего digest по стабильному public key ID. */
  private readonly credentials = new Map<string, ApiKeyCredential>();

  /** Создаёт registry и регистрирует доступные principals. */
  constructor(entries: readonly ApiKeyPrincipal[] = [], now: Date = new Date()) {
    entries.forEach((entry, index) => {
      const digest = this.digest(entry.keyId);
      const keyId = `configured-${index + 1}`;
      const metadata: ApiKeyMetadata = {
        keyId,
        userId: entry.userId,
        role: entry.role,
        label: `configured-${index + 1}`,
        status: 'ACTIVE',
        createdAt: now.toISOString(),
        rotatedAt: null,
        revokedAt: null,
        lastUsedAt: null,
      };
      this.credentials.set(keyId, { digest, metadata });
      this.keyIdByDigest.set(digest, keyId);
    });
  }

  /**
   * Проверяет SHA-256 digest API key и возвращает principal без секрета.
   * Последнее использование обновляется только в metadata; raw credential не
   * сохраняется ни при успешной, ни при ошибочной попытке.
   */
  authenticate(value: string | undefined): ApiKeyPrincipal {
    const digest = value ? this.digest(value) : undefined;
    const keyId = digest ? this.keyIdByDigest.get(digest) : undefined;
    const credential = keyId ? this.credentials.get(keyId) : undefined;
    if (!credential || credential.metadata.status !== 'ACTIVE')
      throw new UnauthorizedException({
        code: 'AUTH_INVALID_API_KEY',
        message: 'Authentication failed',
      });
    this.credentials.set(credential.metadata.keyId, {
      ...credential,
      metadata: { ...credential.metadata, lastUsedAt: new Date().toISOString() },
    });
    return {
      keyId: credential.metadata.keyId,
      role: credential.metadata.role,
      userId: credential.metadata.userId,
    };
  }

  /**
   * Выпускает криптографически случайный API key и возвращает secret один раз.
   * Например, последующий `list()` покажет metadata, но не поле `apiKey`.
   */
  issue(
    input: Readonly<{ userId: string; role: ApiKeyRole; label: string }>,
    now: Date = new Date(),
  ): IssuedApiKey {
    const keyId = `key-${randomUUID()}`;
    const apiKey = `ex_${randomBytes(32).toString('base64url')}`;
    const digest = this.digest(apiKey);
    const metadata: ApiKeyMetadata = {
      keyId,
      ...input,
      status: 'ACTIVE',
      createdAt: now.toISOString(),
      rotatedAt: null,
      revokedAt: null,
      lastUsedAt: null,
    };
    this.credentials.set(keyId, { digest, metadata });
    this.keyIdByDigest.set(digest, keyId);
    return { apiKey, metadata: { ...metadata } };
  }

  /** Возвращает metadata всех active/revoked keys без digest и secret. */
  list(): readonly ApiKeyMetadata[] {
    return [...this.credentials.values()]
      .map(({ metadata }) => ({ ...metadata }))
      .sort((left, right) => left.keyId.localeCompare(right.keyId));
  }

  /**
   * Заменяет secret существующего active key, сохраняя стабильный keyId.
   * Старый digest удаляется до возврата результата и сразу перестаёт проходить
   * authentication.
   */
  rotate(keyId: string, now: Date = new Date()): IssuedApiKey {
    const credential = this.requireCredential(keyId);
    if (credential.metadata.status === 'REVOKED') {
      throw new ConflictException({ code: 'API_KEY_REVOKED', message: 'API key is revoked' });
    }
    const apiKey = `ex_${randomBytes(32).toString('base64url')}`;
    const digest = this.digest(apiKey);
    const metadata = { ...credential.metadata, rotatedAt: now.toISOString(), lastUsedAt: null };
    this.keyIdByDigest.delete(credential.digest);
    this.keyIdByDigest.set(digest, keyId);
    this.credentials.set(keyId, { digest, metadata });
    return { apiKey, metadata: { ...metadata } };
  }

  /** Отзывает key без удаления metadata, сохраняя административный audit trail. */
  revoke(keyId: string, now: Date = new Date()): ApiKeyMetadata {
    const credential = this.requireCredential(keyId);
    if (credential.metadata.status === 'REVOKED') return { ...credential.metadata };
    const metadata: ApiKeyMetadata = {
      ...credential.metadata,
      status: 'REVOKED',
      revokedAt: now.toISOString(),
    };
    this.keyIdByDigest.delete(credential.digest);
    this.credentials.set(keyId, { ...credential, metadata });
    return { ...metadata };
  }

  /** Вычисляет необратимый lookup digest для credential. */
  private digest(value: string): string {
    return createHash('sha256').update(value).digest('hex');
  }

  /** Возвращает внутреннюю запись либо безопасный 404 без перечисления secret. */
  private requireCredential(keyId: string): ApiKeyCredential {
    const credential = this.credentials.get(keyId);
    if (!credential)
      throw new NotFoundException({ code: 'API_KEY_NOT_FOUND', message: 'API key was not found' });
    return credential;
  }
}

/**
 * Guard, выполняющий authentication до controller handler.
 *
 * Порядок запроса: заголовок `x-api-key` → registry → principal в request →
 * controller authorization. При неизвестном или отсутствующем ключе обработчик
 * не вызывается и клиент получает безопасный `401` без причины, раскрывающей
 * содержимое registry.
 */
@Injectable()
export class ApiKeyGuard implements CanActivate {
  constructor(private readonly registry: ApiKeyRegistry) {}

  /** Читает заголовок API key и прикрепляет проверенный principal к request. */
  canActivate(context: ExecutionContext): boolean {
    const request = context
      .switchToHttp()
      .getRequest<{ headers: Record<string, string | undefined>; principal?: ApiKeyPrincipal }>();
    request.principal = this.registry.authenticate(request.headers['x-api-key']);
    return true;
  }
}

/**
 * Выполняет object-level authorization.
 *
 * Trader может работать только с ресурсом своего `userId`; admin проходит эту
 * проверку. Например, `trader:u-1` получает доступ к `u-1`, но запрос к `u-2`
 * завершается кодом `AUTH_OBJECT_FORBIDDEN`.
 */
export function assertObjectAccess(principal: ApiKeyPrincipal, resourceUserId: string): void {
  if (principal.role !== 'admin' && principal.userId !== resourceUserId) {
    throw new ForbiddenException({
      code: 'AUTH_OBJECT_FORBIDDEN',
      message: 'Resource access denied',
    });
  }
}

/**
 * Проверяет доступ к административному transport boundary.
 *
 * Проверка выполняется до mapping DTO в доменную команду, поэтому trader не
 * может инициировать изменение policy, lifecycle или ledger даже при знании URL.
 */
export function assertAdminAccess(principal: ApiKeyPrincipal): void {
  if (principal.role !== 'admin') {
    throw new ForbiddenException({
      code: 'AUTH_ADMIN_REQUIRED',
      message: 'Administrative access is required',
    });
  }
}

/**
 * Пропускает identity административного контура к детальной domain role matrix.
 *
 * Итоговое разрешение операции остаётся за `AdminService`: auditor может читать
 * reconciliation, risk manager — менять risk policy, а support получает
 * аудируемый отказ. Trader отсекается до построения административной команды.
 */
export function assertAdministrativeAccess(principal: ApiKeyPrincipal): void {
  if (principal.role === 'trader') {
    throw new ForbiddenException({
      code: 'AUTH_ADMINISTRATIVE_IDENTITY_REQUIRED',
      message: 'Administrative identity is required',
    });
  }
}
