# Документация проекта

## Глобальные документы

- [Требования к системе](system-design-requirements.md)
- [Архитектура](architecture.md)
- [Технологический стек](technology-stack.md)
- [Правила и стандарты](project-standards.md)
- [Чеклист разработки](development-checklist.md)
- [Каталог контрактных сообщений](events/README.md)
- [Trading state machine и sequencer](trading-state-machine.md)
- [Settlement и event log](settlement.md)
- [Gateway и command API](gateway.md)
- [Projections и query API](projections.md)

## Архитектурные решения

- [ADR 0001: Модульный монолит](adr/0001-modular-monolith.md)
- [ADR 0002: Единый слой контрактов](adr/0002-contract-layer.md)
- [ADR 0003: Log-first для settlement](adr/0003-settlement-log-first.md)

## Правило размещения

Документы, относящиеся ко всей системе, находятся в `docs/`. Документы конкретного модуля находятся рядом с модулем и описывают его назначение, границы, контракты, инварианты, сценарии, тесты и принятые решения.

Любая новая функциональность должна обновлять документацию одновременно с кодом и тестами.
