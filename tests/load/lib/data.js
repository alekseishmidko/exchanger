/** Ожидаемое production-подобное распределение типов заявок и размеров. */
const QUANTITIES = ['0.01', '0.05', '0.1', '0.25', '0.5', '1', '2', '5'];
const PRICES = ['95', '97.5', '99', '100', '101', '102.5', '105'];
const INSTRUMENTS = ['BTC-USD', 'ETH-USD', 'SOL-USD', 'ADA-USD'];

/**
 * Формирует идентификатор, уникальный для run/scenario/VU/iteration.
 * Значение не зависит от wall clock и поэтому воспроизводимо при replay.
 */
export function uniqueId(runId, prefix, scenario, vu, iteration, suffix = 0) {
  return `${prefix}-${runId}-${scenario}-${vu}-${iteration}-${suffix}`;
}

/** Возвращает детерминированное число 0..99 без Math.random. */
function bucket(vu, iteration, salt) {
  return Math.abs(vu * 31 + iteration * 17 + salt * 13) % 100;
}

/**
 * Выбирает инструмент для hot либо uniform workload.
 * В hot-профиле 80% команд адресуют BTC-USD, имитируя концентрированную partition.
 */
export function instrumentFor(distribution, vu, iteration) {
  const value = bucket(vu, iteration, 1);
  if (distribution === 'hot' && value < 80) return 'BTC-USD';
  return INSTRUMENTS[value % INSTRUMENTS.length];
}

/**
 * Строит public PlaceOrder DTO с production-подобными весами.
 * LIMIT составляет 85%, BUY/SELL близки к 50/50, IOC/FOK вместе — 20%.
 */
export function placeOrderData({ runId, scenario, vu, iteration, distribution, suffix = 0 }) {
  const value = bucket(vu, iteration, suffix + 2);
  const orderType = value < 85 ? 'LIMIT' : 'MARKET';
  const timeInForce = value < 80 ? 'GTC' : value < 95 ? 'IOC' : 'FOK';
  const orderId = uniqueId(runId, 'order', scenario, vu, iteration, suffix);
  return {
    commandId: uniqueId(runId, 'place', scenario, vu, iteration, suffix),
    orderId,
    accountId: __ENV.LOAD_ACCOUNT_ID || 'dev-user',
    instrumentId: instrumentFor(distribution, vu, iteration),
    clientOrderId: orderId,
    side: value % 2 === 0 ? 'BUY' : 'SELL',
    orderType,
    quantity: QUANTITIES[value % QUANTITIES.length],
    limitPrice: orderType === 'LIMIT' ? PRICES[value % PRICES.length] : null,
    timeInForce,
  };
}

/** Строит DTO отмены на основе ранее созданной заявки. */
export function cancelOrderData(place, runId, scenario, vu, iteration) {
  return {
    commandId: uniqueId(runId, 'cancel', scenario, vu, iteration),
    orderId: place.orderId,
    accountId: place.accountId,
    instrumentId: place.instrumentId,
  };
}

/**
 * Строит три команды partial/multi-fill сценария.
 * Первая SELL заявка создаёт объём 1, две BUY заявки по 0.4 и 0.6 должны закрыть
 * его двумя сделками после подключения настоящего matching application port.
 */
export function multiFillData(context) {
  const maker = placeOrderData({ ...context, suffix: 10 });
  return [
    {
      ...maker,
      side: 'SELL',
      orderType: 'LIMIT',
      timeInForce: 'GTC',
      quantity: '1',
      limitPrice: '100',
    },
    {
      ...placeOrderData({ ...context, suffix: 11 }),
      side: 'BUY',
      orderType: 'LIMIT',
      timeInForce: 'IOC',
      quantity: '0.4',
      limitPrice: '100',
    },
    {
      ...placeOrderData({ ...context, suffix: 12 }),
      side: 'BUY',
      orderType: 'LIMIT',
      timeInForce: 'IOC',
      quantity: '0.6',
      limitPrice: '100',
    },
  ];
}
