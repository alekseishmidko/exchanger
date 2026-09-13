/**
 * Версионируемый каталог форм нагрузки для k6.
 *
 * Каждый профиль управляет REST arrival rate и числом параллельных WebSocket
 * сессий независимо. Значения допускают уменьшение через `LOAD_DURATION` в CI,
 * но release-прогон обязан использовать зафиксированные здесь интервалы.
 */
export const PROFILES = Object.freeze({
  smoke: {
    rest: {
      executor: 'constant-arrival-rate',
      rate: 1,
      timeUnit: '1s',
      duration: '15s',
      preAllocatedVUs: 2,
      maxVUs: 4,
    },
    websocket: { executor: 'constant-vus', vus: 1, duration: '15s' },
  },
  average: {
    rest: {
      executor: 'constant-arrival-rate',
      rate: 20,
      timeUnit: '1s',
      duration: '2m',
      preAllocatedVUs: 20,
      maxVUs: 60,
    },
    websocket: { executor: 'constant-vus', vus: 25, duration: '2m' },
  },
  stress: {
    rest: {
      executor: 'ramping-arrival-rate',
      startRate: 20,
      timeUnit: '1s',
      preAllocatedVUs: 50,
      maxVUs: 300,
      stages: [
        { duration: '2m', target: 50 },
        { duration: '5m', target: 100 },
        { duration: '2m', target: 20 },
      ],
    },
    websocket: {
      executor: 'ramping-vus',
      startVUs: 10,
      stages: [
        { duration: '2m', target: 100 },
        { duration: '5m', target: 250 },
        { duration: '2m', target: 0 },
      ],
    },
  },
  spike: {
    rest: {
      executor: 'ramping-arrival-rate',
      startRate: 10,
      timeUnit: '1s',
      preAllocatedVUs: 50,
      maxVUs: 500,
      stages: [
        { duration: '30s', target: 10 },
        { duration: '15s', target: 300 },
        { duration: '1m', target: 300 },
        { duration: '30s', target: 10 },
      ],
    },
    websocket: {
      executor: 'ramping-vus',
      startVUs: 10,
      stages: [
        { duration: '30s', target: 10 },
        { duration: '15s', target: 500 },
        { duration: '1m', target: 500 },
        { duration: '30s', target: 0 },
      ],
    },
  },
  soak: {
    rest: {
      executor: 'constant-arrival-rate',
      rate: 30,
      timeUnit: '1s',
      duration: '2h',
      preAllocatedVUs: 30,
      maxVUs: 100,
    },
    websocket: { executor: 'constant-vus', vus: 100, duration: '2h' },
  },
  breakpoint: {
    rest: {
      executor: 'ramping-arrival-rate',
      startRate: 20,
      timeUnit: '1s',
      preAllocatedVUs: 100,
      maxVUs: 1000,
      stages: [
        { duration: '2m', target: 100 },
        { duration: '2m', target: 250 },
        { duration: '2m', target: 500 },
        { duration: '2m', target: 1000 },
      ],
    },
    websocket: {
      executor: 'ramping-vus',
      startVUs: 20,
      stages: [
        { duration: '2m', target: 100 },
        { duration: '2m', target: 250 },
        { duration: '2m', target: 500 },
        { duration: '2m', target: 1000 },
      ],
    },
  },
});

/**
 * Возвращает профиль по имени и завершает init phase при опечатке.
 *
 * @param {string} name Значение `LOAD_PROFILE`.
 * @returns {object} Конфигурация REST и WebSocket executors.
 */
export function profile(name) {
  const selected = PROFILES[name];
  if (!selected) throw new Error(`Неизвестный LOAD_PROFILE: ${name}`);
  return selected;
}
