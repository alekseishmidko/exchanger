# Архитектурные понятия: domain, port, adapter, store, repository

Статус: accepted  
Дата: 2026-09-22

Этот документ объясняет базовые архитектурные термины проекта так, как их удобно
обсуждать на ревью, онбординге и собеседовании. Главная идея: бизнес-правила
должны быть отделены от транспорта, базы данных, брокеров и фреймворков.

## Короткая карта понятий

| Понятие    | Что это                                     | Главный вопрос                        | Пример в проекте                                           |
| ---------- | ------------------------------------------- | ------------------------------------- | ---------------------------------------------------------- |
| Domain     | Бизнес-модель и инварианты                  | “Какие правила биржи всегда истинны?” | `Ledger`, `Balance`, matching engine                       |
| Port       | Интерфейс-граница потребности               | “Что модулю нужно уметь делать?”      | `LedgerPort`, `ProjectionStorePort`                        |
| Adapter    | Конкретная реализация порта или транспорта  | “Как именно мы подключились к миру?”  | `PostgresLedgerAdapter`, REST controller                   |
| Store      | Хранилище/сервис доступа к состоянию        | “Где и как лежит состояние?”          | `PostgresProjectionStore`, `ProjectionStore`               |
| Repository | Доступ к конкретной группе таблиц/aggregate | “Как читать/писать эту сущность?”     | `OrderProjectionRepository`, `ProjectionVersionRepository` |

## Domain

### Определение

`Domain` — это слой бизнес-смысла. В нём живут правила, инварианты и операции,
которые должны оставаться верными независимо от NestJS, PostgreSQL, HTTP,
WebSocket, Redis или Docker.

Для биржи domain отвечает на вопросы:

- можно ли принять заявку;
- как сравниваются цены и время;
- как резервируются средства;
- почему баланс не может стать отрицательным;
- почему повтор команды не должен создать второй денежный эффект.

### Зачем нужен

Domain нужен, чтобы самые важные правила системы были:

- тестируемыми без БД и сети;
- детерминированными;
- защищёнными от случайной логики в controller/repository;
- понятными бизнесу и инженерам;
- переиспользуемыми между REST, WebSocket, background consumers и тестами.

Если правило “reserved не превышает total” живёт только в controller, другой
consumer сможет его обойти. Если правило живёт в domain, любой adapter обязан
пройти через него или явно повторить тот же invariant на storage-level.

### Как выглядит

Признаки domain-кода:

- классы/value objects с бизнес-названиями;
- методы выражают бизнес-действия, а не SQL CRUD;
- нет импортов NestJS controller, HTTP request, Socket.IO, PostgreSQL client;
- ошибки отражают нарушение бизнес-правил;
- данные точные: деньги строками/decimal, typed IDs, deterministic clock.

Пример:

```ts
const balance = Balance.empty().credit(Decimal.from('100')).reserve(Decimal.from('20'));
```

Здесь не важно, пришёл запрос из REST, теста или consumer-а. Важно только правило:
резервирование переносит сумму из `available` в `reserved` и не допускает
отрицательный остаток.

### Типичные ошибки

- Добавить `@Injectable()` или `ConfigService` в чистый domain object.
- Проверять overdraft только в controller.
- Хранить деньги как `number`.
- Смешивать transport DTO и domain entity.
- Делать domain зависящим от PostgreSQL transaction.

## Port

### Определение

`Port` — это интерфейс, описывающий, что одному слою нужно от другого слоя или
от внешнего мира. Port не говорит, как это реализовано.

Простой способ запомнить:

> Port — это “розетка”: приложение знает форму розетки, но не знает, какая
> электростанция за стеной.

В проекте port обычно представлен TypeScript interface и DI token:

```ts
export const PROJECTION_STORE_PORT = Symbol('PROJECTION_STORE_PORT');

export interface ProjectionStorePort {
  apply(event: ProjectionEvent): void | Promise<void>;
  rebuild(events: readonly ProjectionEvent[]): void | Promise<void>;
  getOrders(userId: string, limit?: number, cursor?: string): ProjectionPage<OrderView>;
}
```

### Зачем нужен

Port нужен, чтобы:

- controller/application service не зависели от PostgreSQL client напрямую;
- production adapter можно было заменить без переписывания бизнес-сценариев;
- тесты могли использовать in-memory реализацию;
- архитектура явно показывала boundary;
- staging/production могли fail-fast проверять, что подключён durable adapter.

### Как выглядит в NestJS

Модуль выбирает реализацию порта:

```ts
{
  provide: PROJECTION_STORE_PORT,
  useFactory: (config, transactions, memory) =>
    config.getOrThrow('PROJECTION_STORE_ADAPTER') === 'postgres'
      ? new PostgresProjectionStore(transactions)
      : memory,
}
```

А controller получает именно port:

```ts
constructor(
  @Inject(PROJECTION_STORE_PORT)
  private readonly projections: ProjectionStorePort,
) {}
```

Controller не знает, PostgreSQL это или in-memory store. Для него важно только,
что можно вызвать `getOrders`.

