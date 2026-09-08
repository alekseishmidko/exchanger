import { Module } from '@nestjs/common';
import { GatewayModule } from '../../gateway/gateway.module';
import { InstrumentCatalogService } from './instrument-catalog.service';
import { InstrumentsController } from './instruments.controller';

/** Собирает единый application catalog и его read-only transport adapter. */
@Module({
  imports: [GatewayModule],
  controllers: [InstrumentsController],
  providers: [InstrumentCatalogService],
  exports: [InstrumentCatalogService],
})
export class InstrumentsModule {}
