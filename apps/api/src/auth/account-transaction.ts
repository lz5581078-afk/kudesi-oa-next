import { ConflictException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { DataSource, EntityManager } from 'typeorm';

/** Account names are global. Keep the same connection's advisory lock until commit. */
export async function accountTransaction<T>(ds: DataSource, account: string, action: (em: EntityManager) => Promise<T>): Promise<T> {
  const lock = 'oa-account-' + createHash('sha256').update(`${ds.options.database}\0${account.trim().toLowerCase()}`).digest('hex').slice(0, 48);
  const runner = ds.createQueryRunner();
  let held = false;
  try {
    await runner.connect();
    const [row] = await runner.query('SELECT GET_LOCK(?, 10) AS acquired', [lock]);
    if (Number(row.acquired) !== 1) throw new ConflictException('账号正在处理中，请稍后重试');
    held = true;
    await runner.startTransaction();
    const result = await action(runner.manager);
    await runner.commitTransaction();
    return result;
  } catch (error) {
    if (runner.isTransactionActive) await runner.rollbackTransaction();
    throw error;
  } finally {
    try { if (held) await runner.query('SELECT RELEASE_LOCK(?)', [lock]); }
    finally { await runner.release(); }
  }
}
