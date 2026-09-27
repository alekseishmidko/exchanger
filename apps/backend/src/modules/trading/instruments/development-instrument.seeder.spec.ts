import { ConfigService } from '@nestjs/config';
import { DevelopmentInstrumentSeeder } from './development-instrument.seeder';
import { InstrumentCatalogService } from './instrument-catalog.service';

describe('DevelopmentInstrumentSeeder', () => {
  it('registers an active BTC-USD instrument when explicitly enabled', () => {
    const catalog = new InstrumentCatalogService();
    const seeder = new DevelopmentInstrumentSeeder(
      new ConfigService({ DEVELOPMENT_SEED_INSTRUMENTS: 'true' }),
      catalog,
    );

    seeder.onApplicationBootstrap();

    expect(catalog.get('BTC-USD')).toMatchObject({
      id: 'BTC-USD',
      baseAssetId: 'BTC',
      quoteAssetId: 'USD',
      status: 'ACTIVE',
    });
  });

  it('leaves the catalog empty unless the seed is explicitly enabled', () => {
    const catalog = new InstrumentCatalogService();
    const seeder = new DevelopmentInstrumentSeeder(
      new ConfigService({ DEVELOPMENT_SEED_INSTRUMENTS: 'false' }),
      catalog,
    );

    seeder.onApplicationBootstrap();

    expect(catalog.list()).toEqual([]);
  });

  it('registers the same fixture for the isolated staging resilience environment', () => {
    const catalog = new InstrumentCatalogService();
    const seeder = new DevelopmentInstrumentSeeder(
      new ConfigService({ ISOLATED_STAGING_SEED_INSTRUMENTS: 'true' }),
      catalog,
    );

    seeder.onApplicationBootstrap();

    expect(catalog.get('BTC-USD').status).toBe('ACTIVE');
  });
});
