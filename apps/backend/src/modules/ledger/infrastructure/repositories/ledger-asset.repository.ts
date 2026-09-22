import type { PoolClient } from 'pg';
import type { Asset } from '../../domain/asset-account';

/**
 * Repository immutable asset definitions.
 *
 * Инкапсулирует SQL таблицы `assets` и запрещает незаметное изменение code/scale
 * уже опубликованного asset. Adapter вызывает repository внутри общей ledger
 * transaction boundary.
 */
export class LedgerAssetRepository {
  /** Регистрирует asset или подтверждает идентичное повторное definition. */
  async register(client: PoolClient, asset: Asset): Promise<void> {
    const result = await client.query(
      `INSERT INTO assets (id, code, scale) VALUES ($1, $2, $3)
       ON CONFLICT (id) DO UPDATE SET id = EXCLUDED.id
       WHERE assets.code = EXCLUDED.code AND assets.scale = EXCLUDED.scale`,
      [asset.id, asset.code, asset.scale],
    );
    if (result.rowCount === 0) throw new Error('ASSET_DEFINITION_CONFLICT');
  }
}
