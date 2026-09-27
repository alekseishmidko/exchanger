/**
 * Application layer human authentication.
 *
 * Сервис выполняет полный credential flow после transport validation: создаёт
 * password hash, проверяет login, выпускает и отзывает opaque sessions,
 * обслуживает recovery challenges и фиксирует security-sensitive действия.
 * HTTP cookies и wire DTO здесь намеренно отсутствуют.
 */
import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  Optional,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { AUDIT_LOG_PORT, AuditLogPort } from '../../audit';
import type {
  HumanPrincipal,
  PublicSession,
  PublicUser,
  SessionRecord,
  UserRecord,
} from '@app/modules/identity';
import {
  RECOVERY_DELIVERY,
  RecoveryDelivery,
  SESSION_STORE,
  SessionStore,
  USER_STORE,
  UserStore,
} from '@app/modules/identity';
import { PasswordHasher } from '../security/password-hasher';
import { LOG_EVENTS, StructuredLogger } from '../../observability';
import {
  IDEMPOTENCY_STORE_PORT,
  IdempotencyStorePort,
} from '../../gateway/ports/gateway.idempotency.port';

/** Контекст устройства минимизирует PII: adapter получает только digest IP/UA и короткий label. */
export type SessionContext = Readonly<{
  correlationId: string;
  deviceLabel: string;
  userAgent: string;
  ip: string;
}>;

/** Результат login/register: raw token живёт только до transport header/cookie и не входит в public DTO. */
export type SessionIssueResult = Readonly<{
  token: string;
  user: PublicUser;
  session: PublicSession;
}>;

/**
 * Application service пользовательской identity.
 *
 * Инварианты: email нормализован до storage; ошибки login/reset не подтверждают
 * существование email; session token хранится только у клиента, Redis видит HMAC;
 * live user securityVersion проверяется на каждом запросе; password change
 * немедленно ротирует credential и отзывает stale sessions.
 */
@Injectable()
export class HumanAuthService {
  /**
   * Собирает auth use cases только из портов хранения и security adapters.
   *
   * @param users Source of truth пользовательских records и recovery challenges.
   * @param sessions Source of truth server-side sessions; raw token туда не передаётся.
   * @param passwords Adapter KDF/pepper для hash и constant-work verification.
   * @param config TTL, session limits и секреты HMAC.
   * @param audit Append-only журнал security/admin операций.
   * @param recoveryDelivery Доставка одноразового challenge во внешний канал.
   * @param idempotency Дедупликация административных mutations.
   * @param logger Необязательная operational telemetry без credential payload.
   */
  constructor(
    @Inject(USER_STORE) private readonly users: UserStore,
    @Inject(SESSION_STORE) private readonly sessions: SessionStore,
    private readonly passwords: PasswordHasher,
    private readonly config: ConfigService,
    @Inject(AUDIT_LOG_PORT) private readonly audit: AuditLogPort,
    @Inject(RECOVERY_DELIVERY) private readonly recoveryDelivery: RecoveryDelivery,
    @Inject(IDEMPOTENCY_STORE_PORT) private readonly idempotency: IdempotencyStorePort,
    @Optional() private readonly logger?: StructuredLogger,
  ) {}

  /**
   * Регистрирует пользователя и сразу создаёт server-side session.
   * Password сначала необратимо хешируется, email нормализуется перед storage,
   * затем security event предшествует выдаче нового opaque credential.
   */
  async register(
    input: Readonly<{ email: string; password: string; name: string }>,
    context: SessionContext,
  ): Promise<SessionIssueResult> {
    const passwordHash = await this.passwords.hash(input.password);
    const user = await this.users.create({
      emailNormalized: this.normalizeEmail(input.email),
      name: input.name.trim(),
      passwordHash,
    });
    await this.securityEvent(user.id, 'USER_REGISTERED', context.correlationId);
    return this.issueSession(user, context);
  }