### Важное отличие от domain

Domain содержит правила. Port содержит форму зависимости.

Например:

- `Balance.reserve()` — domain rule;
- `LedgerPort.reserve(...)` — контракт, что application layer может попросить
  ledger выполнить reservation;
- `PostgresLedgerAdapter.reserve(...)` — конкретная реализация этого контракта в
  PostgreSQL.

## Adapter

### Определение

`Adapter` — это код, который соединяет внутреннюю модель приложения с внешним
миром или конкретной технологией.

Adapters бывают входящие и исходящие.

### Входящий adapter

Входящий adapter принимает внешний запрос и переводит его в application/domain
команду.

Примеры:

- REST controller;
- WebSocket gateway;
- background consumer;
- CLI command;
- scheduled job.

REST controller — это adapter, потому что HTTP — внешний транспорт:

```ts
@Post()
createAccount(@Body() dto: CreateAccountRequestDto) {
  return this.application.createAccount(...);
}
```

Controller не должен содержать денежные правила. Его задача:

- authentication;
- authorization;
- DTO validation;
- idempotency headers;
- mapping request → application command;
- safe response/error.

### Исходящий adapter

Исходящий adapter реализует port через конкретную технологию.

Примеры:

- `PostgresProjectionStore`;
- `PostgresLedgerAdapter`;
- event-log/outbox adapter;
- Redis session adapter в будущей авторизации;
- external payment adapter, если он появится.

### Зачем нужен

Adapter нужен, чтобы технологические детали не протекали в domain/application:

- SQL остаётся в infrastructure;
- HTTP decorators остаются в controllers;
- Socket.IO остаётся в gateway;
- Redis/Kafka/PostgreSQL можно заменить за port boundary;
- тесты могут подменять adapter.

### Типичные ошибки

- Назвать файл adapter, но положить туда бизнес-правила.
- Возвращать наружу SQL row вместо public DTO/read-model.
- Делать controller зависимым от PostgreSQL client.
- Делать domain зависящим от adapter.

## Store

### Определение

`Store` — это компонент, который хранит и возвращает состояние. В нашем проекте
это обычно реализация port-а, связанная с read-model, command journal,
idempotency, sessions или другим state.

Store отвечает на вопрос:

> Где находится состояние и как безопасно его читать/изменять?

### Примеры

`ProjectionStore` — in-memory store:

- хранит orders/trades/balances в `Map`;
- удобен для unit/component tests;
- не подходит для production durable runtime.

`PostgresProjectionStore` — durable store:

- хранит projection rows в PostgreSQL;
- применяет event ID, read-model mutation и offset одной transaction;
- поддерживает rebuild через versioned shadow tables/swap.

### Store vs Adapter

Store часто является adapter-ом, но не каждый adapter является store.

| Вопрос                      | Store                     | Adapter                                            |
| --------------------------- | ------------------------- | -------------------------------------------------- |
| Главная роль                | Хранить/читать состояние  | Соединять приложение с внешним миром               |
| Может быть in-memory?       | Да                        | Да                                                 |
| Может быть REST controller? | Обычно нет                | Да                                                 |
| Может реализовывать port?   | Да                        | Да                                                 |
| Пример                      | `PostgresProjectionStore` | `ProjectionsController`, `PostgresProjectionStore` |

То есть `PostgresProjectionStore` одновременно:

- `Store`, потому что хранит read-model state;
- `Adapter`, потому что реализует `ProjectionStorePort` через PostgreSQL.

## Repository

### Определение

`Repository` — это объект доступа к конкретной группе данных: таблице,
aggregate, read-model или version pointer. Он прячет SQL/query details и даёт
методы на языке этой сущности.

Если `Store` отвечает за весь сценарий хранения, то `Repository` отвечает за
конкретный набор строк.

### Зачем нужен

Repository нужен, когда один infrastructure adapter разрастается и начинает
совмещать:

- transaction orchestration;
- SQL для нескольких таблиц;
- row mapping;
- pagination;
- rebuild/swap coordination;
- duplicate/gap policy.

Разделение снижает когнитивную нагрузку: `Store` остаётся coordinator-ом, а
каждый repository становится маленьким SQL boundary для своей сущности.

### Как выглядит

Пример для projections:

```ts
export class OrderProjectionRepository {
  async upsert(client: PoolClient, version: number, event: ProjectionEvent): Promise<void> {
    // SQL только для projection_orders
  }

  async listByUser(client: PoolClient, version: number, userId: string): Promise<OrderView[]> {
    // owner-isolated query только по projection_orders
  }
}
```

Repository получает `PoolClient`, но не создаёт transaction сам. Это важно:
атомарность сценария остаётся выше — в `PostgresProjectionStore` или другом
application/infrastructure coordinator-е.

### Repository vs Store

