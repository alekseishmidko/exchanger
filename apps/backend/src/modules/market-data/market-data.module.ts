import { Module } from '@nestjs/common';
import { MarketDataHub } from './market-data';

/** Составляет market-data boundary; transport WebSocket подключается поверх hub. */
@Module({ providers: [MarketDataHub], exports: [MarketDataHub] })
export class MarketDataModule {}
