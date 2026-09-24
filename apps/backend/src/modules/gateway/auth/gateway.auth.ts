/**
 * Файл описывает API-key security boundary Gateway.
 *
 * `ApiKeyRegistry` хранит только digest credentials, `ApiKeyGuard` превращает
 * HTTP header в `ApiKeyPrincipal`, а helper-функции выполняют role/object
 * authorization. Здесь не должно быть DTO mapping, idempotency или trading
 * логики: файл отвечает только за identity и authorization decisions.
 */
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
import { HumanSessionGuard } from '../../identity/security/human-session.guard';
import { CsrfGuard } from '../../identity/security/csrf.guard';

/**
 * Principal, полученный из API key после аутентификации.
 *
 * `keyId` используется только для rate limit и технической корреляции; сам секрет
 * API key в principal не сохраняется. `userId` применяется для object authorization,
 * а `admin` получает расширенный доступ согласно политике Gateway.
 */
export type ApiKeyRole = 'trader' | 'admin' | 'risk_manager' | 'auditor' | 'support';

/** Principal не хранит секрет API key и фиксирует роль на момент запроса. */
export type ApiKeyPrincipal = Readonly<{
  keyId: string;
  role: ApiKeyRole;
  userId: string;
  scopes?: readonly string[];
}>;

/** Безопасные metadata API key, доступные административному transport API. */
export type ApiKeyMetadata = Readonly<{
  keyId: string;
  userId: string;
  role: ApiKeyRole;
  label: string;
  ownerType: 'USER' | 'SERVICE' | 'SYSTEM';
  scopes: readonly string[];
  expiresAt: string;
  status: 'ACTIVE' | 'REVOKED';
  createdAt: string;
  rotatedAt: string | null;
  revokedAt: string | null;
  lastUsedAt: string | null;
}>;

/** Результат issue/rotate, содержащий secret ровно в command response. */
export type IssuedApiKey = Readonly<{ apiKey: string; metadata: ApiKeyMetadata }>;