  /**
   * Проверяет password enumeration-resistant способом и выдаёт новый session identifier.
   * Для неизвестного email выполняется та же KDF-проверка на dummy hash; устаревший
   * hash обновляется после успешного входа без изменения публичного результата.
   */
  async login(
    input: Readonly<{ email: string; password: string }>,
    context: SessionContext,
  ): Promise<SessionIssueResult> {
    const user = await this.users.findByEmail(this.normalizeEmail(input.email));
    const fallback = this.config.getOrThrow<string>('AUTH_DUMMY_PASSWORD_HASH');
    const valid = await this.passwords.verify(input.password, user?.passwordHash ?? fallback);
    if (!user || !valid || user.passwordResetRequired) {
      this.logger?.warn('identity', LOG_EVENTS.AUTHENTICATION_REJECTED, {
        outcome: 'rejected',
        correlationId: context.correlationId,
        metadata: { mechanism: 'password' },
      });
      throw new UnauthorizedException({
        code: 'AUTH_INVALID_CREDENTIALS',
        message: 'Authentication failed',
      });
    }
    if (this.passwords.needsRehash(user.passwordHash)) {
      await this.users.rehashPassword(
        user.id,
        user.passwordHash,
        await this.passwords.hash(input.password),
      );
    }
    await this.securityEvent(user.id, 'USER_LOGIN', context.correlationId);
    return this.issueSession(user, context);
  }

  /**
   * Аутентифицирует opaque token через live session и live user record.
   *
   * Проверяет TTL, revoke state и `securityVersion`, продлевает только idle TTL
   * в пределах absolute TTL и возвращает principal без самого credential.
   */
  async authenticate(rawToken: string | undefined): Promise<HumanPrincipal> {
    if (!rawToken || rawToken.length < 32 || rawToken.length > 256) throw this.unauthorized();
    const digest = this.digest(rawToken, 'session');
    const session = await this.sessions.findByTokenDigest(digest);
    if (
      !session ||
      session.revokedAt ||
      Date.parse(session.expiresAt) <= Date.now() ||
      Date.parse(session.absoluteExpiresAt) <= Date.now()
    )
      throw this.unauthorized();
    const user = await this.users.findById(session.userId);
    if (!user || user.securityVersion !== session.securityVersion || user.passwordResetRequired)
      throw this.unauthorized();
    const now = new Date();
    const idleSeconds = Number(this.config.get('AUTH_SESSION_IDLE_TTL_SECONDS', '1800'));
    const expiresAt = new Date(
      Math.min(now.getTime() + idleSeconds * 1000, Date.parse(session.absoluteExpiresAt)),
    );
    const refreshed = {
      ...session,
      lastSeenAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
    };
    const touched = await this.sessions.touch(
      digest,
      refreshed,
      Math.max(1, Math.ceil((expiresAt.getTime() - now.getTime()) / 1000)),
    );
    if (!touched) throw this.unauthorized();
    return {
      kind: 'HUMAN_SESSION',
      sessionId: session.sessionId,
      userId: session.userId,
      roles: user.roles,
      scopes: user.scopes,
      authLevel: session.authLevel,
    };
  }

  /** Возвращает allow-listed profile и capabilities из актуального user state. */
  async me(
    principal: HumanPrincipal,
  ): Promise<{ user: PublicUser; capabilities: readonly string[] }> {
    const user = await this.requireUser(principal.userId);
    return { user: this.publicUser(user), capabilities: [...user.scopes] };
  }

  /** Отзывает текущую сессию без удаления forensic metadata и пишет security event. */
  async logout(principal: HumanPrincipal, correlationId: string): Promise<void> {
    await this.sessions.revoke(principal.userId, principal.sessionId, new Date().toISOString());
    await this.securityEvent(principal.userId, 'SESSION_LOGOUT', correlationId);
  }
  /** Отзывает все сессии, включая текущую, единым storage operation. */
  async logoutAll(principal: HumanPrincipal, correlationId: string): Promise<number> {
    const count = await this.sessions.revokeAll(principal.userId, new Date().toISOString());
    await this.securityEvent(principal.userId, 'ALL_SESSIONS_REVOKED', correlationId);
    return count;
  }

  /** Изменяет только name; security/system fields отсутствуют в input type и результате. */
  async updateProfile(
    principal: HumanPrincipal,
    name: string,
    correlationId: string,
  ): Promise<PublicUser> {
    const user = await this.users.updateName(principal.userId, name.trim());
    await this.securityEvent(principal.userId, 'PROFILE_UPDATED', correlationId);
    return this.publicUser(user);
  }

