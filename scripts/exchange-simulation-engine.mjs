import { randomUUID } from 'node:crypto';

export const DEFAULT_MARKETS = Object.freeze([
  { instrumentId: 'BTC-USD', assetId: 'BTC', initialPrice: 60_000 },
  { instrumentId: 'ETH-USD', assetId: 'ETH', initialPrice: 3_000 },
  { instrumentId: 'SOL-USD', assetId: 'SOL', initialPrice: 150 },
  { instrumentId: 'XRP-USD', assetId: 'XRP', initialPrice: 0.6 },
  { instrumentId: 'ADA-USD', assetId: 'ADA', initialPrice: 0.5 },
  { instrumentId: 'DOGE-USD', assetId: 'DOGE', initialPrice: 0.15 },
]);

/** Детерминированный PRNG Mulberry32 для воспроизводимых торговых прогонов. */
export function createPseudoRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** Нормализует пользовательскую конфигурацию в bounded безопасные пределы. */
export function normalizeSimulationConfig(input = {}) {
  return {
    users: boundedInteger(input.users, 1_000, DEFAULT_MARKETS.length * 2, 10_000),
    seed: boundedInteger(input.seed, 42, 0, 0xffff_ffff),
    ordersPerRound: boundedInteger(input.ordersPerRound, 100, 2, 2_000),
    intervalMs: boundedInteger(input.intervalMs, 1_000, 100, 60_000),
    setupConcurrency: boundedInteger(input.setupConcurrency, 20, 1, 100),
    orderConcurrency: boundedInteger(input.orderConcurrency, 25, 1, 200),
  };
}

/**
 * Synthetic exchange worker. Все изменения состояния выполняются через public
 * HTTP API: admin создаёт рынки и funding, trader keys создают accounts/orders.
 */
export class ExchangeSimulationWorker {
  constructor({ backendUrl, adminApiKey = 'dev-admin-key', fetchImpl = fetch }) {
    this.backendUrl = backendUrl.replace(/\/+$/, '');
    this.adminApiKey = adminApiKey;
    this.fetchImpl = fetchImpl;
    this.running = false;
    this.stopRequested = false;
    this.users = [];
    this.usersByMarket = new Map();
    this.prices = new Map(
      DEFAULT_MARKETS.map((market) => [market.instrumentId, market.initialPrice]),
    );
    this.state = this.emptyState();
  }

  emptyState() {
    return {
      phase: 'idle',
      running: false,
      runId: null,
      startedAt: null,
      stoppedAt: null,
      config: null,
      usersReady: 0,
      usersTotal: 0,
      marketsReady: 0,
      ordersSubmitted: 0,
      ordersAccepted: 0,
      ordersFilled: 0,
      ordersRejected: 0,
      rounds: 0,
      lastRoundAt: null,
      recentErrors: [],
      prices: {},
    };
  }

  /** Возвращает безопасный snapshot без issued API keys. */
  status() {
    return structuredClone({
      ...this.state,
      running: this.running,
      prices: Object.fromEntries(
        [...this.prices.entries()].map(([instrumentId, price]) => [instrumentId, price.toFixed(2)]),
      ),
    });
  }

  /** Запускает setup и торговый loop в фоне. */
  start(input = {}) {
    if (this.running) throw new Error('Simulation is already running');
    const config = normalizeSimulationConfig(input);
    const runId = randomUUID().replaceAll('-', '').slice(0, 12);
    this.running = true;
    this.stopRequested = false;
    this.users = [];
    this.usersByMarket = new Map(DEFAULT_MARKETS.map((market) => [market.instrumentId, []]));
    this.prices = new Map(
      DEFAULT_MARKETS.map((market) => [market.instrumentId, market.initialPrice]),
    );
    this.random = createPseudoRandom(config.seed);
    this.state = {
      ...this.emptyState(),
      phase: 'initializing',
      running: true,
      runId,
      startedAt: new Date().toISOString(),
      config,
      usersTotal: config.users,
    };
    this.runPromise = this.run(config).catch((error) => {
      this.recordError('worker', error);
      this.state.phase = 'failed';
      this.running = false;
      this.state.stoppedAt = new Date().toISOString();
    });
    return this.status();
  }

  /** Просит loop завершиться после текущего bounded batch. */
  stop() {
    this.stopRequested = true;
    if (this.running) this.state.phase = 'stopping';
    return this.status();
  }

  async run(config) {
    await this.waitForBackend();
    const approvalKey = await this.issueApiKey(
      `sim-approval-${this.state.runId}`,
      `simulation-approval-${this.state.runId}`,
      'admin',
    );
    await this.prepareMarkets(approvalKey);
    await this.prepareUsers(config);
    if (this.stopRequested) return this.finish();
    this.state.phase = 'trading';
    while (!this.stopRequested) {
      await this.runTradingRound(config);
      if (!this.stopRequested) await delay(config.intervalMs);
    }
    this.finish();
  }

