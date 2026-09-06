import { BadRequestException, ForbiddenException } from '@nestjs/common';

/**
 * Один агрегированный уровень стакана.
 *
 * `price` и `quantity` передаются строками, чтобы не потерять точность при
 * сериализации WebSocket JSON. В increment значение `quantity: "0"` означает
 * удаление уровня, любое другое значение — replace текущего количества.
 */
export type BookLevel = Readonly<{ price: string; quantity: string }>;
/**
 * Самодостаточный снимок стакана.
 *
 * После получения snapshot клиент считает book согласованным на `sequence` и
 * применяет только increments с последовательными номерами. Snapshot можно
 * использовать как новую точку восстановления после disconnect или gap.
 */
export type OrderBookSnapshot = Readonly<{
  channel: 'book';
  instrumentId: string;
  sequence: number;
  bids: readonly BookLevel[];
  asks: readonly BookLevel[];
}>;
/**
 * Инкрементальное изменение уровней поверх snapshot.
 *
 * Поле `bids`/`asks` содержит только изменившиеся уровни. Сообщение нельзя
 * применять, если его sequence не равна локальной sequence плюс один.
 */
export type OrderBookIncrement = Readonly<{
  channel: 'book_update';
  instrumentId: string;
  sequence: number;
  bids: readonly BookLevel[];
  asks: readonly BookLevel[];
}>;
/** Public-сообщение сделки или ticker с instrument sequence. */
export type MarketTick = Readonly<{
  channel: 'trades' | 'ticker';
  instrumentId: string;
  sequence: number;
  price: string;
  quantity: string;
}>;
/**
 * Private user event.
 *
 * `userId` проверяется при подписке и при выборе списка subscribers. Это поле не
 * является клиентским фильтром: сервер никогда не отправляет событие сначала в
 * общий public fan-out, а затем не надеется на фильтрацию клиента.
 */
export type PrivateUserEvent = Readonly<{
  channel: 'user';
  userId: string;
  sequence: number;
  type: string;
  payload: Record<string, unknown>;
}>;
/** Объединение всех сообщений, которые может получить transport adapter. */
export type MarketDataMessage =
  OrderBookSnapshot | OrderBookIncrement | MarketTick | PrivateUserEvent;

/**
 * Ошибка разрыва sequence.
 *
 * Обработчик должен прекратить применение локальных increments и запросить
 * `resync(instrumentId, lastAppliedSequence)`. Скрывать gap нельзя: иначе клиент
 * построит устаревший стакан.
 */
export class MarketDataGapError extends BadRequestException {
  constructor() {
    super({ code: 'MARKET_DATA_GAP', message: 'Market data sequence gap detected' });
  }
}
/** Ошибка bounded buffer: медленный consumer отключается и должен reconnect. */
export class BackpressureError extends BadRequestException {
  constructor() {
    super({ code: 'MARKET_DATA_BACKPRESSURE', message: 'Consumer is too slow' });
  }
}

type Subscriber = {
  readonly clientId: string;
  readonly handler: (message: MarketDataMessage) => void;
  pending: number;
};
type BookState = {
  sequence: number;
  bids: Map<string, string>;
  asks: Map<string, string>;
  history: OrderBookIncrement[];
};

/**
 * Market-data hub для public order book и private user streams.
 *
 * Клиент получает snapshot при подписке, затем только increments с monotonic
 * sequence. Если клиент видит sequence gap, `resync` возвращает snapshot и
 * доступный replay; если replay уже вытеснен retention, клиент начинает с нового
 * snapshot. Private channel проверяет userId до регистрации subscriber.
 *
 * В reference реализации fan-out синхронный и ограничен `maxSubscribers` и
 * `maxPendingPerSubscriber`; production adapter подключает WebSocket transport,
 * distributed pub/sub и durable market-data log.
 */
export class MarketDataHub {
  private readonly books = new Map<string, BookState>();
  private readonly publicSubscribers = new Map<string, Subscriber[]>();
  private readonly privateSubscribers = new Map<string, Subscriber[]>();

  /**
   * Создаёт hub с ограничениями fan-out.
   *
   * @param maxSubscribers Максимальное число public и private subscriptions.
   * @param maxPendingPerSubscriber Максимум сообщений, ожидающих доставки одному consumer.
   */
  constructor(
    private readonly maxSubscribers = 1000,
    private readonly maxPendingPerSubscriber = 100,
  ) {}

  /**
   * Публикует initial snapshot и атомарно заменяет локальное состояние книги.
   *
   * Обычно вызывается после загрузки snapshot из matching engine. История replay
   * очищается, поскольку старые increments относятся к предыдущей базе.
   */
  publishSnapshot(snapshot: OrderBookSnapshot): void {
    this.books.set(snapshot.instrumentId, {
      sequence: snapshot.sequence,
      bids: new Map(snapshot.bids.map((level) => [level.price, level.quantity])),
      asks: new Map(snapshot.asks.map((level) => [level.price, level.quantity])),
      history: [],
    });
  }

  /**
   * Применяет один ordered increment и выполняет public fan-out.
   *
   * @throws MarketDataGapError Если отсутствует snapshot или нарушен `N → N+1`.
   * После ошибки состояние книги не изменяется, поэтому повтор после resync
   * остаётся детерминированным.
   */
  publishIncrement(increment: OrderBookIncrement): void {
    const book = this.books.get(increment.instrumentId);
    if (!book || increment.sequence !== book.sequence + 1) throw new MarketDataGapError();
    this.applyLevels(book.bids, increment.bids);
    this.applyLevels(book.asks, increment.asks);
    book.sequence = increment.sequence;
    book.history.push(increment);
    if (book.history.length > 1000) book.history.shift();
    this.broadcast(
      this.publicSubscribers.get(this.publicKey(increment.instrumentId, 'book')) ?? [],
      increment,
    );
  }

