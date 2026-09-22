/**
 * Стабильный каталог operational log events.
 *
 * Имена являются машинным контрактом для dashboards и alert rules. Новое имя
 * сначала добавляется сюда и в документацию; произвольные production events
 * отклоняются logger-ом и CI contract test.
 */
export const LOG_EVENTS = {
  SYSTEM_FRAMEWORK: 'system.framework',
  SYSTEM_STARTED: 'system.started',
  SYSTEM_SWAGGER_READY: 'system.swagger.ready',
  SYSTEM_SHUTDOWN: 'system.shutdown',
  HTTP_COMPLETED: 'http.request.completed',
  HTTP_REJECTED: 'http.request.rejected',
  WEBSOCKET_CONNECTED: 'websocket.connected',
  WEBSOCKET_SUBSCRIBED: 'websocket.subscribed',
  WEBSOCKET_REJECTED: 'websocket.rejected',
  HEALTH_LIVE: 'health.liveness.succeeded',
  HEALTH_READY: 'health.readiness.succeeded',
  HEALTH_DEPENDENCY_FAILED: 'health.dependency.failed',
  GATEWAY_COMMAND_ACCEPTED: 'gateway.command.accepted',
  GATEWAY_COMMAND_REJECTED: 'gateway.command.rejected',
  SEQUENCER_COMMAND_APPLIED: 'sequencer.command.applied',
  SEQUENCER_COMMAND_REJECTED: 'sequencer.command.rejected',
  MATCHING_ORDER_PROCESSED: 'matching.order.processed',
  MATCHING_ORDER_REJECTED: 'matching.order.rejected',
  SETTLEMENT_APPLIED: 'settlement.applied',
  SETTLEMENT_RETRY: 'settlement.retry',
  SETTLEMENT_REJECTED: 'settlement.rejected',
  LEDGER_COMMAND_APPLIED: 'ledger.command.applied',
  LEDGER_COMMAND_REJECTED: 'ledger.command.rejected',
  EVENT_LOG_APPENDED: 'event-log.appended',
  EVENT_LOG_TIMEOUT: 'event-log.timeout',
  EVENT_LOG_CONSUMED: 'event-log.consumed',
  EVENT_LOG_DEAD_LETTERED: 'event-log.dead-lettered',
  EVENT_LOG_RECOVERED: 'event-log.recovered',
  PROJECTION_APPLIED: 'projection.applied',
  PROJECTION_DUPLICATE: 'projection.duplicate',
  PROJECTION_GAP: 'projection.gap',
  PROJECTION_REBUILT: 'projection.rebuilt',
  ADMIN_ACTION_APPLIED: 'admin.action.applied',
  ADMIN_ACTION_REJECTED: 'admin.action.rejected',
  AUDIT_RECORD_APPENDED: 'audit.record.appended',
  AUDIT_INTEGRITY_FAILED: 'audit.integrity.failed',
  INSTRUMENT_CHANGED: 'instrument.changed',
  INSTRUMENT_REJECTED: 'instrument.rejected',
} as const;

/** Union всех допустимых production event names. */
export type LogEventName = (typeof LOG_EVENTS)[keyof typeof LOG_EVENTS];

/** Runtime allow-list используется adapter-ом и CI contract test. */
export const KNOWN_LOG_EVENTS: ReadonlySet<string> = new Set(Object.values(LOG_EVENTS));

/** Security/audit events никогда не отбрасываются sampling policy. */
export const UNSAMPLED_LOG_EVENTS: ReadonlySet<LogEventName> = new Set([
  LOG_EVENTS.HTTP_REJECTED,
  LOG_EVENTS.WEBSOCKET_REJECTED,
  LOG_EVENTS.ADMIN_ACTION_REJECTED,
  LOG_EVENTS.AUDIT_RECORD_APPENDED,
  LOG_EVENTS.AUDIT_INTEGRITY_FAILED,
]);

/**
 * Минимальная success/failure пара каждого критичного application boundary.
 * Contract test гарантирует, что модуль нельзя оставить без диагностируемого
 * положительного и отрицательного terminal outcome.
 */
export const MODULE_LOG_EVENT_POLICY = {
  http: { success: LOG_EVENTS.HTTP_COMPLETED, failure: LOG_EVENTS.HTTP_REJECTED },
  websocket: { success: LOG_EVENTS.WEBSOCKET_SUBSCRIBED, failure: LOG_EVENTS.WEBSOCKET_REJECTED },
  health: { success: LOG_EVENTS.HEALTH_READY, failure: LOG_EVENTS.HEALTH_DEPENDENCY_FAILED },
  gateway: {
    success: LOG_EVENTS.GATEWAY_COMMAND_ACCEPTED,
    failure: LOG_EVENTS.GATEWAY_COMMAND_REJECTED,
  },
  sequencer: {
    success: LOG_EVENTS.SEQUENCER_COMMAND_APPLIED,
    failure: LOG_EVENTS.SEQUENCER_COMMAND_REJECTED,
  },
  matching: {
    success: LOG_EVENTS.MATCHING_ORDER_PROCESSED,
    failure: LOG_EVENTS.MATCHING_ORDER_REJECTED,
  },
  settlement: { success: LOG_EVENTS.SETTLEMENT_APPLIED, failure: LOG_EVENTS.SETTLEMENT_REJECTED },
  ledger: {
    success: LOG_EVENTS.LEDGER_COMMAND_APPLIED,
    failure: LOG_EVENTS.LEDGER_COMMAND_REJECTED,
  },
  'event-log': { success: LOG_EVENTS.EVENT_LOG_APPENDED, failure: LOG_EVENTS.EVENT_LOG_TIMEOUT },
  projections: { success: LOG_EVENTS.PROJECTION_APPLIED, failure: LOG_EVENTS.PROJECTION_GAP },
  instruments: { success: LOG_EVENTS.INSTRUMENT_CHANGED, failure: LOG_EVENTS.INSTRUMENT_REJECTED },
  admin: { success: LOG_EVENTS.ADMIN_ACTION_APPLIED, failure: LOG_EVENTS.ADMIN_ACTION_REJECTED },
  audit: { success: LOG_EVENTS.AUDIT_RECORD_APPENDED, failure: LOG_EVENTS.AUDIT_INTEGRITY_FAILED },
} as const satisfies Readonly<
  Record<string, Readonly<{ success: LogEventName; failure: LogEventName }>>
>;
