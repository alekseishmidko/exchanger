import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { AppModule } from './app.module';
import { configureSwagger } from './config/swagger';
import { LOG_EVENTS, StructuredLogger } from './modules/observability';

/**
 * Создаёт HTTP/WebSocket приложение и сообщает адреса только после успешного
 * bind сетевого порта. Благодаря этому сообщение «сервер запущен» не появляется,
 * если порт занят или конфигурация заблокировала startup.
 *
 * `APPLICATION_PUBLIC_URL` нужен для Docker/reverse proxy, где внешний адрес
 * отличается от bind address. Без него локальный запуск использует
 * `http://localhost:${PORT}`.
 *
 * @example
 * При Docker mapping `5001:5000` приложение продолжает слушать
 * `0.0.0.0:5000`, но `APPLICATION_PUBLIC_URL=http://localhost:5001` заставляет
 * startup log и ссылку Swagger указывать доступный пользователю порт `5001`.
 */
async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({ bodyLimit: 16 * 1024 }),
    { bufferLogs: true },
  );
  const config = app.get(ConfigService);
  const logger = app.get(StructuredLogger);
  app.useLogger(logger);
  app.flushLogs();
  app.enableShutdownHooks();
  const environment = config.getOrThrow<string>('NODE_ENV');
  const port = config.get<number>('PORT', 5000);
  const host = config.get<string>('HOST', '0.0.0.0');

  const swagger = configureSwagger(app, config);

  await app.listen(port, host);

  const publicUrl = config
    .get<string>('APPLICATION_PUBLIC_URL', `http://localhost:${port}`)
    .replace(/\/+$/, '');
  logger.info('bootstrap', LOG_EVENTS.SYSTEM_STARTED, {
    metadata: {
      message: `Сервер запущен: ${publicUrl}`,
      bindAddress: `${host}:${port}`,
      publicUrl,
      buildVersion: logger.getBuildVersion(),
      environment,
    },
  });

  if (swagger.enabled) {
    const documentationUrl = `${publicUrl}/${swagger.path.replace(/^\/+|\/+$/g, '')}`;
    logger.info('bootstrap', LOG_EVENTS.SYSTEM_SWAGGER_READY, {
      metadata: {
        message: `Документация доступна по адресу: ${documentationUrl}`,
        url: documentationUrl,
        buildVersion: logger.getBuildVersion(),
        environment,
      },
    });
  }
}

void bootstrap();
