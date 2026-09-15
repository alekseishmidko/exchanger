import { createHash } from 'node:crypto';

/**
 * Сериализует JSON value с рекурсивной сортировкой object keys.
 *
 * Одинаковый логический payload получает одинаковую строку независимо от
 * порядка свойств, что необходимо для idempotency fingerprint и audit hash.
 * Массивы сохраняют порядок, поскольку для команд он может иметь смысл.
 *
 * @param value JSON-совместимое значение без циклических ссылок.
 * @returns Каноническая JSON-строка.
 */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * Вычисляет SHA-256 digest канонического JSON без сохранения исходного секрета.
 * @param value Значение idempotency key или payload.
 * @returns Hex digest фиксированной длины.
 */
export function sha256(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}