  finish() {
    this.running = false;
    this.state.phase = 'stopped';
    this.state.stoppedAt = new Date().toISOString();
  }

  async waitForBackend() {
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline && !this.stopRequested) {
      try {
        const response = await this.fetchImpl(`${this.backendUrl}/health/ready`, {
          signal: AbortSignal.timeout(3_000),
        });
        if (response.ok) return;
      } catch {
        // Backend может ещё запускаться; bounded retry продолжается до deadline.
      }
      await delay(500);
    }
    throw new Error('Backend did not become ready within 60 seconds');
  }

  async prepareMarkets(approvalKey) {
    for (const market of DEFAULT_MARKETS) {
      if (this.stopRequested) return;
      const existing = await this.request(`/api/v1/instruments/${market.instrumentId}`, {
        key: this.adminApiKey,
        accepted: [200, 404],
      });
      if (existing.status === 404) {
        const commandId = `sim-market-create-${market.assetId}-${this.state.runId}`;
        await this.dualControl(
          '/api/v1/admin/instruments',
          {
            commandId,
            mode: 'CREATE',
            instrumentId: market.instrumentId,
            baseAssetId: market.assetId,
            quoteAssetId: 'USD',
            rules: marketRules(market, this.state.runId),
          },
          commandId,
          approvalKey,
        );
      }
      const activationId = `sim-market-active-${market.assetId}-${this.state.runId}`;
      await this.dualControl(
        `/api/v1/admin/instruments/${market.instrumentId}/status`,
        { commandId: activationId, status: 'ACTIVE' },
        activationId,
        approvalKey,
        [201, 409],
      );
      this.state.marketsReady += 1;
    }
  }

  async dualControl(path, body, idempotencyKey, approvalKey, accepted = [201, 409]) {
    const requested = await this.request(path, {
      method: 'POST',
      key: this.adminApiKey,
      idempotencyKey,
      body,
      accepted,
    });
    if (requested.status === 409 || requested.body?.status !== 'PENDING_APPROVAL') return;
    await this.request(`/api/v1/admin/approvals/${body.commandId}`, {
      method: 'POST',
      key: approvalKey,
      idempotencyKey: `${idempotencyKey}-approval`,
      body: { commandId: `${body.commandId}-approval` },
      accepted: [201, 409],
    });
  }

  async prepareUsers(config) {
    const indexes = Array.from({ length: config.users }, (_, index) => index);
    await mapConcurrent(indexes, config.setupConcurrency, async (index) => {
      if (this.stopRequested) return;
      const market = DEFAULT_MARKETS[index % DEFAULT_MARKETS.length];
      const suffix = String(index + 1).padStart(5, '0');
      const userId = `sim-user-${suffix}`;
      const accountId = userId;
      try {
        const apiKey = await this.issueApiKey(
          `sim-key-${suffix}-${this.state.runId}`,
          userId,
          'trader',
        );
        await this.request('/api/v1/accounts', {
          method: 'POST',
          key: apiKey,
          idempotencyKey: `sim-account-${suffix}-${this.state.runId}`,
          body: {
            commandId: `sim-account-${suffix}-${this.state.runId}`,
            accountId,
            ownerId: userId,
            balances: [
              { assetId: 'USD', code: 'USD', scale: 2 },
              { assetId: market.assetId, code: market.assetId, scale: 8 },
            ],
          },
          accepted: [201, 409],
        });
        await Promise.all([
          this.credit(accountId, 'USD', '1000000', suffix),
          this.credit(accountId, market.assetId, '1000', suffix),
        ]);
        const user = { userId, accountId, apiKey, market };
        this.users.push(user);
        this.usersByMarket.get(market.instrumentId)?.push(user);
        this.state.usersReady += 1;
      } catch (error) {
        this.recordError(`setup:${userId}`, error);
      }
    });
    if (this.users.length < 2) throw new Error('Fewer than two simulation users are ready');
  }

  async issueApiKey(commandId, userId, role) {
    const issued = await this.request('/api/v1/machine-auth/api-keys', {
      method: 'POST',
      key: this.adminApiKey,
      idempotencyKey: commandId,
      body: {
        commandId,
        userId,
        role,
        label: commandId,
        ownerType: role === 'admin' ? 'SYSTEM' : 'USER',
        scopes:
          role === 'admin'
            ? ['admin:*', 'trading:read', 'trading:write']
            : ['trading:read', 'trading:write'],
      },
      accepted: [201],
    });
    if (typeof issued.body?.apiKey !== 'string') throw new Error('API key was not issued');
    return issued.body.apiKey;
  }

  async credit(accountId, assetId, amount, suffix) {
    const commandId = `sim-fund-${assetId}-${suffix}-${this.state.runId}`;
    await this.request(`/api/v1/accounts/${accountId}/balances/${assetId}/commands`, {
      method: 'POST',
      key: this.adminApiKey,
      idempotencyKey: commandId,
      body: { commandId, action: 'CREDIT', amount },
      accepted: [201],
    });
  }

  async runTradingRound(config) {
    const pairCount = Math.max(1, Math.floor(config.ordersPerRound / 2));
    const pairs = Array.from({ length: pairCount }, (_, index) => index);
    await mapConcurrent(pairs, config.orderConcurrency, async () => {
      const market = DEFAULT_MARKETS[Math.floor(this.random() * DEFAULT_MARKETS.length)];
      const marketUsers = this.usersByMarket.get(market.instrumentId) ?? [];
      if (marketUsers.length < 2) return;
      const firstIndex = Math.floor(this.random() * marketUsers.length);
      let secondIndex = Math.floor(this.random() * marketUsers.length);
      if (secondIndex === firstIndex) secondIndex = (secondIndex + 1) % marketUsers.length;
      const first = marketUsers[firstIndex];
      const second = marketUsers[secondIndex];
      const firstSide = this.random() < 0.5 ? 'BUY' : 'SELL';
      const price = this.nextPrice(market);
      const quantity = (Math.floor(this.random() * 20) + 1) / 100;
      await Promise.all([
        this.placeOrder(first, firstSide, market, price, quantity),
        this.placeOrder(second, firstSide === 'BUY' ? 'SELL' : 'BUY', market, price, quantity),
      ]);
    });
    this.state.rounds += 1;
    this.state.lastRoundAt = new Date().toISOString();
  }

  nextPrice(market) {
    const current = this.prices.get(market.instrumentId) ?? market.initialPrice;
    const movement = (this.random() - 0.5) * 0.02;
    const next = Math.max(0.01, current * (1 + movement));
    this.prices.set(market.instrumentId, next);
    return next.toFixed(2);
  }

  async placeOrder(user, side, market, price, quantity) {
    const sequence = ++this.state.ordersSubmitted;
    const orderId = `sim-${this.state.runId}-${sequence}`;
    try {
      const response = await this.request('/api/v1/orders', {
        method: 'POST',
        key: user.apiKey,
        idempotencyKey: orderId,
        body: {
          commandId: orderId,
          orderId,
          accountId: user.accountId,
          instrumentId: market.instrumentId,
          clientOrderId: orderId,
          side,
          orderType: 'LIMIT',
          quantity: quantity.toFixed(2),
          limitPrice: price,
          timeInForce: 'GTC',
        },
        accepted: [201],
      });
      this.state.ordersAccepted += 1;
      if (response.body?.orderStatus === 'FILLED') this.state.ordersFilled += 1;
    } catch (error) {
      this.state.ordersRejected += 1;
      this.recordError(`order:${orderId}`, error);
    }
  }

  async request(path, { method = 'GET', key, idempotencyKey, body, accepted = [200] } = {}) {
    const response = await this.fetchImpl(`${this.backendUrl}${path}`, {
      method,
      signal: AbortSignal.timeout(10_000),
      headers: {
        accept: 'application/json',
        ...(key ? { 'x-api-key': key } : {}),
        ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}),
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const responseBody = await response.json().catch(() => null);
    if (!accepted.includes(response.status)) {
      throw new Error(
        `${method} ${path}: HTTP ${response.status} ${responseBody?.code ?? ''}`.trim(),
      );
    }
    return { status: response.status, body: responseBody };
  }

  recordError(scope, error) {
    const message = error instanceof Error ? error.message : String(error);
    this.state.recentErrors = [
      { at: new Date().toISOString(), scope, message },
      ...this.state.recentErrors,
    ].slice(0, 10);
  }
}

function marketRules(market, runId) {
  return {
    version: `simulation-${runId}`,
    effectiveAt: '2026-01-01T00:00:00.000Z',
    tickSize: '0.01',
    lotSize: '0.001',
    minQuantity: '0.001',
    maxQuantity: '1000',
    minPrice: '0.01',
    maxPrice: String(Math.max(10_000_000, market.initialPrice * 100)),
    feePolicyVersion: 'simulation-zero-fee',
    maxOrderQuantity: '1000',
    maxOpenOrders: 100_000,
    maxNotional: '10000000000',
  };
}

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number(value ?? fallback);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`Expected an integer between ${minimum} and ${maximum}`);
  }
  return parsed;
}

export async function mapConcurrent(items, concurrency, operation) {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      await operation(items[index], index);
    }
  });
  await Promise.all(workers);
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