  /**
   * Проверяет current password, меняет hash и выдаёт новую session.
   * Обновление password увеличивает `securityVersion`; выбранные старые sessions
   * отзываются до выпуска credential, исключая окно использования stale identity.
   */
  async changePassword(
    principal: HumanPrincipal,
    input: Readonly<{ currentPassword: string; newPassword: string; logoutOtherSessions: boolean }>,
    context: SessionContext,
  ): Promise<SessionIssueResult> {
    const current = await this.requireUser(principal.userId);
    if (!(await this.passwords.verify(input.currentPassword, current.passwordHash)))
      throw new ForbiddenException({
        code: 'AUTH_REAUTH_REQUIRED',
        message: 'Re-authentication is required',
      });
    const updated = await this.users.updatePassword(
      current.id,
      await this.passwords.hash(input.newPassword),
    );
    await this.sessions.revokeAll(
      current.id,
      new Date().toISOString(),
      input.logoutOtherSessions ? undefined : principal.sessionId,
    );
    await this.securityEvent(current.id, 'PASSWORD_CHANGED', context.correlationId);
    return this.issueSession(updated, context, 'PASSWORD_REAUTHENTICATED');
  }

  /** Маппит session records владельца в metadata без token digest и device fingerprints. */
  async listSessions(principal: HumanPrincipal): Promise<readonly PublicSession[]> {
    return (await this.sessions.listByUser(principal.userId)).map((item) =>
      this.publicSession(item, item.sessionId === principal.sessionId),
    );
  }
  /** Отзывает принадлежащую principal session и не раскрывает чужие session identifiers. */
  async revokeOwnSession(
    principal: HumanPrincipal,
    sessionId: string,
    correlationId: string,
  ): Promise<void> {
    if (!(await this.sessions.revoke(principal.userId, sessionId, new Date().toISOString())))
      throw new BadRequestException({
        code: 'SESSION_NOT_REVOCABLE',
        message: 'Session cannot be revoked',
      });
    await this.securityEvent(principal.userId, 'SESSION_REVOKED', correlationId);
  }

  /**
   * Создаёт одноразовый recovery challenge без email-enumeration side channel.
   * Для неизвестного email выполняются dummy KDF и decoy delivery; для известного
   * сохраняется только HMAC digest, а ошибка доставки инвалидирует challenge.
   */
  async requestChallenge(kind: 'EMAIL_VERIFY' | 'PASSWORD_RESET', email: string): Promise<void> {
    const startedAt = Date.now();
    this.logger?.info('identity', LOG_EVENTS.AUTH_RECOVERY_REQUESTED, {
      metadata: { kind },
    });
    const user = await this.users.findByEmail(this.normalizeEmail(email));
    if (!user) {
      await this.passwords.verify(
        randomBytes(18).toString('base64url'),
        this.config.getOrThrow('AUTH_DUMMY_PASSWORD_HASH'),
      );
      const ttl = Number(this.config.get('AUTH_RECOVERY_TTL_SECONDS', '900'));
      await this.recoveryDelivery
        .deliver({
          kind,
          email: this.config.get('AUTH_RECOVERY_DECOY_EMAIL', 'noreply@example.invalid'),
          token: randomBytes(32).toString('base64url'),
          expiresAt: new Date(Date.now() + ttl * 1000).toISOString(),
        })
        .catch(() => undefined);
      await this.padRecovery(startedAt);
      return;
    }
    const token = randomBytes(32).toString('base64url');
    const ttl = Number(this.config.get('AUTH_RECOVERY_TTL_SECONDS', '900'));
    const expiresAt = new Date(Date.now() + ttl * 1000).toISOString();
    const digest = this.digest(token, 'recovery');
    await this.users.issueChallenge({
      userId: user.id,
      kind,
      digest,
      expiresAt,
    });
    try {
      await this.recoveryDelivery.deliver({ kind, email: user.emailNormalized, token, expiresAt });
    } catch {
      await this.users.invalidateChallenge(kind, digest);
      this.logger?.failure('identity', LOG_EVENTS.AUTH_RECOVERY_REQUESTED, {
        outcome: 'failure',
        metadata: { kind, dependency: 'delivery' },
      });
    } finally {
      await this.padRecovery(startedAt);
    }
  }

