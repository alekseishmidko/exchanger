/** Инъецируемые часы исключают sleeps и race conditions из freshness tests. */
export interface Clock {
  now(): Date;
}

export const SYSTEM_CLOCK: Clock = { now: () => new Date() };
