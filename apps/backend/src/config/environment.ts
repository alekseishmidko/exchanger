/** Допустимые режимы запуска backend-приложения. */
export type Environment = 'development' | 'production' | 'test';

/** Набор переменных окружения до преобразования в typed configuration. */
export type EnvironmentConfig = Record<string, unknown>;

/** Проверяет обязательные переменные и диапазон порта до старта NestJS. */
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

  return config;
}
