import type {
  AdmissionContext,
  AdmissionControlChange,
  AdmissionControlPort,
} from './admission-control.port';
import { AdmissionRejectedError } from './admission-control.port';

/** Component-only implementation control plane с production-equivalent policy. */
export class MemoryAdmissionControl implements AdmissionControlPort {
  private readonly controls = new Map<string, AdmissionControlChange>();

  /** Сохраняет последнюю команду control в process-local map. */
  apply(change: AdmissionControlChange): Promise<void> {
    if ([...this.controls.values()].some(({ commandId }) => commandId === change.commandId)) {
      return Promise.resolve();
    }
    this.controls.set(`${change.type}:${change.targetId}`, change);
    return Promise.resolve();
  }

  /** Проверяет global, user, account и instrument restrictions в строгом порядке. */
  assertAllowed(context: AdmissionContext, at = new Date()): Promise<void> {
    this.assert('GLOBAL', '*', 'OPEN', 'CIRCUIT_BREAKER_OPEN', at);
    this.assert('USER', context.userId, 'FROZEN', 'USER_FROZEN', at);
    this.assert('ACCOUNT', context.accountId, 'FROZEN', 'ACCOUNT_FROZEN', at);
    this.assert('INSTRUMENT', context.instrumentId, 'OPEN', 'CIRCUIT_BREAKER_OPEN', at);
    this.assert('INSTRUMENT', context.instrumentId, 'PAUSED', 'INSTRUMENT_PAUSED', at);
    return Promise.resolve();
  }

  /** Возвращает immutable snapshot текущих component controls. */
  list(): Promise<readonly AdmissionControlChange[]> {
    return Promise.resolve([...this.controls.values()]);
  }

  /** Memory adapter всегда готов в component runtime. */
  checkReady(): Promise<void> {
    return Promise.resolve();
  }

  /** Сопоставляет active state и стабильный public rejection code. */
  private assert(
    type: AdmissionControlChange['type'],
    targetId: string,
    blockedState: AdmissionControlChange['state'],
    code: string,
    at: Date,
  ): void {
    const control = this.controls.get(`${type}:${targetId}`);
    if (control?.state === blockedState && control.effectiveAt <= at) {
      throw new AdmissionRejectedError(code);
    }
  }
}
