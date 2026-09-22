import type { ActiveSubscription } from '../transport/market-data.gateway.types';

/**
 * Registry активных WebSocket подписок по socketId.
 *
 * Gateway остаётся transport orchestrator-ом, а lifecycle callbacks подписок
 * хранятся здесь. Повторная подписка на тот же key сначала вызывает прежний
 * unsubscribe, поэтому fan-out не дублируется.
 */
export class MarketDataSubscriptionRegistry {
  private readonly subscriptions = new Map<string, Map<string, ActiveSubscription>>();

  /** Открывает registry bucket при успешном handshake. */
  open(clientId: string): void {
    this.subscriptions.set(clientId, new Map());
  }

  /** Возвращает bucket подписок socket-а либо `undefined`, если socket закрыт. */
  current(clientId: string): Map<string, ActiveSubscription> | undefined {
    return this.subscriptions.get(clientId);
  }

  /** Заменяет подписку на key и гарантированно снимает прежний callback. */
  replace(clientId: string, subscription: ActiveSubscription): void {
    const current = this.subscriptions.get(clientId);
    if (!current) return;
    current.get(subscription.key)?.unsubscribe();
    current.set(subscription.key, subscription);
  }

  /** Идемпотентно снимает одну подписку socket-а. */
  remove(clientId: string, key: string): void {
    this.subscriptions.get(clientId)?.get(key)?.unsubscribe();
    this.subscriptions.get(clientId)?.delete(key);
  }

  /** Снимает все подписки socket-а при disconnect и удаляет bucket. */
  close(clientId: string): void {
    for (const subscription of this.subscriptions.get(clientId)?.values() ?? []) {
      subscription.unsubscribe();
    }
    this.subscriptions.delete(clientId);
  }
}
