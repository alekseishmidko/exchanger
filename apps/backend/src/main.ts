import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { AppModule } from './app.module';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({ bodyLimit: 16 * 1024 }),
  );
  const config = app.get(ConfigService);
  const environment = config.getOrThrow<string>('NODE_ENV');
  const port = config.get<number>('PORT', 5000);
  const host = config.get<string>('HOST', '0.0.0.0');

  app.getHttpAdapter().getInstance().log.info({ environment }, 'Backend started');

  await app.listen(port, host);
}

void bootstrap();
