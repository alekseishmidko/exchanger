# Realtime market (Twelve Data)

Модуль реализует этапы 1–5 из `docs/twelve-data-integration-plan.md` и не
участвует во внутреннем matching flow.

## Реализовано

- строгие shared contracts внешнего инструмента, quote и будущей подписки;
- локальный read-only REST catalog `/api/v1/realtime/instruments`;
- status endpoint `/api/v1/realtime/market-status`;
- admin idempotent trigger `/api/v1/admin/realtime/catalog-sync`;
- allow-listed Twelve Data REST adapter для catalog endpoints;
- memory adapters для component profile и PostgreSQL catalog для durable profile;
- defensive snapshot publication с защитой от пустого/резко уменьшившегося ответа;
- single-owner Twelve Data WebSocket ingest с Redis lease/fencing, heartbeat и reconnect;
- подтверждение полной upstream-подписки до состояния `CONNECTED`, bounded ACK timeout;
- atomic Redis latest quote, local sequence, TTL и Pub/Sub publication;
- feature flag и fail-fast environment validation.
- REST quotes и отдельный Socket.IO namespace `/realtime-market-data`;
- reference-price orders/history, private execution events и EXACT_LAST policy;
- atomic command, quote snapshot, execution, ledger и outbox transaction;
- отдельные price/trading allowlists, kill switch и reconciliation endpoint.

`TWELVE_DATA_ENABLED=false` является безопасным default. В этом режиме модуль не
открывает network connections и не требует provider credentials.

Для локального подключения заполните секрет только в ignored-файле
`.env.development` (для production — в `.env.production` или secret store), затем
включите provider:

```dotenv
TWELVE_DATA_API_KEY=<ваш ключ Twelve Data>
TWELVE_DATA_ENABLED=true
TWELVE_DATA_REDIS_URL=<адрес выделенного Redis>
```

Development Compose поднимает изолированный Redis автоматически. При запуске
backend непосредственно на host используется `redis://127.0.0.1:6380`, чтобы не
конфликтовать с системным Redis на стандартном порту.

Один `TWELVE_DATA_API_KEY` используется серверными REST- и WebSocket-адаптерами.
REST передаёт его в `Authorization` header, поэтому secret не попадает в URL;
WebSocket использует provider handshake query. Клиентским приложениям ключ не
передаётся.

Одноразовая проверка credentials и `/quote` без включения live-зависимости в CI:

```bash
pnpm twelve-data:smoke:test
pnpm twelve-data:smoke
pnpm twelve-data:ws-smoke:test
pnpm twelve-data:ws-smoke
```

REST live-команда расходует один API credit. WebSocket live-команда временно
занимает один subscription credit до закрытия соединения. Очищенные отчёты
сохраняются в `artifacts/twelve-data-smoke/`.

## Инварианты

- публичный request никогда не вызывает Twelve Data;
- provider URL/path/query не принимаются от клиента;
- raw API key и upstream payload не попадают в DTO/cache/logs;
- catalog import не включает price/trading автоматически;
- upstream connection существует только у владельца renewable Redis lease;
- stale/duplicate/out-of-order quote не заменяет более новый snapshot.
