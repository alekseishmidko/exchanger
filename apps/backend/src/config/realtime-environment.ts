type RealtimeEnvironmentConfig = Readonly<Record<string, unknown>>;

/** Проверяет настройки Twelve Data, realtime cache/stream и reference-price execution. */
export function validateRealtimeEnvironment(config: RealtimeEnvironmentConfig): void {
  const twelveDataEnabled = config['TWELVE_DATA_ENABLED'] ?? 'false';
  if (
    typeof twelveDataEnabled !== 'string' ||
    !['true', 'false', '1', '0'].includes(twelveDataEnabled)
  )
    throw new Error('TWELVE_DATA_ENABLED must be true, false, 1, or 0');
  const realtimeExecutionEnabled = config['REALTIME_EXECUTION_ENABLED'] ?? 'false';
  if (
    typeof realtimeExecutionEnabled !== 'string' ||
    !['true', 'false', '1', '0'].includes(realtimeExecutionEnabled)
  )
    throw new Error('REALTIME_EXECUTION_ENABLED must be true, false, 1, or 0');
  const catalogSyncOnStart = config['TWELVE_DATA_CATALOG_SYNC_ON_START'] ?? 'true';
  if (typeof catalogSyncOnStart !== 'string' || !['true', 'false'].includes(catalogSyncOnStart))
    throw new Error('TWELVE_DATA_CATALOG_SYNC_ON_START must be true or false');

  for (const key of [
    'TWELVE_DATA_REQUEST_TIMEOUT_MS',
    'TWELVE_DATA_QUOTE_MAX_AGE_MS',
    'TWELVE_DATA_QUOTE_TTL_MS',
    'TWELVE_DATA_HEARTBEAT_MS',
    'TWELVE_DATA_RECONNECT_MIN_MS',
    'TWELVE_DATA_RECONNECT_MAX_MS',
    'TWELVE_DATA_LEADER_TTL_MS',
    'TWELVE_DATA_MAX_SYMBOLS',
    'TWELVE_DATA_REST_BOOTSTRAP_LIMIT',
    'TWELVE_DATA_CATALOG_SYNC_INTERVAL_MS',
    'REALTIME_MAX_SUBSCRIPTIONS_PER_SOCKET',
    'REALTIME_MAX_PENDING_MESSAGES',
  ] as const) {
    const value = config[key];
    const normalized =
      typeof value === 'string' || typeof value === 'number' ? `${value}` : undefined;
    if (value !== undefined && (normalized === undefined || !/^\d+$/.test(normalized)))
      throw new Error(`${key} must be a positive integer`);
    if (value !== undefined && Number(value) < 1)
      throw new Error(`${key} must be a positive integer`);
  }

  const maxAge = Number(config['TWELVE_DATA_QUOTE_MAX_AGE_MS'] ?? 5000);
  const quoteTtl = Number(config['TWELVE_DATA_QUOTE_TTL_MS'] ?? 15000);
  if (quoteTtl < maxAge)
    throw new Error('TWELVE_DATA_QUOTE_TTL_MS cannot be lower than quote max age');
  const reconnectMin = Number(config['TWELVE_DATA_RECONNECT_MIN_MS'] ?? 1000);
  const reconnectMax = Number(config['TWELVE_DATA_RECONNECT_MAX_MS'] ?? 30000);
  if (reconnectMin > reconnectMax)
    throw new Error('TWELVE_DATA_RECONNECT_MIN_MS cannot exceed max');
  const retainedRatio = Number(config['TWELVE_DATA_CATALOG_MIN_RETAINED_RATIO'] ?? 0.5);
  if (!Number.isFinite(retainedRatio) || retainedRatio <= 0 || retainedRatio > 1)
    throw new Error('TWELVE_DATA_CATALOG_MIN_RETAINED_RATIO must be within (0, 1]');

  const rawAssetClasses = config['TWELVE_DATA_ASSET_CLASSES'] ?? 'crypto,forex';
  if (typeof rawAssetClasses !== 'string')
    throw new Error('TWELVE_DATA_ASSET_CLASSES contains an unsupported asset class');
  const assetClasses = rawAssetClasses
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  if (
    assetClasses.length === 0 ||
    assetClasses.some((value) => !['crypto', 'forex', 'stock', 'commodity'].includes(value))
  )
    throw new Error('TWELVE_DATA_ASSET_CLASSES contains an unsupported asset class');

  if (['true', '1'].includes(twelveDataEnabled)) validateEnabledProvider(config);
  validateExecution(config, twelveDataEnabled, realtimeExecutionEnabled);
}

