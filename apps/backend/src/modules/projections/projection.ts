import { BadRequestException } from '@nestjs/common';

/** Событие event log, достаточное для построения read-моделей. */
export type ProjectionEvent = Readonly<{
  eventId: string;
  eventType:
    'OrderAccepted' | 'OrderRejected' | 'OrderCancelled' | 'TradeExecuted' | 'SettlementApplied';
  sequence: number;
  payload: Record<string, unknown>;
}>;

/** Запись истории заявки, доступная query API только её владельцу. */
export type OrderView = Readonly<{
  orderId: string;
  userId: string;
  accountId: string;
  instrumentId: string;
  status: 'ACCEPTED' | 'REJECTED' | 'CANCELLED';
  remainingQuantity: string;
  updatedAtSequence: number;
}>;

/** Запись сделки для maker и taker history queries. */
export type TradeView = Readonly<{
  tradeId: string;
  instrumentId: string;
  userIds: readonly string[];
  makerOrderId: string;
  takerOrderId: string;
  quantity: string;
  price: string;
  sequence: number;
}>;

/** Изменение баланса, накопленное из SettlementApplied posting deltas. */
export type BalanceView = Readonly<{
  accountId: string;
  assetId: string;
  available: string;
  reserved: string;
  sequence: number;
}>;

/** Страница query API с opaque cursor для стабильной постраничной выдачи. */
export type ProjectionPage<T> = Readonly<{ items: readonly T[]; nextCursor: string | null }>;

/** Метрики актуальности projection consumer. */
export type ProjectionMetrics = Readonly<{
  schemaVersion: number;
  appliedSequence: number;
  sourceSequence: number;
  lag: number;
}>;

/**
 * In-memory read-model projection для order/trade/balance history.
 *
 * Каждый event применяется строго один раз и только в порядке `sequence`:
 * duplicate `eventId` возвращается без изменения состояния, а gap останавливает
 * обработку ошибкой `PROJECTION_SEQUENCE_GAP`. Метод `rebuild` очищает модели и
 * повторно применяет полный журнал, что позволяет сравнить live и rebuilt state.
 *
 * В production карты заменяются таблицами read model, а `apply` выполняется в
 * транзакции вместе с consumer offset. `schemaVersion` позволяет мигрировать
 * структуру проекции независимо от версии исходных domain events.
 */
export class ProjectionStore {
  /** Версия схемы текущих read-моделей. */
  static readonly schemaVersion = 1;
  private readonly orders = new Map<string, OrderView>();
  private readonly trades = new Map<string, TradeView>();
  private readonly balances = new Map<string, BalanceView>();
  private readonly processedEvents = new Set<string>();
  private appliedSequence = 0;
  private sourceSequence = 0;

  /**
   * Применяет одно событие к соответствующей read-модели.
   *
   * @throws ConflictException Для duplicate event с несовместимой последовательностью.
   * @throws BadRequestException При пропущенной последовательности событий.
   */
  apply(event: ProjectionEvent): void {
    if (this.processedEvents.has(event.eventId)) return;
    if (event.sequence !== this.appliedSequence + 1) {
      throw new BadRequestException({
        code: 'PROJECTION_SEQUENCE_GAP',
        message: 'Projection sequence gap detected',
      });
    }
    this.sourceSequence = Math.max(this.sourceSequence, event.sequence);
    switch (event.eventType) {
      case 'OrderAccepted':
        this.applyOrder(event, 'ACCEPTED');
        break;
      case 'OrderRejected':
        this.applyOrder(event, 'REJECTED');
        break;
      case 'OrderCancelled':
        this.applyOrder(event, 'CANCELLED');
        break;
      case 'TradeExecuted':
        this.applyTrade(event);
        break;
      case 'SettlementApplied':
        this.applySettlement(event);
        break;
    }
    this.processedEvents.add(event.eventId);
    this.appliedSequence = event.sequence;
  }

  /** Полностью перестраивает read-модели из упорядоченного event log. */
  rebuild(events: readonly ProjectionEvent[]): void {
    this.orders.clear();
    this.trades.clear();
    this.balances.clear();
    this.processedEvents.clear();
    this.appliedSequence = 0;
    this.sourceSequence = events.at(-1)?.sequence ?? 0;
    for (const event of events) this.apply(event);
  }

  /** Возвращает страницу истории заявок конкретного пользователя. */
  getOrders(userId: string, limit = 50, cursor?: string): ProjectionPage<OrderView> {
    return this.page(
      [...this.orders.values()].filter((item) => item.userId === userId),
      limit,
      cursor,
    );
  }

