/** Безопасный ответ liveness без сведений об инфраструктуре. */
export type LivenessResponse = {
  readonly status: 'ok';
};

/** Безопасный агрегированный ответ readiness-проверки. */
export type ReadinessResponse = {
  readonly status: 'ok' | 'unavailable';
  readonly checks: Readonly<Record<string, 'ok' | 'failed'>>;
};
