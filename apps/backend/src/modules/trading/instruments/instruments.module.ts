import { Module } from '@nestjs/common';
import { GatewayCommonModule } from '../../gateway/gateway-common.module';
import { InstrumentCatalogService } from './instrument-catalog.service';
import { InstrumentsController } from './instruments.controller';
import { DevelopmentInstrumentSeeder } from './development-instrument.seeder';

/** Собирает единый application catalog и его read-only transport adapter. */
@Module({
  imports: [GatewayCommonModule],
  controllers: [InstrumentsController],
  providers: [InstrumentCatalogService, DevelopmentInstrumentSeeder],
  exports: [InstrumentCatalogService],
})
export class InstrumentsModule {}
