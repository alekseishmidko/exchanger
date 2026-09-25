import { resolve } from 'node:path';
import { validateRuntimeAdapters } from './runtime-adapters';

/** Допустимые режимы запуска backend-приложения. */
export type Environment = 'development' | 'production' | 'test';

/** Набор переменных окружения до преобразования в typed configuration. */
export type EnvironmentConfig = Record<string, unknown>;

/**
 * Формирует детерминированный приоритет конфигурационных файлов окружения.
 *
 * Сначала читается ignored runtime override, затем версионируемый безопасный
 * template того же окружения. Поэтому production никогда не откатывается к
 * development-настройкам, а Jest с `NODE_ENV=test` работает в чистом checkout
 * через `.env.test.example`.
 *
 * @example Для `/repo/apps/backend/src` и `test` будут возвращены
 * `/repo/.env.test`, `/repo/.env.test.example`, `/repo/.env.example`.
 */
export function environmentFilePaths(
  runtimeDirectory: string,
  environment: string = process.env['NODE_ENV'] ?? 'development',
): readonly string[] {
  const root = resolve(runtimeDirectory, '../../..');
  return [
    resolve(root, `.env.${environment}`),
    resolve(root, `.env.${environment}.example`),
    resolve(root, '.env.example'),
  ];
}

/**
 * Проверяет обязательные переменные до создания NestJS application graph.
 *
 * Помимо адреса сервера функция валидирует Swagger/WebSocket/logging и bounded
 * OpenTelemetry queue/timeout. Некорректный OTLP URL или нулевой лимит завершает
 * startup немедленно, поэтому runtime не начинает работу в частично настроенном
 * состоянии. Значения возвращаются без секретного логирования и доступны далее
 * через `ConfigService.getOrThrow`; optional настройки имеют явный fallback.
 *
 * @param config Сырые значения, объединённые ConfigModule по env-file priority.
 * @returns Тот же объект после успешной полной проверки.
 * @throws Error При отсутствующем обязательном поле или небезопасном формате.
 */
