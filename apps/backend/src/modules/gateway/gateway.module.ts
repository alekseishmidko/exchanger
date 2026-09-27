/**
 * Файл связывает Gateway как Nest composition root.
 *
 * Здесь выбираются concrete adapters для API-key registry, idempotency store и
 * trading command port. Контроллеры зависят только от DI tokens, поэтому
 * переключение между memory и PostgreSQL runtime не меняет HTTP handlers.
 */
import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuditModule } from '../audit';
import { GatewayController } from './controllers/gateway.controller';
import { POSTGRES_TRANSACTION, PostgresTransactionManager } from '../../infrastructure/postgres';
import { PostgresTradingCommandAdapter } from './infrastructure/postgres-trading-command.adapter';
import { TRADING_COMMAND_PORT } from './types/gateway.types';
import type { TradingCommandPort } from './types/gateway.types';
import { AdmissionControlModule } from '../admin/admission-control';
import { SEQUENCER_STORE_PORT, SequencerModule, SequencerStorePort } from '../trading/sequencer';
import { GatewayCommonModule } from './gateway-common.module';
import { TradingRuntimeModule, TradingRuntimeProcessor } from '../trading/runtime';
import { AuthModule } from '../auth';

/**
 * Composition root Gateway-модуля.
 *
 * Здесь связываются security/application adapters: ConfigService создаёт registry,
 * guard выполняет authentication, а token `TRADING_COMMAND_PORT` позволяет
 * заменить in-memory core на sequencer без изменения controller. Значение
 * `GATEWAY_API_KEYS` имеет формат `key:role:userId,key2:admin:operator`.
 * Development compose явно передаёт тестовые ключи; production не
 * получает default credentials.
 */
@Module({
  imports: [
    /** Аудирует принятые и отклонённые торговые команды. */
    AuditModule,
    /** Подключает machine/human authentication guards и principals. */
    AuthModule,
    /** Добавляет idempotency store и общий request rate limiting. */
    GatewayCommonModule,
    /** Резервирует monotonic sequence и partition ownership durable-команд. */
    SequencerModule,
    /** Проверяет operational pause/freeze до допуска команды к runtime. */
    AdmissionControlModule,
    /** Выполняет принятую команду через единый in-process trading orchestrator. */
    TradingRuntimeModule,
  ],
  /** Публикует REST endpoints заявок и их query/cancel operations. */
  controllers: [GatewayController],
  providers: [
    /** Выбирает direct runtime либо durable PostgreSQL command adapter. */
    {
      provide: TRADING_COMMAND_PORT,
      inject: [ConfigService, POSTGRES_TRANSACTION, SEQUENCER_STORE_PORT, TradingRuntimeProcessor],
      useFactory: (
        config: ConfigService,
        transactions: PostgresTransactionManager,
        sequencer: SequencerStorePort,
        runtime: TradingRuntimeProcessor,
      ): TradingCommandPort =>
        config.getOrThrow('COMMAND_STORE_ADAPTER') === 'postgres'
          ? new PostgresTradingCommandAdapter(
              transactions,
              sequencer,
              config.getOrThrow('INSTANCE_ID'),
              Number(config.get('PARTITION_LEASE_TTL_MS', '15000')),
              runtime,
            )
          : runtime,
    },
  ],
  /** Экспортирует auth/common boundaries и command port, скрывая controller implementation. */
  exports: [AuthModule, GatewayCommonModule, TRADING_COMMAND_PORT],
})
export class GatewayModule {}
