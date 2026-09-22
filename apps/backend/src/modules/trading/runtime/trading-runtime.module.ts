/**
 * Composition root связного in-process trading runtime.
 *
 * Модуль собирает application orchestrator из публичных ports: instrument
 * catalog, ledger, settlement, projections и market-data hub. REST controller
 * не импортирует matching engine или ledger напрямую — он получает только
 * `TradingCommandPort`, который в GatewayModule может быть связан с этим
 * processor-ом или с durable command adapter.
 *
 * @example В development profile `TRADING_COMMAND_PORT` указывает на
 * `TradingRuntimeProcessor`, поэтому две заявки через REST проходят полный путь
 * reserve → match → settle → project → publish без test-only shortcut.
 */
import { Module } from '@nestjs/common';
import { LedgerModule, LEDGER_PORT } from '../../ledger';
import type { LedgerPort } from '../../ledger';
import { MarketDataHub, MarketDataModule } from '../../market-data';
import { PROJECTION_STORE_PORT, ProjectionsModule } from '../../projections';
import type { ProjectionStorePort } from '../../projections';
import { InstrumentsModule, InstrumentCatalogService } from '../instruments';
import { SettlementModule, SettlementService } from '../settlement';
import { TradingRuntimeProcessor } from './trading-runtime.processor';

/** Nest module, экспортирующий единый application processor spot MVP. */
@Module({
  imports: [InstrumentsModule, LedgerModule, SettlementModule, ProjectionsModule, MarketDataModule],
  providers: [
    {
      provide: TradingRuntimeProcessor,
      inject: [
        InstrumentCatalogService,
        LEDGER_PORT,
        SettlementService,
        PROJECTION_STORE_PORT,
        MarketDataHub,
      ],
      useFactory: (
        instruments: InstrumentCatalogService,
        ledger: LedgerPort,
        settlement: SettlementService,
        projections: ProjectionStorePort,
        marketData: MarketDataHub,
      ): TradingRuntimeProcessor =>
        new TradingRuntimeProcessor(instruments, ledger, settlement, projections, marketData),
    },
  ],
  exports: [TradingRuntimeProcessor],
})
export class TradingRuntimeModule {}
