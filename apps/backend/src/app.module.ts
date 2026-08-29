import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { resolve } from 'node:path';
import { validateEnvironment } from './config/environment';
import { HealthModule } from './modules/health/health.module';

/** Корневой composition root приложения и глобальной конфигурации. */
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: [
        resolve(__dirname, `../../../.env.${process.env['NODE_ENV'] ?? 'development'}`),
        resolve(__dirname, '../../../.env.development'),
        resolve(__dirname, '../../../.env'),
      ],
      validate: validateEnvironment,
    }),
    HealthModule,
  ],
})
export class AppModule {}
