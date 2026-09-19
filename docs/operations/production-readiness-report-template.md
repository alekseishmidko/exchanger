# Production-readiness report template

Version: `production-readiness/v1`

## Release candidate

- Build SHA:
- Image/tag:
- Environment:
- Topology:
- Config bundle:
- Dataset:
- Test window:
- Operator:
- Independent reviewer:
- Release manager:

## Go/no-go decision

- Decision: `GO | NO-GO | GO-WITH-RISK-ACCEPTANCE`
- Decision time:
- Approved by:
- Blocking findings:
- Accepted exceptions:

## Capacity evidence

| Check                                       | Artifact | Result | Owner               | Notes |
| ------------------------------------------- | -------- | ------ | ------------------- | ----- |
| maximum sustainable throughput              |          |        | Platform            |       |
| saturation point per critical component     |          |        | Platform            |       |
| average/peak SLO                            |          |        | Platform            |       |
| soak leak/GC/handle check                   |          |        | Platform            |       |
| PostgreSQL connections/storage/WAL/archive  |          |        | Ledger Platform     |       |
| instrument/account/history/projection scale |          |        | Trading/Projections |       |
| telemetry ingestion/cost                    |          |        | Platform            |       |

## Release qualification suites

| Suite                      | Command/workflow               | Artifact                | Required status | Actual status |
| -------------------------- | ------------------------------ | ----------------------- | --------------- | ------------- |
| black-box API flows        | `pnpm api:flows`               | `artifacts/api-flows/`  | passed          |               |
| smoke load                 | `pnpm load:smoke`              | `artifacts/load/`       | passed          |               |
| average load               | `pnpm load:average`            | `artifacts/load/`       | passed          |               |
| spike/stress/soak          | scheduled load workflow        | `artifacts/load/`       | passed          |               |
| chaos/recovery             | `pnpm resilience:staging`      | `artifacts/resilience/` | passed          |               |
| adversarial                | `pnpm adversarial:check`       | CI logs                 | passed          |               |
| backup/restore             | `pnpm postgres:backup-restore` | restore report          | passed          |               |
| archive/restore            | event-log runbook evidence     | archive report          | passed          |               |
| dashboards/alerts/runbooks | human verification             | signed checklist        | passed          |               |

## SLO and budgets

- Availability budget used:
- Command acceptance budget used:
- Settlement correctness: `0 differences required`
- Market-data freshness:
- Projection lag:
- Performance regression budget:
- Error budget exception:

## Recovery evidence

| Failure class              | RTO | RPO | Artifact | Owner           |
| -------------------------- | --: | --: | -------- | --------------- |
| PostgreSQL outage/failover |     |     |          | Ledger Platform |
| event-log/outbox outage    |     |     |          | Ledger Platform |
| backend kill               |     |     |          | Trading Core    |
| owner failover             |     |     |          | Trading Core    |
| projection rebuild         |     |     |          | Projections     |
| observability blackout     |     |     |          | Platform        |

## Rollback and emergency stop rehearsal

- Rollback criteria rehearsed: `yes | no`
- Emergency stop rehearsed: `yes | no`
- Client compatibility during rollback:
- Previous schema compatibility:
- In-flight event handling:
- Runbook links:

## Exceptions and risk acceptance

| Finding | Severity | Owner | Deadline | Risk accepted by | Issue |
| ------- | -------- | ----- | -------- | ---------------- | ----- |

Critical findings block release unless explicitly accepted by the release
manager, security owner and affected capability owner.

## Signatures

- Operator:
- Reviewer:
- Platform:
- Trading Core:
- Ledger Platform:
- Market Data:
- Security:
- Release Manager:
