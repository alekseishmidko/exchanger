# Sequencer и trading state machine

Статус: accepted  
Дата: 2026-09-03

## Ordering model

`instrumentId` является partition key. Только назначенный owner может отправлять команды этой partition. Sequence начинается с 1 и увеличивается строго на единицу; gap и sequence меньше 1 отклоняются до transition. Разные инструменты имеют независимые sequence и могут обрабатываться параллельно.

```mermaid
stateDiagram-v2
  [*] --> ACTIVE
  ACTIVE --> ACTIVE: command sequence = last + 1
  ACTIVE --> PAUSED: pause
  PAUSED --> ACTIVE: resume
  ACTIVE --> [*]: snapshot / shutdown
```

## Admission and deduplication

Проверки выполняются в порядке owner → partition → pause → duplicate → sequence. Duplicate `commandId` возвращает ранее сохранённый result даже после restore snapshot. Новый transition записывается только после успешного выполнения handler.

## Snapshot/replay flow

```mermaid
sequenceDiagram
  participant E as Event/command log
  participant S as Snapshot store
  participant M as State machine
  E->>M: apply commands 1..N
  M->>S: snapshot at sequence N
  M--xM: process crash
  S-->>M: restore sequence/status/idempotency
  E->>M: replay N+1..K
```

## Latency budget и backpressure

Для критического пути admission + transition целевой бюджет — до 1 ms p95 внутри процесса и до 5 ms p99 без внешних вызовов. Sequencer не должен неограниченно накапливать команды: transport adapter обязан ограничивать queue depth, отклонять новые команды с `BACKPRESSURE` и экспортировать queue depth/lag metrics. Эти transport limits будут добавлены вместе с durable event log.
