# Capacity baseline и trend history

## Назначение

Этот журнал хранит ссылки на принятые baseline и сравнимые trend-прогоны. Запись
добавляется только после того, как artifacts сохранены и release/report owner
подтвердил, что topology, hardware, dataset и configuration сопоставимы.

## Текущий статус

Production baseline ещё не принят. Доступные сейчас данные:

| Дата    | Build   | Environment       | Профиль             | Статус  | Artifact | Комментарий                                               |
| ------- | ------- | ----------------- | ------------------- | ------- | -------- | --------------------------------------------------------- |
| pending | pending | release-candidate | average/stress/soak | pending | pending  | первый production-like baseline должен заменить CI budget |

`tests/load/baselines/ci-budget.json` остаётся regression guard для GitHub-hosted
CI и не должен использоваться как production throughput baseline.

## Правила сравнения

- Сравнивать только одинаковый hardware/topology/dataset.
- Фиксировать build SHA, container images, env config и resource limits.
- Отдельно хранить hot instrument и uniform distribution.
- Нельзя “улучшать” baseline удалением неудачных прогонов без issue и owner.
- Регрессия выше согласованного budget блокирует release или требует risk
  acceptance в production-readiness report.
