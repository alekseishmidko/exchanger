# Технологический стек

Статус: draft 0.3 — TypeScript only  
Основание: `system-design-requirements.md` и `architecture.md`.

## 1. Рекомендуемый стек

| Слой | Выбор | Назначение |
|---|---|---|
| Язык платформы | TypeScript на Node.js | Все компоненты системы, включая trading core |
| Framework | NestJS | Модульная структура приложения, DI, REST, WebSocket и operations |
| HTTP/API | NestJS на Fastify adapter | REST, WebSocket, security, configuration, operations |
| Торговое ядро | Чистый TypeScript-модуль без HTTP/DB/framework-зависимости | Deterministic state machine, order book, matching |
| Event log | Redpanda, Kafka-compatible | Durable append-only events, partitions, replay, consumer groups |
| Транзакционные данные | PostgreSQL | Ledger, accounts, idempotency, config и query projections |
| Snapshots/archive | S3-compatible storage; локально MinIO | Snapshots state machine и cold archive |
| Cache | Redis — только при необходимости | Rate limits, ephemeral cache, WebSocket fan-out; не источник истины |
| Схемы сообщений | Protobuf | Версионируемые внутренние commands/events |
| Внешний API-контракт | OpenAPI + JSON | REST-клиенты и документация |
| Миграции | node-pg-migrate или версионированный SQL | Версионирование PostgreSQL-схемы из TypeScript-инструментов |
| Локальная среда | Docker Compose | PostgreSQL, Redpanda, MinIO, Redis, observability |
| Тестирование | Jest, Supertest, Testcontainers, fast-check | TDD, инварианты matching, API, интеграционные сценарии и replay |
| Наблюдаемость | OpenTelemetry, Prometheus, Grafana | Traces, metrics, dashboards, latency и consumer lag |

## 2. Почему этот выбор

### TypeScript / Node.js

Используется во всех слоях: Gateway, API, WebSocket, trading core, ledger, consumers, административные операции, read-модели и внешние адаптеры. Единый язык уменьшает стоимость разработки, количество межъязыковых контрактов и сложность локального запуска. Строгие типы, schema validation и сгенерированные protobuf-типы уменьшают риск расхождения контрактов.

Торговое ядро должно быть обычным детерминированным TypeScript-модулем с минимальным количеством аллокаций в горячем цикле. Оно не должно зависеть от HTTP, Kafka client или PostgreSQL API. Для CPU-bound обработки используется один последовательный event loop на partition; горизонтальное масштабирование выполняется по инструментам.

### NestJS

Используется как единый application framework для Gateway, административного API, query API, WebSocket adapter и operational endpoints. Fastify используется как HTTP adapter, но доменная логика и торговый алгоритм не должны быть спрятаны внутри controller/service-классов.

### Redpanda

Поддерживает модель durable log, partitions и replay, но проще запускается локально, чем отдельный набор Kafka-компонентов. Kafka-compatible API сохраняет возможность заменить реализацию без изменения доменных контрактов.

Event log не заменяет PostgreSQL: log хранит последовательность команд/событий, PostgreSQL предоставляет быстрые транзакционные read-модели и ledger-запросы.

### PostgreSQL

Подходит для двойной записи ledger, уникальных ограничений idempotency, конфигурации инструментов и пользовательских запросов. Денежные значения хранятся как integer в минимальных единицах или как NUMERIC с чёткими правилами; floating point запрещён.

### Protobuf

Внутренние сообщения получают явную схему, номер версии и правила backward compatibility. JSON остаётся на внешней границе для удобства клиентов. Схема события должна изменяться расширением, а не несовместимым переименованием или изменением смысла поля.

## 3. Предлагаемая структура репозитория

```text
exchange/
├── apps/
│   ├── gateway/              # TypeScript: REST/WebSocket и auth boundary
│   ├── trading-core/         # TypeScript: sequencer + state machine + matching + settlement
│   ├── event-consumers/      # TypeScript: projections, market data, notifications
│   └── admin-api/            # TypeScript: control plane
├── modules/
│   ├── domain-orders/        # commands, order lifecycle, policies
│   ├── domain-market/        # instruments and trading rules
│   ├── domain-ledger/        # accounts, reservations, postings
│   ├── matching-engine/      # TypeScript: pure deterministic order book
│   ├── event-contracts/      # protobuf schemas and generated types
│   └── shared-kernel/        # IDs, money, clock, correlation metadata
├── infra/
│   ├── docker-compose.yml
│   ├── migrations/
│   └── observability/
└── docs/
```

