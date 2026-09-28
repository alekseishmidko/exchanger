import { Module } from '@nestjs/common';
import { MarketDataHub } from './domain/market-data';
import { ConfigService } from '@nestjs/config';
import { GatewayCommonModule } from '../gateway/gateway-common.module';
import { MarketDataGateway } from './gateways/market-data.gateway';
import { MetricsService } from '../observability';
import { MarketDataAbuseControl } from './policies/market-data-abuse-control';
import { AuthModule } from '../auth';

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
  imports: [
    /** Авторизует private user streams и изолирует данные разных principals. */
    AuthModule,
    /** Переиспользует общие abuse/rate-limit primitives transport boundary. */
    GatewayCommonModule,
  ],
  providers: [
    /** Создаёт bounded pub/sub hub с лимитами подписчиков и pending messages. */
    {
      provide: MarketDataHub,
      inject: [ConfigService, MetricsService],
      useFactory: (config: ConfigService, metrics: MetricsService): MarketDataHub =>
        new MarketDataHub(
          Number(config.get<string | number>('WEBSOCKET_MAX_SUBSCRIBERS', 1000)),
          Number(config.get<string | number>('WEBSOCKET_MAX_PENDING', 100)),
          metrics,
        ),
    },
    /** Ограничивает subscription churn и недопустимые WebSocket команды. */
    MarketDataAbuseControl,
    /** Реализует Socket.IO protocol: subscribe, replay, heartbeat и resync. */
    MarketDataGateway,
  ],
  /** Trading runtime публикует события только через transport-agnostic hub. */
  exports: [MarketDataHub, MarketDataAbuseControl],
})
export class MarketDataModule {}
