import { createChecker } from '@kudesi/shared';
import { DataSource, EntityManager } from 'typeorm';
import { AuthUser } from '../common/auth.decorators';
import { ResourceRecord } from '../entities';
import { CostService } from './cost.service';

/** 编码列表的只读摘要，沿用当前成本引擎；不登记快照、不发出站任务。 */
export async function bundleCatalog(ds: DataSource, em: EntityManager, user: AuthUser, records: ResourceRecord[]) {
  const result = new Map<number, Record<string, unknown>>();
  if (!records.length) return result;
  const can = createChecker(user.permissions), cost = new CostService(ds), data = await cost.load(user.companyId, em);
  for (const record of records) {
    const row = cost.row(data, record);
    const lines = data.lines.filter(l => l.data.bundleId === record.id).sort((a,b)=>Number(a.data.sortOrder ?? 0)-Number(b.data.sortOrder ?? 0)||a.id-b.id);
    const describe = (roles: string[]) => lines.filter(l=>roles.includes(String(l.data.role))).map(l=>{
      const base = data.baseCodes.get(Number(l.data.baseCodeId));
      const labor = data.labor.get(Number(l.data.laborId));
      return { name: String(base?.data.name || base?.title || labor?.title || '来源已失效'), qty: l.data.qty, unit: String(l.data.unit || '') };
    });
    const mains = lines.filter(l=>l.data.role==='main').map(l=>data.baseCodes.get(Number(l.data.baseCodeId)));
    result.set(record.id, {
      mainStyleCode: mains.map(b=>String(b?.data.styleCode || '')).filter(Boolean).join('+'),
      weightG: row.weightG,
      composition: describe(['main','gift','labor','other']), packaging: describe(['package','label','instruction']),
      ...(can('product.cost.view') ? { costCents: row.preShipCostCents } : {}),
      ...(can('product.price.view') && typeof record.data.salePrice === 'number' ? { saleCents: record.data.salePrice } : {}),
    });
  }
  return result;
}
