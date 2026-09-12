import { resolve } from 'node:path';

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

  for (const key of ['WEBSOCKET_MAX_SUBSCRIBERS', 'WEBSOCKET_MAX_PENDING'] as const) {
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

  return config;
}
