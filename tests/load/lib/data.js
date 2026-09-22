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
 * Строит public PlaceOrder DTO для стабильного accepted-load контура.
 *
 * После подключения Stage 21 runtime заявки больше не проходят shortcut:
 * MARKET/IOC/FOK или crossing orders одного аккаунта могут законно получить
 * бизнес-отказ `409` из-за empty book, self-trade prevention или terminal
 * remainder. CI load gate измеряет throughput/latency принятого command path,
 * поэтому использует non-crossing `BUY LIMIT GTC`; buyer/seller matching и
 * multi-fill доказываются отдельным `business:e2e:staging`.
 */
export function placeOrderData({ runId, scenario, vu, iteration, distribution, suffix = 0 }) {
  const value = bucket(vu, iteration, suffix + 2);
  const orderId = uniqueId(runId, 'order', scenario, vu, iteration, suffix);
  return {
    commandId: uniqueId(runId, 'place', scenario, vu, iteration, suffix),
    orderId,
    accountId: __ENV.LOAD_ACCOUNT_ID || 'dev-user',
    instrumentId: instrumentFor(distribution, vu, iteration),
    clientOrderId: orderId,
    side: 'BUY',
    orderType: 'LIMIT',
    quantity: QUANTITIES[value % QUANTITIES.length],
    limitPrice: PRICES[value % PRICES.length],
    timeInForce: 'GTC',
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
 * Строит несколько non-crossing команд для нагрузки на batch path.
 *
 * Название сохранено для совместимости с профилями и отчётами, но в CI load
 * suite этот helper не моделирует self-crossing сделку одного аккаунта: такой
 * сценарий должен получать отказ self-trade prevention и проверяется не здесь.
 */
export function multiFillData(context) {
  const maker = placeOrderData({ ...context, suffix: 10 });
  return [
    {
      ...maker,
      orderType: 'LIMIT',
      timeInForce: 'GTC',
      quantity: '1',
      limitPrice: '95',
    },
    {
      ...placeOrderData({ ...context, suffix: 11 }),
      orderType: 'LIMIT',
      timeInForce: 'GTC',
      quantity: '0.4',
      limitPrice: '97.5',
    },
    {
      ...placeOrderData({ ...context, suffix: 12 }),
      orderType: 'LIMIT',
      timeInForce: 'GTC',
      quantity: '0.6',
      limitPrice: '99',
    },
  ];
}