export function validateEnvironment(config: EnvironmentConfig): EnvironmentConfig {
  const nodeEnv = config['NODE_ENV'];
  const port = config['PORT'] ?? 5000;

  if (nodeEnv !== 'development' && nodeEnv !== 'production' && nodeEnv !== 'test') {
    throw new Error('NODE_ENV must be development, production, or test');
  }

  if (
    (typeof port !== 'string' && typeof port !== 'number') ||
    (typeof port === 'string' && !/^\d+$/.test(port)) ||
    (typeof port === 'number' && !Number.isInteger(port))
  ) {
    throw new Error('PORT must be an integer');
  }

  const numericPort = Number(port);
  if (numericPort < 1 || numericPort > 65535) {
    throw new Error('PORT must be between 1 and 65535');
  }

  const serviceName = config['SERVICE_NAME'];
  if (typeof serviceName !== 'string' || serviceName.trim() === '') {
    throw new Error('SERVICE_NAME is required');
  }

  const swaggerEnabled = config['SWAGGER_ENABLED'];
  if (
    swaggerEnabled !== undefined &&
    swaggerEnabled !== 'true' &&
    swaggerEnabled !== 'false' &&
    swaggerEnabled !== '1' &&
    swaggerEnabled !== '0'
  ) {
    throw new Error('SWAGGER_ENABLED must be true, false, 1, or 0');
  }

  const swaggerPath = config['SWAGGER_PATH'];
  if (
    swaggerPath !== undefined &&
    (typeof swaggerPath !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9/_-]*$/.test(swaggerPath))
  ) {
    throw new Error('SWAGGER_PATH must be a safe relative URL path');
  }

  const publicUrl = config['APPLICATION_PUBLIC_URL'];
  if (publicUrl !== undefined) {
    if (typeof publicUrl !== 'string') {
      throw new Error('APPLICATION_PUBLIC_URL must be an absolute HTTP(S) URL');
    }
    try {
      const parsed = new URL(publicUrl);
      if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || !parsed.host) {
        throw new Error('unsafe protocol');
      }
    } catch {
      throw new Error('APPLICATION_PUBLIC_URL must be an absolute HTTP(S) URL');
    }
  }

  for (const key of [
    'WEBSOCKET_MAX_SUBSCRIBERS',
    'WEBSOCKET_MAX_PENDING',
    'WEBSOCKET_MAX_CONNECTIONS_PER_IP',
    'WEBSOCKET_MAX_MESSAGES_PER_WINDOW',
    'WEBSOCKET_MESSAGE_WINDOW_MS',
    'WEBSOCKET_MAX_SUBSCRIPTIONS_PER_SOCKET',
  ] as const) {
    const value = config[key];
    if (
      value !== undefined &&
      ((typeof value !== 'string' && typeof value !== 'number') || !/^\d+$/.test(`${value}`))
    ) {
      throw new Error(`${key} must be a positive integer`);
    }
    if (value !== undefined && Number(value) < 1) {
      throw new Error(`${key} must be a positive integer`);
    }
  }

  for (const key of ['LOG_SAMPLE_LIMIT', 'LOG_SAMPLE_WINDOW_MS'] as const) {
    const value = config[key];
    if (
      value !== undefined &&
      ((typeof value !== 'string' && typeof value !== 'number') || !/^\d+$/.test(`${value}`))
    ) {
      throw new Error(`${key} must be a positive integer`);
    }
    if (value !== undefined && Number(value) < 1) {
      throw new Error(`${key} must be a positive integer`);
    }
  }

  for (const key of [
    'GATEWAY_RATE_LIMIT',
    'GATEWAY_RATE_WINDOW_MS',
    'AUTH_RATE_LIMIT',
    'AUTH_RATE_WINDOW_MS',
    'AUTH_RATE_GLOBAL_LIMIT',
    'AUTH_RATE_MAX_BUCKETS',
  ] as const) {
    const value = config[key];
    if (
      value !== undefined &&
      ((typeof value !== 'string' && typeof value !== 'number') || !/^\d+$/.test(`${value}`))
    ) {
      throw new Error(`${key} must be a positive integer`);
    }
    if (value !== undefined && Number(value) < 1) {
      throw new Error(`${key} must be a positive integer`);
    }
  }

  for (const key of [
    'OTEL_BSP_MAX_QUEUE_SIZE',
    'OTEL_BSP_MAX_EXPORT_BATCH_SIZE',
    'OTEL_BSP_SCHEDULE_DELAY',
    'OTEL_BSP_EXPORT_TIMEOUT',
    'OTEL_DIAGNOSTIC_SPAN_LIMIT',
  ] as const) {
    const value = config[key];
    if (
      value !== undefined &&
      ((typeof value !== 'string' && typeof value !== 'number') || !/^\d+$/.test(`${value}`))
    ) {
      throw new Error(`${key} must be a positive integer`);
    }
    if (value !== undefined && Number(value) < 1) {
      throw new Error(`${key} must be a positive integer`);
    }
  }

  const tracesEnabled = config['OTEL_TRACES_ENABLED'];
  if (
    tracesEnabled !== undefined &&
    (typeof tracesEnabled !== 'string' || !['true', 'false', '1', '0'].includes(tracesEnabled))
  ) {
    throw new Error('OTEL_TRACES_ENABLED must be true, false, 1, or 0');
  }

  const tracesEndpoint = config['OTEL_EXPORTER_OTLP_TRACES_ENDPOINT'];
  if (tracesEndpoint !== undefined) {
    if (typeof tracesEndpoint !== 'string') {
      throw new Error('OTEL_EXPORTER_OTLP_TRACES_ENDPOINT must be an absolute HTTP(S) URL');
    }
    try {
      const url = new URL(tracesEndpoint);
      if (!['http:', 'https:'].includes(url.protocol)) throw new Error('unsafe protocol');
    } catch {
      throw new Error('OTEL_EXPORTER_OTLP_TRACES_ENDPOINT must be an absolute HTTP(S) URL');
    }
  }

  const allowedOrigins = config['WEBSOCKET_ALLOWED_ORIGINS'];
  if (
    allowedOrigins !== undefined &&
    (typeof allowedOrigins !== 'string' || !allowedOrigins.trim())
  ) {
    throw new Error('WEBSOCKET_ALLOWED_ORIGINS must be a non-empty comma-separated list');
  }
  const httpOrigins = config['HTTP_ALLOWED_ORIGINS'];
  if (httpOrigins !== undefined && (typeof httpOrigins !== 'string' || !httpOrigins.trim())) {
    throw new Error('HTTP_ALLOWED_ORIGINS must be a non-empty comma-separated list');
  }

  const workersEnabled = config['WORKERS_ENABLED'];
  if (
    workersEnabled !== undefined &&
    (typeof workersEnabled !== 'string' || !['true', 'false', '1', '0'].includes(workersEnabled))
  ) {
    throw new Error('WORKERS_ENABLED must be true, false, 1, or 0');
  }

  for (const key of [
    'WORKER_BATCH_SIZE',
    'WORKER_CONCURRENCY',
    'WORKER_TIMEOUT_MS',
    'WORKER_MAX_ATTEMPTS',
    'WORKER_BASE_BACKOFF_MS',
    'WORKER_MAX_BACKOFF_MS',
    'WORKER_POLL_INTERVAL_MS',
  ] as const) {
    const value = config[key];
    const normalized =
      typeof value === 'string' || typeof value === 'number' ? `${value}` : undefined;
    if (
      value !== undefined &&
      (normalized === undefined || !/^\d+$/.test(normalized) || Number(normalized) < 1)
    ) {
      throw new Error(`${key} must be a positive integer`);
    }
  }

  const runtimeAdapters = validateRuntimeAdapters(config);
  const instanceId =
    config['INSTANCE_ID'] ??
    (runtimeAdapters.RUNTIME_PROFILE === 'component' ? 'component-instance' : undefined);
  if (typeof instanceId !== 'string' || !/^[A-Za-z0-9._-]{1,128}$/.test(instanceId)) {
    throw new Error('INSTANCE_ID is required and must be a safe identifier');
  }
  if (runtimeAdapters.RUNTIME_PROFILE !== 'component') {
    const postgresUrl = config['POSTGRES_URL'];
    if (typeof postgresUrl !== 'string') {
      throw new Error('POSTGRES_URL is required for production-like runtime');
    }
    try {
      const parsed = new URL(postgresUrl);
      if (!['postgres:', 'postgresql:'].includes(parsed.protocol) || !parsed.hostname) {
        throw new Error('invalid PostgreSQL URL');
      }
    } catch {
      throw new Error('POSTGRES_URL must be an absolute PostgreSQL URL');
    }
  }

  for (const key of [
    'POSTGRES_POOL_MAX',
    'POSTGRES_CONNECTION_TIMEOUT_MS',
    'POSTGRES_IDLE_TIMEOUT_MS',
    'POSTGRES_QUERY_TIMEOUT_MS',
    'PARTITION_LEASE_TTL_MS',
    'DEPENDENCY_PROBE_TIMEOUT_MS',
  ] as const) {
    const value = config[key];
    const normalized =
      typeof value === 'string' || typeof value === 'number' ? `${value}` : undefined;
    if (
      value !== undefined &&
      (normalized === undefined || !/^\d+$/.test(normalized) || Number(normalized) < 1)
    ) {
      throw new Error(`${key} must be a positive integer`);
    }
  }

  const componentIdentity = runtimeAdapters.RUNTIME_PROFILE === 'component';
  const tokenTransport = config['AUTH_TOKEN_TRANSPORT'] ?? 'cookie';
  if (tokenTransport !== 'cookie' && tokenTransport !== 'bearer')
    throw new Error('AUTH_TOKEN_TRANSPORT must be cookie or bearer');
  const userStore = config['AUTH_USER_STORE_ADAPTER'] ?? (componentIdentity ? 'memory' : undefined);
  const sessionStore =
    config['AUTH_SESSION_STORE_ADAPTER'] ?? (componentIdentity ? 'memory' : undefined);
  const apiKeyStore =
    config['AUTH_API_KEY_STORE_ADAPTER'] ?? (componentIdentity ? 'memory' : undefined);
  if (userStore !== (componentIdentity ? 'memory' : 'postgres')) {
    throw new Error(
      `AUTH_USER_STORE_ADAPTER must be ${componentIdentity ? 'memory' : 'postgres'} for ${runtimeAdapters.RUNTIME_PROFILE}`,
    );
  }
  if (sessionStore !== (componentIdentity ? 'memory' : 'redis')) {
    throw new Error(
      `AUTH_SESSION_STORE_ADAPTER must be ${componentIdentity ? 'memory' : 'redis'} for ${runtimeAdapters.RUNTIME_PROFILE}`,
    );
  }
  if (apiKeyStore !== (componentIdentity ? 'memory' : 'postgres')) {
    throw new Error(
      `AUTH_API_KEY_STORE_ADAPTER must be ${componentIdentity ? 'memory' : 'postgres'} for ${runtimeAdapters.RUNTIME_PROFILE}`,
    );
  }
  if (!componentIdentity && config['GATEWAY_API_KEYS']) {
    throw new Error(
      'GATEWAY_API_KEYS plaintext configuration is forbidden in production-like runtime',
    );
  }

  for (const key of ['AUTH_PASSWORD_PEPPER', 'AUTH_TOKEN_HASH_SECRET'] as const) {
    const value = config[key];
    if (typeof value !== 'string' || value.length < 32)
      throw new Error(
        `${key} must be supplied by secret storage and contain at least 32 characters`,
      );
  }
  if (config['AUTH_PASSWORD_PEPPER'] === config['AUTH_TOKEN_HASH_SECRET']) {
    throw new Error('AUTH_PASSWORD_PEPPER and AUTH_TOKEN_HASH_SECRET must be independent secrets');
  }
  const pepperVersion = config['AUTH_PASSWORD_PEPPER_VERSION'] ?? 'v1';
  if (typeof pepperVersion !== 'string' || !/^[A-Za-z0-9_-]{1,32}$/.test(pepperVersion))
    throw new Error('AUTH_PASSWORD_PEPPER_VERSION must be a safe identifier');
  const pepperSet = config['AUTH_PASSWORD_PEPPER_SET'];
  if (pepperSet !== undefined) {
    try {
      if (typeof pepperSet !== 'string') throw new Error('invalid pepper set type');
      const set = JSON.parse(pepperSet) as Record<string, unknown>;
      if (
        typeof set[pepperVersion] !== 'string' ||
        String(set[pepperVersion]).length < 32 ||
        Object.values(set).some((value) => typeof value !== 'string' || value.length < 32)
      )
        throw new Error('invalid pepper set');
    } catch {
      throw new Error('AUTH_PASSWORD_PEPPER_SET must contain versioned strong secrets');
    }
  }
  const dummyHash = config['AUTH_DUMMY_PASSWORD_HASH'];
  if (
    typeof dummyHash !== 'string' ||
    !/^scrypt\$(?:[A-Za-z0-9_-]+\$)?\d+\$\d+\$\d+\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]+$/.test(dummyHash)
  ) {
    throw new Error('AUTH_DUMMY_PASSWORD_HASH must be a precomputed scrypt hash');
  }

  for (const key of [
    'AUTH_SESSION_IDLE_TTL_SECONDS',
    'AUTH_SESSION_ABSOLUTE_TTL_SECONDS',
    'AUTH_MAX_SESSIONS_PER_USER',
    'AUTH_RECOVERY_TTL_SECONDS',
    'AUTH_REDIS_CONNECT_TIMEOUT_MS',
    'AUTH_REDIS_COMMAND_TIMEOUT_MS',
    'WEBSOCKET_AUTH_RECHECK_MS',
    'AUTH_RECOVERY_MIN_RESPONSE_MS',
    'AUTH_RECOVERY_DELIVERY_TIMEOUT_MS',
    'AUTH_RECOVERY_DELIVERY_MAX_ATTEMPTS',
    'AUTH_RECOVERY_DELIVERY_BACKOFF_MS',
    'AUTH_RETENTION_INTERVAL_MS',
    'AUTH_RETENTION_BATCH_SIZE',
  ] as const) {
    const value = config[key];
    const normalized =
      typeof value === 'string' || typeof value === 'number' ? `${value}` : undefined;
    if (value !== undefined && (!normalized || !/^\d+$/.test(normalized) || Number(normalized) < 1))
      throw new Error(`${key} must be a positive integer`);
  }
  const idleTtl = Number(config['AUTH_SESSION_IDLE_TTL_SECONDS'] ?? 1800);
  const absoluteTtl = Number(config['AUTH_SESSION_ABSOLUTE_TTL_SECONDS'] ?? 604800);
  if (idleTtl > absoluteTtl)
    throw new Error('AUTH_SESSION_IDLE_TTL_SECONDS cannot exceed absolute TTL');
  const scryptCost = Number(config['AUTH_SCRYPT_COST'] ?? 16384);
  if (
    !Number.isInteger(scryptCost) ||
    scryptCost < 16384 ||
    scryptCost > 32768 ||
    (scryptCost & (scryptCost - 1)) !== 0
  ) {
    throw new Error('AUTH_SCRYPT_COST must be a power of two between 16384 and 32768');
  }

  if (!componentIdentity) {
    if (typeof publicUrl !== 'string' || new URL(publicUrl).protocol !== 'https:')
      throw new Error('APPLICATION_PUBLIC_URL must use HTTPS in production-like runtime');
    for (const key of ['HTTP_ALLOWED_ORIGINS', 'WEBSOCKET_ALLOWED_ORIGINS'] as const) {
      const raw = config[key];
      if (typeof raw !== 'string' || !raw.trim()) throw new Error(`${key} is required`);
      for (const value of raw.split(',')) {
        const candidate = value.trim();
        try {
          const origin = new URL(candidate);
          if (
            origin.protocol !== 'https:' ||
            origin.origin !== candidate ||
            origin.username ||
            origin.password ||
            candidate === 'null' ||
            candidate === '*'
          )
            throw new Error('unsafe origin');
        } catch {
          throw new Error(`${key} must contain exact HTTPS origins only`);
        }
      }
    }
    const trustedProxies = config['TRUSTED_PROXY_CIDRS'];
    if (
      typeof trustedProxies !== 'string' ||
      !trustedProxies.trim() ||
      trustedProxies
        .split(',')
        .some((value) => !/^[0-9a-fA-F:.]+(?:\/\d{1,3})?$/.test(value.trim()))
    ) {
      throw new Error('TRUSTED_PROXY_CIDRS must contain explicit IP/CIDR entries');
    }
    const redisUrl = config['AUTH_REDIS_URL'];
    if (typeof redisUrl !== 'string')
      throw new Error('AUTH_REDIS_URL is required for production-like runtime');
    try {
      const parsed = new URL(redisUrl);
      if (parsed.protocol !== 'rediss:' || !parsed.hostname || !parsed.username || !parsed.password)
        throw new Error('Redis TLS/AUTH required');
    } catch {
      throw new Error(
        'AUTH_REDIS_URL must use rediss:// with authentication in production-like runtime',
      );
    }
    if (tokenTransport === 'cookie') {
      const cookieName = config['AUTH_COOKIE_NAME'];
      const csrfCookieName = config['AUTH_CSRF_COOKIE_NAME'];
      const sameSite = config['AUTH_COOKIE_SAME_SITE'];
      if (
        config['AUTH_COOKIE_SECURE'] !== 'true' ||
        typeof cookieName !== 'string' ||
        !cookieName.startsWith('__Host-') ||
        typeof csrfCookieName !== 'string' ||
        !csrfCookieName.startsWith('__Host-') ||
        (sameSite !== 'Strict' && sameSite !== 'Lax')
      ) {
        throw new Error(
          'production-like cookie auth requires Secure, Strict/Lax and __Host- cookie names',
        );
      }
    }
    const deliveryUrl = config['AUTH_RECOVERY_DELIVERY_URL'];
    if (typeof deliveryUrl !== 'string')
      throw new Error('AUTH_RECOVERY_DELIVERY_URL must be an HTTPS URL in production-like runtime');
    try {
      const parsed = new URL(deliveryUrl);
      if (parsed.protocol !== 'https:') throw new Error('HTTPS required');
    } catch {
      throw new Error('AUTH_RECOVERY_DELIVERY_URL must be an HTTPS URL in production-like runtime');
    }
    const deliverySecret = config['AUTH_RECOVERY_DELIVERY_SECRET'];
    if (typeof deliverySecret !== 'string' || deliverySecret.length < 32) {
      throw new Error('AUTH_RECOVERY_DELIVERY_SECRET must contain at least 32 characters');
    }
    const decoyEmail = config['AUTH_RECOVERY_DECOY_EMAIL'];
    if (typeof decoyEmail !== 'string' || !/^[^@\s]+@[^@\s]+$/.test(decoyEmail))
      throw new Error('AUTH_RECOVERY_DECOY_EMAIL is required for timing-equalized recovery');
  }

  const bypassEnabled = config['AUTH_TEST_BYPASS_ENABLED'] === 'true';
  if (bypassEnabled && (nodeEnv !== 'test' || !componentIdentity)) {
    throw new Error('AUTH test bypass is allowed only in NODE_ENV=test isolated component profile');
  }
  if (
    bypassEnabled &&
    (typeof config['AUTH_TEST_BYPASS_TOKEN'] !== 'string' ||
      String(config['AUTH_TEST_BYPASS_TOKEN']).length < 32)
  ) {
    throw new Error('AUTH_TEST_BYPASS_TOKEN must be supplied as a strong test secret');
  }

  return {
    ...config,
    ...runtimeAdapters,
    INSTANCE_ID: instanceId,
    AUTH_USER_STORE_ADAPTER: userStore,
    AUTH_SESSION_STORE_ADAPTER: sessionStore,
    AUTH_API_KEY_STORE_ADAPTER: apiKeyStore,
    AUTH_TOKEN_TRANSPORT: tokenTransport,
  };
}
