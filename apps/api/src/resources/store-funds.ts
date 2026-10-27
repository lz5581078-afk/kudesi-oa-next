import { EntityManager } from 'typeorm';
import { ResourceRecord } from '../entities';
import { AuthUser } from '../common/auth.decorators';
import { ResourcesService } from './resources.service';

/**
 * 店铺资金口径：以“店铺资金”快照（store-funds）里日期最新的一条为准。
 * 店铺档案上的 保证金/冻结资金/货款/推广费余额 是只读字段，读的时候从最新快照派生，不另存手填值。
 * 对应关系：保证金=deposit、冻结资金=frozen、货款=withdrawable（可提现）、推广费余额=promotion。
 */
export const STORE_FUND_FIELDS = ['deposit', 'frozen', 'goodsFund', 'promotionBalance'] as const;
const FROM_SNAPSHOT: Record<(typeof STORE_FUND_FIELDS)[number], string> = { deposit: 'deposit', frozen: 'frozen', goodsFund: 'withdrawable', promotionBalance: 'promotion' };
const num = (v: unknown) => (typeof v === 'number' ? v : undefined);

/** 每个店铺最新一条资金快照（同一天只会有一条）。返回 storeId → 快照记录 */
export async function latestStoreFunds(em: EntityManager, companyId: number, storeIds?: number[]): Promise<Map<number, ResourceRecord>> {
  const out = new Map<number, ResourceRecord>();
  if (storeIds && !storeIds.length) return out;
  const rows = await em.getRepository(ResourceRecord)
    .createQueryBuilder('r')
    .where('r.company_id = :companyId AND r.type = :type', { companyId, type: 'store-funds' })
    .andWhere(storeIds ? `CAST(JSON_UNQUOTE(JSON_EXTRACT(r.data, '$.storeId')) AS UNSIGNED) IN (:...storeIds)` : '1=1', { storeIds })
    .orderBy('r.id', 'ASC')
    .getMany();
  for (const r of rows) {
    const sid = Number(r.data.storeId);
    const cur = out.get(sid);
    if (!cur || String(r.data.snapshotDate) >= String(cur.data.snapshotDate)) out.set(sid, r);
  }
  return out;
}

/** 店铺列表/详情上的资金字段：来自最新快照；没有快照就是空（不回落到任何手填值） */
export async function deriveStoreFunds(em: EntityManager, companyId: number, records: ResourceRecord[]) {
  const latest = await latestStoreFunds(em, companyId, records.map((r) => r.id));
  const out = new Map<number, Record<string, unknown>>();
  for (const r of records) {
    const snap = latest.get(r.id);
    out.set(r.id, Object.fromEntries(STORE_FUND_FIELDS.map((k) => [k, snap ? num(snap.data[FROM_SNAPSHOT[k]]) : undefined])));
  }
  return out;
}

/** 旧版本里店铺档案手填过资金、但还没有任何快照的店铺：补一条“旧系统档案登记”快照，并清掉档案里的手填值 */
export interface StoreFundBackfill { storeId: number; title: string; date: string; deposit?: number; frozen?: number; withdrawable?: number; promotion?: number }

export async function planStoreFundBackfill(em: EntityManager, companyId: number): Promise<StoreFundBackfill[]> {
  const stores = await em.find(ResourceRecord, { where: { companyId, type: 'stores' } });
  const has = await latestStoreFunds(em, companyId);
  const plan: StoreFundBackfill[] = [];
  for (const s of stores) {
    const d = s.data as Record<string, unknown>;
    const values = { deposit: num(d.deposit), frozen: num(d.frozen), withdrawable: num(d.goodsFund), promotion: num(d.promotionBalance) };
    if (Object.values(values).every((v) => v === undefined)) continue;
    // 已经有快照的店铺以快照为准，手填值只是清掉
    plan.push({ storeId: s.id, title: s.title, date: has.has(s.id) ? '' : new Date(s.updatedAt).toISOString().slice(0, 10), ...values });
  }
  return plan;
}

export async function applyStoreFundBackfill(em: EntityManager, resources: ResourcesService, user: AuthUser, plan: StoreFundBackfill[]) {
  const done = { snapshots: 0, cleared: 0 };
  for (const p of plan) {
    if (p.date) {
      const data: Record<string, unknown> = { storeId: p.storeId, snapshotDate: p.date, source: 'legacy', note: '旧系统档案登记' };
      for (const k of ['deposit', 'frozen', 'withdrawable', 'promotion'] as const) if (p[k] !== undefined) data[k] = p[k];
      await resources.create(user, 'store-funds', data);
      done.snapshots++;
    }
    const store = await em.findOneOrFail(ResourceRecord, { where: { id: p.storeId, companyId: user.companyId, type: 'stores' } });
    const data = { ...store.data } as Record<string, unknown>;
    for (const k of STORE_FUND_FIELDS) delete data[k];
    store.data = data;
    await em.save(store);
    done.cleared++;
  }
  return done;
}
