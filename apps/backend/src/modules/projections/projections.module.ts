import { Module } from '@nestjs/common';
import { GatewayModule } from '../gateway/gateway.module';
import { ProjectionsController } from './projections.controller';
import { ProjectionStore } from './projection';

/** Собирает read-model store и query API, используя только gateway auth boundary. */
@Module({
  imports: [GatewayModule],
  controllers: [ProjectionsController],
  providers: [ProjectionStore],
})
export class ProjectionsModule {}