Физическое разбиение на приложения можно начать проще: `gateway` и `trading-core` в одном deployable процессе, а consumers — отдельными worker-процессами. Пакетные границы должны существовать с первого дня.

## 4. Источники истины

| Данные | Источник истины | Производные данные |
|---|---|---|
| Порядок команд инструмента | Event log + sequence | текущий order book и snapshots |
| Активные заявки | Trading state machine | order history projection |
| Балансовые движения | Ledger postings в PostgreSQL + события | balance projection |
| Инструменты и правила | Versioned PostgreSQL config | кэш конфигурации |
| Рыночные сообщения | Event log | WebSocket streams, ticker, candles |
| Idempotency | PostgreSQL unique constraint | быстрый cache lookup |
| Аудит | Append-only audit events | поисковая/отчётная проекция |

Важно не делать одну БД «источником истины для всего». Order book, ledger и пользовательские read-модели имеют разные требования к записи и чтению.

## 5. Транзакционный подход MVP

Для первого варианта:

1. Gateway принимает команду и передаёт её trading core.
2. Sequencer присваивает sequence конкретного инструмента.
3. Pure matching module рассчитывает результат.
4. Trading core применяет reservation/settlement и формирует доменные события.
5. События надёжно записываются в event log.
6. Consumers строят history, balances, market-data и audit projections.

Чтобы не получить рассогласование между PostgreSQL и event log, нельзя делать бесконтрольную запись в две системы. На MVP следует выбрать один из вариантов:

- transactional outbox в PostgreSQL с публикацией в Redpanda;
- event log как commit log торгового ядра, а PostgreSQL обновляется идемпотентным consumer-ом;
- один процесс trading core с чётким recovery/reconciliation протоколом.

Рекомендуемый первый вариант для простоты аудита — transactional outbox для ledger и критичных доменных событий. После нагрузочного теста можно оценить переход к log-first модели.

## 6. Что не использовать как источник истины

- Redis — только кэш/эпемерное состояние.
- PostgreSQL query projections — не источник порядка matching.
- WebSocket messages — не журнал операций.
- Логи приложения — не audit trail.
- In-memory order book без durable log/snapshot — только временная оптимизация.
- Distributed locks для каждой заявки — вместо последовательного владельца partition.

## 7. Развёртывание по этапам

### Этап 1: локальный MVP

- один TypeScript application для Gateway/API/trading core;
- matching engine как pure TypeScript module;
- PostgreSQL;
- Redpanda;
- MinIO;
- Docker Compose;
- один partition на инструмент;
- базовые Prometheus metrics.

### Этап 2: нагрузочный контур

- отдельный trading-core process;
- отдельные event consumers;
- несколько partitions/instruments;
- snapshots и replay tests;
- WebSocket fan-out load test;
- consumer lag and backpressure policies.

### Этап 3: масштабирование

- несколько экземпляров Gateway;
- горизонтальное масштабирование consumers;
- partition ownership и controlled failover;
- отдельное масштабирование market-data;
- Kubernetes только при подтверждённой операционной необходимости.

Go, Rust/C++ и специализированные low-latency технологии не выбираются заранее. Они становятся обоснованными только если нагрузочный тест TypeScript/Node.js не достигает целевых p99 при зафиксированном профиле нагрузки.

## 8. Отложенные решения

- Kafka или Redpanda в production;
- отдельный Rust/C++ matching engine;
- Kubernetes и multi-region deployment;
- Schema Registry конкретного типа;
- Redis для distributed rate limiting;
- отдельная поисковая система для аудита;
- полноценный identity provider;
- cloud provider и managed services.

Перед фиксацией production-варианта нужно провести benchmark: команды ордеров/с, p50/p95/p99 latency, размер event log, время replay, задержка projections и максимальный fan-out market data.
