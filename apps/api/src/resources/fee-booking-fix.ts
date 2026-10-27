import { DataSource, EntityManager } from 'typeorm';
import { FEE_SEED_ITEMS, normalizeFeeBookingNodes } from '@kudesi/shared';
import { ResourceRecord } from '../entities';
import { AuthUser } from '../common/auth.decorators';
import { ResourcesService } from './resources.service';

/**
 * 迁入后的费用档案修正：早先的种子导入丢了默认挂账节点“仓库”“公户”（被改成“不固定”）。
 * 这里按默认费用档案的编号找回：只处理现在还是“不固定/空”的费用项（人工改过的不动）。
 * 默认只出计划；执行要显式 apply。
 */
export interface FeeBookingFixItem { id: number; code: string; name: string; from: string; to: string }

export async function planFeeBookingFix(em: EntityManager, companyId: number): Promise<FeeBookingFixItem[]> {
  const seed = new Map(FEE_SEED_ITEMS.map((i) => [i[0], i[4]]));
  const rows = await em.find(ResourceRecord, { where: { companyId, type: 'finance-fee-items' }, select: ['id', 'title', 'data'] });
  const plan: FeeBookingFixItem[] = [];
  for (const r of rows) {
    const code = String(r.data.code ?? '');
    const want = seed.get(code);
    if (!want || !/仓库|公户/.test(want)) continue;
    const cur = String(r.data.defaultObject ?? '').trim();
    if (cur && cur !== '不固定') continue;
    const nodes = normalizeFeeBookingNodes(want);
    if (!nodes.length) continue;
    plan.push({ id: r.id, code, name: r.title, from: cur || '（空）', to: nodes.join('、') });
  }
  return plan;
}

export async function applyFeeBookingFix(_ds: DataSource, resources: ResourcesService, user: AuthUser, plan: FeeBookingFixItem[]) {
  let fixed = 0;
  for (const p of plan) {
    await resources.update(user, 'finance-fee-items', p.id, { defaultObject: p.to });
    fixed++;
  }
  return { fixed };
}