/** Проверяет secrets/endpoints/cache для включённого upstream provider. */
function validateEnabledProvider(config: RealtimeEnvironmentConfig): void {
  if (
    typeof config['TWELVE_DATA_API_KEY'] !== 'string' ||
    String(config['TWELVE_DATA_API_KEY']).length < 8
  )
    throw new Error('TWELVE_DATA_API_KEY is required when Twelve Data is enabled');
  for (const [key, protocol] of [
    ['TWELVE_DATA_REST_URL', 'https:'],
    ['TWELVE_DATA_WS_URL', 'wss:'],
  ] as const) {
    const raw = config[key];
    if (typeof raw !== 'string') throw new Error(`${key} is required when Twelve Data is enabled`);
    try {
      if (new URL(raw).protocol !== protocol) throw new Error('unsafe protocol');
    } catch {
      throw new Error(`${key} must use ${protocol}`);
    }
  }
  const redisUrl = config['TWELVE_DATA_REDIS_URL'];
  if (typeof redisUrl !== 'string')
    throw new Error('TWELVE_DATA_REDIS_URL is required when Twelve Data is enabled');
  try {
    const parsed = new URL(redisUrl);
    if (!['redis:', 'rediss:'].includes(parsed.protocol) || !parsed.hostname)
      throw new Error('invalid Redis URL');
    if (
      config['RUNTIME_PROFILE'] !== 'component' &&
      (parsed.protocol !== 'rediss:' || !parsed.username || !parsed.password)
    )
      throw new Error('Redis TLS/AUTH required');
  } catch {
    throw new Error(
      'TWELVE_DATA_REDIS_URL must be a valid Redis URL (TLS/AUTH in production-like runtime)',
    );
  }
}

/** Проверяет отдельный durable execution flow и системные settlement accounts. */
function validateExecution(
  config: RealtimeEnvironmentConfig,
  twelveDataEnabled: string,
  realtimeExecutionEnabled: string,
): void {
  const rawFeeRate = config['REALTIME_EXECUTION_FEE_RATE'] ?? '0';
  const feeRate =
    typeof rawFeeRate === 'string' || typeof rawFeeRate === 'number' ? `${rawFeeRate}` : '';
  if (!/^(0|1|0\.\d+)$/.test(feeRate) || Number(feeRate) < 0 || Number(feeRate) >= 1)
    throw new Error('REALTIME_EXECUTION_FEE_RATE must be within [0, 1)');
  if (!['true', '1'].includes(realtimeExecutionEnabled)) return;
  if (!['true', '1'].includes(twelveDataEnabled))
    throw new Error('REALTIME_EXECUTION_ENABLED requires TWELVE_DATA_ENABLED');
  if (config['RUNTIME_PROFILE'] === 'component')
    throw new Error('REALTIME_EXECUTION_ENABLED requires durable adapters');
  if (
    typeof config['REALTIME_LIQUIDITY_ACCOUNT_ID'] !== 'string' ||
    !config['REALTIME_LIQUIDITY_ACCOUNT_ID']
  )
    throw new Error('REALTIME_LIQUIDITY_ACCOUNT_ID is required');
  if (
    Number(feeRate) > 0 &&
    (typeof config['REALTIME_FEE_ACCOUNT_ID'] !== 'string' || !config['REALTIME_FEE_ACCOUNT_ID'])
  )
    throw new Error('REALTIME_FEE_ACCOUNT_ID is required when fee rate is positive');
  if (
    Number(feeRate) > 0 &&
    config['REALTIME_FEE_ACCOUNT_ID'] === config['REALTIME_LIQUIDITY_ACCOUNT_ID']
  )
    throw new Error('REALTIME_FEE_ACCOUNT_ID must differ from liquidity account');
}