/** Внутренняя credential запись; digest никогда не попадает в публичный DTO. */
export type ApiKeyCredential = Readonly<{ digest: string; metadata: ApiKeyMetadata }>;

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
  protected readonly keyIdByDigest = new Map<string, string>();
  /** Registry metadata и текущего digest по стабильному public key ID. */
  protected readonly credentials = new Map<string, ApiKeyCredential>();

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
        ownerType: 'SYSTEM',
        scopes: entry.scopes ?? this.defaultScopes(entry.role),
        expiresAt: new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000).toISOString(),
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
    if (
      !credential ||
      credential.metadata.status !== 'ACTIVE' ||
      Date.parse(credential.metadata.expiresAt) <= Date.now()
    )
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
      scopes: credential.metadata.scopes,
    };
  }

  /**
   * Выпускает криптографически случайный API key и возвращает secret один раз.
   * Например, последующий `list()` покажет metadata, но не поле `apiKey`.
   */
  issue(
    input: Readonly<{
      userId: string;
      role: ApiKeyRole;
      label: string;
      ownerType?: 'USER' | 'SERVICE' | 'SYSTEM';
      scopes?: readonly string[];
      expiresAt?: string | undefined;
    }>,
    now: Date = new Date(),
  ): Promise<IssuedApiKey> {
    const keyId = `key-${randomUUID()}`;
    const apiKey = `ex_${randomBytes(32).toString('base64url')}`;
    const digest = this.digest(apiKey);
    const metadata: ApiKeyMetadata = {
      keyId,
      userId: input.userId,
      role: input.role,
      label: input.label,
      ownerType: input.ownerType ?? 'USER',
      scopes: input.scopes ?? this.defaultScopes(input.role),
      expiresAt:
        input.expiresAt ?? new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000).toISOString(),
      status: 'ACTIVE',
      createdAt: now.toISOString(),
      rotatedAt: null,
      revokedAt: null,
      lastUsedAt: null,
    };
    this.credentials.set(keyId, { digest, metadata });
    this.keyIdByDigest.set(digest, keyId);
    return Promise.resolve({ apiKey, metadata: { ...metadata } });
  }

  /** Возвращает metadata всех active/revoked keys без digest и secret. */
  list(): Promise<readonly ApiKeyMetadata[]> {
    return Promise.resolve(
      [...this.credentials.values()]
        .map(({ metadata }) => ({ ...metadata }))
        .sort((left, right) => left.keyId.localeCompare(right.keyId)),
    );
  }

  /**
   * Заменяет secret существующего active key, сохраняя стабильный keyId.
   * Старый digest удаляется до возврата результата и сразу перестаёт проходить
   * authentication.
   */
  rotate(keyId: string, now: Date = new Date()): Promise<IssuedApiKey> {
    const credential = this.requireCredential(keyId);
    if (credential.metadata.status === 'REVOKED') {
      throw new ConflictException({ code: 'API_KEY_REVOKED', message: 'API key is revoked' });
    }
    const apiKey = `ex_${randomBytes(32).toString('base64url')}`;
    const digest = this.digest(apiKey);
    const metadata = {
      ...credential.metadata,
      rotatedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000).toISOString(),
      lastUsedAt: null,
    };
    this.keyIdByDigest.delete(credential.digest);
    this.keyIdByDigest.set(digest, keyId);
    this.credentials.set(keyId, { digest, metadata });
    return Promise.resolve({ apiKey, metadata: { ...metadata } });
  }

  /** Отзывает key без удаления metadata, сохраняя административный audit trail. */
  revoke(keyId: string, now: Date = new Date()): Promise<ApiKeyMetadata> {
    const credential = this.requireCredential(keyId);
    if (credential.metadata.status === 'REVOKED')
      return Promise.resolve({ ...credential.metadata });
    const metadata: ApiKeyMetadata = {
      ...credential.metadata,
      status: 'REVOKED',
      revokedAt: now.toISOString(),
    };
    this.keyIdByDigest.delete(credential.digest);
    this.credentials.set(keyId, { ...credential, metadata });
    return Promise.resolve({ ...metadata });
  }

  /** Вычисляет необратимый lookup digest для credential. */
  protected digest(value: string): string {
    return createHash('sha256').update(value).digest('hex');
  }

  /** Назначает минимальный baseline scopes по типу machine identity. */
  private defaultScopes(role: ApiKeyRole): readonly string[] {
    if (role === 'admin') return ['admin:*', 'trading:*'];
    if (role === 'trader') return ['trading:read', 'trading:write'];
    return ['admin:read'];
  }

  /** Возвращает внутреннюю запись либо безопасный 404 без перечисления secret. */
  protected requireCredential(keyId: string): ApiKeyCredential {
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
  constructor(
    private readonly registry: ApiKeyRegistry,
    private readonly humanSessions: HumanSessionGuard,
    private readonly csrf: CsrfGuard,
  ) {}

  /** Читает заголовок API key и прикрепляет проверенный principal к request. */
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context
      .switchToHttp()
      .getRequest<{ headers: Record<string, string | undefined>; principal?: ApiKeyPrincipal }>();
    if (request.headers['x-api-key']) {
      request.principal = this.registry.authenticate(request.headers['x-api-key']);
      return true;
    }
    await this.humanSessions.canActivate(context);
    const human = context
      .switchToHttp()
      .getRequest<{ principal: import('../../identity').HumanPrincipal }>().principal;
    if (human.kind === 'HUMAN_SESSION') this.csrf.canActivate(context);
    request.principal = {
      keyId: `${human.kind.toLowerCase()}:${human.sessionId}`,
      userId: human.userId,
      role: human.roles.includes('ADMIN') ? 'admin' : 'trader',
      scopes: human.scopes,
    };
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

/** Проверяет exact/wildcard scope до object authorization protected endpoint. */
export function assertApiKeyScope(principal: ApiKeyPrincipal, required: string): void {
  const [group] = required.split(':');
  if (
    !principal.scopes?.includes(required) &&
    !principal.scopes?.includes(`${group}:*`) &&
    !principal.scopes?.includes('admin:*')
  ) {
    throw new ForbiddenException({
      code: 'AUTH_SCOPE_REQUIRED',
      message: 'Required scope is missing',
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
