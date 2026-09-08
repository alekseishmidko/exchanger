import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

/**
 * Запускает внешнюю PostgreSQL utility и завершает проверку при ненулевом коде.
 * Аргументы передаются без shell interpolation, чтобы URL не интерпретировался
 * командной оболочкой и не попадал в диагностическую строку.
 */
function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'inherit', 'inherit'] });
    child.once('error', reject);
    child.once('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${command} failed`))));
  });
}

/**
 * Практически проверяет custom-format backup и restore в отдельную базу.
 *
 * Требуются `POSTGRES_URL`, отличный от него `POSTGRES_RESTORE_URL` и явный
 * предохранитель `ALLOW_POSTGRES_RESTORE=YES`. Target очищается `pg_restore
 * --clean`, поэтому скрипт отказывается работать без отдельного URL и opt-in.
 */
async function main() {
  const sourceUrl = process.env['POSTGRES_URL'];
  const restoreUrl = process.env['POSTGRES_RESTORE_URL'];
  if (!sourceUrl || !restoreUrl || sourceUrl === restoreUrl || process.env['ALLOW_POSTGRES_RESTORE'] !== 'YES') {
    throw new Error('Provide distinct POSTGRES_URL/POSTGRES_RESTORE_URL and ALLOW_POSTGRES_RESTORE=YES');
  }
  const directory = await mkdtemp(join(tmpdir(), 'exchange-pg-restore-'));
  const archivePath = join(directory, 'backup.dump');
  try {
    await run('pg_dump', ['--format=custom', '--no-owner', '--file', archivePath, sourceUrl]);
    await run('pg_restore', ['--clean', '--if-exists', '--no-owner', '--dbname', restoreUrl, archivePath]);
    await run('psql', [restoreUrl, '--set', 'ON_ERROR_STOP=1', '--command', 'SELECT 1 FROM assets LIMIT 1;']);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

await main();