| Вопрос                        | Store                              | Repository                               |
| ----------------------------- | ---------------------------------- | ---------------------------------------- |
| Масштаб                       | Целый сценарий хранения/read model | Одна сущность или группа таблиц          |
| Transaction boundary          | Обычно начинает/держит transaction | Использует переданный transaction client |
| Знает несколько repositories? | Да                                 | Обычно нет                               |
| Пример                        | `PostgresProjectionStore`          | `OrderProjectionRepository`              |

### Repository vs Adapter

Repository может быть частью adapter-а, но сам не всегда является полноценным
adapter-ом. Например `PostgresProjectionStore` реализует port и поэтому является
adapter-ом. `OrderProjectionRepository` не реализует внешний port: он внутренний
помощник adapter-а, отвечающий за SQL конкретной таблицы.

## Port vs Adapter vs Store vs Repository на одном примере

Для projections:

```text
ProjectionsController
  -> ProjectionStorePort
      -> ProjectionStore              # in-memory store
      -> PostgresProjectionStore      # PostgreSQL store/adapter
          -> ProjectionVersionRepository
          -> ProjectionProcessedEventRepository
          -> OrderProjectionRepository
          -> TradeProjectionRepository
          -> BalanceProjectionRepository
```

Разбор:

- `ProjectionsController` — входящий adapter REST API;
- `ProjectionStorePort` — port, то есть контракт возможностей;
- `ProjectionStore` — in-memory store для тестов/dev fallback;
- `PostgresProjectionStore` — durable store и infrastructure adapter.
- repositories — маленькие SQL boundaries для конкретных projection tables.

## Почему это полезно именно для биржи

Биржа чувствительна к ошибкам:

- деньги нельзя списать дважды;
- accepted command нельзя потерять;
- порядок команд по instrument должен быть монотонным;
- private data нельзя показать другому пользователю;
- outage БД должен закрывать readiness/admission безопасно.

Разделение на domain/port/adapter/store помогает:

- держать финансовые инварианты ближе к domain;
- проверять business flow без настоящей инфраструктуры;
- запускать production-like topology с durable adapters;
- не смешивать API, SQL и бизнес-правила;
- точечно рефакторить модуль без изменения public API.

## Как выбрать папку для нового файла

| Если файл…                                    | Куда класть                                                  |
| --------------------------------------------- | ------------------------------------------------------------ |
| Описывает бизнес-правило/value object         | `domain/`                                                    |
| Описывает контракт зависимости                | `ports/`                                                     |
| Принимает HTTP/WebSocket запрос               | `controllers/`, `gateways/`, transport folder                |
| Реализует port через PostgreSQL/Redis/broker  | `infrastructure/`                                            |
| Читает/пишет конкретную таблицу/aggregate     | `infrastructure/repositories/`                               |
| Хранит read/write state                       | `infrastructure/` или `application/` для reference in-memory |
| Содержит публичный request/response shape     | `dto/`                                                       |
| Содержит shared TypeScript types без behavior | `types/`                                                     |
| Оркестрирует use-case                         | `application/`                                               |

## Вопросы как на собеседовании

### Чем port отличается от interface в целом?

Любой port технически является interface/DI token, но не любой interface является
port. Port находится на архитектурной границе и описывает зависимость между
слоями: application → storage, controller → application, consumer → event log.

### Почему controller не должен ходить напрямую в PostgreSQL?

Потому что тогда transport начинает знать storage schema и может обойти
authorization, idempotency, audit, validation и domain invariants. Controller
должен быть тонким adapter-ом, а не местом бизнес-логики.

### Почему domain не должен импортировать NestJS?

NestJS — framework доставки и сборки приложения. Domain должен быть проверяемым
обычным unit-тестом без DI container, HTTP server и внешней инфраструктуры. Если
domain зависит от NestJS, бизнес-правила становятся менее переносимыми и сложнее
тестируются.

### Чем repository отличается от store?

`Store` — более широкое слово: компонент хранения state/read-model и координатор
атомарного сценария. `Repository` уже: доступ к конкретному aggregate/table set.
Например, `PostgresProjectionStore` управляет rebuild/apply transaction, а
`OrderProjectionRepository` знает только SQL таблицы `projection_orders`.

### Где должна жить transaction boundary?

На application/infrastructure boundary, где понятен весь атомарный use-case.
Например, durable projection apply должен одной transaction записать read-model
mutation, processed event ID и offset. Нельзя размазывать это по controller-у.

### Почему in-memory adapter нельзя случайно включать в production?

Потому что он теряет состояние при restart и не даёт RPO=0. В проекте startup
safety должен блокировать production-like runtime, если critical write path
сконфигурирован на in-memory adapter.

## Мини-шпаргалка

- Domain — бизнес-правила.
- Port — что нужно приложению.
- Adapter — как приложение подключилось к внешнему миру.
- Store — где лежит состояние.
- Repository — как читать/писать конкретную сущность внутри storage.
- Controller — входящий adapter.
- PostgreSQL implementation — исходящий adapter и часто store.
- DTO — публичная форма транспорта, не domain entity.
- Barrel `index.ts` — публичный вход модуля, чтобы другие модули не делали deep
  imports во внутренние папки.
