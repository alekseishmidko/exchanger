/** Публичные роли пользователя. Внутренние служебные роли не сериализуются в profile DTO. */
export type UserRole = 'USER' | 'ADMIN' | 'SUPPORT' | 'RISK_MANAGER' | 'AUDITOR';

/** Состояние пользователя, необходимое authentication service, но не HTTP-клиенту. */
export type UserRecord = Readonly<{
  id: string;
  emailNormalized: string;
  name: string;
  passwordHash: string;
  roles: readonly UserRole[];
  scopes: readonly string[];
  emailVerifiedAt: string | null;
  passwordResetRequired: boolean;
  securityVersion: number;
  createdAt: string;
  updatedAt: string;
}>;

/** Безопасное представление пользователя: hash, flags и normalized email исключены. */
export type PublicUser = Readonly<{
  id: string;
  email: string;
  name: string;
  emailVerified: boolean;
  createdAt: string;
}>;

/** Уровень подтверждения identity, зафиксированный при создании сессии. */
export type AuthenticationLevel = 'PASSWORD' | 'PASSWORD_REAUTHENTICATED';

/**
 * Server-side session record. Raw cookie/bearer token здесь принципиально отсутствует:
 * lookup выполняется по keyed digest, поэтому Redis dump не раскрывает credentials.
 */
export type SessionRecord = Readonly<{
  sessionId: string;
  userId: string;
  roles: readonly UserRole[];
  scopes: readonly string[];
  authLevel: AuthenticationLevel;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  absoluteExpiresAt: string;
  revokedAt: string | null;
  device: Readonly<{ label: string; userAgentDigest: string; ipPrefixDigest: string }>;
  correlation: Readonly<{
    createdByCorrelationId: string;
    tokenDigest?: string;
    revokeGeneration?: string;
  }>;
  securityVersion: number;
}>;

/** Principal создаётся только guard-ом после live lookup session state. */
export type HumanPrincipal = Readonly<{
  kind: 'HUMAN_SESSION' | 'TEST_BYPASS';
  sessionId: string;
  userId: string;
  roles: readonly UserRole[];
  scopes: readonly string[];
  authLevel: AuthenticationLevel;
}>;

/** Allow-listed session metadata для self-service/admin responses. */
export type PublicSession = Readonly<{
  sessionId: string;
  current: boolean;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  revokedAt: string | null;
  deviceLabel: string;
}>;