  /** Возвращает страницу сделок, где пользователь является maker или taker. */
  getTrades(userId: string, limit = 50, cursor?: string): ProjectionPage<TradeView> {
    return this.page(
      [...this.trades.values()].filter((item) => item.userIds.includes(userId)),
      limit,
      cursor,
    );
  }

  /** Возвращает страницу балансов только указанного account owner. */
  getBalances(userId: string, limit = 50, cursor?: string): ProjectionPage<BalanceView> {
    return this.page(
      [...this.balances.values()].filter((item) => item.accountId === userId),
      limit,
      cursor,
    );
  }

  /** Возвращает состояние проекции и lag относительно последнего source event. */
  getMetrics(): ProjectionMetrics {
    return {
      schemaVersion: ProjectionStore.schemaVersion,
      appliedSequence: this.appliedSequence,
      sourceSequence: this.sourceSequence,
      lag: Math.max(0, this.sourceSequence - this.appliedSequence),
    };
  }

  /** Выполняет migration hook для будущих версий схемы read-моделей. */
  migrate(targetVersion: number): void {
    if (targetVersion !== ProjectionStore.schemaVersion)
      throw new Error('Unsupported projection schema version');
  }

  private applyOrder(event: ProjectionEvent, status: OrderView['status']): void {
    const payload = event.payload;
    this.orders.set(String(payload['orderId']), {
      orderId: String(payload['orderId']),
      userId: String(payload['userId']),
      accountId: String(payload['accountId']),
      instrumentId: String(payload['instrumentId']),
      status,
      remainingQuantity: asString(payload['remainingQuantity'], '0'),
      updatedAtSequence: event.sequence,
    });
  }

  private applyTrade(event: ProjectionEvent): void {
    const payload = event.payload;
    this.trades.set(String(payload['tradeId']), {
      tradeId: String(payload['tradeId']),
      instrumentId: String(payload['instrumentId']),
      userIds: [String(payload['makerUserId']), String(payload['takerUserId'])],
      makerOrderId: String(payload['makerOrderId']),
      takerOrderId: String(payload['takerOrderId']),
      quantity: String(payload['quantity']),
      price: String(payload['price']),
      sequence: event.sequence,
    });
  }

  private applySettlement(event: ProjectionEvent): void {
    const postings = event.payload['postings'];
    if (!Array.isArray(postings))
      throw new BadRequestException({
        code: 'PROJECTION_INVALID_EVENT',
        message: 'Projection event is invalid',
      });
    for (const posting of postings as Array<Record<string, unknown>>) {
      const accountId = String(posting['accountId']);
      const assetId = String(posting['assetId']);
      const key = `${accountId}:${assetId}`;
      const current = this.balances.get(key) ?? {
        accountId,
        assetId,
        available: '0',
        reserved: '0',
        sequence: event.sequence,
      };
      this.balances.set(key, {
        ...current,
        available: addDecimal(current.available, asString(posting['availableDelta'], '0')),
        reserved: addDecimal(current.reserved, asString(posting['reservedDelta'], '0')),
        sequence: event.sequence,
      });
    }
  }

  private page<T>(items: readonly T[], limit: number, cursor?: string): ProjectionPage<T> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100 || (cursor && !/^\d+$/.test(cursor)))
      throw new BadRequestException({
        code: 'PAGINATION_INVALID',
        message: 'Pagination parameters are invalid',
      });
    const start = cursor ? Number(cursor) : 0;
    const page = items.slice(start, start + limit);
    return {
      items: page,
      nextCursor: start + page.length < items.length ? String(start + page.length) : null,
    };
  }
}

/** Складывает decimal strings без floating point для balance projection. */
function addDecimal(left: string, right: string): string {
  const [leftWhole, leftFraction = ''] = left.split('.');
  const [rightWhole, rightFraction = ''] = right.split('.');
  const scale = Math.max(leftFraction.length, rightFraction.length);
  const leftInteger = BigInt(`${leftWhole}${leftFraction.padEnd(scale, '0')}`);
  const rightInteger = BigInt(`${rightWhole}${rightFraction.padEnd(scale, '0')}`);
  const sum = (leftInteger + rightInteger).toString().padStart(scale + 1, '0');
  return scale === 0 ? sum : `${sum.slice(0, -scale)}.${sum.slice(-scale)}`.replace(/\.0+$/, '');
}

/** Безопасно извлекает строковое decimal-поле из непроверенного event payload. */
function asString(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}
