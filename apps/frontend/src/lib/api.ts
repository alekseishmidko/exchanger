export type HttpMethod = 'GET' | 'POST';

export type RequestLogEntry = Readonly<{
  id: string;
  method: HttpMethod;
  path: string;
  status: number | 'NETWORK_ERROR';
  durationMs: number;
  ok: boolean;
  timestamp: string;
  requestBody?: unknown;
  responseBody: unknown;
}>;

export type ApiClientConfig = Readonly<{
  baseUrl: string;
  apiKey: string;
}>;

/**
 * Генерирует компактный idempotency key для ручных команд.
 *
 * Ключ включает назначение команды и timestamp. Этого достаточно для панели:
 * оператор видит ключ в форме, может повторить тот же запрос вручную и проверить
 * idempotency, либо сгенерировать новый ключ для нового business effect.
 */
export function makeIdempotencyKey(scope: string): string {
  return `${scope}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Безопасно форматирует произвольный JSON для textarea/ответов.
 *
 * `undefined` превращается в пустую строку, чтобы формы не отправляли строку
 * `"undefined"` как body. Ошибка сериализации маловероятна, но bounded fallback
 * не ломает UI при циклических объектах из browser extensions.
 */
export function prettyJson(value: unknown): string {
  if (value === undefined) return '';
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/**
 * Делает bounded preview для UI, чтобы большой OpenMetrics/plain text response
 * не подвешивал React при сохранении в state и форматировании `<pre>`.
 */
export function compactForUi(value: unknown, maxLength = 12_000): unknown {
  if (typeof value === 'string') return truncate(value, maxLength);
  const rendered = prettyJson(value);
  if (rendered.length <= maxLength) return value;
  return {
    preview: truncate(rendered, maxLength),
    truncated: true,
    originalLength: rendered.length,
  };
}

/** Ограничивает строку и явно показывает факт усечения. */
function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength)}\n… truncated ${value.length - maxLength} chars`;
}

/**
 * Парсит JSON из textarea и возвращает понятную ошибку для оператора.
 *
 * @example
 * const body = parseJsonBody('{"commandId":"cmd-1"}');
 */
export function parseJsonBody(source: string): unknown {
  const trimmed = source.trim();
  if (!trimmed) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown JSON parse error';
    throw new Error(`Некорректный JSON: ${message}`);
  }
}

/**
 * Выполняет HTTP-запрос к backend и возвращает нормализованный журналируемый
 * результат. API key передаётся только в header и никогда не попадает в log body.
 */
export async function callApi(
  config: ApiClientConfig,
  method: HttpMethod,
  path: string,
  body?: unknown,
  idempotencyKey?: string,
): Promise<RequestLogEntry> {
  const started = performance.now();
  const normalizedBase = config.baseUrl.replace(/\/+$/, '');
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  const headers: Record<string, string> = {
    accept: 'application/json',
    ...(config.apiKey ? { 'x-api-key': config.apiKey } : {}),
  };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (idempotencyKey) headers['idempotency-key'] = idempotencyKey;

  try {
    const init: RequestInit = {
      method,
      headers,
    };
    if (body !== undefined) init.body = JSON.stringify(body);
    const response = await fetch(`${normalizedBase}${normalizedPath}`, init);
    const text = await response.text();
    const responseBody = compactForUi(text ? safeJson(text) : null);
    return {
      id: crypto.randomUUID(),
      method,
      path: normalizedPath,
      status: response.status,
      durationMs: Math.round((performance.now() - started) * 100) / 100,
      ok: response.ok,
      timestamp: new Date().toISOString(),
      requestBody: body,
      responseBody,
    };
  } catch (error) {
    return {
      id: crypto.randomUUID(),
      method,
      path: normalizedPath,
      status: 'NETWORK_ERROR',
      durationMs: Math.round((performance.now() - started) * 100) / 100,
      ok: false,
      timestamp: new Date().toISOString(),
      requestBody: body,
      responseBody: { message: error instanceof Error ? error.message : 'Network error' },
    };
  }
}

/** Парсит JSON response, но оставляет text/plain как строку для диагностики. */
function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
