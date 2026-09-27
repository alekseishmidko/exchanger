import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createPseudoRandom,
  extractSessionCookies,
  mapConcurrent,
  normalizeSimulationConfig,
} from './exchange-simulation-engine.mjs';

test('pseudo-random generator is deterministic for the same seed', () => {
  const first = createPseudoRandom(42);
  const second = createPseudoRandom(42);
  assert.deepEqual(
    Array.from({ length: 8 }, () => first()),
    Array.from({ length: 8 }, () => second()),
  );
});

test('extracts opaque session and CSRF credentials from login cookies', () => {
  assert.deepEqual(
    extractSessionCookies([
      'exchange_session=opaque-session; Path=/; HttpOnly; SameSite=Strict',
      'exchange_csrf=csrf-value; Path=/; SameSite=Strict',
    ]),
    {
      cookie: 'exchange_session=opaque-session; exchange_csrf=csrf-value',
      csrfToken: 'csrf-value',
    },
  );
});

test('simulation defaults to 1000 bounded users', () => {
  assert.equal(normalizeSimulationConfig().users, 1_000);
  assert.throws(() => normalizeSimulationConfig({ users: 11 }), /between 12 and 10000/);
  assert.throws(() => normalizeSimulationConfig({ users: 10_001 }), /between 12 and 10000/);
});

test('bounded concurrent mapper processes every item once', async () => {
  const processed = [];
  await mapConcurrent([1, 2, 3, 4, 5], 2, async (value) => processed.push(value));
  assert.deepEqual(
    processed.sort((left, right) => left - right),
    [1, 2, 3, 4, 5],
  );
});
