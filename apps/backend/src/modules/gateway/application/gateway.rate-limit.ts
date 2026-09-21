/**
 * Файл содержит lightweight rate-limit policy для Gateway endpoints.
 *
 * Rate limit применяется после authentication по стабильному `keyId`, чтобы
 * ошибки не раскрывали raw API key. Текущая реализация process-local и подходит
 * для dev/component runtime; production должен заменить storage на shared
 * backend без изменения controller-кода.
 */
import { HttpException, Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * Счётчик одного fixed window для API key.
 *
 * Окно начинается в `startedAt` и принимает не более `limit` запросов. После
 * истечения `windowMs` счётчик создаётся заново. В production состояние должно
 * храниться в общем rate-limit store, чтобы лимит действовал одинаково на всех
 * репликах Gateway.
 */
type RateWindow = { startedAt: number; count: number };

/**
 * Ограничивает command/query requests и не включает секреты в ошибки.
 *
 * Reference policy: 60 запросов за 60 секунд на `keyId`. Превышение даёт HTTP
 * 429 с кодом `RATE_LIMIT_EXCEEDED`; значение API key в response не попадает.
 */
@Injectable()
export class RateLimitService {
  private readonly windows = new Map<string, RateWindow>();
  private readonly limit: number;
  private readonly windowMs: number;

  /**
   * Создаёт fixed-window policy из валидированной конфигурации.
   * Fallback сохраняет прежнюю production policy в unit-тестах, а load Compose
   * может поднять лимит для одного изолированного synthetic credential.
   */
  constructor(@Optional() config?: ConfigService) {
    this.limit = Number(config?.get<string | number>('GATEWAY_RATE_LIMIT', 60) ?? 60);
    this.windowMs = Number(
      config?.get<string | number>('GATEWAY_RATE_WINDOW_MS', 60_000) ?? 60_000,
    );
  }

  /** Проверяет окно, увеличивает счётчик и выбрасывает безопасный HTTP 429 при превышении. */
  check(keyId: string, now = Date.now()): void {
    const current = this.windows.get(keyId);
    const window =
      !current || now - current.startedAt >= this.windowMs ? { startedAt: now, count: 0 } : current;
    window.count += 1;
    this.windows.set(keyId, window);
    if (window.count > this.limit) {
      throw new HttpException({ code: 'RATE_LIMIT_EXCEEDED', message: 'Rate limit exceeded' }, 429);
    }
  }
}
