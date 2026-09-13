import http from 'k6/http';

/** Создаёт headers без записи API key в tags или custom metrics. */
export function headers(apiKey, idempotencyKey) {
  return {
    accept: 'application/json',
    'content-type': 'application/json',
    'x-api-key': apiKey,
    ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}),
  };
}

/** Выполняет command POST с нормализованным endpoint name для метрик k6. */
export function postCommand(baseUrl, path, body, apiKey, idempotencyKey, tags = {}) {
  return http.post(`${baseUrl}${path}`, JSON.stringify(body), {
    headers: headers(apiKey, idempotencyKey),
    tags: { name: path.replace(/\/[^/]+\/cancel$/, '/:orderId/cancel'), ...tags },
    timeout: __ENV.LOAD_REQUEST_TIMEOUT || '5s',
  });
}

/** Выполняет авторизованный query GET с bounded metric name. */
export function getQuery(baseUrl, path, apiKey, name = path) {
  return http.get(`${baseUrl}${path}`, {
    headers: headers(apiKey),
    tags: { name },
    timeout: __ENV.LOAD_REQUEST_TIMEOUT || '5s',
  });
}
