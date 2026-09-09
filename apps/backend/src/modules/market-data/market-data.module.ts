import { Module } from '@nestjs/common';
import { MarketDataHub } from './market-data';
import { ConfigService } from '@nestjs/config';
import { GatewayModule } from '../gateway/gateway.module';
import { MarketDataGateway } from './market-data.gateway';

/**
 * Составляет market-data boundary: domain producers работают с `MarketDataHub`,
 * а внешний transport подключается через `MarketDataGateway` и не получает
 * прямой доступ к matching engine. Лимиты читаются через Nest ConfigService с
 * безопасными fallback для test/development.
 *
 * @example Импорт `MarketDataModule` в `AppModule` публикует namespace
 * `/market-data`, а injection `MarketDataHub` позволяет application adapter
 * вызвать `publishPublic(...)` без зависимости от Socket.IO.
 */
@Module({
  imports: [GatewayModule],
  providers: [
    {
      provide: MarketDataHub,
      inject: [ConfigService],
      useFactory: (config: ConfigService): MarketDataHub =>
        new MarketDataHub(
          Number(config.get<string | number>('WEBSOCKET_MAX_SUBSCRIBERS', 1000)),
          Number(config.get<string | number>('WEBSOCKET_MAX_PENDING', 100)),
        ),
    },
    MarketDataGateway,
  ],
  exports: [MarketDataHub],
})
export class MarketDataModule {}