  /** Однократно поглощает verification challenge и отмечает email подтверждённым. */
  async confirmEmail(token: string): Promise<void> {
    const user = await this.users.consumeChallenge('EMAIL_VERIFY', this.digest(token, 'recovery'));
    if (!user) {
      this.recoveryRejected('EMAIL_VERIFY');
      throw this.invalidChallenge();
    }
    await this.users.markEmailVerified(user.id);
  }
  /** Поглощает reset challenge, заменяет password hash и отзывает все старые sessions. */
  async resetPassword(token: string, password: string, correlationId: string): Promise<void> {
    const user = await this.users.completePasswordReset(
      this.digest(token, 'recovery'),
      await this.passwords.hash(password),
    );
    if (!user) {
      this.recoveryRejected('PASSWORD_RESET');
      throw this.invalidChallenge();
    }
    await this.sessions.revokeAll(user.id, new Date().toISOString());
    await this.securityEvent(user.id, 'PASSWORD_RESET', correlationId);
  }

  /** Пишет отдельный low-cardinality security event без token/email/IP. */
  private recoveryRejected(kind: 'EMAIL_VERIFY' | 'PASSWORD_RESET'): void {
    this.logger?.warn('identity', LOG_EVENTS.AUTH_RECOVERY_REJECTED, {
      outcome: 'rejected',
      metadata: { kind },
    });
  }

