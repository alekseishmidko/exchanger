import { Injectable, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Decimal, createId } from '../../shared-kernel';
import { InstrumentCatalogService } from './instrument-catalog.service';
import { Instrument } from './instrument';

/**
 * Наполняет ephemeral-каталог минимальным активным инструментом для ручного
 * development-стенда. Seeder включается явным env-флагом и запрещён вне
 * development через общую валидацию окружения.
 */
@Injectable()
export class DevelopmentInstrumentSeeder implements OnApplicationBootstrap {
  constructor(
    private readonly config: ConfigService,
    private readonly catalog: InstrumentCatalogService,
  ) {}

  /** Создаёт BTC-USD до начала обработки пользовательских запросов. */
  onApplicationBootstrap(): void {
    const enabled = this.config.get<string>('DEVELOPMENT_SEED_INSTRUMENTS');
    if (enabled !== 'true' && enabled !== '1') return;

    const instrument = new Instrument(
      'BTC-USD',
      createId<'AssetId'>('BTC'),
      createId<'AssetId'>('USD'),
      {
        version: 'development-v1',
        effectiveAt: new Date('2026-01-01T00:00:00.000Z'),
        tickSize: Decimal.from('0.01'),
        lotSize: Decimal.from('0.00000001'),
        minQuantity: Decimal.from('0.00000001'),
        maxQuantity: Decimal.from('1000'),
        priceBand: {
          min: Decimal.from('0.01'),
          max: Decimal.from('10000000'),
        },
        feePolicyVersion: 'development-zero-fee',
        limits: {
          maxOrderQuantity: Decimal.from('1000'),
          maxOpenOrders: 1000,
          maxNotional: Decimal.from('1000000000'),
        },
      },
    );
    instrument.activate();
    this.catalog.register(instrument);
  }
}
