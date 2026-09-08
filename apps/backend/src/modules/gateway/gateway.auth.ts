import {
  Injectable,
  CanActivate,
  ExecutionContext,
  UnauthorizedException,
  ForbiddenException,
} from '@nestjs/common';

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
  /** Индекс секретного значения ключа; наружу ключ не возвращается. */
  private readonly keys = new Map<string, ApiKeyPrincipal>();

  /** Создаёт registry и регистрирует доступные principals. */
  constructor(entries: readonly ApiKeyPrincipal[] = []) {
    for (const entry of entries) this.keys.set(entry.keyId, entry);
  }

  /** Проверяет API key и возвращает обезличенный principal без публикации секрета. */
  authenticate(value: string | undefined): ApiKeyPrincipal {
    const principal = value ? this.keys.get(value) : undefined;
    if (!principal)
      throw new UnauthorizedException({
        code: 'AUTH_INVALID_API_KEY',
        message: 'Authentication failed',
      });
    return principal;
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
