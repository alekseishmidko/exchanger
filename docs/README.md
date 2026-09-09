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
- [REST и WebSocket client guide](api-client-guide.md)
- [Projections и query API](projections.md)
- [Market data и WebSocket](market-data.md)
- [Admin, risk и audit](admin-risk-audit.md)
- [Emergency stop runbook](runbooks/emergency-stop.md)
- [Administrative incident runbook](runbooks/admin-incident-response.md)
- [Системная проверка](system-verification.md)
- [Failure matrix](testing/failure-matrix.md)
- [Security review](security-review.md)
- [Pilot performance baseline](testing/pilot-performance.md)
- [PostgreSQL backup/restore runbook](runbooks/postgres-backup-restore.md)
- [Event-log archive/restore runbook](runbooks/event-log-archive-restore.md)
- [Runbook verification log](runbooks/verification-log.md)

## Архитектурные решения

- [ADR 0001: Модульный монолит](adr/0001-modular-monolith.md)
- [ADR 0002: Единый слой контрактов](adr/0002-contract-layer.md)
- [ADR 0003: Log-first для settlement](adr/0003-settlement-log-first.md)

## Правило размещения

Документы, относящиеся ко всей системе, находятся в `docs/`. Документы конкретного модуля находятся рядом с модулем и описывают его назначение, границы, контракты, инварианты, сценарии, тесты и принятые решения.

Любая новая функциональность должна обновлять документацию одновременно с кодом и тестами.
