import { Module } from '@nestjs/common';
import { GatewayCommonModule } from '../../gateway/gateway-common.module';
import { InstrumentCatalogService } from './instrument-catalog.service';
import { InstrumentsController } from './instruments.controller';
import { DevelopmentInstrumentSeeder } from './development-instrument.seeder';
import { AuthModule } from '../../auth';

/** Собирает единый application catalog и его read-only transport adapter. */
@Module({
  imports: [
    /** Защищает catalog API и предоставляет machine/human principal. */
    AuthModule,
    /** Применяет shared query rate limits к catalog transport. */
    GatewayCommonModule,
  ],
  /** Публикует read-only список и карточку торгового инструмента. */
  controllers: [InstrumentsController],
  providers: [
    /** Владеет единым catalog state и lifecycle rules инструментов. */
    InstrumentCatalogService,
    /** Заполняет безопасный seed catalog только в разрешённых isolated profiles. */
    DevelopmentInstrumentSeeder,
  ],
  /** Trading runtime и AdminModule изменяют/читают catalog через application service. */
  exports: [InstrumentCatalogService],
})
export class InstrumentsModule {}
