import { EntityManager } from 'typeorm';
import { ResourceRecord } from '../entities';

/**
 * 银行账户的当前余额 = 档案里登记的期初余额 + 财务“现金银行”已过账的收支流水（finance_entries.kind = 'bank'）。
 * 旧系统的 current_balance 由流水实时维护；新系统档案只存期初，当前余额读的时候现算，和“资金概况”“现金银行查询”同一口径。
 */
export async function bankMovements(em: EntityManager, companyId: number, accountIds?: number[]): Promise<Map<number, number>> {
  if (accountIds && !accountIds.length) return new Map();
  const rows: Array<{ id: number | string; s: string }> = await em.query(
    `SELECT account_id AS id, SUM(amount_cents) AS s FROM finance_entries WHERE company_id = ? AND kind = 'bank'${accountIds ? ` AND account_id IN (${accountIds.map(() => '?').join(',')})` : ''} GROUP BY account_id`,
    [companyId, ...(accountIds ?? [])],
  );
  return new Map(rows.map((r) => [Number(r.id), Number(r.s)]));
}

/**
 * 银行账户列表/详情上读时现算的两项：
 * - 当前余额：期初余额 + 流水合计（整数分）；
 * - 公户详情（旧列表“已维护/未维护”）：公户、店铺公户的客户号、开户档案位置、开户附件任一项有就是已维护，其他类型没有这一项。
 */
export async function deriveBankBalances(em: EntityManager, companyId: number, records: ResourceRecord[]): Promise<Map<number, Record<string, unknown>>> {
  const moves = await bankMovements(em, companyId, records.map((r) => r.id));
  return new Map(records.map((r) => {
    const d = r.data as Record<string, unknown>;
    const isPublic = d.kind === 'company_public' || d.kind === 'store_public';
    const kept = String(d.customerNo ?? '').trim() !== '' || typeof d.openingArchiveLocationId === 'number' || (Array.isArray(d.attachments) && d.attachments.length > 0);
    return [r.id, { currentBalance: (Math.round(Number(d.balance ?? 0)) || 0) + (moves.get(r.id) ?? 0), publicInfoFlag: isPublic ? (kept ? 'yes' : 'no') : undefined }];
  }));
}
