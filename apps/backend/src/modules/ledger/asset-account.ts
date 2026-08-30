import { AccountId, AssetId } from '../shared-kernel';

/** Неизменяемое описание актива и его точности хранения. */
export class Asset {
  constructor(
    readonly id: AssetId,
    readonly code: string,
    readonly scale: number,
  ) {
    if (!/^[A-Z0-9-]+$/.test(code) || !Number.isInteger(scale) || scale < 0) {
      throw new Error('Invalid asset definition');
    }
  }
}

/** Неизменяемое описание владельца ledger-счёта. */
export class Account {
  constructor(
    readonly id: AccountId,
    readonly ownerId: string,
  ) {
    if (ownerId.trim() === '') {
      throw new Error('Account owner must not be empty');
    }
  }
}