  /** Возвращает immutable snapshot текущего стакана для reconnect/resync. */
  getSnapshot(instrumentId: string): OrderBookSnapshot {
    const book = this.books.get(instrumentId);
    if (!book) throw new Error('Instrument book does not exist');
    return {
      channel: 'book',
      instrumentId,
      sequence: book.sequence,
      bids: [...book.bids].map(([price, quantity]) => ({ price, quantity })),
      asks: [...book.asks].map(([price, quantity]) => ({ price, quantity })),
    };
  }

  /**
   * Возвращает минимальный набор данных для восстановления клиента.
   *
   * Если все increments после `lastSequence` ещё есть в bounded history, отдаётся
   * только replay. Иначе отдаётся один полный snapshot; клиент должен заменить им
   * локальное состояние, а не смешивать старую и новую историю.
   */
  resync(instrumentId: string, lastSequence: number): readonly MarketDataMessage[] {
    const book = this.books.get(instrumentId);
    if (!book) throw new Error('Instrument book does not exist');
    const replay = book.history.filter((item) => item.sequence > lastSequence);
    return replay.length === book.sequence - lastSequence
      ? replay
      : [this.getSnapshot(instrumentId)];
  }

  /**
   * Регистрирует public subscription.
   *
   * Для `book` handler немедленно получает snapshot, что устраняет race между
   * подпиской и первым increment. Для `trades`/`ticker` отправляются только
   * сообщения соответствующего channel.
   *
   * @returns Функция отключения subscription, безопасная для повторного вызова.
   */
  subscribePublic(
    clientId: string,
    instrumentId: string,
    channel: 'book' | 'trades' | 'ticker' = 'book',
    handler: (message: MarketDataMessage) => void,
  ): () => void {
    const subscribers = this.publicSubscribers.get(this.publicKey(instrumentId, channel)) ?? [];
    this.ensureCapacity();
    const subscriber = { clientId, handler, pending: 0 };
    subscribers.push(subscriber);
    this.publicSubscribers.set(this.publicKey(instrumentId, channel), subscribers);
    if (channel === 'book') handler(this.getSnapshot(instrumentId));
    return () => this.remove(subscribers, subscriber);
  }

  /**
   * Регистрирует private user stream после object authorization.
   *
   * `authenticatedUserId` берётся из проверенного API key/session, а
   * `requestedUserId` — из subscription request. Они должны совпадать; иначе
   * подписка отклоняется до записи в subscriber registry.
   */
  subscribePrivate(
    clientId: string,
    authenticatedUserId: string,
    requestedUserId: string,
    handler: (message: MarketDataMessage) => void,
  ): () => void {
    if (authenticatedUserId !== requestedUserId)
      throw new ForbiddenException({
        code: 'PRIVATE_STREAM_FORBIDDEN',
        message: 'Private stream access denied',
      });
    const subscribers = this.privateSubscribers.get(requestedUserId) ?? [];
    this.ensureCapacity();
    const subscriber = { clientId, handler, pending: 0 };
    subscribers.push(subscriber);
    this.privateSubscribers.set(requestedUserId, subscribers);
    return () => this.remove(subscribers, subscriber);
  }

  /** Доставляет private event только подписчикам точно такого же userId. */
  publishPrivate(event: PrivateUserEvent): void {
    this.broadcast(this.privateSubscribers.get(event.userId) ?? [], event);
  }

  /** Публикует trade/ticker только подписчикам того же instrument и channel. */
  publishTick(event: MarketTick): void {
    this.broadcast(
      this.publicSubscribers.get(this.publicKey(event.instrumentId, event.channel)) ?? [],
      event,
    );
  }

  /** Возвращает число активных subscriptions для monitoring и fan-out alerts. */
  getSubscriberCount(): number {
    return [...this.publicSubscribers.values(), ...this.privateSubscribers.values()].reduce(
      (sum, items) => sum + items.length,
      0,
    );
  }

  private applyLevels(target: Map<string, string>, levels: readonly BookLevel[]): void {
    for (const level of levels) {
      if (level.quantity === '0') target.delete(level.price);
      else target.set(level.price, level.quantity);
    }
  }
  private broadcast(subscribers: Subscriber[], message: MarketDataMessage): void {
    for (const subscriber of [...subscribers]) {
      subscriber.pending += 1;
      if (subscriber.pending > this.maxPendingPerSubscriber) {
        this.remove(subscribers, subscriber);
        throw new BackpressureError();
      }
      subscriber.handler(message);
      subscriber.pending -= 1;
    }
  }
  private ensureCapacity(): void {
    if (this.getSubscriberCount() >= this.maxSubscribers) throw new BackpressureError();
  }
  private publicKey(instrumentId: string, channel: 'book' | 'trades' | 'ticker'): string {
    return `${instrumentId}:${channel}`;
  }
  private remove(subscribers: Subscriber[], subscriber: Subscriber): void {
    const index = subscribers.indexOf(subscriber);
    if (index >= 0) subscribers.splice(index, 1);
  }
}
