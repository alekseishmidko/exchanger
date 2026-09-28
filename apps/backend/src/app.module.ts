import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { environmentFilePaths, validateEnvironment } from './config/environment';
import { HealthModule } from './modules/health';
import { GatewayModule } from './modules/gateway';
import { ProjectionsModule } from './modules/projections';
import { MarketDataModule } from './modules/market-data/market-data.module';
import { AdminModule } from './modules/admin';
import { InstrumentsModule } from './modules/trading/instruments';
import { LedgerModule } from './modules/ledger';
import { ObservabilityModule } from './modules/observability';
import { RuntimeSafetyService } from './config/runtime-safety.service';
import { PostgresModule } from './infrastructure/postgres';
import { EventLogModule } from './modules/trading/event-log';
import { AuditModule } from './modules/audit';
import { SettlementModule } from './modules/trading/settlement';
import { SequencerModule } from './modules/trading/sequencer';
import { AdmissionControlModule } from './modules/admin/admission-control';
import { TradingWorkersModule } from './modules/trading/workers';
import { AuthModule } from './modules/auth';
import { RealtimeMarketModule } from './modules/realtime-market';

/**
 * Корневой composition root backend-приложения.
 *
 * Здесь собираются инфраструктурные и бизнес-модули верхнего уровня. Порядок в
 * `imports` отражает направление зависимостей: сначала конфигурация и durable
 * infrastructure, затем общие сервисы, публичные transport boundaries и в
 * конце orchestration/admin capabilities. Бизнес-логика остаётся внутри своих
 * модулей и не реализуется в этом классе.
 */
@Module({
  imports: [
    /**
     * Загружает профиль окружения до построения dependency graph и делает
     * проверенную конфигурацию доступной всем модулям без повторных imports.
     */
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: [...environmentFilePaths(__dirname)],
      validate: validateEnvironment,
    }),
    /** Предоставляет общий PostgreSQL pool и transaction boundary durable adapters. */
    PostgresModule,
    /** Хранит упорядоченные доменные события и transactional outbox сообщений. */
    EventLogModule,
    /** Записывает неизменяемый tamper-evident журнал значимых действий системы. */
    AuditModule,
    /** Инкапсулирует регистрацию, login, сессии, API keys и guards авторизации. */
    AuthModule,
    /** Выдаёт монотонные sequence и обеспечивает fencing владельцев partition. */
    SequencerModule,
    /** Управляет pause, freeze и circuit-breaker до допуска торговой команды. */
    AdmissionControlModule,
    /** Подключает structured logs, metrics и distributed tracing приложения. */
    ObservabilityModule,
    /** Публикует liveness/readiness с проверкой критичных runtime dependencies. */
    HealthModule,
    /** Открывает REST command/query boundary биржи и применяет transport policies. */
    GatewayModule,
    /** Строит и отдаёт read-модели заявок, сделок, балансов и их lag metrics. */
    ProjectionsModule,
    /** Доставляет snapshot и ordered market-data increments по WebSocket. */
    MarketDataModule,
    /** Изолирует внешний каталог и ingest Twelve Data от внутреннего matching flow. */
    RealtimeMarketModule,
    /** Управляет каталогом торговых инструментов и их lifecycle/status. */
    InstrumentsModule,
    /** Владеет счетами, балансами, reservations и double-entry postings. */
    LedgerModule,
    /** Атомарно проводит результаты сделок через ledger и event log. */
    SettlementModule,
    /** Запускает durable consumers, recovery и обработку торговых команд. */
    TradingWorkersModule,
    /** Предоставляет защищённые операционные команды, approvals и reconciliation. */
    AdminModule,
  ],
  /** Проверяет runtime-инварианты после сборки полного application graph. */
  providers: [RuntimeSafetyService],
})
export class AppModule {}
