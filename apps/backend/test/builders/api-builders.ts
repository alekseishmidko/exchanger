import { ApiKeyRegistry } from '../../src/modules/gateway/gateway.auth';

/** Роли тестовых API keys, которые повторяют public access matrix Gateway/Admin. */
type TestApiKeyRole = 'trader' | 'admin' | 'risk_manager' | 'auditor' | 'support';

/** Описание одного тестового API key без секрета production-уровня. */
type TestApiKeyDefinition = Readonly<{ keyId: string; role: TestApiKeyRole; userId: string }>;

/**
 * Возвращает стандартный набор principals для transport/e2e проверок.
 *
 * Набор держится в одном месте, чтобы spec-файлы описывали сценарий, а не
 * повторяли access matrix. Если роль меняется в Gateway/Admin boundary, тесты
 * должны обновить этот builder и явно показать изменение public-поведения.
 *
 * @example
 * const registry = testApiKeyRegistry();
 */
export function testApiKeyRegistry(): ApiKeyRegistry {
  return new ApiKeyRegistry(testApiKeys());
}

/**
 * Возвращает API keys для flow-тестов с одним trader principal.
 *
 * Используется там, где тест проверяет не матрицу ролей, а прохождение команды
 * через controller → application port → domain → projection.
 */
export function flowApiKeyRegistry(): ApiKeyRegistry {
  return new ApiKeyRegistry([{ keyId: 'flow-key', role: 'trader', userId: 'user-1' }]);
}

/** Stable fixture API keys для REST transport completeness сценариев. */
export function testApiKeys(): readonly TestApiKeyDefinition[] {
  return [
    { keyId: 'trader-1-key', role: 'trader', userId: 'user-1' },
    { keyId: 'trader-2-key', role: 'trader', userId: 'user-2' },
    { keyId: 'admin-1-key', role: 'admin', userId: 'admin-1' },
    { keyId: 'admin-2-key', role: 'admin', userId: 'admin-2' },
    { keyId: 'risk-1-key', role: 'risk_manager', userId: 'risk-1' },
    { keyId: 'risk-2-key', role: 'risk_manager', userId: 'risk-2' },
    { keyId: 'auditor-key', role: 'auditor', userId: 'auditor-1' },
    { keyId: 'support-key', role: 'support', userId: 'support-1' },
  ];
}

/** DTO создания аккаунта с валидным public transport shape. */
export function createAccountBody(
  overrides: Partial<{
    commandId: string;
    accountId: string;
    ownerId: string;
    balances: Array<{ assetId: string; code: string; scale: number }>;
  }> = {},
) {
  return {
    commandId: 'create-account-1',
    accountId: 'account-1',
    ownerId: 'user-1',
    balances: [{ assetId: 'USD', code: 'USD', scale: 2 }],
    ...overrides,
  };
}

/** DTO размещения лимитной заявки с orderId === clientOrderId для lookup flow. */
export function placeOrderBody(
  overrides: Partial<{
    commandId: string;
    orderId: string;
    accountId: string;
    instrumentId: string;
    clientOrderId: string;
    side: 'BUY' | 'SELL';
    orderType: 'LIMIT' | 'MARKET';
    quantity: string;
    limitPrice: string;
    timeInForce: 'GTC' | 'IOC' | 'FOK';
  }> = {},
) {
  const orderId = overrides.orderId ?? 'order-flow-1';
  return {
    commandId: 'flow-place-1',
    orderId,
    accountId: 'user-1',
    instrumentId: 'BTC-USD',
    clientOrderId: overrides.clientOrderId ?? orderId,
    side: 'BUY' as const,
    orderType: 'LIMIT' as const,
    quantity: '1',
    limitPrice: '100',
    timeInForce: 'GTC' as const,
    ...overrides,
  };
}

/** Валидная версия правил инструмента для admin/instrument lifecycle tests. */
export function instrumentRules(
  overrides: Partial<{
    version: string;
    effectiveAt: string;
    tickSize: string;
    lotSize: string;
    minQuantity: string;
    maxQuantity: string;
    minPrice: string;
    maxPrice: string;
    feePolicyVersion: string;
    maxOrderQuantity: string;
    maxOpenOrders: number;
    maxNotional: string;
  }> = {},
) {
  return {
    version: 'rules-v1',
    effectiveAt: '2026-01-01T00:00:00.000Z',
    tickSize: '0.5',
    lotSize: '0.001',
    minQuantity: '0.001',
    maxQuantity: '10',
    minPrice: '100',
    maxPrice: '100000',
    feePolicyVersion: 'fees-v1',
    maxOrderQuantity: '10',
    maxOpenOrders: 100,
    maxNotional: '1000000',
    ...overrides,
  };
}
