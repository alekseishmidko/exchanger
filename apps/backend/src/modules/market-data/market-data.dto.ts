/**
 * Публичные каналы рыночных данных, не содержащие пользовательских сведений.
 * Значение становится частью ключа подписки `channel:instrumentId`, например
 * `book:BTC-USD`, поэтому существующие значения нельзя переименовывать в v1.
 */
export type PublicMarketDataChannel = 'book' | 'trades' | 'ticker';

/**
 * Команда подписки WebSocket-клиента.
 *
 * Для public channel обязателен `instrumentId`. Для private `user` обязателен
 * `userId`, совпадающий с authenticated API-key principal. `requestId` становится
 * correlationId ответов и позволяет клиенту сопоставить ack/error с командой.
 *
 * @example
 * `{ "requestId": "req-1", "channel": "book", "instrumentId": "BTC-USD" }`
 */
export type SubscribeRequestDto = Readonly<{
  requestId: string;
  channel: PublicMarketDataChannel | 'user';
  instrumentId?: string | undefined;
  userId?: string | undefined;
}>;

/**
 * Команда удаления одной ранее созданной подписки.
 * Повторяет routing fields subscribe-команды, благодаря чему unsubscribe не
 * требует внутреннего server subscription id и остаётся идемпотентным.
 *
 * @example
 * `{ "requestId": "req-2", "channel": "ticker", "instrumentId": "BTC-USD" }`
 */
export type UnsubscribeRequestDto = SubscribeRequestDto;

/**
 * Команда восстановления order book после reconnect или sequence gap.
 * `lastSequence` — последний непрерывно применённый клиентом номер.
 * Hub вернёт последовательные increments, а при истёкшем replay window — новый
 * snapshot, который должен атомарно заменить локальный стакан.
 *
 * @example
 * `{ "requestId": "resync-1", "instrumentId": "BTC-USD", "lastSequence": 41 }`
 */
export type ResyncRequestDto = Readonly<{
  requestId: string;
  instrumentId: string;
  lastSequence: number;
}>;

/**
 * Heartbeat-команда для проверки живости transport connection.
 * `sentAt` необязателен и возвращается сервером без интерпретации, чтобы клиент
 * мог вычислить round-trip time; business dependencies при этом не вызываются.
 *
 * @example
 * `{ "requestId": "ping-1", "sentAt": "2026-09-09T00:00:00.000Z" }`
 */
export type HeartbeatRequestDto = Readonly<{ requestId: string; sentAt?: string | undefined }>;

/**
 * Общий wire envelope server message.
 *
 * Envelope отделяет protocol metadata от domain-derived payload. Ни внутренний
 * order book aggregate, ни ledger postings в `data` не передаются. Для market
 * event `sequence` повторяет payload sequence, а control response использует 0.
 *
 * @example
 * `{ "messageVersion": "1.0", "correlationId": "req-1", "emittedAt": "2026-09-09T00:00:00.000Z", "sequence": 0, "data": { "action": "subscribed", "subscription": "book:BTC-USD" } }`
 */
export type WebSocketEnvelope<T> = Readonly<{
  messageVersion: '1.0';
  correlationId: string;
  emittedAt: string;
  sequence: number;
  data: T;
}>;

/**
 * Подтверждение subscribe/unsubscribe с каноническим subscription key.
 * Ack отправляется до initial snapshot, поэтому после него клиент может считать
 * channel зарегистрированным и безопасно применять последующие `market.data`.
 *
 * @example
 * `{ "action": "subscribed", "subscription": "book:BTC-USD" }`
 */
export type SubscriptionAckDto = Readonly<{
  action: 'subscribed' | 'unsubscribed';
  subscription: string;
}>;

/**
 * Безопасная protocol error без stack trace, API key и внутренних деталей.
 * `recoverable` сообщает, можно ли исправить команду в текущем соединении; при
 * false gateway обычно разрывает connection и требует новый handshake.
 *
 * @example
 * `{ "code": "AUTH_REQUIRED", "message": "Private subscription requires authentication", "recoverable": true }`
 */
export type WebSocketErrorDto = Readonly<{
  code: string;
  message: string;
  recoverable: boolean;
}>;

/**
 * Heartbeat-ответ с серверным временем, не зависящий от business state.
 * `receivedAt` формируется непосредственно handler-ом, а optional `sentAt`
 * копируется из валидной команды для расчёта latency на стороне клиента.
 *
 * @example
 * `{ "receivedAt": "2026-09-09T00:00:00.010Z", "sentAt": "2026-09-09T00:00:00.000Z" }`
 */
export type HeartbeatResponseDto = Readonly<{
  receivedAt: string;
  sentAt?: string | undefined;
}>;
