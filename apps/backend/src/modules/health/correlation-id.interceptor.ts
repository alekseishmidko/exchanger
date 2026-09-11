/**
 * Совместимое имя прежнего interceptor для внешних imports.
 *
 * Реализация перенесена в observability-модуль: теперь correlation context и
 * HTTP terminal events используют единый DI logger, redaction и event catalog.
 */
export { HttpLoggingInterceptor as CorrelationIdInterceptor } from '../observability';
