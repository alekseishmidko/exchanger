/**
 * Публичная точка входа gateway-модуля без deep imports.
 *
 * Соседние модули должны импортировать guard, ports, DTO и adapters отсюда.
 * Прямые импорты в `controllers/`, `auth/`, `application/` или
 * `infrastructure/` допустимы только внутри самого Gateway-модуля.
 */
export * from './application/gateway.idempotency';
export * from './application/gateway.rate-limit';
export * from './auth/gateway.auth';
export * from './controllers/auth.controller';
export * from './controllers/gateway.controller';
export * from './dto/auth.dto';
export * from './dto/gateway.dto';
export * from './gateway.module';
export * from './gateway-common.module';
export * from './infrastructure/postgres-idempotency.store';
export * from './infrastructure/postgres-trading-command.adapter';
export * from './ports/gateway.idempotency.port';
export * from './types/gateway.types';
export * from './validation/auth.validation';
export * from './validation/gateway.validation';