  /** Выравнивает быстрый unknown-email path с bounded recovery admission budget. */
  private async padRecovery(startedAt: number): Promise<void> {
    const minimum = Number(this.config.get('AUTH_RECOVERY_MIN_RESPONSE_MS', '250'));
    const remaining = minimum - (Date.now() - startedAt);
    if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, remaining));
  }

  /** Проверяет admin principal и возвращает безопасную session metadata целевого пользователя. */
  async adminListSessions(
    actor: HumanPrincipal,
    userId: string,
  ): Promise<readonly PublicSession[]> {
    this.requireAdmin(actor);
    return (await this.sessions.listByUser(userId)).map((item) => this.publicSession(item, false));
  }
  /** Идемпотентно отзывает одну session и записывает actor/reason в audit log. */
  async adminRevoke(
    actor: HumanPrincipal,
    userId: string,
    sessionId: string,
    reason: string,
    commandId: string,
  ): Promise<void> {
    this.requireAdmin(actor);
    await this.idempotency.execute(
      `${actor.userId}:${commandId}`,
      { action: 'revoke-session', userId, sessionId, reason },
      async () => {
        await this.sessions.revoke(userId, sessionId, new Date().toISOString());
        await this.audit.append(
          { actorId: actor.userId, role: 'ADMIN' },
          'ACTION_APPLIED',
          'ADMIN_REVOKE_SESSION',
          commandId,
          sessionId,
          { subjectId: userId, reason },
        );
        return { applied: true };
      },
    );
  }
  /** Идемпотентно отзывает все sessions пользователя и возвращает фактическое число изменений. */
  async adminRevokeAll(
    actor: HumanPrincipal,
    userId: string,
    reason: string,
    commandId: string,
  ): Promise<number> {
    this.requireAdmin(actor);
    const result = await this.idempotency.execute(
      `${actor.userId}:${commandId}`,
      { action: 'revoke-all', userId, reason },
      async () => {
        const count = await this.sessions.revokeAll(userId, new Date().toISOString());
        await this.audit.append(
          { actorId: actor.userId, role: 'ADMIN' },
          'ACTION_APPLIED',
          'ADMIN_REVOKE_ALL_SESSIONS',
          commandId,
          userId,
          { reason, revokedCount: count },
        );
        return { revokedCount: count };
      },
    );
    return result.revokedCount;
  }
  /** Помечает password обязательным к замене и атомарно закрывает существующий session access. */
  async adminRequirePasswordReset(
    actor: HumanPrincipal,
    userId: string,
    reason: string,
    commandId: string,
  ): Promise<void> {
    this.requireAdmin(actor);
    await this.idempotency.execute(
      `${actor.userId}:${commandId}`,
      { action: 'require-password-reset', userId, reason },
      async () => {
        const user = await this.requireUser(userId);
        await this.users.updatePassword(userId, user.passwordHash, true);
        await this.sessions.revokeAll(userId, new Date().toISOString());
        await this.audit.append(
          { actorId: actor.userId, role: 'ADMIN' },
          'ACTION_APPLIED',
          'ADMIN_REQUIRE_PASSWORD_RESET',
          commandId,
          userId,
          { reason },
        );
        return { applied: true };
      },
    );
  }

  /**
   * Создаёт raw token, сохраняет только его HMAC digest и ограничивает число sessions.
   * Raw credential возвращается transport-слою ровно для установки HttpOnly cookie.
   */
  private async issueSession(
    user: UserRecord,
    context: SessionContext,
    authLevel: SessionRecord['authLevel'] = 'PASSWORD',
  ): Promise<SessionIssueResult> {
    const token = randomBytes(32).toString('base64url');
    const now = new Date();
    const idle = Number(this.config.get('AUTH_SESSION_IDLE_TTL_SECONDS', '1800'));
    const absolute = Number(this.config.get('AUTH_SESSION_ABSOLUTE_TTL_SECONDS', '604800'));
    const session: SessionRecord = {
      sessionId: `ses_${randomUUID()}`,
      userId: user.id,
      roles: user.roles,
      scopes: user.scopes,
      authLevel,
      createdAt: now.toISOString(),
      lastSeenAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + idle * 1000).toISOString(),
      absoluteExpiresAt: new Date(now.getTime() + absolute * 1000).toISOString(),
      revokedAt: null,
      device: {
        label: context.deviceLabel.slice(0, 80),
        userAgentDigest: this.digest(context.userAgent, 'metadata'),
        ipPrefixDigest: this.digest(context.ip, 'metadata'),
      },
      correlation: { createdByCorrelationId: context.correlationId },
      securityVersion: user.securityVersion,
    };
    await this.sessions.create(this.digest(token, 'session'), session, Math.min(idle, absolute));
    await this.sessions.trimToLimit(
      user.id,
      Number(this.config.get('AUTH_MAX_SESSIONS_PER_USER', '10')),
      now.toISOString(),
    );
    return { token, user: this.publicUser(user), session: this.publicSession(session, true) };
  }

  /** Канонизирует email одинаково для register, login и recovery lookup. */
  private normalizeEmail(value: string): string {
    return value.trim().normalize('NFKC').toLocaleLowerCase('en-US');
  }
  /** Разделяет HMAC domains по purpose, чтобы digest нельзя было переиспользовать между flows. */
  private digest(value: string, purpose: string): string {
    return createHmac('sha256', this.config.getOrThrow<string>('AUTH_TOKEN_HASH_SECRET'))
      .update(`${purpose}\u0000${value}`)
      .digest('base64url');
  }
  /** Явным allow-list mapping исключает password/security fields из API response. */
  private publicUser(user: UserRecord): PublicUser {
    return {
      id: user.id,
      email: user.emailNormalized,
      name: user.name,
      emailVerified: Boolean(user.emailVerifiedAt),
      createdAt: user.createdAt,
    };
  }
  /** Явным allow-list mapping исключает token digest и device fingerprints. */
  private publicSession(session: SessionRecord, current: boolean): PublicSession {
    return {
      sessionId: session.sessionId,
      current,
      createdAt: session.createdAt,
      lastSeenAt: session.lastSeenAt,
      expiresAt: session.expiresAt,
      revokedAt: session.revokedAt,
      deviceLabel: session.device.label,
    };
  }
  /** Загружает актуального пользователя либо возвращает общую authentication error. */
  private async requireUser(id: string): Promise<UserRecord> {
    const user = await this.users.findById(id);
    if (!user) throw this.unauthorized();
    return user;
  }
  /** Требует одновременно admin role и admin scope, не доверяя только одному claim. */
  private requireAdmin(principal: HumanPrincipal): void {
    if (!principal.roles.includes('ADMIN') || !principal.scopes.includes('admin:*'))
      throw new ForbiddenException({
        code: 'AUTH_ADMIN_REQUIRED',
        message: 'Administrative access is required',
      });
  }
  /** Строит единую session error без раскрытия конкретной причины отказа. */
  private unauthorized(): UnauthorizedException {
    return new UnauthorizedException({
      code: 'AUTH_SESSION_INVALID',
      message: 'Authentication failed',
    });
  }
  /** Строит единую challenge error для expired, consumed и unknown tokens. */
  private invalidChallenge(): BadRequestException {
    return new BadRequestException({
      code: 'AUTH_CHALLENGE_INVALID',
      message: 'Challenge is invalid or expired',
    });
  }
  /** Записывает bounded audit event без email, password, token и network metadata. */
  private async securityEvent(userId: string, action: string, commandId: string): Promise<void> {
    await this.audit.append(
      { actorId: userId, role: 'USER' },
      'SECURITY_EVENT',
      action,
      commandId,
      userId,
      {},
    );
  }
}
